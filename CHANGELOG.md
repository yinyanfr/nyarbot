# Changelog

## [0.8.1] — 2026-05-14

### Added

- **Persona naming envs** (`src/configs/env.ts`, `src/libs/persona.ts`, prompts/docs): added `BOT_PERSONA_NAME`, `BOT_PERSONA_FULL_NAME`, `BOT_PERSONA_READING` so deployers can customize the bot's in-chat identity without changing code.

### Changed

- **Persona prompt unification** (`src/libs/persona.ts`, `src/libs/system-prompt.ts`, `src/libs/ai.ts`, `src/libs/diary.ts`, `src/handlers/index.ts`): extracted shared persona label/identity helpers and switched prompt strings/help text/status text to use env-driven persona values.
- **Deployment configuration hardening** (`src/configs/env.ts`, `.env.example`, README/docs):
  - `BOT_USERNAME` is now required.
  - Added configurable envs for `DEEPSEEK_BASE_URL`, `CF_AIG_GATEWAY`, `GITHUB_API_BASE`, `GITHUB_API_VERSION`, timezone, logger naming/rate limit, proactive intervals/cooldowns, bot message delay, and buffer save path/interval.
  - `APP_TIMEZONE` now validates IANA timezone format at startup and fails fast on invalid values.

### Fixed

- **Memory cap consistency during compression** (`src/services/firestore.ts`): `overwriteUserMemories()` now enforces `MEMORY_MAX_ENTRIES` when merging compressed memories with concurrently-added memories, preventing temporary overflow beyond the 30-entry cap.

## [0.8.0] — 2026-05-13

### Added

- **Sticker keywords** (`src/libs/sticker-store.ts`, `src/libs/ai.ts`, `src/handlers/extract-content.ts`). `StickerDoc` and `ReceivedStickerDoc` now include `keywords?: string[]`. `describeSticker()` output changed from raw string to `{ description, keywords } | null`, with a simplified prompt targeting ≤30-char descriptions + 3-5 keywords separated by `|`. Retry on missing pipe separator with fallback prompt. `maxOutputTokens` reduced from 8000 → 800.
- **Two-stage sticker selection** (`src/libs/ai.ts`). `sendSticker` tool now uses compact emoji→keywords index (`😀 开心,庆祝 | 😭 大哭,崩溃 | ...`) instead of embedding full sticker descriptions in the tool description. LLM picks an emoji + keywords, then `execute` pre-filters candidates via `filterStickersByKeywords()` (max 5) and uses Flash to pick the best match from the shortlist. This reduces the per-request input token cost by ~60%.
- **Keyword-based sticker pre-filter** (`src/libs/sticker-store.ts`). `filterStickersByKeywords()` scores stickers by keyword overlap. Falls back to returning stickers without keywords (up to 5) when no keyword match is found, so pre-migration stickers remain selectable via semantic match.
- **`rewrite-sticker-descriptions.ts`** (`src/scripts/`). Migration script to re-describe all existing stickers in Firestore with the new `description|keywords` format.

### Changed

- **`describeSticker` prompt simplified**. Removed complex multi-example format instructions that confused the model. Now uses a minimal 3-line prompt with one example. Added retry: if first attempt yields no `|` separator, retries with ultra-minimal prompt. Falls back to description-only (empty keywords) if retry also fails.
- **`adoptSticker` relaxed**. No longer rejects stickers without keywords. Emoji-only stickers can still be adopted and matched via exact emoji lookup in `sendSticker`.
- **`sendSticker` input schema** changed from `{ description }` to `{ emoji, keywords }`.
- **`getStickerList()` return type** includes `keywords: string[]`.
- **`migrate-stickers.ts`** and **`sync-stickers-to-received.ts`** updated to pass `keywords` in `saveSticker`/`set()` calls.

### Removed

- **`getKeywordIndex()`** (`src/libs/sticker-store.ts`). Dead code — never called.
- **`getStickerFileIdByDescription` unused import** in `src/libs/ai.ts`.

## [0.7.0] — 2026-05-13

### Added

- **Diary system** (`src/libs/diary.ts`, `src/libs/ai.ts`, `src/services/firestore.ts`). `writeDiary` AI tool lets the model record conversational observations in natural language. Observations stored in Firestore `diary/{YYYY-MM-DD}` via `arrayUnion`. Midnight (UTC+8) auto-generates yesterday's consolidated diary using DeepSeek v4 Pro with thinking. Admin `/diary` command in private chat generates today's diary on demand for preview.
- **Hexo blog publishing** (`src/services/github.ts`, `src/configs/env.ts`). Midnight-generated diaries are automatically pushed to the `nyarbot-diary` Hexo blog via GitHub Content API (`PUT /repos/{repo}/contents/{path}`). Uses `GITHUB_TOKEN` and `GITHUB_REPO` env vars (both optional). Hexo front matter with title, date, and tags. SHA-based idempotent updates.
- **GitHub Actions deploy workflow** (`nyarbot-diary/.github/workflows/deploy.yml`). Push to main → `hexo generate` → deploy to GitHub Pages via official `actions/deploy-pages`.
- **dayjs date refactoring** (`src/libs/time.ts`). Centralized timezone-aware date utilities: `now()`, `todayDateStr()`, `yesterdayDateStr()`, `formatTimestamp()`, `formatSystemPromptTime()`. Fixed TZ `Asia/Shanghai`. Replaced all manual `new Date()` offset math across the codebase.

### Changed

- **Private admin handler expanded** (`src/handlers/index.ts`). Now handles `/status`, `/reset`, and `/diary` commands in DM with bot admin.

### Fixed

- **`writeGeneratedDiary` idempotency** (`src/services/firestore.ts`). Changed from `update()` to `set({ merge: true })`, matching `writeDiaryEntry`'s pattern and preventing `NOT_FOUND` if the document doesn't exist yet.

### Added (dependencies)

- `dayjs`

## [0.6.0] — 2026-05-12

### Added

- **Description-based sticker selection** (`src/libs/ai.ts`, `src/libs/stickers.ts`, `src/libs/sticker-store.ts`). The `sendSticker` tool now accepts a Chinese description (chosen from a numbered list) rather than an emoji. Multi-level fallback: exact/substring match → DeepSeek v4 Flash semantic match → emoji extraction → random sticker. Descriptions are the primary selection criterion; emoji is secondary.
- **Sticker-specific `describeSticker` prompt** (`src/libs/ai.ts`). Separate from `describeImage`, focuses on visual content + style + suitable chat context/emotion.
- **Native ffmpeg for animated sticker conversion** (`src/libs/telegram-image.ts`). Replaced `@ffmpeg/ffmpeg` (browser WASM, node-unsupported) with `fluent-ffmpeg` + `ffmpeg-static` (bundled binary). Extracts first frame from webm stickers to webp.
- **`application/octet-stream` detection** (`src/libs/telegram-image.ts`). `convertStickerForGemini` now detects WebM (EBML signature `1A 45 DF A3`) and WebP (RIFF...WEBP) when Telegram returns generic MIME type.
- **Sticker description validation** (`src/handlers/extract-content.ts`, `src/libs/ai.ts`, `src/scripts/migrate-stickers.ts`). Stickers without valid AI-generated descriptions are excluded from both `received_stickers` cache and `stickers` collection. `adoptSticker` rejects stickers with missing/emoji-only descriptions.
- **`getStickerByFileId()`** (`src/libs/sticker-store.ts`). Look up sticker metadata by Telegram file_id for buffer logging.
- **`sync-stickers-to-received.ts`** (`src/scripts/`). Copies all documents from Firestore `stickers` → `received_stickers`.
- **Day of week** in system prompt time display (`_2026年05月12日 周二 22:30 (UTC+8)_`).
- **Video/animation/video_note/document/audio thumbnail description** (`src/handlers/extract-content.ts`, `src/handlers/index.ts`). Telegram provides a free `thumbnail` field (and `cover` for videos) on these media types — a tiny JPEG separate from the full file. The bot now downloads thumbnails via `getFile(thumbnail_file_id)`, describes them through Gemini, and injects type-tagged descriptions (`[视频: desc]`, `[GIF动画: desc]`, `[视频消息: desc]`, `[文件: filename: desc]`, `[音频: title: desc]`) into the AI prompt and conversation buffer. Text-only fallback markers (`[视频]`, etc.) appear when no thumbnail is available. Descriptions are cached in Firestore `images/{file_id}` (shared cache with photos). Reply-to media is also processed. Zero additional dependencies — no ffmpeg needed since thumbnails are pre-generated by Telegram.

### Changed

- **`AiTurnResult.stickerEmoji` → `stickerFileId`** (`src/libs/ai.ts`, `src/handlers/index.ts`, `src/libs/proactive.ts`, `src/app.ts`). The sticker dispatch pipeline now carries the Telegram file_id directly instead of resolving emoji→file_id at send time. Eliminates one layer of lookup.
- **Buffer sticker logs include emoji** (`src/handlers/index.ts`, `src/libs/proactive.ts`). Format changed from `[贴纸: opaque_file_id]` to `[贴纸 😀: file_id]`.
- **`adoptSticker` sends the adopted sticker to chat** (`src/libs/ai.ts`). Sets `stickerFileId` on successful adoption. Tool description now requires calling `send_message` after adopting for an傲娇 verbal acknowledgment.

### Fixed

- **ffmpeg pipe input seek failure** (`src/libs/telegram-image.ts`). `.seekInput()` (input-seeking) replaced with `.seek()` (output-seeking) for pipe compatibility. Previously caused "Seek to desired resync point failed" + "WebPAnimEncoderAssemble() failed" for webm stickers.
- **ffmpeg crash as uncaught exception** (`src/libs/telegram-image.ts`). Error handler moved from pipe stream to ffmpeg command object, plus `try/catch` wrapper.
- **Sticker store initialization race** (`src/app.ts`). `main()` now awaits `stickerStoreReady()` before starting the bot and proactive checker.
- **Migration script misleading truncated log** (`src/scripts/migrate-stickers.ts`). Removed `desc?.slice(0, 40)` so complete descriptions appear in logs.

### Removed

- **`sharp`** (`package.json`, `src/libs/telegram-image.ts`). No longer needed after webp→PNG conversion was dropped (webp passes directly to Gemini now).
- **`@ffmpeg/ffmpeg`**, **`@ffmpeg/core`**, **`@ffmpeg/util`** (`package.json`). Replaced by `fluent-ffmpeg` + `ffmpeg-static`.

### Added (dependencies)

- `fluent-ffmpeg`, `ffmpeg-static`, `@types/fluent-ffmpeg`

### Removed (dependencies)

- `sharp`, `@types/sharp`, `@ffmpeg/ffmpeg`, `@ffmpeg/core`, `@ffmpeg/util`

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
- **Conversation ring buffer** (60 entries/group, 500 chars/entry).
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
