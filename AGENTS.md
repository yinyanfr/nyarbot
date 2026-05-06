# AGENTS.md

## Critical: Do Not Trust Internal Knowledge

Everything you know is outdated or wrong. Your training data contains obsolete APIs, deprecated patterns, and incorrect usage. Do a websearch everytime.

## Build & run

```bash
npm run typecheck  # tsc --noEmit
npm run build      # tsc (compile src/ → dist/)
npm run lint       # eslint .
npm run format     # prettier --write .
node dist/app.js   # run the compiled bot
```

## CI pipeline (local & GitHub Actions)

- **Pre-commit** (Husky + lint-staged): auto-formats and lints staged `.ts` files
- **GitHub Actions** (`.github/workflows/ci.yml`): typecheck → lint → format-check on push/PR

## Project type

- **TypeScript, ESM** (`"type": "module"` in package.json). Use `import`/`export` syntax everywhere.
- Module resolution: `nodenext`. Use `.js` extensions in TS import paths.
- Source: `src/` → Output: `dist/`.

## Stack

| Layer                  | Library                                                    |
| ---------------------- | ---------------------------------------------------------- |
| Telegram bot framework | `grammy` v1                                                |
| AI / LLM               | `ai` (Vercel AI SDK v6) with DeepSeek via `@ai-sdk/openai` |
| Web search             | `@tavily/ai-sdk`                                           |
| Database               | `firebase-admin` (Firestore)                               |

## Architecture

- `src/app.ts` — bot entrypoint (imports `dotenv/config`, creates Bot, registers handlers, starts)
- `src/configs/env.ts` — typed config reader from `process.env`
- `src/handlers/index.ts` — message handler: group filter, user lookup, image/sticker extraction, trigger detection, AI routing, stream reply
- `src/libs/system-prompt.ts` — bot persona system prompt builder (Chinese)
- `src/libs/ai.ts` — DeepSeek providers (no-think + thinking), `classifyMessage()`, `generateResponse()` with model + reasoning routing
- `src/libs/conversation-buffer.ts` — in-memory ring buffer: `pushMessage()`, `getHistory()`, `formatHistoryAsContext()`
- `src/libs/stickers.ts` — Miaohaha sticker pack mapping (emoji → file_id), `STICKER_EMOJIS` array
- `src/libs/index.ts` — re-exports from `ai.ts`
- `src/services/index.ts` — Firebase Admin SDK initialization
- `src/services/firestore.ts` — Firestore operations: `getOrCreateUser`, `cacheImage`, `getCachedImage`
- `src/global.d.ts` — shared types (`User` with uid, nickname, memories)

## Secrets (important)

- All secrets live in `.env` (gitignored). Template at `.env.example`.
- `dotenv/config` is imported at the top of `src/app.ts`.
- Firebase service account JSON is at `src/services/serviceAccountKey.json` (gitignored).

## Conventions

- The bot is scoped to a **single Telegram group** (`tgGroupId` in config). Ignore private chats and other groups.
- User nicknames and memories are stored in Firestore under `users/{uid}`.
- The bot is meant to reply naturally, memorize users, understand images/stickers, and proactively join conversations — not just respond to commands.
- **Language**: The group chat is in Simplified Chinese. System prompt, classification prompt, and bot responses are in Chinese. Match the user's language if they switch.
- **DeepSeek API**: Base URL is `https://api.deepseek.com` (no `/v1` suffix). Thinking mode is **ON by default** — must explicitly send `thinking: { type: "disabled" }` for simple/fast responses.
- **Auto-retry**: `@grammyjs/auto-retry` is applied on `bot.api.config` before stream middleware to handle 429 rate limits.
