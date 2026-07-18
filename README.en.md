# nyarbot

> [中文 README](README.md)

A tsundere high-school catgirl AI that lives inside your Telegram group chat.

[![Release](https://img.shields.io/badge/release-1.0.0-8b5cf6?style=flat-square)](CHANGELOG.md)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-3c873a?style=flat-square&logo=nodedotjs&logoColor=white)](package.json)
[![TypeScript](https://img.shields.io/badge/typescript-ESM-3178c6?style=flat-square&logo=typescript&logoColor=white)](tsconfig.json)
[![Telegram](https://img.shields.io/badge/telegram-bot-26a5e4?style=flat-square&logo=telegram&logoColor=white)](https://core.telegram.org/bots/api)
[![AI SDK](https://img.shields.io/badge/AI%20SDK-v6-black?style=flat-square&logo=vercel&logoColor=white)](https://sdk.vercel.ai)
[![License](https://img.shields.io/badge/license-ISC-0f172a?style=flat-square)](package.json)

Built with [grammy](https://grammy.dev) and [Vercel AI SDK](https://sdk.vercel.ai): DeepSeek handles chat and tool use, Gemini handles vision, diary generation, and diary notices through Cloudflare AI Gateway, and Firestore provides persistence. This is not a generic Q&A bot with a persona sticker on top. It is designed as a long-lived group participant with memory, proactive timing, tool-calling, and diary publishing.

## Overview

- **Feels like a group member**: conversation-first behavior instead of command-only automation
- **Tool-call architecture**: speaking, dismissing, stickers, search, media inspection, and diary writing are all explicit tools
- **Long-lived context**: nicknames, memories, rolling chat history, proactive replies, and daily diary generation
- **Local routing for speed**: short chats, technical questions, detailed requests, and current-fact queries are routed locally first, then escalated to the classifier / advisor when needed
- **Publishing pipeline**: while running, wordclouds publish at noon, in the evening, and after rollover; midnight diaries can reuse the final cloud for Hexo/GitHub and Telegram channels
- **Security-conscious prompt design**: dedicated guardrails for prompt injection, memory poisoning, and external-content replay

## Highlights

| Capability         | Description                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| Natural group chat | Triggered by mention/reply, optimized for short-form chat rhythm rather than essay-style responses |
| Serious mode       | Programming, math, and technical questions automatically suppress the stronger persona layer       |
| On-demand tools    | Media and URL tools are only used when actually needed, not eagerly preprocessed                   |
| Proactive chatter  | Cheap probe first; only new candidates are answerable and stale generations are cancelled          |
| Memory system      | Nicknames, user memories, affection scoring, and morning/night routines                            |
| Diary system       | Observations become a daily catgirl diary, ready for blog/channel distribution                     |
| Wordcloud system   | Recent local messages become timed daily clouds with a top-5 leaderboard while the bot is running  |

## Features

- 💬 **Natural Chat**: mention or reply to the bot to start a conversation; default tone is tsundere catgirl, but it can dial that down when needed
- 🧠 **Serious Mode**: handles programming, math, academic, and technical topics in a more direct, less roleplay-heavy style
- 🔍 **Web Search**: forces `webSearch` for current events, real-time facts, and fast-moving APIs
- 🔗 **URL Understanding (On Demand)**: fetches link content only when needed; tweet links include optional image-aware context
- 🖼️ **Media Understanding (On Demand)**: images, GIFs, video covers, stickers, and file thumbnails can be inspected when relevant
- 🌅 **Morning Greetings**: `/nighty` schedules a personalized morning greeting on the next message after 8+ hours
- 💔 **Affection Scoring**: `/love` and confession-style messages trigger memory-based scoring and a persona-consistent response
- ⚡ **Shock Reactions**: `/shock` supports intensity and optional extra text for different frazzled reactions
- 🎲 **Dice Rolls**: `/roll` defaults to `1d20` and accepts `NdM`; the numeric result is immediate, followed by a queued AI reaction
- 🏷️ **Nicknames & Memory**: users can naturally teach the bot how to address them or what to remember
- 📔 **Diary System**: observations are recorded during chat and turned into a daily diary entry
- ☁️ **Wordcloud System**: while running, chat becomes noon, evening, and final daily wordclouds with active-user ranking; bundled Source Han Sans keeps CJK text readable
- 🎨 **Sticker Replies**: emoji-routed hardcoded sticker responses, optionally alongside text
- 🔄 **Dismiss Retry**: if the model chooses silence after an explicit trigger, the bot retries with stronger reply hints

## Tech Stack

| Layer               | Library                                            |
| ------------------- | -------------------------------------------------- |
| Telegram Bot        | `grammy` v1                                        |
| AI / LLM            | `ai` (Vercel AI SDK v6) + DeepSeek v4              |
| Gemini              | Gemini 3.1 Flash Lite / Pro Preview via AI Gateway |
| Search / Extraction | `@tavily/ai-sdk`                                   |
| Database            | `firebase-admin` (Firestore)                       |
| Local Storage       | `better-sqlite3` + `nodejieba` + `@napi-rs/canvas` |
| Runtime             | Node.js + TypeScript ESM                           |
| Timezone            | `dayjs` (`Asia/Shanghai`)                          |

## Project Layout

```text
src/
├── app.ts                      # Bootstraps bot, Firebase, diary, wordcloud, proactive loop, logging
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
│   ├── wordcloud.ts            # Wordcloud generation, layout, rendering, publishing
│   ├── format-telegram.ts      # Markdown → Telegram HTML
│   ├── stickers.ts             # emoji → file_id sticker routing
│   ├── telegram-image.ts       # Telegram file download helpers
│   ├── logger.ts               # pino + admin DM notifications
│   └── time.ts                 # Timezone utilities
├── services/
│   ├── firestore.ts            # Firestore CRUD
│   ├── local-wordcloud-store.ts # Local SQLite wordcloud storage and activity stats
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

| Command                       | Description                                                            |
| ----------------------------- | ---------------------------------------------------------------------- |
| `/help`                       | Show help text                                                         |
| `/love`                       | Trigger affection scoring + tsundere reply                             |
| `/shock`                      | Zap the bot; supports intensity and extra text                         |
| `/stroke`                     | Pet the bot; supports intensity and extra text                         |
| `/roll [NdM]`                 | Roll dice; defaults to `1d20`, supports 1–20 dice and 2–99999 sides    |
| `/nighty`                     | Schedule a morning greeting 8+ hours later                             |
| `/status`                     | Show bot runtime status (admin only)                                   |
| `/reset`                      | Clear conversation buffer and runtime summary (admin only)             |
| `/diary`                      | Generate today's diary preview (admin only, DM only)                   |
| `/wordcloud [date]`           | Generate a wordcloud preview for a specific date (admin only, DM only) |
| `/diaryobs [date]`            | List structured diary observations (admin only, DM only)               |
| `/diaryshow <id>`             | Show one diary observation (admin only, DM only)                       |
| `/diaryedit <id> <json>`      | Patch a diary observation (admin only, DM only)                        |
| `/diaryretract <id> [reason]` | Retract a diary observation (admin only, DM only)                      |
| `/diaryregen [date]`          | Regenerate a preview without saving/publishing (admin only, DM only)   |

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

| Variable                      | Required | Description                                                               |
| ----------------------------- | -------- | ------------------------------------------------------------------------- |
| `BOT_API_KEY`                 | ✅       | Telegram bot token                                                        |
| `BOT_USERNAME`                | ✅       | Bot username (must match Telegram)                                        |
| `TG_GROUP_ID`                 | ✅       | Target group ID                                                           |
| `TG_ADMIN_UID`                | ✅       | Admin Telegram user ID                                                    |
| `DEEPSEEK_API_KEY`            | ✅       | DeepSeek API key                                                          |
| `TAVILY_API_KEY`              | ✅       | Tavily API key                                                            |
| `CF_AIG_TOKEN`                | ✅       | Cloudflare AI Gateway token                                               |
| `CF_ACCOUNT_ID`               | ✅       | Cloudflare account ID                                                     |
| `BOT_PERSONA_NAME`            | ❌       | Persona display name                                                      |
| `BOT_PERSONA_FULL_NAME`       | ❌       | Persona full name                                                         |
| `BOT_PERSONA_READING`         | ❌       | Persona reading                                                           |
| `GITHUB_TOKEN`                | ❌       | GitHub PAT for Hexo diary publishing                                      |
| `GITHUB_REPO`                 | ❌       | GitHub repo in `owner/repo` form                                          |
| `TG_DIARY_CHANNEL_ID`         | ❌       | Telegram channel ID for full diary publishing                             |
| `WORDCLOUD_DB_PATH`           | ❌       | Local SQLite path for wordcloud storage (default `data/wordcloud.sqlite`) |
| `WORDCLOUD_CHECK_INTERVAL_MS` | ❌       | Wordcloud publication-slot check interval (default `60000`)               |

## Wordcloud Notes

- Wordcloud source messages live only in local SQLite, not Firestore.
- Only human users count. The bot itself and other bots are excluded from both the cloud and the activity leaderboard.
- Command messages are excluded. If a normal message is later edited into a command, it is removed from the local wordcloud store.
- Edited messages overwrite by the same `message_id`, so the cloud uses the final text.
- Forwarded messages still count toward the activity leaderboard and `messageCount`, but are excluded from the wordcloud body.
- While running, the noon slot is attempted from 12:00–17:59 and the evening slot after 18:00; missed noon slots are not backfilled. The previous day's final cloud publishes after 00:02 with restart catch-up.
- The final cloud is reused for the diary channel image and blog `index_img`; image and Markdown are sent in one Git Data API commit.
- Repeated words inside the same message count once.
- Rendering uses a bundled full Source Han Sans variable font so Simplified Chinese, Traditional Chinese, Japanese, and Korean do not fall back to tofu squares.
- The default layout is center-heavy: high-frequency words form the core cluster first, short Chinese words may occasionally go vertical to fill gaps, and obvious negative tokens plus common filler/function words are filtered out.

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
- Recent updates: added `/roll` and a fast `/nighty` path; proactive turns now use candidate windows and activity revisions to prevent duplicate or stale replies; Telegram media is MIME-sniffed and animated stickers use safe thumbnails; wordclouds gained noon/evening slots and diary reuse; blog publishing batches image and Markdown; Gemini 3.1 Pro Preview writes diaries while Flash Lite reads the full diary for restrained update copy

## Disclaimer

This is a personal project. The bot’s behavior, tone, boundaries, and group-fit are intentionally customized. Run it with your own judgment.
