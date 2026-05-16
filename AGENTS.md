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

- `src/app.ts` — bot entrypoint (imports `dotenv/config`, creates Bot, registers handlers, creates ProactiveCallbacks, starts proactive checker)
- `src/configs/env.ts` — typed config reader from `process.env`
- `src/handlers/index.ts` — message handler: group filter, user lookup, trigger detection, AI routing, tool-call architecture, dismiss retry, typing indicator, sendAiMessages
- `src/libs/ai.ts` — DeepSeek providers (no-think + thinking), `classifyMessage()`, `generateAiTurn()` with tool-call architecture, `probeGate()` for proactive, `describeImage()`, `fetchUrlContent()`
- `src/libs/system-prompt.ts` — `buildSystemPrompt()` (persona + naturalness), `buildProbeSystemPrompt()` (lean probe variant), `buildLateBindingPrompt()` (per-turn human-likeness feedback)
- `src/libs/conversation-buffer.ts` — in-memory ring buffer: `pushMessage()`, `getHistory()`, `formatHistoryAsContext()`
- `src/libs/format-telegram.ts` — Markdown→Telegram HTML converter (bold, italic, code, links, LaTeX→Unicode)
- `src/libs/stickers.ts` — sticker facade: emoji-based lookup only (`getStickerFileId`), random fallback (`pickRandomStickerEmoji`), emoji-by-file-id reverse lookup (`getStickerEmojiByFileId`)
- `src/libs/telegram-image.ts` — Telegram file download as data URL (no sticker download/conversion)
- `src/libs/proactive.ts` — two-stage proactive checker: `probeGate()` (cheap model), `generateAiTurn()` (full model), `ProactiveCallbacks` interface
- `src/libs/diary.ts` — diary system: `checkAndGenerateDiary()` (midnight timer), `generateDiaryForDate()` (on-demand, used by admin /diary), imports `proThinkModel` from ai.ts
- `src/libs/time.ts` — dayjs timezone utilities: `now()`, `todayDateStr()`, `yesterdayDateStr()`, `formatTimestamp()`, `formatSystemPromptTime()`, fixed TZ `Asia/Shanghai`
- `src/libs/index.ts` — re-exports from `ai.ts`
- `src/services/index.ts` — Firebase Admin SDK initialization
- `src/services/firestore.ts` — Firestore operations: `getOrCreateUser`, `cacheImage`, `getCachedImage`, `writeDiaryEntry`, `getDiaryEntries`, `writeGeneratedDiary`
- `src/services/github.ts` — GitHub Content API: `pushDiaryToGithub()` pushes Hexo-formatted diary markdown to `nyarbot-diary` repo (source/\_posts/), triggers Pages deploy via Actions
- `src/global.d.ts` — shared types (`User` with uid, nickname, memories, `DiaryEntry` with ts/content)

## Secrets (important)

- All secrets live in `.env` (gitignored). Template at `.env.example`.
- `dotenv/config` is imported at the top of `src/app.ts`.
- Firebase service account JSON is at `src/services/serviceAccountKey.json` (gitignored).
- `GITHUB_TOKEN` and `GITHUB_REPO` are optional — bot runs fine without GitHub publishing.

## Conventions

- The bot is scoped to a **single Telegram group** (`tgGroupId` in config). Ignore private chats and other groups.
- User nicknames and memories are stored in Firestore under `users/{uid}`.
- The bot is meant to reply naturally, memorize users, understand images/stickers, and proactively join conversations — not just respond to commands.
- **Language**: The group chat is in Simplified Chinese. System prompt, classification prompt, and bot responses are in Chinese. Match the user's language if they switch.
- **DeepSeek API**: Base URL is `https://api.deepseek.com` (no `/v1` suffix). Thinking mode is **ON by default** — must explicitly send `thinking: { type: "disabled" }` for simple/fast responses.
- **Auto-retry**: `@grammyjs/auto-retry` is applied on `bot.api.config` before stream middleware to handle 429 rate limits.
- **Tool-call architecture**: The model must call `send_message` to speak; raw text output is invisible inner monologue. The `dismiss` tool is a binary speak/silence choice.
- **Dismiss retry**: When triggered (@/reply) but model chooses dismiss, retries up to 3 times with escalating hints. Falls back to raw text or sticker.
- **Proactive two-stage probe**: Cheap model first, full model only if probe activates.
- **`formatForTelegramHtml`**: All bot output is converted from Markdown to Telegram HTML before sending.
- **`exactOptionalPropertyTypes: true`** in tsconfig — can't pass `undefined` for optional props; use conditional spread or separate assignment instead.
- **`tavilySearch` tool**: Must be conditionally included via spread syntax (`...(needsSearch ? { webSearch: ... } : {})`) not set to `undefined`.
- **`zod/v4`**: Import Zod from `zod/v4` (new mini API), not plain `zod`.
- **Diary system**: Model writes observations via `writeDiary` tool. Midnight (UTC+8) auto-generates yesterday's diary via DeepSeek v4 Pro with thinking. Admin `/diary` in private DM generates today's diary on demand (preview only, no save/push). GitHub push (via `GITHUB_TOKEN`) only on midnight generation, not on `/diary`.
- **Timezone**: All date formatting is UTC+8 (`Asia/Shanghai`), centralized in `src/libs/time.ts`. Use `todayDateStr()`, `formatTimestamp()`, etc. — never manual Date offset math.
