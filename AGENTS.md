# AGENTS.md

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

| Layer                  | Library                               |
| ---------------------- | ------------------------------------- |
| Telegram bot framework | `grammy` v1                           |
| AI / LLM               | `ai` (Vercel AI SDK v6) with DeepSeek |
| Web search             | `@tavily/ai-sdk`                      |
| Database               | `firebase-admin` (Firestore)          |

## Architecture

- `src/app.ts` — bot entrypoint (imports `dotenv/config`, currently a design doc comment; implementation TBD)
- `src/handlers/index.ts` — Telegram bot command/message handlers (stub)
- `src/libs/index.ts` — shared tool/utility functions (stub)
- `src/services/index.ts` — Firebase Admin SDK initialization
- `src/global.d.ts` — shared types (`User` with uid, nickname, memories)

## Secrets (important)

- All secrets live in `.env` (gitignored). Template at `.env.example`.
- `dotenv/config` is imported at the top of `src/app.ts`.
- Firebase service account JSON is at `src/services/serviceAccountKey.json` (gitignored).

## Conventions

- The bot is scoped to a **single Telegram group** (`tgGroupId` in config). Ignore private chats and other groups.
- User nicknames and memories are stored in Firestore under `users/{uid}`.
- The bot is meant to reply naturally, memorize users, understand images/stickers, and proactively join conversations — not just respond to commands.
