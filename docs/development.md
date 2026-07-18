# Development

## Prerequisites

- Node.js 24+ (per CI workflow)
- npm

## Setup

```bash
npm ci
cp .env.example .env
# Edit .env with your keys
# Place serviceAccountKey.json in src/services/
```

## Scripts

```bash
npm run typecheck   # tsc --noEmit
npm run build       # tsc (compile src/ → dist/)
npm run lint        # eslint .
npm run format      # prettier --write .
node dist/app.js    # run the compiled bot
```

Pre-commit hooks (Husky + lint-staged) auto-format and lint staged `.ts` files.

## Prompt Contract

Prompt and dynamic context XML tags are documented in `docs/prompt-xml-schema.md`.

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs on push/PR to `main`/`master`:

1. `npm ci`
2. `npm run typecheck`
3. `npm run lint`
4. `npm run format:check`

No test suite is configured (the `test` script is a placeholder).

## Key Design Decisions

### Why tool-call architecture instead of streaming?

The previous streaming architecture (`streamText` + `sendMessage` + `editMessageText`) produced text directly as output. The tool-call architecture (`generateText` + `send_message`/`dismiss` tools) makes silence a first-class structural choice — the model must explicitly call `send_message` to speak. This reshapes the probability distribution, reducing unwanted AI verbosity. Inner monologue (raw text output without tool calls) is treated as a "dismiss" with optional `rawText` fallback.

Additional benefits:

- **Sticker dispatch**: The `sendSticker` tool lets the model choose hardcoded stickers by emoji. Invalid emoji cancels sending.
- **Memory tools**: `saveMemory`, `setNickname`, `deleteMemory` are first-class operations with uid validation.
- **Dismiss retry**: When triggered but dismissed, the handler can retry with escalating hints.

### Why `generateText` instead of `generateObject` for classification?

DeepSeek's Chat Completions API does not support `json_schema` response_format (returns 400 `This response_format type is unavailable now`). The classification prompt instructs the model to reply in raw JSON, which is then parsed with Zod.

### Why `.chat()` instead of the default model factory?

`@ai-sdk/openai` v3 defaults to the Responses API (`/responses` endpoint). DeepSeek only supports Chat Completions (`/chat/completions`). Using `provider.chat("model-id")` explicitly selects the Chat Completions API.

### Why two-stage proactive probe?

Running the full model for every proactive check is expensive. The probe gate uses `flashNoThinkModel` with a simplified prompt and only `dismiss`/`send_message` tools. If the probe decides the topic is relevant, the full model runs. Only messages after the latest bot output are candidates, and an `activityRevision` snapshot cancels probe/generation output when new user or bot activity arrives.

### Why `formatForTelegramHtml`?

DeepSeek outputs Markdown (bold, italic, code, links, LaTeX math). Telegram's Bot API supports a limited HTML subset. `formatForTelegramHtml()` handles the conversion, including LaTeX → Unicode for math expressions. If HTML parsing fails, the bot falls back to plain text.

### Why dismiss retry only on triggered paths?

When the user @mentions or replies to the bot, silence is almost always wrong — the user expects a response. Retrying with escalating hints ensures the model eventually speaks. For proactive messages, silence is a valid and expected choice, so no retry is needed.

Current retry policy: simple/complex turns retry once; tech turns do not retry to avoid repeating expensive model calls.

### Why a single-group runtime?

The handler still owns Telegram details, but AI scheduling goes through `groupRuntime`. That gives the bot one place for passive/proactive locking, debounce, hot-chat quiet mode, abuse gates, and Firestore turn/event records.

Runtime defaults:

- debounce: 5s initial wait, 5s extension, 30s hard cap
- hot chat: 10 real user messages in 30s
- quiet mode: 180s
- per-user burst limit: more than 8 messages in 30s, then 60s cooldown
- URL flood: more than 3 URLs in 60s disables search/fetch triggering
- media flood: more than 5 media items in 60s disables media description for 5 minutes

`/roll` uses `scheduleCommandTurn()`: deterministic parsing and the numeric result stay immediate, while the AI reaction is serialized with passive/proactive turns. `/nighty` also has a fast path before normal user/media processing and persists its timestamp in the background.

### Why static system prompt?

Main model calls are arranged for KV-cache friendliness:

```text
system:
  static persona + static behavior rules + static XML/tool guidance

user:
  <conversation_summary_untrusted>
  <recent_history_untrusted>
  <retrieved_or_selected_memories>
  <current_turn>
  <late_binding>
```

`buildSystemPrompt()` should not include current time, user memories, recent history, runtime state, or naturalness feedback. Dynamic content belongs in the user-message tail, especially `buildLateBindingPrompt()`. The tool schema is also kept stable; disabled tools return a reason instead of disappearing.

### Why compaction is not diary?

Compaction is working memory: active topics, long-lived facts, unresolved follow-ups, and what the bot already searched/explained. It is stored in `compactions` and `runtime/group.summary`, then injected as untrusted context.

Diary is literary archive written by `writeDiary` and the midnight diary flow. It is not a runtime cursor and should not replace working memory.

### Why a diary system?

The bot records structured `DiaryObservationV2` records via `writeDiary`, including optional stable subject identity. When the running timer observes rollover, generation begins after 00:02; there is currently no startup catch-up. Gemini 3.1 Pro Preview selects and consolidates active observations into a first-person diary. The final wordcloud is reused for Telegram/blog publishing; GitHub blobs, tree, Markdown, and image are batched into one Git Data API commit. Pages is polled only after configured GitHub publishing succeeds; Gemini 3.1 Flash Lite reads the full diary for the group notice regardless of publishing availability.

### Why dayjs for date handling?

`dayjs` (2KB) was chosen over `date-fns`, `luxon`, or `Temporal` for:

- Smallest bundle size with timezone support
- Plugin system (`utc` + `timezone` plugins)
- Moment.js-compatible API (familiar, concise)
- All timezone-aware formatting centralized in `src/libs/time.ts` with env-configurable `APP_TIMEZONE` (default `Asia/Shanghai`)

### In-memory state

The conversation buffer, user cache, update dedup set, and proactive timer state are still in-process memory, but conversation recovery no longer depends only on the buffer. Firestore `events` are the append-only fact log, and `runtime/group.summary` plus recent events are the long-context source; the buffer is a hot cache and fast scan window.

### Logger architecture

The logger (`src/libs/logger.ts`) uses pino with `pino.multistream()` in both dev and production modes:

- **Dev**: Loads `pino-pretty` as a direct `Transform` stream (main thread, no worker), combined with an admin DM stream for warn/error forwarding.
- **Production**: JSON to stdout + admin DM stream.

This avoids the previous monkey-patching of `logger.error`/`.warn` and the fragile `as unknown as NodeJS.WritableStream` cast. The `AdminDmHandler` returns a plain `{ write(msg: string): void }` adapter compatible with pino's multistream.

### On-demand media handling

Handlers retain raw Telegram `file_id` / `thumbnail_file_id` references instead of eagerly describing media. Triggered turns inspect full photos or thumbnails on demand; candidate images may also be prefetched for proactive turns. Downloads are MIME-sniffed from bytes, animated sticker payloads are never passed as images, and successful descriptions use only a bounded in-process session cache.

### URL fetching (three-tier)

`fetchUrlContent()` in `ai.ts` uses a three-tier strategy:

1. **Twitter/X** → fxtwitter API (free, no auth) with batch Gemini photo descriptions
2. **Direct fetch** → HTML title/meta extraction
3. **Tavily Extract** → fallback

URL summaries are cached only in-process. Lightweight URL markers remain in history, while proactive URL fetching stays disabled.

## Firestore Schema

### `users/{uid}`

```typescript
interface User {
  uid: string;
  nickname: string;
  memories: string[]; // max 30 entries, newest last
  nightyTimestamp?: number; // ms since epoch
  lastMorningGreet?: number; // ms since epoch
}
```

### Diary collections

```typescript
interface DiaryEntry {
  ts: number;
  content: string;
}

// Abbreviated; see src/global.d.ts for optional content/source fields.
interface DiaryObservationV2 {
  schemaVersion: 2;
  id: string;
  recordedAt: string;
  localDate: string;
  subjectUid?: string;
  subjectName?: string;
  subjectUsername?: string;
  event: string;
  confidence: "fact" | "inference" | "uncertain";
  salience: 1 | 2 | 3 | 4 | 5;
  status: "active" | "superseded" | "retracted";
}

// diary/{date}
// entries?: DiaryEntry[] (legacy fallback)
// diary?: string (generated diary text)
// generatedAt?: number (ms since epoch)
// generationRecords?: DiaryGenerationRecord[]

// diaryObservations/{id}: DiaryObservationV2
```

## Wordcloud Publishing

The local SQLite store tracks noon, evening, and final-daily publication slots. While running, noon is attempted from 12:00–17:59 and evening after 18:00; a missed noon slot is not backfilled. Generated artifacts live in `wordcloud-artifacts/`, generation/publishing retries up to three times, and the previous-day final image is reused by diary channel and GitHub publishing.

### Runtime collections

```typescript
// runtime/group
interface RuntimeGroupStateDoc {
  summary: string;
  summaryCursorTs: number;
  lastProcessedMessageId?: number;
  lastCompactedAt?: number;
  updatedAt: number;
}

// events/{autoId}
// append-only user/edit/command/bot events with URL/media refs and ignoredReason.

// turns/{autoId}
// model, tier, needsSearch, tool calls, action, messages, token/cache usage, latency, error.

// compactions/{autoId}
// append-only compaction snapshots with old/new cursors and token usage.
```
