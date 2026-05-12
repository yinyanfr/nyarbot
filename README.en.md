# nyarbot

A tsundere high-school catgirl AI living in your Telegram group chat.

Built with [grammy](https://grammy.dev) and [Vercel AI SDK](https://sdk.vercel.ai), powered by DeepSeek for LLM, Gemini for vision (via Cloudflare AI Gateway), and Firestore for persistence.

---

## Features

- 💬 **Natural Chat** — @mention or reply to trigger a conversation with tsundere catgirl quirks (喵, 哼!, 笨蛋!), intentional mispronunciations (机器人→姬器人, AI→猫工智能)
- 🧠 **Serious Mode** — Automatically drops the catgirl persona for programming, math, and technical questions
- 🔍 **Web Search** — Auto-searches for current events and real-time information when needed (forced search mechanism ensures the model doesn't skip it)
- 🔗 **URL Understanding** — Tweet links auto-fetched via fxtwitter API (with Gemini photo recognition); other links try direct HTML fetch for title/description, falling back to Tavily; only successful results enter context
- 🖼️ **Image Roasting** — Gemini identifies image content (including images in replied-to messages), catgirl-style commentary, descriptions auto-cached and written to conversation context for proactive chatter
- 🌅 **Morning Greeting** — Say goodnight with `/nighty`, receive a personalized greeting 8+ hours later
- 💔 **Love Rejection** — `/love` or confession keywords trigger personalized tsundere rejection based on stored memories
- 🏷️ **Nickname & Memory** — Tell her "call me XX" or "remember XXX" and she'll remember
- 📔 **Diary System** — Bot auto-records observational notes during chat, generates a consolidated catgirl diary at midnight, publishes to Hexo blog
- 🎯 **Proactive Chatter** — Two-stage probe: cheap model checks topic relevance, full model generates reply only when activated
- 🎨 **Sticker Replies** — Select stickers by Chinese description (multi-level matching), standalone or alongside text
- 🔄 **Dismiss Retry** — When triggered but model chooses silence, retries up to 3 times with escalating reply hints; falls back to raw text or sticker if still silent
- ⌨️ **Typing Indicator** — Shows "typing..." while AI generates
- 📝 **Markdown→Telegram HTML** — Replies auto-convert Markdown bold/italic/code/links to Telegram HTML

---

## Tech Stack

| Layer                  | Library                                               |
| ---------------------- | ----------------------------------------------------- |
| Telegram Bot Framework | `grammy` v1                                           |
| AI / LLM               | `ai` (Vercel AI SDK v6) + DeepSeek v4                 |
| Vision                 | Gemini 2.5 Flash (via Cloudflare AI Gateway)          |
| Web Search             | `@tavily/ai-sdk`                                      |
| Database               | `firebase-admin` (Firestore)                          |
| Date/Time              | `dayjs` (UTC+8, Asia/Shanghai)                        |
| Runtime                | Node.js, TypeScript (ESM, moduleResolution: nodenext) |

---

## Architecture

```
src/
├── app.ts                      # Entry: load dotenv, init Firebase, register handlers,
│                               #   create ProactiveCallbacks, start proactive checker
├── configs/
│   └── env.ts                  # Environment variable reading and validation
├── handlers/
│   ├── index.ts                # Message handler: classify→AI turn→send (with dismiss
│   │                           #   retry, typing indicator, sticker dispatch)
│   ├── context.ts              # BotContext and RequestState types
│   ├── constants.ts            # Constants (MAX_BUFFER_TEXT, LOVE_REGEX, etc.)
│   ├── match-command.ts        # Command matching utility
│   ├── extract-content.ts      # URL/image/sticker extraction
│   ├── reply-and-track.ts      # Reply + buffer push
│   └── update-dedup.ts         # LRU dedup
├── libs/
│   ├── ai.ts                   # DeepSeek providers, classifyMessage(),
│   │                           #   generateAiTurn() (tool-call architecture),
│   │                           #   probeGate() (proactive probe),
│   │                           #   describeImage(), fetchUrlContent(), etc.
│   ├── conversation-buffer.ts  # In-memory ring buffer (60 msgs/group)
│   ├── system-prompt.ts        # Catgirl persona system prompt, probe prompt,
│   │                           #   naturalness late-binding prompt
│   ├── stickers.ts             # Sticker facade (description selection + emoji lookup + random fallback)
│   ├── format-telegram.ts      # Markdown→Telegram HTML (LaTeX→Unicode)
│   ├── proactive.ts            # Proactive: ProactiveCallbacks interface,
│   │                           #   two-stage probe, cooldown, sticker/typing dispatch
│   ├── diary.ts                # Diary: midnight timer, per-date diary generation
│   ├── time.ts                 # dayjs timezone utils (UTC+8)
│   ├── telegram-image.ts       # Telegram file download → base64 data URL
│   ├── logger.ts                # Pino logger
│   └── index.ts                # Barrel re-exports
├── services/
│   ├── index.ts                # Firebase Admin SDK initialization
│   ├── firestore.ts            # Firestore CRUD (users, image cache, diary, nighty/morning)
│   ├── github.ts               # GitHub Content API: push diary to Hexo blog
│   └── serviceAccountKey.json  # Firebase credentials (gitignored)
└── global.d.ts                 # User, DiaryEntry type definitions
```

See [Architecture Docs](docs/architecture.md) for details.

---

## Quick Start

```bash
# 1. Install dependencies
npm ci

# 2. Configure environment variables
cp .env.example .env
# Edit .env with your Bot Token, DeepSeek API Key, Tavily API Key, CF AI Gateway Token, etc.

# 3. Place Firebase service account key
# Save serviceAccountKey.json to src/services/

# 4. Build
npm run build

# 5. Run
node dist/app.js
```

---

## Commands & Interactions

See [Commands & Interactions Docs](docs/commands-and-interactions.md) for details.

| Command   | Description                                                 |
| --------- | ----------------------------------------------------------- |
| `/help`   | Show help text                                              |
| `/love`   | Confess your love, receive a tsundere rejection             |
| `/nighty` | Say goodnight; bot sends a morning greeting 8+ hours later  |
| `/status` | Bot status — uptime, buffer size, memory count (admin only) |
| `/reset`  | Clear conversation history buffer (admin only)              |
| `/diary`  | Generate today's diary preview (admin only, private chat)   |

| Scenario           | Trigger                                                            |
| ------------------ | ------------------------------------------------------------------ |
| Chat               | @nyarbot or reply to her messages                                  |
| Confession         | Say "I love you", "let's get married", etc. (requires @ or reply)  |
| Set nickname       | Tell her "call me XX"                                              |
| Save memory        | Tell her "remember XXX"                                            |
| Share URL          | Send a link directly (@ her for a summary, otherwise context only) |
| Send image/sticker | Send directly, Gemini identifies and catgirl comments              |
| Diary observation  | Bot auto-records notes via writeDiary tool during conversation     |

---

## Configuration

See [Configuration Docs](docs/configuration.md) for details.

| Variable           | Required | Description                                     |
| ------------------ | -------- | ----------------------------------------------- |
| `BOT_API_KEY`      | ✅       | Telegram Bot Token                              |
| `TG_GROUP_ID`      | ✅       | Target group ID (bot only works in this group)  |
| `TG_ADMIN_UID`     | ✅       | Admin Telegram user ID                          |
| `DEEPSEEK_API_KEY` | ✅       | DeepSeek API Key                                |
| `TAVILY_API_KEY`   | ✅       | Tavily Search API Key                           |
| `CF_AIG_TOKEN`     | ✅       | Cloudflare AI Gateway Token (for Gemini vision) |
| `CF_ACCOUNT_ID`    | ✅       | Cloudflare Account ID (for Gemini vision)       |
| `BOT_USERNAME`     | ❌       | Bot username, default `nyarbot`                 |
| `GITHUB_TOKEN`     | ❌       | GitHub PAT for pushing diaries to Hexo blog     |
| `GITHUB_REPO`      | ❌       | GitHub repo in `owner/repo` format              |
| `LOG_LEVEL`        | ❌       | Log level, default `info`                       |

---

## Development

See [Development Docs](docs/development.md) for design decisions, Firestore schema, and troubleshooting.

```bash
npm run typecheck  # TypeScript type checking (tsc --noEmit)
npm run lint       # ESLint check
npm run format     # Prettier formatting
npm run build      # Compile src/ → dist/
```

Husky + lint-staged automatically runs prettier and eslint on staged `.ts` files.

---

## Documentation

- [Architecture](docs/architecture.md) — Tool-call architecture, proactive two-stage probe, dismiss retry, Markdown rendering
- [Configuration](docs/configuration.md) — Environment variables, Firebase, model selection, AI Gateway
- [Commands & Interactions](docs/commands-and-interactions.md) — Commands, natural language triggers, LLM tools, dismiss retry
- [Development](docs/development.md) — Design decisions, Firestore schema, troubleshooting

中文文档：

- [架构](docs/architecture.zh-CN.md)
- [配置](docs/configuration.zh-CN.md)
- [命令与交互](docs/commands-and-interactions.zh-CN.md)
- [开发](docs/development.zh-CN.md)

---

## Disclaimer

This is a personal project. The bot's behavior and persona are customized by the owner. Use at your own discretion.
