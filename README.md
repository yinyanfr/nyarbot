# nyarbot

> [English README](README.en.md)

一只住在 Telegram 群聊里的傲娇高中生猫娘 AI。

[![Release](https://img.shields.io/badge/release-1.0.0-8b5cf6?style=flat-square)](CHANGELOG.md)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-3c873a?style=flat-square&logo=nodedotjs&logoColor=white)](package.json)
[![TypeScript](https://img.shields.io/badge/typescript-ESM-3178c6?style=flat-square&logo=typescript&logoColor=white)](tsconfig.json)
[![Telegram](https://img.shields.io/badge/telegram-bot-26a5e4?style=flat-square&logo=telegram&logoColor=white)](https://core.telegram.org/bots/api)
[![AI SDK](https://img.shields.io/badge/AI%20SDK-v6-black?style=flat-square&logo=vercel&logoColor=white)](https://sdk.vercel.ai)
[![License](https://img.shields.io/badge/license-ISC-0f172a?style=flat-square)](package.json)

基于 [grammy](https://grammy.dev) 和 [Vercel AI SDK](https://sdk.vercel.ai) 构建，LLM 接入 DeepSeek，视觉理解走 Gemini（经 Cloudflare AI Gateway），持久化使用 Firestore。它不是一个“问答机器人”，而是一个真正有群聊人格、会主动参与、会记人、会写日记的长期群友。

## Overview

- **像群友，不像客服**：默认是自然聊天 bot，不是命令行助手套壳
- **工具调用驱动**：回复、沉默、贴纸、联网、看图、写日记都走显式 tool-call 架构
- **长期上下文**：支持昵称、记忆、对话缓冲、主动插话、日记归档
- **本地路由提速**：短聊、技术题、详细解释、当前事实查询会先走本地判断，再按需升级到 advisor / 分类模型
- **发布链路完整**：午夜自动生成日记与昨日词云，日记可推送到博客与 Telegram 频道
- **安全性有专门收口**：对 prompt injection、外部内容回流、memory 污染做了专门防护

## Highlights

| 能力           | 说明                                                                        |
| -------------- | --------------------------------------------------------------------------- |
| 自然聊天       | `@` 她或回复她就能触发对话，支持傲娇猫娘风格、短消息节奏、贴纸收尾          |
| 严肃模式       | 编程 / 数学 / 技术问题会自动降低人设强度，直接进入认真回答                  |
| 联网与外部内容 | 涉及时效性内容时强制 `webSearch`，链接和媒体只在必要时按需抓取              |
| 主动插话       | 两阶段探测，先便宜模型判断是否值得接话，再决定是否调用完整生成              |
| 记忆系统       | 支持昵称、用户记忆、好感度告白回应、早安 / 晚安链路                         |
| 日记系统       | 自动记录观察，跨天生成日记，支持 GitHub / Hexo 发布与 Telegram channel 推送 |
| 词云系统       | 本地保存最近 10 天群消息，跨天生成昨日彩色正方形词云并附活跃榜              |

## Features

- 💬 **自然聊天**：@ 她或回复她即可触发；有“喵”“哼”“笨蛋”式傲娇口吻，也会根据场景收敛
- 🧠 **严肃模式**：遇到编程、学术、技术分析类问题会优先给清晰答案
- 🔍 **联网搜索**：涉及时事、实时事实、最新 API 时强制联网，不靠过期记忆瞎猜
- 🔗 **链接理解（按需）**：只有在被动触发且确实需要时，才抓取 URL 内容；推文支持图片说明
- 🖼️ **媒体理解（按需）**：图片、GIF、视频封面、贴纸、文件缩略图可按需解析
- 🌅 **早安问候**：`/nighty` 后 8 小时以上，下次发言会收到个性化早安
- 💔 **告白回应**：`/love` 或告白文本触发记忆驱动的好感度评分与傲娇回应
- ⚡ **被电反应**：`/shock` 支持强度与附带文本，模拟不同程度的炸毛反应
- 🏷️ **昵称与记忆**：支持“叫我 XX”“记住 XXX”这类自然语言记忆更新
- 📔 **日记系统**：群聊观察会沉淀成每日猫娘日记，可自动发布
- ☁️ **词云系统**：昨日聊天会生成一张本地词云图，并在群里附上活跃群友前五名；词云使用内置思源黑体完整 CJK 字体，支持中日韩混排
- 🎨 **贴纸回复**：贴纸按 emoji 硬编码路由，可单独发送或作为结束动作
- 🔄 **沉默重试**：被明确触发时若模型想沉默，会重试并附加强制回复提示

## Tech Stack

| 层                  | 库                                                 |
| ------------------- | -------------------------------------------------- |
| Telegram Bot        | `grammy` v1                                        |
| AI / LLM            | `ai` (Vercel AI SDK v6) + DeepSeek v4              |
| Vision              | Gemini 2.5 Flash via Cloudflare AI Gateway         |
| Search / Extraction | `@tavily/ai-sdk`                                   |
| Database            | `firebase-admin` (Firestore)                       |
| Local Storage       | `better-sqlite3` + `nodejieba` + `@napi-rs/canvas` |
| Runtime             | Node.js + TypeScript ESM                           |
| Timezone            | `dayjs` (`Asia/Shanghai`)                          |

## Project Layout

```text
src/
├── app.ts                      # 入口：初始化 bot / Firebase / diary / wordcloud / proactive / logging
├── configs/
│   └── env.ts                  # 环境变量读取与校验
├── handlers/
│   ├── index.ts                # 主消息处理器
│   ├── context.ts              # BotContext / RequestState
│   ├── constants.ts            # 常量
│   ├── match-command.ts        # 命令匹配
│   ├── extract-content.ts      # URL / 媒体提取
│   ├── reply-and-track.ts      # 回复并写入上下文
│   └── update-dedup.ts         # 更新去重
├── libs/
│   ├── ai.ts                   # 分类、生成、工具定义、媒体/链接读取
│   ├── system-prompt.ts        # system prompt / probe prompt / session context
│   ├── prompt-safety.ts        # prompt injection 防护与不可信数据净化
│   ├── conversation-buffer.ts  # 对话缓冲区
│   ├── proactive.ts            # 主动插话调度
│   ├── diary.ts                # 日记生成与发布链路
│   ├── wordcloud.ts            # 词云生成、渲染与发布
│   ├── format-telegram.ts      # Markdown → Telegram HTML
│   ├── stickers.ts             # emoji → file_id 贴纸路由
│   ├── telegram-image.ts       # Telegram 文件下载
│   ├── logger.ts               # pino + admin DM 通知
│   └── time.ts                 # 时区工具
├── services/
│   ├── firestore.ts            # Firestore CRUD
│   ├── local-wordcloud-store.ts # 本地 sqlite 消息存储与活跃榜统计
│   ├── github.ts               # Hexo diary 推送
│   ├── index.ts                # Firebase Admin 初始化
│   └── serviceAccountKey.json  # Firebase 凭证（gitignored）
└── global.d.ts                 # 共享类型
```

详见 [架构文档](docs/architecture.zh-CN.md)。

## Quick Start

```bash
# 1. 安装依赖
npm ci

# 2. 配置环境变量
cp .env.example .env

# 3. 放入 Firebase 服务账号密钥
# 将 serviceAccountKey.json 放到 src/services/ 下

# 4. 编译
npm run build

# 5. 运行
node dist/app.js
```

## Commands & Interactions

详见 [命令与交互文档](docs/commands-and-interactions.zh-CN.md)。

| 命令                | 说明                                     |
| ------------------- | ---------------------------------------- |
| `/help`             | 显示帮助                                 |
| `/love`             | 向 bot 告白，触发好感度评分与傲娇回应    |
| `/shock`            | 电 bot 一下，支持强度与附带文本          |
| `/stroke`           | 抚摸 bot 一下，支持强度与附带文本        |
| `/nighty`           | 晚安，8 小时后下次发言自动早安问候       |
| `/status`           | bot 运行状态（仅管理员）                 |
| `/reset`            | 清除对话历史缓冲区和运行摘要（仅管理员） |
| `/diary`            | 生成今日日记预览（仅管理员，私聊）       |
| `/wordcloud [date]` | 生成指定日期词云预览（仅管理员，私聊）   |

| 场景          | 触发方式                                           |
| ------------- | -------------------------------------------------- |
| 聊天          | `@nyarbot` 或回复她的消息                          |
| 告白          | 说「我喜欢你」「我们结婚吧」等（需 `@` 或回复）    |
| 设置昵称      | 跟她说「叫我 XX」                                  |
| 记录记忆      | 跟她说「记住 XXX」                                 |
| 分享链接      | 直接发链接（被动触发时按需抓取）                   |
| 发图片 / 贴纸 | 直接发送（被动触发时按需解析媒体）                 |
| 日记记录      | bot 在群聊中自动通过 `writeDiary` 工具记录观察笔记 |

## Configuration

详见 [配置文档](docs/configuration.zh-CN.md)。

| 变量                          | 必填 | 说明                                               |
| ----------------------------- | ---- | -------------------------------------------------- |
| `BOT_API_KEY`                 | ✅   | Telegram Bot Token                                 |
| `BOT_USERNAME`                | ✅   | Bot 用户名（必须与 Telegram 实际用户名一致）       |
| `TG_GROUP_ID`                 | ✅   | 目标群组 ID（bot 只在此群工作）                    |
| `TG_ADMIN_UID`                | ✅   | 管理员 Telegram 用户 ID                            |
| `DEEPSEEK_API_KEY`            | ✅   | DeepSeek API Key                                   |
| `TAVILY_API_KEY`              | ✅   | Tavily Search API Key                              |
| `CF_AIG_TOKEN`                | ✅   | Cloudflare AI Gateway Token                        |
| `CF_ACCOUNT_ID`               | ✅   | Cloudflare Account ID                              |
| `BOT_PERSONA_NAME`            | ❌   | 机器人对话名，默认 `にゃる`                        |
| `BOT_PERSONA_FULL_NAME`       | ❌   | 机器人全名，默认 `晴海猫月`                        |
| `BOT_PERSONA_READING`         | ❌   | 名字读音标注，默认 `はるみ にゃる`                 |
| `GITHUB_TOKEN`                | ❌   | GitHub PAT，用于推送日记到 Hexo 博客               |
| `GITHUB_REPO`                 | ❌   | GitHub 仓库名，格式 `owner/repo`                   |
| `TG_DIARY_CHANNEL_ID`         | ❌   | 自动日记全文推送频道 ID                            |
| `WORDCLOUD_DB_PATH`           | ❌   | 本地词云 sqlite 路径，默认 `data/wordcloud.sqlite` |
| `WORDCLOUD_CHECK_INTERVAL_MS` | ❌   | 词云跨天检查间隔，默认 `60000`                     |

## Wordcloud Notes

- 词云消息只保存在本地 SQLite，不上传 Firestore。
- 仅统计活人消息；bot 自身和其他 bot 不参与词云和活跃榜。
- 命令消息不会进入词云；如果一条普通消息后来被编辑成命令，会从本地词云库删除。
- 编辑消息按同一 `message_id` 覆盖，词云使用最终文本。
- 转发消息会计入活跃榜和 `messageCount`，但不会进入词云正文；预览 caption 会明确标注这一点。
- 同一条消息里同一个词无论出现多少次，只按 1 次计数。
- 词云渲染内置完整 Source Han Sans 可变字体，保证简中、繁中、日文、韩文都不会退化成方块字。
- 默认排版会优先把高频词压在中心骨架上，少量短中文词可竖排来补空隙；同时会过滤明显负面词与部分单字虚词（如 `的`、`和`、`把`、`被`、`吧`）。

## Development

详见 [开发文档](docs/development.zh-CN.md)。

```bash
npm run typecheck  # TypeScript 类型检查
npm run lint       # ESLint 检查
npm run format     # Prettier 格式化
npm run build      # 编译 src/ → dist/
```

保存时通过 Husky + lint-staged 自动运行 Prettier 和 ESLint。

## Documentation

- [架构文档](docs/architecture.zh-CN.md)
- [Prompt XML Schema](docs/prompt-xml-schema.md)
- [配置文档](docs/configuration.zh-CN.md)
- [命令与交互](docs/commands-and-interactions.zh-CN.md)
- [开发文档](docs/development.zh-CN.md)

English docs:

- [Architecture](docs/architecture.md)
- [Configuration](docs/configuration.md)
- [Commands & Interactions](docs/commands-and-interactions.md)
- [Development](docs/development.md)

## Release Notes

- 当前发布版本：[`1.0.0`](CHANGELOG.md)
- 最近更新重点：本地路由会优先识别短聊、技术题、详细解释和当前事实查询；`saveMemory` 语义放宽为“以后大概率还会用到的用户事实”，`writeDiary` 更偏向先收集候选再筛；搜索改为“预取成功即算已搜过”；被 dismiss 后的 raw draft 会尽量通过真实 `send_message` rescue 出站；`/stroke` 已加入；`memoryCandidateHints` 也收紧了；本地 sqlite 词云流水线也已补齐重启补发、转发消息过滤、内置 CJK 字体、中心骨架式排版与虚词过滤

## Disclaimer

这是个人项目。bot 的行为、人设、尺度和群规适配都偏强定制；如果你选择运行或互动，请自行甄别。
