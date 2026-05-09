# Changelog

## [Unreleased]

### Added

- **Twitter/X link understanding** via fxtwitter API (`src/libs/ai.ts`). Detects `twitter.com`/`x.com`/`*/status/*` URLs and fetches author, text, quoted tweet, and up to 4 photos. Photos are sent to Gemini 2.5 Flash in a single batch for ≤150-char Chinese descriptions. Content stored in conversation buffer as `[Tweet url | @handle: text | 配图: desc1; desc2]`.
- **Multi-tier URL fetching** (`src/libs/ai.ts`). Three-tier fallback: fxtwitter API for tweets → direct HTML fetch (title + meta description) for other links → Tavily Extract as last resort. Failed fetches are silently ignored—nothing enters the buffer.

### Fixed

- **Reply-to image recognition** (`src/handlers/extract-content.ts`). Photos from `msg.reply_to_message.photo` are now processed alongside the message's own photos. Replying "what do you think?" to an image correctly provides the image to Gemini for description.
- **Image descriptions not available in proactive context**. Image descriptions are now included inline in the conversation buffer (`[图片: desc]` instead of bare `[图片]`), so the proactive checker sees full image context.
- **Image caching deferred to `handleAiTurn()`**. Caching now happens immediately after Gemini describes an image in the main handler — before the trigger gate. Images are cached regardless of whether the bot was triggered, ensuring the proactive checker benefits from Firestore cache hits.
- **Raw URLs polluting the conversation buffer**. `buildBufferLine()` no longer emits `[链接: url]`. Only successfully fetched content enters the buffer. Prevents the proactive checker from asking "what's this link?" about unfetchable URLs.

### Changed

- **Cloudflare account ID moved to env** (`src/configs/env.ts`). Previously hardcoded `"5b2af39cf1c595a34ffa9057bbf17f0b"` in `ai.ts`. Now read from `CF_ACCOUNT_ID` env var. Added to `.env.example`.
- **Logger rewrite** (`src/libs/logger.ts`). Removed fragile `as unknown as NodeJS.WritableStream` type assertion and dev-mode monkey-patching of `logger.error`/`.warn`. Dev and prod now use the same `pino.multistream([...])` pattern. In dev, `pino-pretty` is loaded as a direct `Transform` stream (no worker). `AdminDmHandler` returns a plain `{ write(msg: string): void }` adapter.
- **`buildUserMessage()` tweet detection** (`src/handlers/index.ts`). Tweet content (starting with `[Tweet `) is displayed as-is; normal links are wrapped with `[链接 url: content]`. Buffer push also differentiates tweets (`[推文]`) from normal links (`[链接]`).
- **`handleAiTurn()` cleanup**. Removed `photoFileIds`, `imageDataUrls`, and `caption` parameters (no longer needed since caching moved to main handler).

## [0.5.0] — 2026-05-08

### Added

- **Admin DM logging with crash guards** (`src/libs/logger.ts`, `src/app.ts`). `AdminDmStream` forwards warn/error pino logs to admin via Telegram DM (rate-limited to 1/5s). Added global `uncaughtException`/`unhandledRejection` crash handlers that log fatal before exit.

## [0.4.0] — 2026-05-07

### Added

- **Tool-call architecture** (`src/libs/ai.ts`, `src/handlers/index.ts`). Replaced stream-based output (`streamText` + `sendMessage` + `editMessageText`) with `generateText` + `send_message`/`dismiss` tools. Silence is a first-class structural choice. Inner monologue (raw text without tool calls) is invisible to users.
- **Dismiss retry** (`src/handlers/index.ts`). When triggered (@mention/reply) but model chooses `dismiss`, retries up to 3 times with escalating `[系统提示]` hints. Falls back to `rawText` or random sticker if all retries still dismiss.
- **Sticker fixes in tool-call path**. `sendSticker` without `send_message` correctly returns `action: "send"`. Stickers dispatch after text messages with proper reply references. Proactive path also dispatches stickers.
- **Late-binding prompt** (`src/libs/system-prompt.ts`). Per-turn human-likeness feedback: warns if ≥2 of last 5 bot messages end with `。`, or if average length > 40 chars.
- **Forced web search instruction**. When `needsSearch=true`, appends mandatory `<强制指令>` to ensure model calls `webSearch` before answering.

### Changed

- **Proactive path overhaul** (`src/libs/proactive.ts`). Added `sendSticker`/`sendChatAction`/`sendText` via `ProactiveCallbacks` interface. Typing indicators, message staggering (400ms), and HTML formatting now match the handler path.
- **Dismiss attitude tuning**. System prompt, dismiss tool description, late-binding prompt, and probe prompt all shifted from default-silence to default-participate.
- **Gaudy smiley removed from dismiss tool description**.
- **Dynamic imports in proactive.ts replaced with static imports**.

## [0.3.0] — 2026-05-06

### Added

- **Markdown → Telegram HTML converter** (`src/libs/format-telegram.ts`). Converts bold, italic, strikethrough, code, links, and LaTeX math to Telegram's limited HTML subset. LaTeX symbols, fractions, sqrt, super/subscripts → Unicode. Falls back to plain text on parse failure.

### Changed

- **Goodnight only via `/nighty` command**. Removed `NIGHTY_REGEX` text matching. Only the `/nighty` slash command triggers goodnight timestamp.
- **Gemini vision model upgraded** from `gemini-2.5-flash` to `gemini-3-flash-preview`.
- **Image description prompt enhanced**. Detailed content, OCR text extraction, math problem solving, caption awareness. Max output tokens: 80 → 8000.
- **AI output rendered as HTML** with `parse_mode: "HTML"`. `replyAndTrack()` accepts optional `formatMarkdown` flag. Proactive messages also HTML-rendered.

### Fixed

- **DeepSeek thinking mode multi-step tool call error**. `injectThinking()` now sets `reasoning_content: ""` on assistant history messages when thinking is enabled.

## [0.2.0] — 2026-05-05

### Added

- **Chinese & English documentation**: architecture, configuration, commands/interactions, development.
- **Gemini 2.5 Flash vision** via Cloudflare AI Gateway (`src/libs/ai.ts`). Fresh images pre-described by Gemini before being passed as text to DeepSeek (which has no vision capability).

### Fixed

- **`@ai-sdk/openai` v3 Responses API mismatch**. DeepSeek only supports Chat Completions. Using `provider.chat("model-id")` now selects the correct API.
- **DeepSeek rejecting `json_schema` response_format**. Classification switched from `generateObject` + Zod schema to `generateText` + manual JSON parsing.
- **`@grammyjs/stream` removed**. `sendMessageDraft` returns `TEXTDRAFT_PEER_INVALID` for bots in groups. Replaced with `sendMessage` + `editMessageText`.
- **Web search tool calls not generating final response**. Added `stopWhen: stepCountIs(5)` for multi-step tool execution.

## [0.1.2] — 2026-05-04

### Added

- **Firestore transactions** for `getOrCreateUser()` race-condition safety. Process-local cache with 60s TTL.
- **Image cache TTL** (30 days), lazy expiry on read, startup batch cleanup.
- **Memory cap** (30 entries per user), transactional append+trim.
- **Update dedup** (`src/handlers/update-dedup.ts`): LRU (1024) prevents double-replies.
- **Status command enhancements**: uptime, memory users, cached images, RSS memory.

### Fixed

- **Bot token leaked into LLM prompts** via image URLs. Photos now downloaded as data URLs, never exposed as text.
- **Admin-only commands** (`/reset`, `/status`) now check `tgAdminUid`.
- **ESM import-order crash**. Firestore client lazily initialized (`getFirestore()` after `initializeApp()`).
- **`nightyTimestamp`**: uses `FieldValue.delete()` instead of `null`.
- **`LOVE_REGEX` tightened** to require preposition before `交往`.

### Changed

- **Handler refactoring**. 540-line handler split into focused modules: `constants`, `context`, `match-command`, `extract-content`, `reply-and-track`, `update-dedup`.
- **Morning greeting + AI reply merged** into single response when user @s bot after waking up (`systemHint`).
- **System prompt includes recent-members table** with UIDs for third-party user tools.
- **Runtime uid validation** on `saveMemory`/`setNickname`/`deleteMemory` tools.
- **Silent `.catch(() => {})` replaced with `logger.warn()`** throughout.

## [0.1.1] — 2026-05-03

### Fixed

- **Slash commands missing `@botUsername` suffix support** in groups (`/love`, `/status`, `/reset`).
- **URL extraction using wrong string offsets** for caption entities.
- **Goodnight regex** (`gn`, `nite`) now requires word boundaries to prevent false matches.
- **Trigger detection moved before morning greeting** to prevent double replies.
- **Non-triggered URL content ordering**: now `await`ed instead of fire-and-forget.
- **Replied-to user name** added to reply context for both message and edited handlers.

### Added

- **`/love` command and love confession detection** with `LOVE_REGEX` and `generateLoveRejection()`.
- **URL content extraction** via Tavily's `urlExtract` tool + DeepSeek summarization (`fetchUrlContent()`).
- **`matchCommand()` helper** for reusable command matching.

## [0.1.0] — 2026-05-02

### Added

- **Core AI chatbot** with DeepSeek v4 (flash + pro), thinking mode routing, message classification (simple/complex/tech).
- **Telegram Bot** via grammy with auto-retry.
- **Multi-modal support**: text, images (vision), stickers (Miaohaha pack).
- **Web search** via `@tavily/ai-sdk` with `tavilySearch` tool.
- **Conversation ring buffer** (30 entries/group, 500 chars/entry).
- **Proactive conversation checker** with activity-based cooldown.
- **Goodnight/morning greeting** — `/nighty` command + 8h timer.
- **Image caching** via Firestore (`images/{fileId}`).
- **User memory system** — `saveMemory`/`deleteMemory`/`setNickname` tools.
- **Commands**: `/help`, `/nighty`, `/status` (admin), `/reset` (admin).
- **Edited message handler** for trigger-based re-replies.
- **Pino logger** with pretty printing in dev.
- **Graceful shutdown** on SIGINT/SIGTERM.

### Infrastructure

- TypeScript ESM (`"type": "module"`, `moduleResolution: "nodenext"`).
- Firebase Admin SDK (Firestore persistence).
- Husky + lint-staged pre-commit hooks.
- GitHub Actions CI (typecheck → lint → format-check).
