# 配置

## 环境变量

所有配置通过 `.env` 文件（已 gitignore）。模板在 `.env.example`。

| 变量                         | 必填 | 说明                                                                        |
| ---------------------------- | ---- | --------------------------------------------------------------------------- |
| `BOT_API_KEY`                | ✅   | Telegram Bot Token（来自 [@BotFather](https://t.me/BotFather)）             |
| `BOT_PERSONA_NAME`           | ❌   | 人设显示名（用于提示词/帮助文案，默认：`にゃる`）                           |
| `BOT_PERSONA_FULL_NAME`      | ❌   | 人设全名（默认：`晴海猫月`）                                                |
| `BOT_PERSONA_READING`        | ❌   | 人设读音标注（默认：`はるみ にゃる`）                                       |
| `TG_ADMIN_UID`               | ✅   | 管理员 ID，用于私聊状态/重置、日记观察管理和词云命令                        |
| `TG_GROUP_ID`                | ✅   | 目标群组 ID；其他聊天被忽略，但支持的管理员私聊命令除外                     |
| `QWEN_API_KEY`               | ✅   | 千问 AI 平台 API Key，用于主对话与多模态理解                                |
| `DEEPSEEK_API_KEY`           | ✅   | DeepSeek API key（[platform.deepseek.com](https://platform.deepseek.com)）  |
| `TAVILY_API_KEY`             | ✅   | Tavily API key，用于网页搜索和 URL 提取（[tavily.com](https://tavily.com)） |
| `CF_AIG_TOKEN`               | ✅   | Cloudflare AI Gateway token，用于 Gemini 调用                               |
| `CF_ACCOUNT_ID`              | ✅   | Cloudflare 账户 ID，用于 AI Gateway                                         |
| `BILIBILI_SESSDATA`          | ❌   | Bilibili 登录 Cookie，用于可靠获取字幕                                      |
| `BILIBILI_BILI_JCT`          | ❌   | Bilibili CSRF Cookie，需与其他 Bilibili 凭据一起配置                        |
| `BILIBILI_DEDEUSERID`        | ❌   | Bilibili 用户 ID Cookie，需与其他 Bilibili 凭据一起配置                     |
| `BOT_USERNAME`               | ✅   | Telegram bot 用户名（必填，用于 @提及匹配）                                 |
| `GITHUB_TOKEN`               | ❌   | GitHub PAT，用于推送日记到 Hexo 博客（格式 `ghp_...`）                      |
| `GITHUB_REPO`                | ❌   | GitHub 仓库名，格式 `owner/repo`（如 `yinyanfr/nyarbot-diary`）             |
| `TG_DIARY_CHANNEL_ID`        | ❌   | 完整日记推送频道 ID；有词云时会一并发送                                     |
| `DATABASE_PATH`              | ❌   | 统一 SQLite 数据库路径（默认：`data/nyarbot.sqlite`）                       |
| `DATABASE_BACKUP_PASSPHRASE` | ✅   | SQLite 备份加密口令，长度必须为 20–1024 字符                                |
| `DATABASE_BACKUP_SCHEDULE`   | ❌   | 基于 `APP_TIMEZONE` 的每日备份时间，24 小时 `HH:mm`（默认：`03:30`）        |
| `DATABASE_BACKUP_PATH`       | ❌   | 本地加密备份目录（默认：`data/backups`）                                    |
| `LOG_LEVEL`                  | ❌   | Pino 日志级别（默认：`info`）                                               |
| `PORT`                       | ❌   | 未使用（长轮询模式，无 webhook 服务器）                                     |

其他可选变量（带默认值）：

- `DEEPSEEK_BASE_URL`（`https://api.deepseek.com`）
- `QWEN_BASE_URL`（`https://dashscope.aliyuncs.com/compatible-mode/v1`）
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
- `WORDCLOUD_CHECK_INTERVAL_MS`（`60000`）

`DATABASE_BACKUP_PASSPHRASE` 是启动必填项。必须与数据库和加密归档分开保管；丢失口令后备份无法恢复。

## 统一 SQLite 存储

- 生产持久化由 `src/services/database.ts` 和 `src/services/persistence.ts` 实现，不初始化 Firebase Admin，也不访问 Firestore。
- `DATABASE_PATH` 默认是 `data/nyarbot.sqlite`，统一保存用户、记忆、日记、runtime events/turns/state/compactions 和词云表。
- 词云流水线使用同一个数据库。
- 生成的 PNG 保存在 SQLite 同目录的 `wordcloud-artifacts/`。
- `WORDCLOUD_CHECK_INTERVAL_MS` 同时驱动中午、晚间和跨天发布检查，不只是午夜生成。
- 只保留最近 10 天消息。
- 仅统计活人；bot 自身和其他 bot 都会被排除。
- 命令消息不会进入词云；如果普通消息后来被编辑成命令，会从本地词云库删除。
- 编辑消息按相同 `message_id` 覆盖，词云始终使用最终文本。
- 转发消息会计入活跃榜和预览 `messageCount`，但不会进入词云正文。
- 同一条消息里重复出现的同一个词只计 1 次。
- 词云渲染内置完整 Source Han Sans 可变字体，支持简中、繁中、日文、韩文。

## 备份与 Firebase 维护

默认情况下，bot 每天在 `APP_TIMEZONE` 的 03:30 创建在线 SQLite 快照，使用 `DATABASE_BACKUP_PASSPHRASE` 压缩加密，保存到 `DATABASE_BACKUP_PATH`，并发送给 `TG_ADMIN_UID`。本地文件名形如 `nyarbot-20260812T193000Z.sqlite.gz.enc`，保留最新七份。上传失败会通过管理员私聊报告，并在 15 分钟后重试。

生产环境不依赖 Firebase，也不挂载运行时凭据。已 gitignore 的 `src/services/serviceAccountKey.json` 只在切换前由独立的 `tools/firestore-to-sqlite` 维护工具使用。一次性命令、检查、回滚与恢复流程见[数据库迁移与备份维护](database-maintenance.zh-CN.md)。

## 对话模型

`qwen3.7-flash` 负责所有对话 tier、分类、主动探测、压缩、记忆整理和 Telegram/推文视觉理解，并显式发送 `enable_thinking: false`。Telegram 图片与原消息文本在同一条 user message 中发送；包含 WebM 视频贴纸的轮次会先把动画循环转为三秒 MP4，再直接交给 Gemini 3.5 Flash-Lite，普通视频和 TGS 贴纸仍使用 Telegram 缩略图。

可选 `startSubagent` advisor 仅使用开启思考的 `deepseek-v4-flash`；项目不再使用 DeepSeek V4 Pro。Qwen 首次调用遇到网络、超时、认证、限流或 5xx 错误时可回退到 Gemini 3.5 Flash-Lite，工具调用开始后不跨 provider 切换。

## Cloudflare AI Gateway

Gemini 调用通过 Cloudflare AI Gateway 路由，以获得缓存和可观测性。网关名称可通过 `CF_AIG_GATEWAY` 配置（默认 `gem`）；账户 ID（`CF_ACCOUNT_ID`）和 API token（`CF_AIG_TOKEN`）必须在 `.env` 中设置。

- 通过原生 Google provider adapter 调用 `gemini-3.5-flash-lite`：用于 Qwen 不可用时的回复回退和完整日记导读；原生 adapter 会在多步工具调用中保留 Gemini thought signature。
- `google-ai-studio/gemini-3.1-pro-preview`：午夜日记生成和管理员 `/diary` 预览。

YouTube 视频理解同样通过 Cloudflare AI Gateway 调用 `gemini-3.5-flash-lite`。由于 gateway wrapper 不会声明原生 URL 支持，这一路径使用受限的 AI SDK URL passthrough，把公开 YouTube URL 保留为 Gemini `fileData`。Bot 不会直连 Google API，也不会下载视频；每次调用只读取一个视频。

Bilibili 读取支持 BV 链接、遗留的 `av+数字` 链接和 `b23.tv` 短链接。AV ID 会先通过 Bilibili 公开 view API 转换成 BV ID，再由锁定版本的本地 `@xzxzzx/bilibili-mcp` 子进程调用 `get_video_transcript` 和 `get_video_metadata`。不会暴露下载或账号写操作；字幕不可用时仅返回元数据。公开元数据通常不要求 Cookie，但可靠字幕读取一般需要完整登录凭据。

媒体描述只做当前进程会话缓存，不写入 SQLite。

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
