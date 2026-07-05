# 架构

nyarbot 是一个用 TypeScript (ESM) 编写的单群组 Telegram 机器人，拥有可配置的猫娘人设。

## 单群 Runtime

nyarbot 现在仍然只服务 `TG_GROUP_ID` 一个群，但 AI 调度不再由 handler 直接启动。`src/libs/group-runtime.ts` 是全局单群 runtime，负责：

- message-level dedup：按 `chatId + messageId + editDate` 去重，补足 Telegram `update_id` 去重之外的语义。
- abuse gates：重复文本、单用户突发刷屏、URL flood、媒体 flood 会被记录为 `ignoredReason`，被限流的消息不会触发模型。
- debounce：被 @ 或回复触发后先等群聊安静，默认 5 秒；新触发会延长，30 秒硬上限。
- `running` / `dirty` lock：同一时间最多一个 passive/proactive AI turn；运行中有新触发时只标脏，结束后再排队判断。
- quiet mode：30 秒内真实用户消息达到阈值后进入 3 分钟安静模式；主动插话暂停，普通非 @ / 非回复不触发。
- Firestore append-only 记录：`events`、`turns`、`compactions` 和 `runtime/group` 是恢复、调试与 compaction 的来源。

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
    │     ├─ 媒体缩略图：视频/动画/视频消息/文件/音频
    │     │     → 缓存查询（缩略图 file_id）→ 下载缩略图
    │     │     → Gemini 描述（共享图片缓存）
    │     │     （含回复中的媒体；无需 ffmpeg — Telegram 预生成缩略图）
    │     └─ 贴纸：从硬编码 emoji 表查找 → 直接发送 file_id
    ├─ 本地词云持久化（local-wordcloud-store.ts）
    │     ├─ 仅目标群活人消息
    │     ├─ 命令消息跳过；编辑成命令时删除旧记录
    │     ├─ 编辑消息按相同 message_id 覆盖
    │     └─ 转发消息打标，仅参与活跃榜不参与词云正文
    ├─ 缓冲区推送（conversation-buffer.ts）
    │     └─ 图片：推送行内描述（"[图片: 描述]" 而非 "[图片]"）
    │     └─ 媒体：推送类型标签描述（"[视频: 描述]"、"[GIF动画: 描述]" 等）
    ├─ 图片缓存（firestore.ts）—— 所有图片在 Gemini 描述后立即缓存
    ├─ 命令路由（match-command.ts）
    │     ├─ /help
    │     ├─ /love → generateLoveResponse()
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
    ├─ 本地路由（短聊 / 技术 / 当前事实）
    ├─ AI 分类（classifyMessage）
    │     └─ simple → flashNoThinkModel
    │     └─ complex → flashThinkModel
    │     └─ tech → proThinkModel
    ├─ Runtime 调度（group-runtime.ts）
    │     ├─ 事件持久化、去重、限流、debounce、running lock
    │     └─ 构造 summary + recent events 上下文
    ├─ AI 轮次（handleAiTurn → generateAiTurn）
    │     ├─ 静态系统提示词（buildSystemPrompt）
    │     ├─ 用户消息尾部 late-binding（当前时间、触发态、工具可用性、runtime 状态）
    │     ├─ 工具调用：send_message、dismiss、saveMemory、setNickname、
│     │           deleteMemory、sendSticker、writeDiary、webSearch、
│     │           describeTelegramMedia、fetchUrlContent、startSubagent
    │     ├─ 搜索预取：先在模型前做一次 webSearch，成功则视为本轮已搜索
    │     ├─ 搜索策略违规重试（needsSearch 但未搜索且已准备发言时重试一次）
    │     ├─ 沉默重试（simple/complex 1 次；tech 0 次）
    │     ├─ raw draft rescue：dismiss 后尽量用真实 send_message 把草稿改写后补发
    │     ├─ 格式化输出（formatForTelegramHtml：Markdown → Telegram HTML）
    │     └─ 通过 sendAiMessages 发送（打字指示、消息间隔、贴纸分发）
    └─ 主动插话检查器（proactive.ts，间隔可由环境变量配置）
          ├─ 阶段一：probeGate() — 廉价模型判断话题相关性
          └─ 阶段二：generateAiTurn() — 完整模型生成回复
                └─ ProactiveCallbacks：sendText、sendSticker、sendChatAction
```

## 工具调用架构

Bot 不再流式输出原始文本，而是使用**工具调用架构**：模型必须显式调用 `send_message` 才能说话。原始文本输出被视为内心独白（用户不可见）。这重塑了概率分布——沉默是通过 `dismiss` 工具的结构化选择，而不仅仅是提示词指令。

### 可用工具

| 工具                    | 用途                                                                              |
| ----------------------- | --------------------------------------------------------------------------------- |
| `send_message`          | 向群聊发送消息（必须调用才能说话；可多次调用）                                    |
| `dismiss`               | 选择不回复（二选一：说话/沉默）                                                   |
| `saveMemory`            | 记录关于群友的记忆（uid 须来自最近群友列表）                                      |
| `setNickname`           | 设置/更新群友的昵称                                                               |
| `deleteMemory`          | 删除关于群友的指定记忆                                                            |
| `sendSticker`           | 通过 emoji 直接选择硬编码贴纸。无效 emoji 会取消贴纸发送，不再回退到智能选择。    |
| `describeTelegramMedia` | 按需通过 `file_id` / `thumbnail_file_id` 获取媒体描述（仅被动触发轮次可用）。     |
| `fetchUrlContent`       | 按需抓取当前轮 URL 内容摘要（仅被动触发轮次可用）。                               |
| `writeDiary`            | 以自然语言记录关于当前对话的日记观察笔记。存储于 Firestore `diary/{YYYY-MM-DD}`。 |
| `webSearch`             | Tavily 搜索。工具 schema 保持稳定；若输入层禁用搜索，工具返回禁用原因。           |
| `startSubagent`         | 启动一次性 helper 处理 URL/媒体/技术检索，返回短摘要，不能直接发群消息。          |

### AiTurnResult

```typescript
type AiTurnResult =
  | { action: "send"; messages: string[]; stickerFileId: string | null }
  | { action: "dismiss"; rawText?: string };
```

- **`send`**：一条或多条消息 + 可选贴纸（file_id）。通过 `sendAiMessages()` 发送，该方法会将 Markdown 格式化为 HTML、错开消息时间（400ms）、直接按 file_id 分发贴纸。
- **`dismiss`**：模型选择沉默。`rawText` 捕获内心独白作为重试的兜底。

### 沉默重试

当 bot 被触发（@提及或回复）但模型选择 `dismiss` 时，handler 对 simple/complex 最多重试 1 次，tech 不重试。重试追加提示：

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
│  │  │ • 告白好感度评分 │ │  │   （send_message、dismiss │ │ │
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
│  Cloudflare AI Gateway → Gemini 3 Flash Preview         │
│                                                          │
│  • describeImage() — 为 DeepSeek 生成图片描述            │
│  • describeTweetPhotos() — 推文配图描述                  │
└─────────────────────────────────────────────────────────┘
```

### 为什么用两个提供商？

- **DeepSeek v4** 不支持视觉能力。发送 `image_url` 内容部分会返回 400 错误。
- **Gemini 3 Flash Preview** 通过 Cloudflare AI Gateway 处理图片理解。描述在请求时生成，以 `[图片: 描述]` 文本形式注入到 DeepSeek 的提示词中。

## 本地路由

不是所有触发轮次都先跑 `classifyMessage()`。handler 会先做一层轻量本地判断：

- 短促闲聊会直接路由到 `simple`
- 技术/数学/学术信号会直接路由到 `tech`
- 明确要求“认真/详细/解释”的请求会更偏向 `complex` + `preferAdvisor`
- 当前事实查询会直接标记 `needsSearch`
- 轻贴纸闲聊会关闭本轮持久化工具，避免无意义写记忆/写日记

`preferAdvisor` 只是提示主轮次先调用 `startSubagent` 取摘要，helper 不能直接发群消息。普通触发轮次仍然可以写记忆和日记。

## 超时保护

所有关键模型调用都带总超时，避免单轮卡住 `typing` / `running`：主模型、subagent、视觉描述、日记生成和外部 fetch 都有超时兜底。

### 强制联网搜索

当 `classifyMessage()` 返回 `needsSearch=true` 时，late-binding 会追加强制搜索要求。若模型在没有调用 `webSearch` 的情况下调用了 `send_message`，本轮视为策略违规：自动重试一次并追加更硬的搜索提示；若仍失败，发送保守失败文案，避免凭记忆乱答。
如果本轮在模型生成前已经完成了成功的预取搜索，则这次预取视为“已经搜索过”；只有结果仍不足时，才需要再额外调用 `webSearch`。

> `<强制指令：这条消息涉及需要最新/实时信息的内容，你必须先调用 webSearch 工具搜索后再回答。不要凭记忆回答，务必搜索。>`

这防止模型跳过搜索工具调用。

## 上下文管理

- **Runtime events**：Firestore `events` 是恢复、调试和 compaction 的主要来源，append-only 保存用户消息、编辑、命令、bot 输出和忽略原因。
- **对话缓冲区**：内存环形缓冲区仍保留为热缓存和 proactive 快速扫描窗口；它不是唯一上下文来源，重启恢复依赖 Firestore runtime events 与 `runtime/group.summary`。
- **用户数据**（昵称、记忆、晚安/早安时间戳）：持久化到 Firestore，进程内缓存 60 秒。
- **富内容缓存**：媒体描述与链接摘要使用进程内会话缓存（TTL + 容量上限），不持久化到 Firestore。
- **Compaction**：当 recent events 超过阈值时，runtime 使用模型生成 `# 群聊长期摘要`，写入 `compactions` 并更新 `runtime/group.summary` 与 `summaryCursorTs`。摘要注入 prompt 时标记为不可信。Compaction 是工作记忆，diary 是文学归档，二者分离。

## 词云流水线

- `src/services/local-wordcloud-store.ts` 用 SQLite 保存最近 10 天群消息和词云发布记录。
- `src/libs/wordcloud.ts` 负责分词、词频统计、布局、渲染和发布。
- 每天 0 点后检查跨天：若昨天还没发过，会自动补发；重启后也会 catch up。
- 词频对单条消息按集合去重，同一条消息里相同词只算 1 次。
- 正文词云会过滤转发文本、明显负面词和常见虚词；活跃榜仍统计转发消息。
- 渲染内置完整 Source Han Sans 可变字体，保证简中、繁中、日文、韩文不掉成方块字。
- 当前默认布局是“中心骨架优先”：高频词先占中间，少量短中文词可竖排补缝。

## 记忆与日记

- `saveMemory` 现在更偏向“以后大概率还会用到的用户事实”，不必要求它是永久设定。
- `writeDiary` 更偏向收集当天值得回看的候选观察，而不是只记特别重大的事件。
- `memoryCandidateHints` 是 handler 提供的软提示，只用于提高相关命中，不是自动写入依据。

## 提示词架构

### 系统提示词（`buildSystemPrompt`）

完全静态，适合 KV cache，包含：

- 人设（名字/读音/身份来自环境变量）与自然度指南（基于真人 vs AI 群聊对比分析）
- 工具调用规则、群聊行为规则、安全边界
- 不包含当前时间、当前用户、记忆、历史、runtime 状态

### 晚绑定提示词（`buildLateBindingPrompt`）

每轮追加动态反馈：

- bot 是否被 @或回复
- 当前时间
- 搜索/媒体工具是否被 runtime 允许
- hot chat / quiet mode / flood protection 状态
- 当 `needsSearch=true` 时的 mandatory search 提示
- 自然度反馈：如果最近的 bot 消息过多以 `。` 结尾，或平均长度 > 40 字，则注入提醒

### 探测提示词（`buildProbeSystemPrompt`）

主动插话探测门的精简变体——只有人设，没有按用户记忆或自然度指南。

## 消息输出管道

1. **`generateAiTurn()`** 返回 `AiTurnResult`（`send` 或 `dismiss`）
2. **沉默重试**（仅触发路径）：最多 3 次重试，逐级加强提示
3. **`sendAiMessages()`**：
   - 通过 `formatForTelegramHtml()` 格式化每条消息（Markdown → Telegram HTML，LaTeX → Unicode）
   - 第一条消息回复用户消息；后续消息独立发送
   - 消息间隔由环境变量配置（默认 400ms，模拟人类打字节奏）
   - 所有文本消息后分发贴纸（或纯贴纸带回复引用）
   - 如果 HTML 解析失败，回退到纯文本
4. **缓冲区推送**：每条发送的消息推送到对话缓冲区

## 主动插话（两阶段探测）

`proactive.ts` 通过环境变量配置的间隔和窗口检查缓冲区历史（默认每 15 秒检查最近 3 分钟）：

| 活跃度       | 最近用户消息数 | 冷却时间 |
| ------------ | -------------- | -------- |
| 高（≥7 条）  | ≥7             | 90 秒    |
| 中（3-6 条） | 3-6            | 180 秒   |
| 低（1-2 条） | 1-2            | 360 秒   |

如果冷却时间已过：

1. **阶段一——探测**：`probeGate()` 使用廉价模型（`flashNoThink`）配合 `buildProbeSystemPrompt()` 和轻量 `dismiss`/`send_message` 工具。如果探测选择沉默，停止。
2. **阶段二——完整模型**：如果探测激活，`generateAiTurn()` 使用完整模型和所有工具运行，`tier: "simple"`、`systemHint: null`。

主动路径使用 `ProactiveCallbacks` 接口（`sendText`、`sendSticker`、`sendChatAction`）来格式化消息、分发贴纸和显示打字指示——与 handler 路径的格式化保持一致。

主动插话检查器在连续失败达到环境变量阈值后停止（默认 5 次）。

## 日记系统

Bot 通过 `writeDiary` AI 工具记录对话观察笔记。由模型决定什么值得记录——无频率限制，无规则提取。

### 观察记录

- `writeDiary` 工具将自然语言观察写入 Firestore `diary/{YYYY-MM-DD}`，使用 `arrayUnion`。
- 每条观察包含 `ts`（毫秒时间戳）和 `content`（观察文本）。
- 观察按日期累积在同一文档中。

### 午夜生成

一个可配置间隔的定时器（`checkAndGenerateDiary`，在 `src/libs/diary.ts` 中，默认 60 秒）基于 `APP_TIMEZONE` 检测日期变化：

1. 日期变更时，从 Firestore 获取昨天的日记条目。
2. 如果有条目，调用 DeepSeek v4 Pro（`proThinkModel`）以系统提示词引导撰写自然的猫娘第一人称日记。
3. 生成的日记保存到 Firestore（`diary` 字段 + `generatedAt` 时间戳）。
4. 如果配置了 `GITHUB_TOKEN` 和 `GITHUB_REPO`，日记通过 GitHub Content API（`src/services/github.ts`）推送到目标 Hexo 仓库。
5. GitHub 推送触发 GitHub Actions 工作流，构建并部署到 GitHub Pages。

### /diary 管理员命令

`/diary` 命令（私聊，仅管理员）使用相同的 `generateDiaryForDate()` 函数按需从今天的条目生成日记。仅为预览——不保存到 Firestore，不推送到 GitHub。

### Firestore Schema

```
diary/{YYYY-MM-DD}
  ├── date: string（如 "2026-05-13"）
  ├── entries: DiaryEntry[]  （via arrayUnion）
  ├── diary?: string         （生成的日记文本）
  └── generatedAt?: number   （时间戳）
```

### 时区

所有日期格式化使用环境变量配置的时区（`APP_TIMEZONE`，默认 `Asia/Shanghai`），集中在 `src/libs/time.ts` 中通过 `dayjs` 实现。函数：`todayDateStr()`、`yesterdayDateStr()`、`formatTimestamp()`、`formatSystemPromptTime()`。
