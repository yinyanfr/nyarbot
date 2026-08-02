# 配置

## 环境变量

所有配置通过 `.env` 文件（已 gitignore）。模板在 `.env.example`。

| 变量                    | 必填 | 说明                                                                        |
| ----------------------- | ---- | --------------------------------------------------------------------------- |
| `BOT_API_KEY`           | ✅   | Telegram Bot Token（来自 [@BotFather](https://t.me/BotFather)）             |
| `BOT_PERSONA_NAME`      | ❌   | 人设显示名（用于提示词/帮助文案，默认：`にゃる`）                           |
| `BOT_PERSONA_FULL_NAME` | ❌   | 人设全名（默认：`晴海猫月`）                                                |
| `BOT_PERSONA_READING`   | ❌   | 人设读音标注（默认：`はるみ にゃる`）                                       |
| `TG_ADMIN_UID`          | ✅   | 管理员 ID，用于私聊状态/重置、日记观察管理和词云命令                        |
| `TG_GROUP_ID`           | ✅   | 目标群组 ID；其他聊天被忽略，但支持的管理员私聊命令除外                     |
| `DEEPSEEK_API_KEY`      | ✅   | DeepSeek API key（[platform.deepseek.com](https://platform.deepseek.com)）  |
| `TAVILY_API_KEY`        | ✅   | Tavily API key，用于网页搜索和 URL 提取（[tavily.com](https://tavily.com)） |
| `CF_AIG_TOKEN`          | ✅   | Cloudflare AI Gateway token，用于 Gemini 调用                               |
| `CF_ACCOUNT_ID`         | ✅   | Cloudflare 账户 ID，用于 AI Gateway                                         |
| `BILIBILI_SESSDATA`     | ❌   | Bilibili 登录 Cookie，用于可靠获取字幕                                      |
| `BILIBILI_BILI_JCT`     | ❌   | Bilibili CSRF Cookie，需与其他 Bilibili 凭据一起配置                        |
| `BILIBILI_DEDEUSERID`   | ❌   | Bilibili 用户 ID Cookie，需与其他 Bilibili 凭据一起配置                     |
| `BOT_USERNAME`          | ✅   | Telegram bot 用户名（必填，用于 @提及匹配）                                 |
| `GITHUB_TOKEN`          | ❌   | GitHub PAT，用于推送日记到 Hexo 博客（格式 `ghp_...`）                      |
| `GITHUB_REPO`           | ❌   | GitHub 仓库名，格式 `owner/repo`（如 `yinyanfr/nyarbot-diary`）             |
| `TG_DIARY_CHANNEL_ID`   | ❌   | 完整日记推送频道 ID；有词云时会一并发送                                     |
| `LOG_LEVEL`             | ❌   | Pino 日志级别（默认：`info`）                                               |
| `PORT`                  | ❌   | 未使用（长轮询模式，无 webhook 服务器）                                     |

其他可选变量（带默认值）：

- `DEEPSEEK_BASE_URL`（`https://api.deepseek.com`）
- `CF_AIG_GATEWAY`（`gem`）
- `BILIBILI_REQUEST_TIMEOUT_MS`（`10000`）、`BILIBILI_RATE_LIMIT_MS`（`500`）、
  `BILIBILI_CACHE_SIZE`（`100`）
- `VIDEO_READ_TIMEOUT_MS`（`120000`）、`VIDEO_TRANSCRIPT_MAX_CHARS`（`20000`）
- `GITHUB_API_BASE`（`https://api.github.com`）
- `GITHUB_API_VERSION`（`2022-11-28`）
- `APP_TIMEZONE`（`Asia/Shanghai`，启动时会校验 IANA 时区，非法值直接报错）
- `LOG_APP_NAME`、`ADMIN_DM_MIN_INTERVAL_MS`
- `CONVERSATION_BUFFER_PATH`、`BUFFER_SAVE_INTERVAL_MS`
- `BOT_MESSAGE_DELAY_MS`
- Runtime/debounce/abuse/compaction：
  `RUNTIME_INITIAL_DELAY_MS`（默认 5000）、
  `RUNTIME_TYPING_EXTEND_MS`（5000）、
  `RUNTIME_MAX_DELAY_MS`（30000）、
  `RUNTIME_QUIET_WINDOW_MS`（30000）、
  `RUNTIME_HOT_CHAT_THRESHOLD`（10）、
  `RUNTIME_QUIET_DURATION_MS`（180000）、
  `RUNTIME_USER_BURST_THRESHOLD`（8）、
  `RUNTIME_USER_COOLDOWN_MS`（60000）、
  `RUNTIME_URL_FLOOD_THRESHOLD`（3）、
  `RUNTIME_MEDIA_FLOOD_THRESHOLD`（5）、
  `RUNTIME_MEDIA_FLOOD_COOLDOWN_MS`（300000）、
  `RUNTIME_MAX_CONTEXT_EST_TOKENS`（12000）、
  `RUNTIME_WORKING_WINDOW_EST_TOKENS`（4000）、
  `RUNTIME_MAX_RECENT_EVENTS`（120）、
  `RUNTIME_RETAIN_RECENT_EVENTS`（40）
- `PROACTIVE_CHECK_INTERVAL_MS`、`PROACTIVE_WINDOW_MS`、`PROACTIVE_MESSAGE_DELAY_MS`、
  `PROACTIVE_MAX_FAILURES`、`PROACTIVE_COOLDOWN_HIGH_MS`、
  `PROACTIVE_COOLDOWN_MEDIUM_MS`、`PROACTIVE_COOLDOWN_LOW_MS`
- `DIARY_CHECK_INTERVAL_MS`
- `WORDCLOUD_DB_PATH`（`data/wordcloud.sqlite`）
- `WORDCLOUD_CHECK_INTERVAL_MS`（`60000`）

当前 `.env.example` 未列出词云变量；它们仍是可选项，并使用上述默认值。

## 本地词云存储

- 词云使用本地 SQLite，不上传 Firestore。
- 默认数据库路径由 `WORDCLOUD_DB_PATH` 控制，默认 `data/wordcloud.sqlite`。
- 生成的 PNG 保存在 SQLite 同目录的 `wordcloud-artifacts/`。
- `WORDCLOUD_CHECK_INTERVAL_MS` 同时驱动中午、晚间和跨天发布检查，不只是午夜生成。
- 只保留最近 10 天消息。
- 仅统计活人；bot 自身和其他 bot 都会被排除。
- 命令消息不会进入词云；如果普通消息后来被编辑成命令，会从本地词云库删除。
- 编辑消息按相同 `message_id` 覆盖，词云始终使用最终文本。
- 转发消息会计入活跃榜和预览 `messageCount`，但不会进入词云正文。
- 同一条消息里重复出现的同一个词只计 1 次。
- 词云渲染内置完整 Source Han Sans 可变字体，支持简中、繁中、日文、韩文。

## Firebase

1. 在 [console.firebase.google.com](https://console.firebase.google.com) 创建 Firebase 项目
2. 在项目中启用 **Cloud Firestore**
3. 生成**服务账号密钥** JSON 文件：项目设置 → 服务账号 → 生成新的私钥
4. 保存为 `src/services/serviceAccountKey.json`（已 gitignore）

使用的 Firestore 集合：

| 集合                     | 文档 ID          | 字段                                                                        |
| ------------------------ | ---------------- | --------------------------------------------------------------------------- |
| `users/{uid}`            | Telegram 用户 ID | `uid`、`nickname`、`memories[]`、`nightyTimestamp?`、`lastMorningGreet?`    |
| `diary/{date}`           | 日期 YYYY-MM-DD  | 旧 `entries[]`、`diary?`、`generatedAt?`、`generationRecords[]`             |
| `diaryObservations/{id}` | 观察 ID          | 结构化事件/反应、subject identity、confidence/status                        |
| `runtime/group`          | 固定文档         | `summary`、`summaryCursorTs`、`lastProcessedMessageId?`、`lastCompactedAt?` |
| `events/{autoId}`        | 自动 ID          | append-only 群聊事件、bot 输出、忽略原因、URL/媒体引用                      |
| `turns/{autoId}`         | 自动 ID          | AI turn 的模型、工具调用、action、token/cache usage、latency、错误          |
| `compactions/{autoId}`   | 自动 ID          | 工作记忆摘要快照与 cursor/token usage                                       |

## DeepSeek 模型

Bot 使用两个 DeepSeek model ID，共配置三种变体：

| 模型                | 思考模式                               | 用途                                                         |
| ------------------- | -------------------------------------- | ------------------------------------------------------------ |
| `deepseek-v4-flash` | 禁用（`thinking: {type: "disabled"}`） | 分类、早安问候、告白/互动反应、主动探测                      |
| `deepseek-v4-flash` | 启用（`thinking: {type: "enabled"}`）  | 复杂对话（tier=`complex`），带 send_message/dismiss 工具调用 |
| `deepseek-v4-pro`   | 启用（`thinking: {type: "enabled"}`）  | 技术问题（tier=`tech`），带 send_message/dismiss 工具调用    |

思考模式通过自定义 `fetch` 包装器注入，在发送前修改请求体。Base URL 可通过 `DEEPSEEK_BASE_URL` 配置（默认 `https://api.deepseek.com`，无 `/v1` 后缀）。

面向回复的 DeepSeek 快速路径预留 12 秒，思考路径预留 45 秒。网络/超时、401–403、408/409/429 和 5xx 会在 DeepSeek 尚未调用工具时把整轮回复切换到 Gemini 3.5 Flash-Lite，后续 step 继续使用 Gemini。分类、subagent、URL 抽取、compaction 和后台记忆压缩仍只使用 DeepSeek。

## Cloudflare AI Gateway

Gemini 调用通过 Cloudflare AI Gateway 路由，以获得缓存和可观测性。网关名称可通过 `CF_AIG_GATEWAY` 配置（默认 `gem`）；账户 ID（`CF_ACCOUNT_ID`）和 API token（`CF_AIG_TOKEN`）必须在 `.env` 中设置。

- 通过原生 Google provider adapter 调用 `gemini-3.5-flash-lite`：用于 DeepSeek 不可用时的回复回退、Telegram/推文图片理解和完整日记导读；原生 adapter 会在多步工具调用中保留 Gemini thought signature。
- `google-ai-studio/gemini-3.1-pro-preview`：午夜日记生成和管理员 `/diary` 预览。

YouTube 视频理解同样通过 Cloudflare AI Gateway 调用 `gemini-3.5-flash-lite`。由于 gateway wrapper 不会声明原生 URL 支持，这一路径使用受限的 AI SDK URL passthrough，把公开 YouTube URL 保留为 Gemini `fileData`。Bot 不会直连 Google API，也不会下载视频；每次调用只读取一个视频。

Bilibili 读取支持 BV 链接、遗留的 `av+数字` 链接和 `b23.tv` 短链接。AV ID 会先通过 Bilibili 公开 view API 转换成 BV ID，再由锁定版本的本地 `@xzxzzx/bilibili-mcp` 子进程调用 `get_video_transcript` 和 `get_video_metadata`。不会暴露下载或账号写操作；字幕不可用时仅返回元数据。公开元数据通常不要求 Cookie，但可靠字幕读取一般需要完整登录凭据。

媒体描述只做当前进程会话缓存，不再使用 Firestore `images` 运行时缓存。

## 工具调用架构

Bot 使用 `generateText()`（非流式）向模型暴露以下工具：

| 工具                    | 用途                                                      |
| ----------------------- | --------------------------------------------------------- |
| `send_message`          | 向群聊发送消息——说话的唯一方式                            |
| `dismiss`               | 选择不回复（二选一：说话/沉默）                           |
| `saveMemory`            | 记录关于群友的记忆（uid 已验证）                          |
| `setNickname`           | 设置/更新群友的昵称                                       |
| `deleteMemory`          | 删除关于群友的指定记忆                                    |
| `sendSticker`           | 通过 emoji 从硬编码贴纸表选择；无效 emoji 取消发送        |
| `writeDiary`            | 记录关于当前对话的观察笔记                                |
| `webSearch`             | Tavily 搜索；schema 固定，runtime flood 禁用时返回原因    |
| `describeTelegramMedia` | 按需查看当前轮 Telegram 媒体；主动/限流场景会返回禁用原因 |
| `fetchUrlContent`       | 按需抓取当前轮 URL；无 URL 或限流时返回原因               |
| `readVideo`             | 原生 Gemini 读取 YouTube；Bilibili 字幕优先、元数据降级   |
| `startSubagent`         | 一次性 helper，用于 URL/媒体/技术检索，不能直接发群消息   |

工具 schema 尽量保持稳定以利于 KV cache。当 `needsSearch=true` 时，late-binding 会追加 mandatory search；如果模型未搜索却准备发送，会自动重试一次。

多步工具调用使用 `stopWhen: stepCountIs(5)` 允许最多 5 步（初始调用 + 4 轮工具调用）。
