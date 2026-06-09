# 配置

## 环境变量

所有配置通过 `.env` 文件（已 gitignore）。模板在 `.env.example`。

| 变量                    | 必填 | 说明                                                                        |
| ----------------------- | ---- | --------------------------------------------------------------------------- |
| `BOT_API_KEY`           | ✅   | Telegram Bot Token（来自 [@BotFather](https://t.me/BotFather)）             |
| `BOT_PERSONA_NAME`      | ❌   | 人设显示名（用于提示词/帮助文案，默认：`にゃる`）                           |
| `BOT_PERSONA_FULL_NAME` | ❌   | 人设全名（默认：`晴海猫月`）                                                |
| `BOT_PERSONA_READING`   | ❌   | 人设读音标注（默认：`はるみ にゃる`）                                       |
| `TG_ADMIN_UID`          | ✅   | 你的 Telegram 用户 ID（用于 `/status` 和 `/reset` 权限控制）                |
| `TG_GROUP_ID`           | ✅   | 目标群组 ID — bot 忽略所有其他聊天/私聊的消息                               |
| `DEEPSEEK_API_KEY`      | ✅   | DeepSeek API key（[platform.deepseek.com](https://platform.deepseek.com)）  |
| `TAVILY_API_KEY`        | ✅   | Tavily API key，用于网页搜索和 URL 提取（[tavily.com](https://tavily.com)） |
| `CF_AIG_TOKEN`          | ✅   | Cloudflare AI Gateway token，用于 Gemini 图片识别调用                       |
| `CF_ACCOUNT_ID`         | ✅   | Cloudflare 账户 ID，用于 AI Gateway                                         |
| `BOT_USERNAME`          | ✅   | Telegram bot 用户名（必填，用于 @提及匹配）                                 |
| `GITHUB_TOKEN`          | ❌   | GitHub PAT，用于推送日记到 Hexo 博客（格式 `ghp_...`）                      |
| `GITHUB_REPO`           | ❌   | GitHub 仓库名，格式 `owner/repo`（如 `yinyanfr/nyarbot-diary`）             |
| `LOG_LEVEL`             | ❌   | Pino 日志级别（默认：`info`）                                               |
| `PORT`                  | ❌   | 未使用（长轮询模式，无 webhook 服务器）                                     |

其他可选变量（带默认值）：

- `DEEPSEEK_BASE_URL`（`https://api.deepseek.com`）
- `CF_AIG_GATEWAY`（`gem`）
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

## Firebase

1. 在 [console.firebase.google.com](https://console.firebase.google.com) 创建 Firebase 项目
2. 在项目中启用 **Cloud Firestore**
3. 生成**服务账号密钥** JSON 文件：项目设置 → 服务账号 → 生成新的私钥
4. 保存为 `src/services/serviceAccountKey.json`（已 gitignore）

使用的 Firestore 集合：

| 集合                   | 文档 ID          | 字段                                                                        |
| ---------------------- | ---------------- | --------------------------------------------------------------------------- |
| `users/{uid}`          | Telegram 用户 ID | `uid`、`nickname`、`memories[]`、`nightyTimestamp?`、`lastMorningGreet?`    |
| `images/{fileId}`      | Telegram file_id | `fileId`、`description`、`cachedAt`                                         |
| `diary/{date}`         | 日期 YYYY-MM-DD  | `date`、`entries[]`、`diary?`、`generatedAt?`                               |
| `runtime/group`        | 固定文档         | `summary`、`summaryCursorTs`、`lastProcessedMessageId?`、`lastCompactedAt?` |
| `events/{autoId}`      | 自动 ID          | append-only 群聊事件、bot 输出、忽略原因、URL/媒体引用                      |
| `turns/{autoId}`       | 自动 ID          | AI turn 的模型、工具调用、action、token/cache usage、latency、错误          |
| `compactions/{autoId}` | 自动 ID          | 工作记忆摘要快照与 cursor/token usage                                       |

## DeepSeek 模型

Bot 使用两个模型，各有两种思考模式变体：

| 模型                | 思考模式                               | 用途                                                         |
| ------------------- | -------------------------------------- | ------------------------------------------------------------ |
| `deepseek-v4-flash` | 禁用（`thinking: {type: "disabled"}`） | 分类、早安问候、告白好感度评分回应、探测门、URL/图片描述     |
| `deepseek-v4-flash` | 启用（`thinking: {type: "enabled"}`）  | 复杂对话（tier=`complex`），带 send_message/dismiss 工具调用 |
| `deepseek-v4-pro`   | 启用（`thinking: {type: "enabled"}`）  | 技术问题（tier=`tech`），带 send_message/dismiss 工具调用    |
| `deepseek-v4-pro`   | 启用（`thinking: {type: "enabled"}`）  | 日记生成（午夜汇总 / `/diary` 命令）                         |

思考模式通过自定义 `fetch` 包装器注入，在发送前修改请求体。Base URL 可通过 `DEEPSEEK_BASE_URL` 配置（默认 `https://api.deepseek.com`，无 `/v1` 后缀）。

## Cloudflare AI Gateway

Gemini 图片识别调用通过 Cloudflare AI Gateway 路由，以获得缓存和可观测性。网关名称可通过 `CF_AIG_GATEWAY` 配置（默认 `gem`）；账户 ID（`CF_ACCOUNT_ID`）和 API token（`CF_AIG_TOKEN`）必须在 `.env` 中设置。

使用的模型：`google-ai-studio/gemini-3-flash-preview` — 快速、便宜，且支持视觉输入。也用于 `describeTweetPhotos()` 中的批量推文配图描述。

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
| `webSearch`             | Tavily 搜索（仅在分类结果 `needsSearch=true` 时附带）     |
| `describeTelegramMedia` | 按需查看当前轮 Telegram 媒体；主动/限流场景会返回禁用原因 |
| `fetchUrlContent`       | 按需抓取当前轮 URL；无 URL 或限流时返回原因               |
| `startSubagent`         | 一次性 helper，用于 URL/媒体/技术检索，不能直接发群消息   |

工具 schema 尽量保持稳定以利于 KV cache。当 `needsSearch=true` 时，late-binding 会追加 mandatory search；如果模型未搜索却准备发送，会自动重试一次。

多步工具调用使用 `stopWhen: stepCountIs(5)` 允许最多 5 步（初始调用 + 4 轮工具调用）。
