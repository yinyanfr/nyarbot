# 架构

nyarbot 是一个用 TypeScript (ESM) 编写的单群组 Telegram 机器人，拥有猫娘人设。

## 数据流

```
Telegram Update
    │
    ▼
app.ts（入口：初始化 Firebase、创建 Bot、注册 handler、启动轮询）
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
    │     └─ 贴纸 emoji 提取
    ├─ 缓冲区推送（conversation-buffer.ts）
    ├─ 命令路由（match-command.ts）
    │     ├─ /help
    │     ├─ /love → generateLoveRejection()
    │     ├─ /status（管理员）
    │     └─ /reset（管理员）
    ├─ 晚安检测 → setNightyTimestamp()
    ├─ 早安逻辑 → generateMorningGreeting()
    ├─ 触发检测（@提及 / 回复bot）
    ├─ 等待 URL 内容（ai.ts → tavilyExtract）
    ├─ 新鲜图片描述（ai.ts → Gemini）
    ├─ AI 分类（classifyMessage）
    │     └─ simple → flashNoThinkModel
    │     └─ complex → flashThinkModel
    │     └─ tech → proThinkModel
    ├─ AI 回复（generateResponse）
    │     └─ 系统提示词（system-prompt.ts）
    │     └─ 工具调用：saveMemory、setNickname、deleteMemory、sendSticker
    │     └─ 可选：webSearch（tavilySearch，当 needsSearch=true 时）
    │     └─ 流式回复，通过 sendMessage + editMessageText
    └─ 主动插话检查器（proactive.ts，每15秒）
          └─ shouldSpeak() → 如果非 SILENT 则发送消息
```

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
│  │  │ • 早安问候   │ │  │ • 带工具调用的回复        │ │ │
│  │  │ • 好人卡     │ │  │                          │ │ │
│  │  │ • 主动插话   │ │  │                          │ │ │
│  │  │ • 图片描述   │ │  │                          │ │ │
│  │  │ • URL 描述   │ │  │                          │ │ │
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
└─────────────────────────────────────────────────────────┘
```

为什么用两个提供商？

- **DeepSeek v4** 不支持视觉能力。发送 `image_url` 内容部分会返回 400 错误。
- **Gemini 2.5 Flash** 通过 Cloudflare AI Gateway 处理图片理解。描述在请求时生成，以 `[图片: 描述]` 文本形式注入到 DeepSeek 的提示词中。

## 上下文管理

- **对话缓冲区**：内存环形缓冲区（每组最多 30 条，每条最多 500 字）。每条用户消息和 bot 回复都会推送。用于 `generateResponse` 系统提示词和 `shouldSpeak` 主动插话检查。进程重启后丢失。
- **用户数据**（昵称、记忆、晚安/早安时间戳）：持久化到 Firestore，进程内缓存 60 秒。
- **图片缓存**：Firestore `images/{fileId}`，30 天 TTL。缓存命中时直接使用存储的描述，避免重新下载和重新描述图片。

## 流式回复

Bot 回复通过 `sendMessage`（占位符 `"…"`) + `editMessageText`（每 800ms 更新）流式发送到 Telegram。`@grammyjs/stream` 插件已被移除，因为 `sendMessageDraft` 对群组中的 bot 返回 `TEXTDRAFT_PEER_INVALID`。

流式过程中的工具调用（saveMemory、setNickname 等）使用 `stopWhen: stepCountIs(5)` 以允许多步执行。这对 `webSearch` 至关重要——没有它，流会在工具调用后结束，而不会生成最终回复。

## 主动插话

每 15 秒，`proactive.ts` 检查最近 3 分钟的缓冲区历史：

| 活跃度 | 最近用户消息数 | 冷却时间 |
| --- | --- | --- |
| 高（≥7 条） | ≥7 | 90 秒 |
| 中（3-6 条） | 3-6 | 180 秒 |
| 低（1-2 条） | 1-2 | 360 秒 |

如果冷却时间已过，调用 `shouldSpeak()`。LLM 返回一条短消息或 `SILENT`。主动插话检查器在连续 5 次失败后停止。