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

- **Sticker dispatch**: The `sendSticker` tool lets the model choose stickers by emoji + keywords (two-stage shortlist + semantic match). The `adoptSticker` tool lets the model adopt user-sent stickers into its library.
- **Memory tools**: `saveMemory`, `setNickname`, `deleteMemory` are first-class operations with uid validation.
- **Dismiss retry**: When triggered but dismissed, the handler can retry with escalating hints.

### Why `generateText` instead of `generateObject` for classification?

DeepSeek's Chat Completions API does not support `json_schema` response_format (returns 400 `This response_format type is unavailable now`). The classification prompt instructs the model to reply in raw JSON, which is then parsed with Zod.

### Why `.chat()` instead of the default model factory?

`@ai-sdk/openai` v3 defaults to the Responses API (`/responses` endpoint). DeepSeek only supports Chat Completions (`/chat/completions`). Using `provider.chat("model-id")` explicitly selects the Chat Completions API.

### Why two-stage proactive probe?

Running the full model for every proactive check is expensive. The probe gate uses `flashNoThinkModel` (cheapest and fastest) with a simplified prompt and only `dismiss`/`send_message` tools. If the probe decides the topic is relevant, the full model runs with all tools. This saves ~80% of proactive compute on average.

### Why `formatForTelegramHtml`?

DeepSeek outputs Markdown (bold, italic, code, links, LaTeX math). Telegram's Bot API supports a limited HTML subset. `formatForTelegramHtml()` handles the conversion, including LaTeX → Unicode for math expressions. If HTML parsing fails, the bot falls back to plain text.

### Why dismiss retry only on triggered paths?

When the user @mentions or replies to the bot, silence is almost always wrong — the user expects a response. Retrying with escalating hints ensures the model eventually speaks. For proactive messages, silence is a valid and expected choice, so no retry is needed.

### Why a diary system?

The bot records conversational observations via the `writeDiary` AI tool rather than post-hoc extraction. The model decides what's worth recording based on the conversation context — no rule-based triggers or frequency limits. At midnight (based on `APP_TIMEZONE`), observations are consolidated into a natural first-person catgirl diary using DeepSeek v4 Pro with thinking. The generated diary is pushed to a Hexo blog via GitHub Content API for public reading.

### Why dayjs for date handling?

`dayjs` (2KB) was chosen over `date-fns`, `luxon`, or `Temporal` for:

- Smallest bundle size with timezone support
- Plugin system (`utc` + `timezone` plugins)
- Moment.js-compatible API (familiar, concise)
- All timezone-aware formatting centralized in `src/libs/time.ts` with env-configurable `APP_TIMEZONE` (default `Asia/Shanghai`)

### In-memory state

The conversation buffer, user cache, update dedup set, and proactive timer state are all in-process memory. A restart loses all conversation context and the proactive checker stops. This is acceptable for a single-group personal bot.

### Logger architecture

The logger (`src/libs/logger.ts`) uses pino with `pino.multistream()` in both dev and production modes:

- **Dev**: Loads `pino-pretty` as a direct `Transform` stream (main thread, no worker), combined with an admin DM stream for warn/error forwarding.
- **Production**: JSON to stdout + admin DM stream.

This avoids the previous monkey-patching of `logger.error`/`.warn` and the fragile `as unknown as NodeJS.WritableStream` cast. The `AdminDmHandler` returns a plain `{ write(msg: string): void }` adapter compatible with pino's multistream.

### Image caching timing

Images are described via Gemini and cached to Firestore immediately in the main handler — before the `if (!isMentioned && !isRepliedToBot) return` gate. Previously caching was deferred to `handleAiTurn()`, meaning non-triggered images were described but never cached. This ensures proactive context is always available.

### URL fetching (three-tier)

`fetchUrlContent()` in `ai.ts` uses a three-tier strategy:

1. **Twitter/X** → fxtwitter API (free, no auth) with batch Gemini photo descriptions
2. **Direct fetch** → HTML title/meta extraction
3. **Tavily Extract** → fallback

Only successful results enter the conversation buffer; failed fetches are silently ignored. Raw URLs never enter the buffer to avoid proactive noise.

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

### `images/{fileId}`

```typescript
interface CachedImage {
  fileId: string; // Telegram file_id
  description: string; // Gemini-generated Chinese description
  cachedAt: number; // ms since epoch, 30-day TTL
}
```

### `stickers/{file_unique_id}` and `received_stickers/{file_unique_id}`

```typescript
interface StickerDoc {
  file_unique_id: string; // Stable Telegram sticker identity (document ID)
  file_id: string; // Mutable Telegram file_id used for send/download
  emoji: string;
  description: string;
  keywords?: string[];
  source?: string;
}

interface ReceivedStickerDoc {
  file_unique_id: string; // Stable Telegram sticker identity (document ID)
  file_id: string; // Latest observed file_id for this sticker
  emoji: string;
  description: string;
  keywords?: string[];
  seen_at: number;
}
```

Sticker identity is keyed by `file_unique_id`, while runtime dispatch still uses `file_id`.

### Sticker ID migration script

Run `src/scripts/migrate-sticker-doc-ids-to-unique.ts` when upgrading legacy data keyed by `file_id`:

- Migrates both `stickers` and `received_stickers` to `file_unique_id` document IDs
- Reuses existing `file_unique_id` when present, otherwise resolves via Telegram `getFile(file_id)`
- Merges collisions onto the target `file_unique_id` document and deletes old legacy doc IDs
- Exits non-zero if unresolved records remain, so deployment pipelines can fail fast

### `diary/{date}`

```typescript
interface DiaryEntry {
  ts: number; // ms since epoch
  content: string; // natural-language observation
}

// Document fields:
// date: string (e.g., "2026-05-13")
// entries: DiaryEntry[] (via arrayUnion)
// diary?: string (generated diary text)
// generatedAt?: number (ms since epoch)
```
