# 架构

nyarbot 是一个用 TypeScript (ESM) 编写的单群组 Telegram 机器人，拥有猫娘人设。

## 数据流

```
Telegram Update
    │
    ▼
app.ts（入口：初始化 Firebase、创建 Bot、注册 handler、启动主动插话检查器）
    │
    ▼
handlers/index.ts（setupHandlers）
    │
    ├─ 更新去重（update-dedup.ts）
    ├─ 群组过滤（tgGroupId）
    ├─ 用户解析（firestore.ts → 60秒进程内缓存）
    ├─ 内容提取（extract-content.ts）
    │     ├─ URL 检测（entity + 正则回退）
    │     ├─ 图片：缓存查询 → 下载 → Gemini 描述
    │     │     （含回复消息中的图片：msg.reply_to_message.photo）
    │     └─ 贴纸 emoji 提取
    ├─ 缓冲区推送（conversation-buffer.ts）
    │     └─ 图片：推送行内描述（"[图片: 描述]" 而非 "[图片]"）
    ├─ 图片缓存（firestore.ts）—— 所有图片在 Gemini 描述后立即缓存
    ├─ 命令路由（match-command.ts）
    │     ├─ /help
    │     ├─ /love → generateLoveRejection()
    │     ├─ /status（管理员）
    │     └─ /reset（管理员）
    ├─ 晚安检测 → setNightyTimestamp()
    ├─ 早安逻辑 → generateMorningGreeting()
    ├─ 触发检测（@提及 / 回复bot）
    ├─ 等待 URL 内容（ai.ts → fetchUrlContent）
    │     ├─ Twitter/X 推文链接 → fxtwitter API（免费）→ Gemini 配图描述
    │     ├─ 其他链接 → 直接抓取（提取 <title> + <meta description>）
    │     └─ 回退 → Tavily Extract（AI 摘要）
    ├─ URL 内容缓冲区推送
    │     ├─ 成功抓取 → 作为系统条目推送（"[推文]" 或 "[链接]"）
    │     └─ 抓取失败 → 静默忽略（无缓冲区条目，无主动插话噪音）
    ├─ 新鲜图片描述（ai.ts → Gemini）
    ├─ AI 分类（classifyMessage）
    │     └─ simple → flashNoThinkModel
    │     └─ complex → flashThinkModel
    │     └─ tech → proThinkModel
    ├─ AI 轮次（handleAiTurn → generateAiTurn）
    │     ├─ 系统提示词（buildSystemPrompt + buildLateBindingPrompt）
    │     ├─ 工具调用：send_message、dismiss、saveMemory、setNickname、
    │     │           deleteMemory、sendSticker
    │     ├─ 条件：webSearch（tavilySearch，当 needsSearch=true 时）
    │     ├─ 沉默重试（最多 3 次，逐级加强回复提示）
    │     ├─ 格式化输出（formatForTelegramHtml：Markdown → Telegram HTML）
    │     └─ 通过 sendAiMessages 发送（打字指示、消息间隔、贴纸分发）
    └─ 主动插话检查器（proactive.ts，每15秒）
          ├─ 阶段一：probeGate() — 廉价模型判断话题相关性
          └─ 阶段二：generateAiTurn() — 完整模型生成回复
                └─ ProactiveCallbacks：sendText、sendSticker、sendChatAction
```

## 工具调用架构

Bot 不再流式输出原始文本，而是使用**工具调用架构**：模型必须显式调用 `send_message` 才能说话。原始文本输出被视为内心独白（用户不可见）。这重塑了概率分布——沉默是通过 `dismiss` 工具的结构化选择，而不仅仅是提示词指令。

### 可用工具

| 工具           | 用途                                                  |
| -------------- | ----------------------------------------------------- |
| `send_message` | 向群聊发送消息（必须调用才能说话；可多次调用）        |
| `dismiss`      | 选择不回复（二选一：说话/沉默）                       |
| `saveMemory`   | 记录关于群友的记忆（uid 须来自最近群友列表）          |
| `setNickname`  | 设置/更新群友的昵称                                   |
| `deleteMemory` | 删除关于群友的指定记忆                                |
| `sendSticker`  | 选择一个妙哈哈贴纸 emoji，随文字一起或单独发送        |
| `webSearch`    | Tavily 搜索（仅在分类结果 `needsSearch=true` 时附带） |

### AiTurnResult

```typescript
type AiTurnResult =
  | { action: "send"; messages: string[]; stickerEmoji: string | null }
  | { action: "dismiss"; rawText?: string };
```

- **`send`**：一条或多条消息 + 可选贴纸。通过 `sendAiMessages()` 发送，该方法会将 Markdown 格式化为 HTML、错开消息时间（400ms）、分发贴纸。
- **`dismiss`**：模型选择沉默。`rawText` 捕获内心独白作为重试的兜底。

### 沉默重试

当 bot 被触发（@提及或回复）但模型选择 `dismiss` 时，handler 最多重试 3 次。每次重试追加递增的提示：

> `[系统提示：用户明确@了你或回复了你，你必须回复，不要选择沉默。]`

如果所有重试仍然沉默：

- 如果 `rawText` 存在 → 作为单条消息发送 + 随机贴纸
- 如果 `rawText` 为空 → 只发送随机贴纸（作为回复）

## AI 模型路由

```
┌─────────────────────────────────────────────────────────┐
│                  DeepSeek API                           │
│  ┌──────────────────┐  ┌─────────────────────────────┐ │
│  │  deepseek-v4-flash                               │ │
│  │  ┌──────────────┐ │  ┌──────────────────────────┐ │ │
│  │  │ 无思考模式    │ │  │ 思考模式（enabled）        │ │ │
│  │  │ (disabled)   │ │  │                          │ │ │
│  │  │              │ │  │                          │ │ │
│  │  │ • 消息分类   │ │  │ • 复杂对话                │ │ │
│  │  │ • 早安问候   │ │  │ • 工具调用回复             │ │ │
│  │  │ • 好人卡     │ │  │   （send_message、dismiss │ │ │
│  │  │ • 图片描述   │ │  │    saveMemory 等）        │ │ │
│  │  │ • URL 描述   │ │  │                          │ │ │
│  │  │ • 探测门     │ │  │                          │ │ │
│  │  └──────────────┘ │  └──────────────────────────┘ │ │
│  └──────────────────┘                                │ │
│  ┌──────────────────┐                                │ │
│  │  deepseek-v4-pro  │                                │ │
│  │  思考模式（enabled）│                                │ │
│  │                    │                                │ │
│  │  • 技术问题        │                                │ │
│  └──────────────────┘                                │ │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  Cloudflare AI Gateway → Gemini 2.5 Flash              │
│                                                          │
│  • describeImage() — 为 DeepSeek 生成图片描述            │
│  • describeTweetPhotos() — 推文配图描述                  │
└─────────────────────────────────────────────────────────┘
```

### 为什么用两个提供商？

- **DeepSeek v4** 不支持视觉能力。发送 `image_url` 内容部分会返回 400 错误。
- **Gemini 2.5 Flash** 通过 Cloudflare AI Gateway 处理图片理解。描述在请求时生成，以 `[图片: 描述]` 文本形式注入到 DeepSeek 的提示词中。

### 强制联网搜索

当 `classifyMessage()` 返回 `needsSearch=true` 时，`webSearch` 工具（Tavily）会被包含在工具集中。此外，用户提示词会追加一条强制指令：

> `<强制指令：这条消息涉及需要最新/实时信息的内容，你必须先调用 webSearch 工具搜索后再回答。不要凭记忆回答，务必搜索。>`

这防止模型跳过搜索工具调用。

## 上下文管理

- **对话缓冲区**：内存环形缓冲区（每组最多 60 条，每条最多 500 字）。每条用户消息和 bot 回复都会推送。用于 `buildSystemPrompt` 和 `probeGate` 主动插话检查。进程重启后丢失。图片条目包含 Gemini 行内描述（如 `[图片: 一只猫在睡觉]`）；URL 条目仅包含成功抓取的内容（推文：`[推文]: [Tweet url | @x: 文本 | 配图: ...]`，普通链接：`[链接内容]: 标题 — 描述`）。原始 URL 绝不进入缓冲区，避免对无法抓取的链接产生主动噪音。
- **用户数据**（昵称、记忆、晚安/早安时间戳）：持久化到 Firestore，进程内缓存 60 秒。
- **图片缓存**：Firestore `images/{fileId}`，30 天 TTL。缓存命中时直接使用存储的描述，避免重新下载和重新描述图片。

## 提示词架构

### 系统提示词（`buildSystemPrompt`）

每轮构建，包含：

- 猫娘人设和自然度指南（基于真人 vs AI 群聊对比分析）
- 当前用户上下文（昵称、uid、记忆）
- 最近群友列表（用于记忆/昵称工具的 uid 验证）
- 最近聊天历史

### 晚绑定提示词（`buildLateBindingPrompt`）

每轮追加动态反馈：

- bot 是否被 @或回复
- 自然度反馈：如果最近的 bot 消息过多以 `。` 结尾，或平均长度 > 40 字，则注入提醒

### 探测提示词（`buildProbeSystemPrompt`）

主动插话探测门的精简变体——只有人设，没有按用户记忆或自然度指南。

## 消息输出管道

1. **`generateAiTurn()`** 返回 `AiTurnResult`（`send` 或 `dismiss`）
2. **沉默重试**（仅触发路径）：最多 3 次重试，逐级加强提示
3. **`sendAiMessages()`**：
   - 通过 `formatForTelegramHtml()` 格式化每条消息（Markdown → Telegram HTML，LaTeX → Unicode）
   - 第一条消息回复用户消息；后续消息独立发送
   - 消息间隔 400ms（模拟人类打字节奏）
   - 所有文本消息后分发贴纸（或纯贴纸带回复引用）
   - 如果 HTML 解析失败，回退到纯文本
4. **缓冲区推送**：每条发送的消息推送到对话缓冲区

## 主动插话（两阶段探测）

每 15 秒，`proactive.ts` 检查最近 3 分钟的缓冲区历史：

| 活跃度       | 最近用户消息数 | 冷却时间 |
| ------------ | -------------- | -------- |
| 高（≥7 条）  | ≥7             | 90 秒    |
| 中（3-6 条） | 3-6            | 180 秒   |
| 低（1-2 条） | 1-2            | 360 秒   |

如果冷却时间已过：

1. **阶段一——探测**：`probeGate()` 使用廉价模型（`flashNoThink`）配合 `buildProbeSystemPrompt()` 和轻量 `dismiss`/`send_message` 工具。如果探测选择沉默，停止。
2. **阶段二——完整模型**：如果探测激活，`generateAiTurn()` 使用完整模型和所有工具运行，`tier: "simple"`、`systemHint: null`。

主动路径使用 `ProactiveCallbacks` 接口（`sendText`、`sendSticker`、`sendChatAction`）来格式化消息、分发贴纸和显示打字指示——与 handler 路径的格式化保持一致。

主动插话检查器在连续 5 次失败后停止。
