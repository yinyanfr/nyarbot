# 配置

## 环境变量

所有配置通过 `.env` 文件（已 gitignore）。模板在 `.env.example`。

| 变量               | 必填 | 说明                                          |
| ------------------ | ---- | --------------------------------------------- |
| `BOT_API_KEY`      | ✅   | Telegram Bot Token（来自 [@BotFather](https://t.me/BotFather)） |
| `TG_ADMIN_UID`     | ✅   | 你的 Telegram 用户 ID（用于 `/status` 和 `/reset` 权限控制） |
| `TG_GROUP_ID`      | ✅   | 目标群组 ID — bot 忽略所有其他聊天/私聊的消息 |
| `DEEPSEEK_API_KEY` | ✅   | DeepSeek API key（[platform.deepseek.com](https://platform.deepseek.com)） |
| `TAVILY_API_KEY`   | ✅   | Tavily API key，用于网页搜索和 URL 提取（[tavily.com](https://tavily.com)） |
| `CF_AIG_TOKEN`     | ✅   | Cloudflare AI Gateway token，用于 Gemini 图片识别调用 |
| `BOT_USERNAME`     | ❌   | Bot 用户名（默认：`nyarbot`）                 |
| `LOG_LEVEL`        | ❌   | Pino 日志级别（默认：`info`）                  |
| `PORT`             | ❌   | 未使用（长轮询模式，无 webhook 服务器）         |

## Firebase

1. 在 [console.firebase.google.com](https://console.firebase.google.com) 创建 Firebase 项目
2. 在项目中启用 **Cloud Firestore**
3. 生成**服务账号密钥** JSON 文件：项目设置 → 服务账号 → 生成新的私钥
4. 保存为 `src/services/serviceAccountKey.json`（已 gitignore）

使用的 Firestore 集合：

| 集合 | 文档 ID | 字段 |
| --- | --- | --- |
| `users/{uid}` | Telegram 用户 ID | `uid`、`nickname`、`memories[]`、`nightyTimestamp?`、`lastMorningGreet?` |
| `images/{fileId}` | Telegram file_id | `fileId`、`description`、`cachedAt` |

## DeepSeek 模型

Bot 使用两个模型，各有两种思考模式变体：

| 模型 | 思考模式 | 用途 |
| --- | --- | --- |
| `deepseek-v4-flash` | 禁用（`thinking: {type: "disabled"}`） | 分类、早安问候、好人卡、主动插话检查、URL/图片描述 |
| `deepseek-v4-flash` | 启用（`thinking: {type: "enabled"}`） | 复杂对话（tier=`complex`）带工具调用 |
| `deepseek-v4-pro` | 启用（`thinking: {type: "enabled"}`） | 技术问题（tier=`tech`） |

思考模式通过自定义 `fetch` 包装器注入，在发送前修改请求体。Base URL 为 `https://api.deepseek.com`（无 `/v1` 后缀）。

## Cloudflare AI Gateway

Gemini 图片识别调用通过 Cloudflare AI Gateway 路由，以获得缓存和可观测性。网关 ID `gem` 和账户 ID 硬编码在 `ai.ts` 中。API token（`CF_AIG_TOKEN`）必须在 `.env` 中设置。

使用的模型：`google-ai-studio/gemini-2.5-flash` — 快速、便宜，且支持视觉输入。