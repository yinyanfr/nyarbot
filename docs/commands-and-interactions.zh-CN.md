# 命令与交互

## 斜杠命令

| 命令                          | 权限     | 说明                                 |
| ----------------------------- | -------- | ------------------------------------ |
| `/help`                       | 所有人   | 显示帮助文本                         |
| `/love`                       | 所有人   | 触发好感度评分条目 + 傲娇回应        |
| `/shock`                      | 所有人   | 电 bot 一下，触发被电到炸毛的反应    |
| `/stroke`                     | 所有人   | 摸 bot；正常力度亲昵，过度时可能抗议 |
| `/roll [NdM]`                 | 所有人   | 立即掷骰并排队生成一句 AI 反应       |
| `/nighty`                     | 所有人   | 说晚安；8 小时后 bot 发送早安问候    |
| `/status`                     | 仅管理员 | 显示运行时间、缓冲区大小、记忆用户数 |
| `/reset`                      | 仅管理员 | 清除对话历史缓冲区和运行摘要         |
| `/diary`                      | 仅管理员 | 生成今日日记预览（仅私聊）           |
| `/wordcloud [date]`           | 仅管理员 | 生成指定日期词云预览（仅私聊）       |
| `/diaryobs [date]`            | 仅管理员 | 列出结构化日记观察（仅私聊）         |
| `/diaryshow <id>`             | 仅管理员 | 查看单条日记观察（仅私聊）           |
| `/diaryedit <id> <json>`      | 仅管理员 | 用 JSON patch 修改观察（仅私聊）     |
| `/diaryretract <id> [reason]` | 仅管理员 | 撤回观察（仅私聊）                   |
| `/diaryregen [date]`          | 仅管理员 | 重新生成预览，不保存或发布（仅私聊） |

管理员命令通过比对 `TG_ADMIN_UID` 与发送者用户 ID 来鉴权。

## 自然语言触发

### @提及 或 回复

当用户 @提及bot 或回复它的消息时，触发完整 AI 流程：

1. **分类** — `classifyMessage()` 将消息归类为 `simple`、`complex` 或 `tech`，以及是否需要联网搜索。
2. **模型选择** — `simple` → flash-无思考、`complex` → flash-思考、`tech` → pro-思考。
3. **工具增强生成** — `generateAiTurn()` 运行带工具的生成（send_message、dismiss、记忆、昵称、贴纸、可选联网搜索）。
4. **沉默重试** — 如果模型在被触发时选择 `dismiss`，simple/complex 最多重试 1 次，tech 不重试。之后会先尽量把 raw draft 救成真实的 `send_message`，再回退到贴纸。
5. **输出** — 消息通过 `formatForTelegramHtml()` 格式化（Markdown → Telegram HTML），带打字指示和可选贴纸分发。

在正式分类前，handler 会先做一层本地路由：短聊、技术题、详细解释和当前事实查询可以直接命中路由，不一定每次都要跑 `classifyMessage()`。

### 特殊上下文记录

- 部分不是 `send_message` 产生的 bot 输出也会写入对话缓冲区，例如 `/love`、`/shock`、`/stroke`、`/roll`、`/reset`、早安问候、每日自动日记通知。
- 这些记录在 XML 历史里会带 `kind="..."` 属性，表示它们是命令回复或系统性插入记录，模型应将其视为真实发生过的上下文。

### 图片与媒体

- handler 不再预下载、预描述媒体。
- 上下文只保留原始引用（`file_id` / `thumbnail_file_id`，含当前消息与 reply-to）。
- 在**被动触发**（@提及/回复）时，模型可按需调用 `describeTelegramMedia`。
- 在**主动插话**时，URL 抓取仍禁用；最新候选消息中的图片可以预取，bot 在谈论图片前必须先理解图片，旧媒体只作为背景上下文。
- Telegram 下载优先识别 JPEG、PNG、GIF、WebP、BMP、TIFF、AVIF、HEIC 字节签名；未命中时接受 `image/*` 响应头作为回退，两者都没有才拒绝。

### URL

- URL 仍通过 Telegram entity + 正则回退提取。
- handler 不再预抓取链接内容。
- 在**被动触发**时，模型可按需调用 `fetchUrlContent` 或 `readVideo`。
- `readVideo` 会把支持的 YouTube URL 直接交给原生 Gemini 理解声音与画面；Bilibili 走只读 MCP 获取字幕和元数据，字幕不可用时只返回元数据。
- `fetchUrlContent` 三级策略：
  1. Twitter/X 推文链接 → FxEmbed API v2（`/2/status/{id}`）
  2. 其他链接 → 直接抓取 `<title>`/`<meta description>`
  3. 回退 → Tavily Extract
- 链接摘要缓存为进程内会话缓存，不写入 SQLite。

### 贴纸

收到贴纸时默认只读取 emoji 做轻量上下文，且不会持久化描述。被动触发轮次可安全查看贴纸缩略图；动画 WebM 原文件不会作为图片送入视觉模型，不支持的负载会直接跳过。

回复时，LLM 可以：

- **文字 + 贴纸**：调用 `send_message` 后调用 `sendSticker` — 贴纸在文字消息后分发。
- **纯贴纸**：只调用 `sendSticker` 不调用 `send_message` — 贴纸带回复引用发送。
- **无贴纸**：只调用 `send_message` — 纯文字回复。

`sendSticker` 工具展示硬编码的 emoji 列表。LLM 只需要选择 emoji。无效 emoji 会取消贴纸发送。

### 词云预览与统计口径

- `/wordcloud [date]` 只在管理员私聊中可用；不传日期时默认预览今天。
- 预览 caption 会根据目标日期自动写“今天 / 昨天 / 指定日期”，不再固定写“昨天”。
- 活跃榜与 `messageCount` 会统计转发消息；词云正文不会使用转发文本。

### 掷骰子

- `/roll` 默认投 `1d20`；`/roll 2d6` 表示投两颗六面骰。
- 支持 1–20 颗骰子、2–99999 面。
- 程序会立即发送结果或参数错误，再通过单群 runtime 排队生成一句强制 AI 跟进。

### 视频、GIF动画、视频消息、文件与音频

- 上下文保留这些媒体的 `file_id` 与可用的 `thumbnail_file_id`。
- 模型可自行决定是否调用 `describeTelegramMedia` 以及查看哪个 file id。
- handler 不再预下载缩略图并预注入描述。

### 晚安 / 早安

- **晚安**：仅 `/nighty` 命令 → 使用 Telegram `first_name` 立即回复，再在后台持久化 `nightyTimestamp`，不等待用户查询、媒体提取或模型调用。
- **早安**：如果用户有 ≥8 小时前的 `nightyTimestamp` 且发送了新消息：
  - 同时 @提及/回复 bot → 注入系统提示，让回复自然以早安开头。
  - 未触发 → 单独发送一条早安问候。

### 告白

匹配 `LOVE_REGEX` 的文本（我爱你、喜欢你、嫁给我、love 等）触发 `generateLoveResponse()` — 一个专用提示词，基于用户记忆自由生成好感度评分条目并计算总分，再按人设做傲娇回应。

## LLM 工具

`generateAiTurn()` 函数向模型暴露以下工具：

| 工具                    | 说明                                                   |
| ----------------------- | ------------------------------------------------------ |
| `send_message`          | 向群聊发送消息——说话的唯一方式；可多次调用             |
| `dismiss`               | 选择不回复（二选一：说话/沉默）                        |
| `saveMemory`            | 记录关于群友的记忆（uid 必须来自最近群友列表）         |
| `setNickname`           | 设置/更新群友的昵称                                    |
| `deleteMemory`          | 删除关于群友的指定记忆                                 |
| `sendSticker`           | 通过 emoji 从硬编码贴纸表选择；无效 emoji 取消发送     |
| `describeTelegramMedia` | 按需解析媒体；主动路径只允许查看最新候选消息中的图片   |
| `fetchUrlContent`       | 按需抓取当前轮 URL 内容（仅被动触发）                  |
| `readVideo`             | 理解 YouTube 声画内容；Bilibili 字幕优先、元数据降级   |
| `writeDiary`            | 创建、更新、取代或撤回结构化日记观察                   |
| `webSearch`             | Tavily 搜索；schema 固定，runtime flood 禁用时返回原因 |
| `startSubagent`         | 一次性 URL/媒体/技术研究 helper，不能直接发群消息      |

如果本轮在模型生成前已经完成成功的搜索预取，这次预取就算已经搜索过；只有结果仍不足时，模型才需要再额外调用 `webSearch`。

所有记忆/昵称工具在写入 SQLite 前会验证 `uid` 是否在 `allowedUids`（最近对话缓冲区中出现的 UID 集合）中。

### 工具调用流程

```
用户消息 → classifyMessage() → generateAiTurn()
                                        │
                                        ├─ 模型调用 send_message → 文本添加到 messages[]
                                        ├─ 模型调用 dismiss → dismissed = true
                                        ├─ 模型调用 saveMemory → SQLite 写入
                                        ├─ 模型调用 setNickname → SQLite 写入
                                        ├─ 模型调用 deleteMemory → SQLite 删除
                                         ├─ 模型调用 sendSticker → 选择 file_id 分发
                                         ├─ 模型调用 describeTelegramMedia → 按需媒体描述
                                         ├─ 模型调用 fetchUrlContent → 按需 URL 摘要
                                         ├─ 模型调用 readVideo → YouTube/Bilibili 视频信息
                                         ├─ 模型调用 writeDiary → 修改结构化观察
                                         ├─ 模型调用 webSearch → Tavily 搜索执行
                                         ├─ 模型调用 startSubagent → 一次性研究摘要
                                        │
                                        ▼
                                 AiTurnResult
                                  ├─ { action: "send", messages, stickerFileId }
                                  └─ { action: "dismiss", rawText? }
```

### 沉默重试（仅触发路径）

当用户明确 @提及或回复 bot，但模型选择 `dismiss` 时：

1. simple/complex 最多重试 1 次并追加 `[系统提示：用户明确@了你或回复了你，你必须回复，不要选择沉默。]`；tech 不重试。
2. 如果仍然 `dismiss`：
   - 如果 `rawText` 存在 → 先尝试救成真实 `send_message`；成功时只发送救回的消息，不附贴纸。
   - 如果 rescue 失败 → 发送原始草稿 + 随机贴纸。
   - 如果 `rawText` 为空 → 只发送随机贴纸（带回复引用）。

主动插话路径不重试——沉默是合理的预期结果。

## 消息格式化

AI 文本和其他启用 Markdown 的回复路径在发送前通过 `formatForTelegramHtml()` 处理；固定命令回复和部分 caption 会直接发送。

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
