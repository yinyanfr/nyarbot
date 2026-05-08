# 配置

## 环境变量

所有配置通过 `.env` 文件（已 gitignore）。模板在 `.env.example`。

| 变量               | 必填 | 说明                                                                        |
| ------------------ | ---- | --------------------------------------------------------------------------- |
| `BOT_API_KEY`      | ✅   | Telegram Bot Token（来自 [@BotFather](https://t.me/BotFather)）             |
| `TG_ADMIN_UID`     | ✅   | 你的 Telegram 用户 ID（用于 `/status` 和 `/reset` 权限控制）                |
| `TG_GROUP_ID`      | ✅   | 目标群组 ID — bot 忽略所有其他聊天/私聊的消息                               |
| `DEEPSEEK_API_KEY` | ✅   | DeepSeek API key（[platform.deepseek.com](https://platform.deepseek.com)）  |
| `TAVILY_API_KEY`   | ✅   | Tavily API key，用于网页搜索和 URL 提取（[tavily.com](https://tavily.com)） |
| `CF_AIG_TOKEN`     | ✅   | Cloudflare AI Gateway token，用于 Gemini 图片识别调用                       |
| `BOT_USERNAME`     | ❌   | Bot 用户名（默认：`nyarbot`）                                               |
| `LOG_LEVEL`        | ❌   | Pino 日志级别（默认：`info`）                                               |
| `PORT`             | ❌   | 未使用（长轮询模式，无 webhook 服务器）                                     |

## Firebase

1. 在 [console.firebase.google.com](https://console.firebase.google.com) 创建 Firebase 项目
2. 在项目中启用 **Cloud Firestore**
3. 生成**服务账号密钥** JSON 文件：项目设置 → 服务账号 → 生成新的私钥
4. 保存为 `src/services/serviceAccountKey.json`（已 gitignore）

使用的 Firestore 集合：

| 集合              | 文档 ID          | 字段                                                                     |
| ----------------- | ---------------- | ------------------------------------------------------------------------ |
| `users/{uid}`     | Telegram 用户 ID | `uid`、`nickname`、`memories[]`、`nightyTimestamp?`、`lastMorningGreet?` |
| `images/{fileId}` | Telegram file_id | `fileId`、`description`、`cachedAt`                                      |

## DeepSeek 模型

Bot 使用两个模型，各有两种思考模式变体：

| 模型                | 思考模式                               | 用途                                                         |
| ------------------- | -------------------------------------- | ------------------------------------------------------------ |
| `deepseek-v4-flash` | 禁用（`thinking: {type: "disabled"}`） | 分类、早安问候、好人卡、探测门、URL/图片描述                 |
| `deepseek-v4-flash` | 启用（`thinking: {type: "enabled"}`）  | 复杂对话（tier=`complex`），带 send_message/dismiss 工具调用 |
| `deepseek-v4-pro`   | 启用（`thinking: {type: "enabled"}`）  | 技术问题（tier=`tech`），带 send_message/dismiss 工具调用    |

思考模式通过自定义 `fetch` 包装器注入，在发送前修改请求体。Base URL 为 `https://api.deepseek.com`（无 `/v1` 后缀）。

## Cloudflare AI Gateway

Gemini 图片识别调用通过 Cloudflare AI Gateway 路由，以获得缓存和可观测性。网关 ID `gem` 和账户 ID 硬编码在 `ai.ts` 中。API token（`CF_AIG_TOKEN`）必须在 `.env` 中设置。

使用的模型：`google-ai-studio/gemini-2.5-flash` — 快速、便宜，且支持视觉输入。

## 工具调用架构

Bot 使用 `generateText()`（非流式）向模型暴露以下工具：

| 工具           | 用途                                                  |
| -------------- | ----------------------------------------------------- |
| `send_message` | 向群聊发送消息——说话的唯一方式                        |
| `dismiss`      | 选择不回复（二选一：说话/沉默）                       |
| `saveMemory`   | 记录关于群友的记忆（uid 已验证）                      |
| `setNickname`  | 设置/更新群友的昵称                                   |
| `deleteMemory` | 删除关于群友的指定记忆                                |
| `sendSticker`  | 选择妙哈哈贴纸 emoji 发送（可单独发送或随文字）       |
| `webSearch`    | Tavily 搜索（仅在分类结果 `needsSearch=true` 时附带） |

当 `needsSearch=true` 时，追加一条强制指令确保模型在回答前调用 `webSearch`。

多步工具调用使用 `stopWhen: stepCountIs(5)` 允许最多 5 步（初始调用 + 4 轮工具调用）。
