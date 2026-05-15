# 命令与交互

## 斜杠命令

| 命令      | 权限     | 说明                                             |
| --------- | -------- | ------------------------------------------------ |
| `/help`   | 所有人   | 显示帮助文本                                     |
| `/love`   | 所有人   | 收到一张傲娇好人卡                               |
| `/nighty` | 所有人   | 说晚安；8 小时后 bot 发送早安问候                |
| `/status` | 仅管理员 | 显示运行时间、缓冲区大小、记忆用户数、图片缓存数 |
| `/reset`  | 仅管理员 | 清除对话历史缓冲区                               |
| `/diary`  | 仅管理员 | 生成今日日记预览（仅私聊）                       |

管理员命令通过比对 `TG_ADMIN_UID` 与发送者用户 ID 来鉴权。

## 自然语言触发

### @提及 或 回复

当用户 @提及bot 或回复它的消息时，触发完整 AI 流程：

1. **分类** — `classifyMessage()` 将消息归类为 `simple`、`complex` 或 `tech`，以及是否需要联网搜索。
2. **模型选择** — `simple` → flash-无思考、`complex` → flash-思考、`tech` → pro-思考。
3. **工具增强生成** — `generateAiTurn()` 运行带工具的生成（send_message、dismiss、记忆、昵称、贴纸、可选联网搜索）。
4. **沉默重试** — 如果模型在被触发时选择 `dismiss`，最多重试 3 次，每次追加递增的回复提示。所有重试仍沉默则回退到原始文本或贴纸。
5. **输出** — 消息通过 `formatForTelegramHtml()` 格式化（Markdown → Telegram HTML），带打字指示和可选贴纸分发。

### 图片

- **直接及回复中的图片**：用户自己消息中的图片（`msg.photo`）以及回复消息中的图片（`msg.reply_to_message.photo`）都会被处理。
- **缓存命中**：如果 Telegram `file_id` 之前出现过且 Firestore 中有描述，直接将描述以 `[图片: 描述]` 文本形式注入。
- **新鲜图片**：图片下载为 data URL，发送到 **Gemini 3 Flash Preview** 生成描述，描述以文本形式注入 DeepSeek 的提示词。描述随后缓存到 Firestore（30 天 TTL）。
- **缓冲区增强**：图片描述以行内形式写入对话缓冲区（`[图片: 描述]` 而非裸 `[图片]`），使主动插话检查器和后续触发轮次获得完整图片上下文。
- **无条件缓存**：所有图片在 Gemini 描述后立即缓存，无论 bot 是否被触发——确保主动插话上下文始终可用。

### URL

- URL 同时通过 Telegram entity 和正则回退两种方式检测。
- `fetchUrlContent()` 使用三级抓取策略：
  1. **Twitter/X 推文链接**（`twitter.com`/`x.com`/`*/status/*`）→ **fxtwitter API**（免费，无需认证）。提取作者、正文以及最多 4 张配图。配图在单次调用中发送给 **Gemini 3 Flash Preview** 生成 ≤150 字的中文描述。引用推文也会被提取。
  2. **其他链接** → 直接 `fetch()`（8 秒超时），从 HTML 中提取 `<title>` 和 `<meta name="description">`。
  3. **回退** → Tavily Extract（AI 摘要）。
- **成功**：内容推送到对话缓冲区：
  - 推文 → `[推文]: [Tweet url | @handle (Name): 文本 | 配图: desc1; desc2]`
  - 普通链接 → `[链接]: [链接内容: 标题 — 描述]`
- **失败**：缓冲区中不推送任何内容。主动模式下 bot 保持沉默。触发（被动）模式下，LLM 看到 `[链接 url: 无法获取内容]`，可以请用户描述链接。
- **无持久化存储**：链接描述仅存在于内存对话缓冲区中（最多 30 条）。

### 贴纸

群友发送的贴纸会被下载、格式转换（动态贴纸 webm→webp via ffmpeg），并由 Gemini 进行中文描述和关键词提取。描述（≤30字）和关键词（3-5个）缓存到 `received_stickers`。贴纸文档以 Telegram `file_unique_id`（稳定身份）作为文档 ID，同时在文档中保留最新 `file_id` 用于实际发送/下载。只有生成有效 AI 描述的贴纸才会被缓存。

LLM 可通过 `adoptSticker` 工具将 `received_stickers` 缓存中的贴纸收入 bot 自己的 `stickers` 贴纸库。提示词上下文里的 `sticker_id` 对应 `file_unique_id`（不是 `file_id`）。收入时贴纸会发送到聊天，并提示模型调用 `send_message` 用傲娇猫娘口吻确认。

回复时，LLM 可以：

- **文字 + 贴纸**：调用 `send_message` 后调用 `sendSticker` — 贴纸在文字消息后分发。
- **纯贴纸**：只调用 `sendSticker` 不调用 `send_message` — 贴纸带回复引用发送。
- **无贴纸**：只调用 `send_message` — 纯文字回复。

`sendSticker` 工具展示紧凑的 emoji→关键词索引（`😀 开心,庆祝 | 😭 大哭,崩溃 | ...`）。LLM 通过选择 emoji 和关键词来匹配贴纸。工具先按关键词重叠打分预选（最多5个候选），再由 Flash 在候选中语义匹配。回退到 emoji 精确匹配或随机贴纸。

### 视频、GIF动画、视频消息、文件与音频

Telegram 在以下消息类型上免费提供 `thumbnail` 字段（微小的 JPEG，通常 ≤320×320、<200 KB）：`Video`、`Animation`（GIF）、`VideoNote`、`Document` 和 `Audio`。该缩略图是一个独立文件，完全不需要下载实际视频内容。

Bot 通过 `getFile(thumbnail_file_id)` 下载缩略图，由 Gemini 生成描述，并将带类型标签的描述注入 AI 提示词和对话缓冲：

| 媒体类型 | 格式                   | 缩略图来源                         |
| -------- | ---------------------- | ---------------------------------- |
| 视频     | `[视频: 描述]`         | `cover`（取最大尺寸）→ `thumbnail` |
| GIF动画  | `[GIF动画: 描述]`      | `thumbnail`                        |
| 视频消息 | `[视频消息: 描述]`     | `thumbnail`                        |
| 文件     | `[文件: 文件名: 描述]` | `thumbnail`                        |
| 音频     | `[音频: 标题: 描述]`   | `thumbnail`（专辑封面）            |

- **已缓存**：缩略图描述缓存于 Firestore `images/{thumbnail_file_id}` — 与图片共享同一缓存（30 天 TTL）。
- **纯文本回退**：若无缩略图（极少见），则注入 `[视频]` 或 `[文件: report.pdf]` 等文本标记，使 bot 至少获知有媒体发送。
- **回复中的媒体**：回复消息中的视频/GIF/视频消息/文件/音频缩略图同样被处理，与现有的回复图片行为一致。
- **无需 ffmpeg**：缩略图是 Telegram 预生成的 JPEG/WebP 图片，无需视频提取。
- **无条件缓存**：所有媒体缩略图在 Gemini 描述后立即缓存，无论 bot 是否被触发——确保主动插话上下文始终可用。

### 晚安 / 早安

- **晚安**：仅 `/nighty` 命令 → 在 Firestore 存储 `nightyTimestamp`。
- **早安**：如果用户有 ≥8 小时前的 `nightyTimestamp` 且发送了新消息：
  - 同时 @提及/回复 bot → 注入系统提示，让回复自然以早安开头。
  - 未触发 → 单独发送一条早安问候。

### 告白

匹配 `LOVE_REGEX` 的文本（我爱你、喜欢你、嫁给我、love 等）触发 `generateLoveRejection()` — 一个专用提示词，使用用户的记忆生成个性化傲娇好人卡。

## LLM 工具

`generateAiTurn()` 函数向模型暴露以下工具：

| 工具           | 说明                                                  |
| -------------- | ----------------------------------------------------- |
| `send_message` | 向群聊发送消息——说话的唯一方式；可多次调用            |
| `dismiss`      | 选择不回复（二选一：说话/沉默）                       |
| `saveMemory`   | 记录关于群友的记忆（uid 必须来自最近群友列表）        |
| `setNickname`  | 设置/更新群友的昵称                                   |
| `deleteMemory` | 删除关于群友的指定记忆                                |
| `sendSticker`  | 通过 emoji + 关键词选择贴纸；两阶段预选后语义匹配     |
| `adoptSticker` | 将群友贴纸收入 bot 库，附带描述和关键词               |
| `writeDiary`   | 记录关于当前对话的观察笔记                            |
| `webSearch`    | Tavily 搜索（仅在分类结果 `needsSearch=true` 时附带） |

所有记忆/昵称工具在写入 Firestore 前会验证 `uid` 是否在 `allowedUids`（最近对话缓冲区中出现的 UID 集合）中。

### 工具调用流程

```
用户消息 → classifyMessage() → generateAiTurn()
                                        │
                                        ├─ 模型调用 send_message → 文本添加到 messages[]
                                        ├─ 模型调用 dismiss → dismissed = true
                                        ├─ 模型调用 saveMemory → Firestore 写入
                                        ├─ 模型调用 setNickname → Firestore 写入
                                        ├─ 模型调用 deleteMemory → Firestore 删除
                                         ├─ 模型调用 sendSticker → 选择 file_id 分发
                                         ├─ 模型调用 writeDiary → Firestore 日记写入
                                         ├─ 模型调用 webSearch → Tavily 搜索执行
                                        │
                                        ▼
                                 AiTurnResult
                                  ├─ { action: "send", messages, stickerFileId }
                                  └─ { action: "dismiss", rawText? }
```

### 沉默重试（仅触发路径）

当用户明确 @提及或回复 bot，但模型选择 `dismiss` 时：

1. 最多重试 3 次，每次追加 `[系统提示：用户明确@了你或回复了你，你必须回复，不要选择沉默。]` 到 `systemHint`。
2. 所有重试后仍然 `dismiss`：
   - 如果 `rawText` 存在（模型产生了内心独白）→ 将 `rawText` 作为消息发送 + 随机贴纸兜底。
   - 如果 `rawText` 为空 → 只发送随机贴纸（带回复引用）。

主动插话路径不重试——沉默是合理的预期结果。

## 消息格式化

所有 bot 输出在发送前通过 `formatForTelegramHtml()` 处理：

- **代码块**：` ```code``` ` → `<pre><code>`
- **行内代码**：`` `code` `` → `<code>`
- **粗体**：`**text**` → `<b>text</b>`
- **斜体**：`*text*` → `<i>text</i>`
- **删除线**：`~~text~~` → `<s>text</s>`
- **链接**：`[text](url)` → `<a href="url">text</a>`
- **LaTeX 数学**：`$...$` → `<code>` 带 Unicode 转换，`$$...$$` → `<pre><code>`
- 如果 HTML 解析失败，回退到纯文本

## 打字指示

在 `handleAiTurn()` 开始时和每次沉默重试前发送 `sendChatAction("typing")`，让用户在 AI 生成时看到"正在输入…"。
