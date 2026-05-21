# nyarbot

> [中文 README](README.md)

A tsundere high-school catgirl AI that lives inside your Telegram group chat.

[![Release](https://img.shields.io/badge/release-1.0.0-8b5cf6?style=flat-square)](CHANGELOG.md)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-3c873a?style=flat-square&logo=nodedotjs&logoColor=white)](package.json)
[![TypeScript](https://img.shields.io/badge/typescript-ESM-3178c6?style=flat-square&logo=typescript&logoColor=white)](tsconfig.json)
[![Telegram](https://img.shields.io/badge/telegram-bot-26a5e4?style=flat-square&logo=telegram&logoColor=white)](https://core.telegram.org/bots/api)
[![AI SDK](https://img.shields.io/badge/AI%20SDK-v6-black?style=flat-square&logo=vercel&logoColor=white)](https://sdk.vercel.ai)
[![License](https://img.shields.io/badge/license-ISC-0f172a?style=flat-square)](package.json)

Built with [grammy](https://grammy.dev) and [Vercel AI SDK](https://sdk.vercel.ai), backed by DeepSeek for language, Gemini for vision (via Cloudflare AI Gateway), and Firestore for persistence. This is not a generic Q&A bot with a persona sticker on top. It is designed as a long-lived group participant with memory, proactive timing, tool-calling, and diary publishing.

## Overview

- **Feels like a group member**: conversation-first behavior instead of command-only automation
- **Tool-call architecture**: speaking, dismissing, stickers, search, media inspection, and diary writing are all explicit tools
- **Long-lived context**: nicknames, memories, rolling chat history, proactive replies, and daily diary generation
- **Publishing pipeline**: midnight diary generation can publish to Hexo/GitHub and Telegram channels
- **Security-conscious prompt design**: dedicated guardrails for prompt injection, memory poisoning, and external-content replay

## Highlights

| Capability         | Description                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| Natural group chat | Triggered by mention/reply, optimized for short-form chat rhythm rather than essay-style responses |
| Serious mode       | Programming, math, and technical questions automatically suppress the stronger persona layer       |
| On-demand tools    | Media and URL tools are only used when actually needed, not eagerly preprocessed                   |
| Proactive chatter  | Cheap probe first, full generation only when the topic is worth joining                            |
| Memory system      | Nicknames, user memories, affection scoring, and morning/night routines                            |
| Diary system       | Observations become a daily catgirl diary, ready for blog/channel distribution                     |

## Features

- 💬 **Natural Chat**: mention or reply to the bot to start a conversation; default tone is tsundere catgirl, but it can dial that down when needed
- 🧠 **Serious Mode**: handles programming, math, academic, and technical topics in a more direct, less roleplay-heavy style
- 🔍 **Web Search**: forces `webSearch` for current events, real-time facts, and fast-moving APIs
- 🔗 **URL Understanding (On Demand)**: fetches link content only when needed; tweet links include optional image-aware context
- 🖼️ **Media Understanding (On Demand)**: images, GIFs, video covers, stickers, and file thumbnails can be inspected when relevant
- 🌅 **Morning Greetings**: `/nighty` schedules a personalized morning greeting on the next message after 8+ hours
- 💔 **Affection Scoring**: `/love` and confession-style messages trigger memory-based scoring and a persona-consistent response
- ⚡ **Shock Reactions**: `/shock` supports intensity and optional extra text for different frazzled reactions
- 🏷️ **Nicknames & Memory**: users can naturally teach the bot how to address them or what to remember
- 📔 **Diary System**: observations are recorded during chat and turned into a daily diary entry
- 🎨 **Sticker Replies**: emoji-routed hardcoded sticker responses, optionally alongside text
- 🔄 **Dismiss Retry**: if the model chooses silence after an explicit trigger, the bot retries with stronger reply hints

## Tech Stack

| Layer               | Library                                    |
| ------------------- | ------------------------------------------ |
| Telegram Bot        | `grammy` v1                                |
| AI / LLM            | `ai` (Vercel AI SDK v6) + DeepSeek v4      |
| Vision              | Gemini 2.5 Flash via Cloudflare AI Gateway |
| Search / Extraction | `@tavily/ai-sdk`                           |
| Database            | `firebase-admin` (Firestore)               |
| Runtime             | Node.js + TypeScript ESM                   |
| Timezone            | `dayjs` (`Asia/Shanghai`)                  |

## Project Layout

```text
src/
├── app.ts                      # Bootstraps bot, Firebase, diary, proactive loop, logging
├── configs/
│   └── env.ts                  # Environment loading and validation
├── handlers/
│   ├── index.ts                # Main message handler
│   ├── context.ts              # BotContext / RequestState
│   ├── constants.ts            # Shared constants
│   ├── match-command.ts        # Command matching
│   ├── extract-content.ts      # URL / media extraction
│   ├── reply-and-track.ts      # Reply + context writeback
│   └── update-dedup.ts         # Update deduplication
├── libs/
│   ├── ai.ts                   # Classification, generation, tools, media/link readers
│   ├── system-prompt.ts        # System prompt, probe prompt, session context blocks
│   ├── prompt-safety.ts        # Prompt injection hardening and untrusted-data normalization
│   ├── conversation-buffer.ts  # Rolling chat history buffer
│   ├── proactive.ts            # Proactive scheduling and dispatch
│   ├── diary.ts                # Diary generation and publishing
│   ├── format-telegram.ts      # Markdown → Telegram HTML
│   ├── stickers.ts             # emoji → file_id sticker routing
│   ├── telegram-image.ts       # Telegram file download helpers
│   ├── logger.ts               # pino + admin DM notifications
│   └── time.ts                 # Timezone utilities
├── services/
│   ├── firestore.ts            # Firestore CRUD
│   ├── github.ts               # Hexo diary publishing
│   ├── index.ts                # Firebase Admin initialization
│   └── serviceAccountKey.json  # Firebase credentials (gitignored)
└── global.d.ts                 # Shared types
```

See [Architecture Docs](docs/architecture.md) for the full breakdown.

## Quick Start

```bash
# 1. Install dependencies
npm ci

# 2. Configure environment variables
cp .env.example .env

# 3. Place the Firebase service account key
# Save serviceAccountKey.json to src/services/

# 4. Build
npm run build

# 5. Run
node dist/app.js
```

## Commands & Interactions

See [Commands & Interactions Docs](docs/commands-and-interactions.md).

| Command   | Description                                          |
| --------- | ---------------------------------------------------- |
| `/help`   | Show help text                                       |
| `/love`   | Trigger affection scoring + tsundere reply           |
| `/shock`  | Zap the bot; supports intensity and extra text       |
| `/nighty` | Schedule a morning greeting 8+ hours later           |
| `/status` | Show bot runtime status (admin only)                 |
| `/reset`  | Clear conversation buffer (admin only)               |
| `/diary`  | Generate today's diary preview (admin only, DM only) |

| Scenario     | Trigger                                                            |
| ------------ | ------------------------------------------------------------------ |
| Chat         | Mention `@nyarbot` or reply to one of her messages                 |
| Confession   | “I love you”, “let’s get married”, etc. (with mention/reply)       |
| Nickname     | Tell the bot “call me XX”                                          |
| Memory       | Tell the bot “remember XXX”                                        |
| Shared links | Send a link directly; content may be fetched on demand             |
| Media        | Send images / stickers / media; content may be inspected on demand |
| Diary note   | The bot can record observations through the `writeDiary` tool      |

## Configuration

See [Configuration Docs](docs/configuration.md).

| Variable                | Required | Description                                   |
| ----------------------- | -------- | --------------------------------------------- |
| `BOT_API_KEY`           | ✅       | Telegram bot token                            |
| `BOT_USERNAME`          | ✅       | Bot username (must match Telegram)            |
| `TG_GROUP_ID`           | ✅       | Target group ID                               |
| `TG_ADMIN_UID`          | ✅       | Admin Telegram user ID                        |
| `DEEPSEEK_API_KEY`      | ✅       | DeepSeek API key                              |
| `TAVILY_API_KEY`        | ✅       | Tavily API key                                |
| `CF_AIG_TOKEN`          | ✅       | Cloudflare AI Gateway token                   |
| `CF_ACCOUNT_ID`         | ✅       | Cloudflare account ID                         |
| `BOT_PERSONA_NAME`      | ❌       | Persona display name                          |
| `BOT_PERSONA_FULL_NAME` | ❌       | Persona full name                             |
| `BOT_PERSONA_READING`   | ❌       | Persona reading                               |
| `GITHUB_TOKEN`          | ❌       | GitHub PAT for Hexo diary publishing          |
| `GITHUB_REPO`           | ❌       | GitHub repo in `owner/repo` form              |
| `TG_DIARY_CHANNEL_ID`   | ❌       | Telegram channel ID for full diary publishing |

## Development

See [Development Docs](docs/development.md).

```bash
npm run typecheck  # TypeScript validation
npm run lint       # ESLint
npm run format     # Prettier
npm run build      # Compile src/ → dist/
```

Husky + lint-staged automatically run Prettier and ESLint on staged `.ts` files.

## Documentation

- [Architecture](docs/architecture.md)
- [Prompt XML Schema](docs/prompt-xml-schema.md)
- [Configuration](docs/configuration.md)
- [Commands & Interactions](docs/commands-and-interactions.md)
- [Development](docs/development.md)

中文文档：

- [架构](docs/architecture.zh-CN.md)
- [配置](docs/configuration.zh-CN.md)
- [命令与交互](docs/commands-and-interactions.zh-CN.md)
- [开发](docs/development.zh-CN.md)

## Release Notes

- Current release: [`1.0.0`](CHANGELOG.md)
- Release focus: `/shock`, special context `kind`, on-demand rich-content tools, diary publishing flow, prompt-injection hardening, stronger channel-send diagnostics

## Disclaimer

This is a personal project. The bot’s behavior, tone, boundaries, and group-fit are intentionally customized. Run it with your own judgment.
