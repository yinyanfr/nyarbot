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
- `src/handlers/index.ts` — message handler: group filter, user lookup, trigger detection, command routing, runtime ingestion, sendAiMessages
- `src/libs/group-runtime.ts` — single-group runtime: message-level dedup, abuse gates, debounce, running/dirty lock, quiet mode, Firestore event/turn persistence, compaction trigger
- `src/libs/ai.ts` — DeepSeek providers (no-think + thinking) with Gemini 3.5 Flash-Lite reply fallback, `classifyMessage()`, `generateAiTurn()` with stable tool-call architecture, `probeGate()` for proactive, one-shot `startSubagent`, compaction generation, on-demand rich-content tools
- `src/libs/system-prompt.ts` — `buildSystemPrompt()` (static persona + rules), `buildSessionContextBlock()` (summary/history/user data), `buildProbeSystemPrompt()` (lean probe variant), `buildLateBindingPrompt()` (current time + per-turn dynamic state)
- `src/libs/conversation-buffer.ts` — in-memory hot ring buffer: `pushMessage()`, `getHistory()`, `formatHistoryAsContext()`
- `src/libs/format-telegram.ts` — Markdown→Telegram HTML converter (bold, italic, code, links, LaTeX→Unicode)
- `src/libs/stickers.ts` — sticker facade: emoji-based lookup only (`getStickerFileId`), random fallback (`pickRandomStickerEmoji`), emoji-by-file-id reverse lookup (`getStickerEmojiByFileId`)
- `src/libs/telegram-image.ts` — Telegram file download as data URL (no sticker download/conversion)
- `src/libs/proactive.ts` — two-stage proactive checker: `probeGate()` (cheap model), `generateAiTurn()` (full model), `ProactiveCallbacks` interface
- `src/libs/diary.ts` — diary system: rollover timer, Gemini Pro generation, Telegram/GitHub publishing, Pages polling, and Gemini 3.5 Flash-Lite group notice
- `src/libs/time.ts` — dayjs timezone utilities: `now()`, `todayDateStr()`, `yesterdayDateStr()`, `formatTimestamp()`, `formatSystemPromptTime()`, configurable `APP_TIMEZONE`
- `src/libs/index.ts` — re-exports from `ai.ts`
- `src/services/index.ts` — Firebase Admin SDK initialization
- `src/services/firestore.ts` — Firestore operations: users, structured diary observations/generation records, plus runtime `events`, `turns`, `runtime/group`, and `compactions`
- `src/services/github.ts` — Git Data API publishing: `pushDiaryToGithub()` batches Hexo Markdown and optional wordcloud image into one commit; external repo automation may deploy Pages
- `src/global.d.ts` — shared `User`, `DiaryEntry`, `DiaryObservationV2`, and `DiaryGenerationRecord` types

## Secrets (important)

- All secrets live in `.env` (gitignored). Template at `.env.example`.
- `dotenv/config` is imported at the top of `src/app.ts`.
- Firebase service account JSON is at `src/services/serviceAccountKey.json` (gitignored).
- `GITHUB_TOKEN` and `GITHUB_REPO` are optional — bot runs fine without GitHub publishing.

## Conventions

- The bot is scoped to a **single Telegram group** (`tgGroupId` in config). Ignore other chats except supported admin DM commands.
- User nicknames and memories are stored in Firestore under `users/{uid}`.
- The bot is meant to reply naturally, memorize users, understand images/stickers, and proactively join conversations — not just respond to commands.
- **Language**: The group chat is in Simplified Chinese. System prompt, classification prompt, and bot responses are in Chinese. Match the user's language if they switch.
- **DeepSeek API**: Base URL is `https://api.deepseek.com` (no `/v1` suffix). Thinking mode is **ON by default** — must explicitly send `thinking: { type: "disabled" }` for simple/fast responses.
- **Auto-retry**: `@grammyjs/auto-retry` is applied on `bot.api.config` before stream middleware to handle 429 rate limits.
- **Tool-call architecture**: The model must call `send_message` to speak; raw text output is invisible inner monologue. The `dismiss` tool is a binary speak/silence choice.
- **Dismiss retry**: When triggered (@/reply) but model chooses dismiss, simple/complex retry once; tech does not retry. Falls back to raw text or sticker.
- **Proactive two-stage probe**: Cheap model first, full model only if probe activates.
- **Single-group runtime**: Passive and proactive AI turns must go through `groupRuntime` so debounce, `running`, `dirty`, and quiet mode stay coherent.
- **KV cache strategy**: Keep `buildSystemPrompt()` byte-stable. Current time, hot-chat state, naturalness feedback, search/media availability, and mandatory search hints belong in late-binding user-context tail.
- **Stable tool schema**: `generateAiTurn()` keeps the main tool set stable (`send_message`, `dismiss`, memory tools, diary, sticker, rich-content tools, `webSearch`, `startSubagent`). Tools return a runtime-disabled reason internally instead of disappearing from the schema.
- **Compaction vs diary**: Compaction is untrusted working memory under `compactions` and `runtime/group.summary`. Structured observations live under `diaryObservations`; generated diaries and generation records live under `diary/{date}`. Do not mix them.
- **`formatForTelegramHtml`**: AI text and Markdown-enabled reply paths are converted to Telegram HTML; deterministic command replies/captions may bypass it.
- **`exactOptionalPropertyTypes: true`** in tsconfig — can't pass `undefined` for optional props; use conditional spread or separate assignment instead.
- **`webSearch` tool**: Keep schema stable. When flood protection disables search, expose a disabled tool that returns the reason; do not set the tool to `undefined`.
- **`zod/v4`**: Import Zod from `zod/v4` (new mini API), not plain `zod`.
- **Diary system**: Model writes structured observations via `writeDiary`. After 00:02, startup and interval checks scan the previous three dates; missing structured material falls back to legacy entries and then a bounded sample of persisted runtime events. Gemini 3.1 Pro Preview writes the diary and Gemini 3.5 Flash-Lite writes its group notice. Admin `/diary` is preview-only; scheduled generation alone saves/publishes.
- **Timezone**: Date formatting is centralized in `src/libs/time.ts` and uses `APP_TIMEZONE` (default `Asia/Shanghai`). Use `todayDateStr()`, `formatTimestamp()`, etc. — never manual Date offset math.
