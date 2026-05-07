# 命令与交互

## 斜杠命令

| 命令      | 权限     | 说明                                             |
| --------- | -------- | ------------------------------------------------ |
| `/help`   | 所有人   | 显示帮助文本                                     |
| `/love`   | 所有人   | 收到一张傲娇好人卡                               |
| `/nighty` | 所有人   | 说晚安；8 小时后 bot 发送早安问候                |
| `/status` | 仅管理员 | 显示运行时间、缓冲区大小、记忆用户数、图片缓存数 |
| `/reset`  | 仅管理员 | 清除对话历史缓冲区                               |

管理员命令通过比对 `TG_ADMIN_UID` 与发送者用户 ID 来鉴权。

## 自然语言触发

### @提及 或 回复

当用户 @提及bot 或回复它的消息时，触发完整 AI 流程：

1. **分类** — `classifyMessage()` 将消息归类为 `simple`、`complex` 或 `tech`，以及是否需要联网搜索。
2. **模型选择** — `simple` → flash-无思考、`complex` → flash-思考、`tech` → pro-思考。
3. **工具增强流式回复** — `generateResponse()` 流式回复，可选工具调用（记忆、昵称、贴纸、联网搜索）。
4. **后处理** — 贴纸发送、图片缓存写入。

### 图片

- **缓存命中**：如果 Telegram `file_id` 之前出现过且 Firestore 中有描述，直接将描述以 `[图片: 描述]` 文本形式注入。
- **新鲜图片**：图片下载为 data URL，发送到 **Gemini 2.5 Flash** 生成描述，描述以文本形式注入 DeepSeek 的提示词。描述随后缓存到 Firestore（30 天 TTL）。

### URL

- URL 同时通过 Telegram entity 和正则回退两种方式检测。
- 当 bot 被触发（@提及/回复）时，`fetchUrlContent()` 使用 Tavily 的 `urlExtract` 工具 + DeepSeek 摘要。
- 当 bot 未被触发时，URL 内容仍然被异步提取并作为系统条目推送到对话缓冲区——这为主动插话检查器提供了上下文。

### 贴纸

Telegram 贴纸 emoji 被提取并以 `[贴纸: emoji]` 形式发送给 LLM。LLM 可以通过 `sendSticker` 工具调用回复一个妙哈哈贴纸包的 emoji。

### 晚安 / 早安

- **晚安**：`/nighty` 命令或匹配正则的文本（晚安、night、睡了等）→ 在 Firestore 存储 `nightyTimestamp`。
- **早安**：如果用户有 ≥8 小时前的 `nightyTimestamp` 且发送了新消息：
  - 同时 @提及/回复 bot → 注入系统提示，让回复自然以早安开头。
  - 未触发 → 单独发送一条早安问候。

### 告白

匹配 `LOVE_REGEX` 的文本（我爱你、喜欢你、嫁给我、love 等）触发 `generateLoveRejection()` — 一个专用提示词，使用用户的记忆生成个性化傲娇好人卡。

## LLM 工具

`generateResponse()` 函数向模型暴露以下工具：

| 工具           | 说明                                                  |
| -------------- | ----------------------------------------------------- |
| `saveMemory`   | 记录关于群友的记忆（uid 必须来自最近群友列表）        |
| `setNickname`  | 设置/更新群友的昵称                                   |
| `deleteMemory` | 删除关于群友的指定记忆                                |
| `sendSticker`  | 选择一个妙哈哈贴纸 emoji 随回复一起发送               |
| `webSearch`    | Tavily 搜索（仅在分类结果 `needsSearch=true` 时附带） |

所有记忆/昵称工具在写入 Firestore 前会验证 `uid` 是否在 `allowedUids`（最近对话缓冲区中出现的 UID 集合）中。
