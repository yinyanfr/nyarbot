# Architecture

nyarbot is a Telegram bot written in TypeScript (ESM) with one configured group runtime, a configurable catgirl persona, and a separate private-admin command path.

## Single-Group Runtime

Group interactions are scoped to `TG_GROUP_ID`; supported private admin commands are handled separately. AI scheduling no longer starts directly from the handler. `src/libs/group-runtime.ts` is the single runtime for the group:

- message-level dedup by `chatId + messageId + editDate`
- abuse gates for repeated text, per-user bursts, URL flood, and media flood
- debounce with a 5s default quiet wait and a 30s max delay
- one `running` lock plus a `dirty` flag so passive/proactive turns never overlap
- quiet mode for hot chat periods; proactive is paused and ordinary non-mention messages do not trigger
- append-only SQLite records for runtime events, turns, compactions, and group state

## Data Flow

```
Telegram Update
    │
    ▼
app.ts (entry: init SQLite, create Bot, register handlers, start proactive checker)
    │
    ▼
handlers/index.ts (setupHandlers)
    │
    ├─ Update dedup (update-dedup.ts)
    ├─ Private admin DM branch
    │     ├─ /status, /reset, /diary, /wordcloud
    │     └─ /diaryobs, /diaryshow, /diaryedit, /diaryretract, /diaryregen
    ├─ Target-group filter (tgGroupId)
    ├─ Fast group commands
    │     ├─ /nighty → immediate acknowledgement + background timestamp write
    │     └─ /roll → immediate result; background extraction + scheduleCommandTurn()
    ├─ User resolution (persistence.ts → 60s in-process cache)
    ├─ Content extraction (extract-content.ts)
    │     ├─ URL detection (entity + regex fallback)
    │     └─ Raw file_id / thumbnail_file_id / sticker emoji references
    ├─ Unified SQLite wordcloud persistence (local-wordcloud-store.ts)
    │     ├─ target-group human messages only
    │     ├─ command messages skipped; edited-to-command messages deleted from store
    │     ├─ edited messages overwrite by the same message_id
    │     └─ forwarded messages tagged for leaderboard-only counting
    ├─ Buffer push (conversation-buffer.ts; raw media/link markers)
    ├─ Command routing (match-command.ts)
    │     └─ /help, /love, /shock, /stroke
    ├─ Morning greeting logic → generateMorningGreeting()
    ├─ Trigger detection (@mention / reply-to-bot)
    ├─ Local routing (short chat / tech / current-fact)
    ├─ AI classification (classifyMessage)
    │     └─ simple / complex / tech → deepseekFlashModel (no thinking)
    │     └─ advisor → advisorModel (high thinking)
    ├─ Runtime scheduling (group-runtime.ts)
    │     ├─ Persist event in SQLite, dedup, rate-limit, debounce, running lock
    │     └─ Build summary + recent events context
    ├─ AI turn (handleAiTurn → generateAiTurn)
    │     ├─ Static system prompt (buildSystemPrompt)
    │     ├─ User-tail late binding (time, trigger state, tool availability, runtime state)
    │     ├─ Tool calls: send_message, dismiss, saveMemory, setNickname,
│     │               deleteMemory, sendSticker, writeDiary, webSearch,
│     │               describeTelegramMedia, fetchUrlContent, readVideo, startSubagent
    │     ├─ Rich content on demand; session-only cache, no persistent image cache
    │     │     ├─ Images and text share one request; other media/stickers prefer thumbnails
    │     │     └─ JPEG / PNG / GIF / WebP only; known byte signatures win
    │     ├─ Search prefetch: run webSearch before the model; if it succeeds, that counts as this turn's search
    │     ├─ Search-policy retry when `needsSearch` sends without `webSearch`
    │     ├─ Dismiss retry (simple/complex 1×, tech 0×)
    │     ├─ Raw draft rescue: after dismiss, try to rewrite the draft into real send_message output
    │     ├─ Format output (formatForTelegramHtml: Markdown → Telegram HTML)
    │     └─ Send via sendAiMessages (typing indicator, stagger delay, sticker dispatch)
└─ Proactive checker (proactive.ts, env-configurable interval)
          ├─ Candidate window starts after the latest bot output
          ├─ Phase 1: probeGate() — cheap model checks topic relevance
          ├─ Phase 2: generateAiTurn() — full model generates reply
          └─ Activity-revision checks cancel stale output before/between sends
```

## Tool-Call Architecture

Instead of streaming raw text, the bot uses a **tool-call architecture** where the model must explicitly call `send_message` to speak. Raw text output is treated as inner monologue (invisible to users). This reshapes the probability distribution — silence is a structural choice via the `dismiss` tool, not just a prompt instruction.

### Available Tools

| Tool                    | Purpose                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `send_message`          | Send a message to the group (required to speak; can be called multiple times)                                |
| `dismiss`               | Choose not to reply (binary speak/silence choice)                                                            |
| `saveMemory`            | Record a memory about a group member (uid validated against recent members)                                  |
| `setNickname`           | Set/update a group member's preferred nickname                                                               |
| `deleteMemory`          | Remove a specific memory about a group member                                                                |
| `sendSticker`           | Select a sticker by emoji from the hardcoded pack. Invalid emoji cancels sticker sending.                    |
| `describeTelegramMedia` | On-demand media description for triggered turns, plus selected newest-candidate images in proactive turns.   |
| `fetchUrlContent`       | On-demand URL extraction/summarization for links in current turn (passive-triggered turns only).             |
| `readVideo`             | YouTube native Gemini understanding; Bilibili subtitle reading with metadata-only fallback.                  |
| `writeDiary`            | Create/update/retract a structured observation in unified SQLite.                                            |
| `webSearch`             | Tavily search. Tool schema stays stable; when flood protection disables search, the tool returns the reason. |
| `startSubagent`         | One-shot helper for URL/media/technical research. It returns a short summary and cannot send group messages. |

### AiTurnResult

```typescript
type AiTurnResult =
  | { action: "send"; messages: string[]; stickerFileId: string | null }
  | { action: "dismiss"; rawText?: string };
```

- **`send`**: One or more messages + optional sticker (file_id). Sent via `sendAiMessages()` which formats Markdown→HTML, staggers messages (400ms), and dispatches stickers directly by file_id.
- **`dismiss`**: Model chose silence. `rawText` captures any inner monologue as fallback for retry.

### Dismiss Retry

When the bot is triggered (@mention or reply) but the model chooses `dismiss`, the handler retries simple/complex turns once; tech turns do not retry. The retry appends:

> `[系统提示：用户明确@了你或回复了你，你必须回复，不要选择沉默。]`

If all retries still dismiss:

- If `rawText` exists → first rescue it into real `send_message` output; successful rescue sends those messages without a sticker
- If rescue fails → send the raw draft as one message + random sticker
- If `rawText` is empty → send just a random sticker (as reply)

## AI Model Routing

| Provider/model                                   | Usage                                                                            |
| ------------------------------------------------ | -------------------------------------------------------------------------------- |
| DeepSeek Flash, thinking disabled                | Every main chat tier, classification, proactive probes, vision, and light tasks  |
| DeepSeek Flash, high thinking                    | One-shot `startSubagent` advisors only                                           |
| Gemini 3.5 Flash-Lite via Cloudflare AI Gateway  | DeepSeek reply fallback, full-diary notification copy, and YouTube understanding |
| Gemini 3.1 Pro Preview via Cloudflare AI Gateway | Midnight diary generation and admin `/diary` previews                            |

### Why two providers?

- **DeepSeek Flash** supports native vision. Telegram images are sent as `image_url` parts beside current text in one user message; it also handles thumbnails and tweet photos.
- **Gemini 3.5 Flash-Lite** handles unavailable-DeepSeek reply fallback, YouTube understanding, and diary notification copy through Cloudflare AI Gateway; **Gemini 3.1 Pro Preview** writes diaries.
- Provider selection is sticky for the whole reply: if the first DeepSeek step falls back, every later tool step stays on Gemini so thought signatures remain valid. The bot never switches providers after DeepSeek has already emitted a tool call. Fallback activates for network/timeouts, 401–403, 408/409/429, and 5xx responses, but not malformed 400 requests or normal dismissals.

## Local Routing

Not every triggered turn starts with `classifyMessage()`. The handler first runs a lightweight local pass:

- Short casual chats route directly to `simple`
- Technical / math / academic signals route directly to `tech`
- Requests like “be serious”, “explain”, or “go into detail” bias toward `complex` + `preferAdvisor`
- Current-fact questions are marked `needsSearch`
- Light sticker-only chat disables persistent tools for that turn to avoid pointless memory/diary writes

`preferAdvisor` only nudges the non-thinking main turn to call the high-thinking `startSubagent` for a short summary first; the helper cannot speak in the group. Normal triggered turns still can write memory and diary entries.

## Timeout Guards

All critical model calls carry total timeouts so a single turn cannot pin `typing` / `running`: the main model, subagent, vision descriptions, diary generation, and external fetches all have timeout fallback.

### Forced Web Search

When `classifyMessage()` returns `needsSearch=true`, late binding adds a mandatory search requirement. If the model calls `send_message` without first calling `webSearch`, the turn is treated as a policy violation: retry once with a stronger search hint, then use a conservative fallback if it still fails.
If a prefetch search already succeeded before generation, that counts as the required search for the turn. Only if the prefetched result is still insufficient should the model call `webSearch` again.

> `<强制指令：这条消息涉及需要最新/实时信息的内容，你必须先调用 webSearch 工具搜索后再回答。不要凭记忆回答，务必搜索。>`

This prevents the model from skipping the search tool call.

## Context Management

- **Runtime events**: SQLite `runtime_events` are the append-only source for recovery, debugging, and compaction.
- **Conversation buffer**: The in-memory ring buffer remains a hot cache and quick proactive scan window. It is no longer the only context source; restart recovery uses SQLite runtime events plus `runtime_group` state.
- **User data** (nickname, memories, nighty/morning timestamps): Persisted in SQLite and cached in-process for 60 seconds.
- **Rich-content cache**: On-demand media descriptions and URL summaries are cached in-process for the current session only (TTL + size cap), not persisted.
- **Compaction**: When recent events exceed thresholds, the runtime generates a working-memory summary, appends a `runtime_compactions` row, and updates `runtime_group`. Compaction is untrusted working memory; diary is literary archive.

## Wordcloud Pipeline

- `src/services/local-wordcloud-store.ts` keeps the most recent 10 days of group messages plus per-day publish markers in the unified SQLite database.
- `src/libs/wordcloud.ts` handles tokenization, frequency counting, layout, rendering, preview captions, and publishing.
- While running, the noon slot is attempted from 12:00–17:59 and the evening slot after 18:00, tracked by SQLite markers. A missed noon slot is not backfilled.
- After 00:02, the runtime publishes yesterday's final rollup and can catch up after restart.
- Rendered PNG artifacts are retained under `wordcloud-artifacts/` beside the SQLite database and retried up to three times; the final artifact is reused by diary publishing.
- Repeated tokens inside a single message are deduplicated before counting.
- The wordcloud body filters forwarded text, obvious negative tokens, and common filler/function words, while the activity leaderboard still counts forwarded messages.
- Rendering bundles the full Source Han Sans variable font so Simplified Chinese, Traditional Chinese, Japanese, and Korean stay readable.
- The current default layout is center-heavy: high-frequency terms form the core cluster first, with a small amount of vertical short-CJK filling when useful.

## Memory and Diary

- `saveMemory` now prefers reusable user facts, not only permanent traits.
- `writeDiary` is more candidate-first: if a turn leaves a concrete trace, it can be recorded and filtered later.
- `memoryCandidateHints` are only soft hints from the handler, used to improve recall without auto-saving anything.

## Prompt Architecture

### System Prompt (`buildSystemPrompt`)

Fully static and KV-cache friendly:

- Persona (name/reading/identity from env) and naturalness guidelines (based on human vs AI chat analysis)
- Tool-call, group-chat, and safety rules
- No current time, current user, memories, recent history, or runtime state

### Late-Binding Prompt (`buildLateBindingPrompt`)

Appended per-turn with dynamic feedback:

- Whether the bot was @mentioned or replied-to
- Current time
- Search/media tool availability
- Hot chat / quiet mode / flood-protection state
- Mandatory search hint when `needsSearch=true`
- Human-likeness feedback: if recent bot messages end with `。` too often or average length > 40 chars, a reminder is injected

### Probe Prompt (`buildProbeSystemPrompt`)

A lean variant for the proactive probe gate — persona only, no per-user memories or naturalness guidelines.

## Message Output Pipeline

1. **`generateAiTurn()`** returns `AiTurnResult` (`send` or `dismiss`)
2. **Dismiss retry** (triggered path only): simple/complex once, tech never
3. **`sendAiMessages()`**:
   - Formats each message via `formatForTelegramHtml()` (Markdown → Telegram HTML, LaTeX → Unicode)
   - First message replies to the user's message; subsequent messages are standalone
   - Staggers messages with env-configurable delay (default 400ms; mimics human typing)
   - Dispatches sticker after all text messages (or sticker-only with reply reference)
   - Falls back to plain text if HTML parsing fails
4. **Buffer push**: Each sent message is pushed to the conversation buffer

## Proactive Speaking (Two-Stage Probe)

`proactive.ts` checks recent buffer history on env-configurable intervals/windows (defaults: every 15 seconds, last 3 minutes):

| Activity level | Recent user messages | Cooldown    |
| -------------- | -------------------- | ----------- |
| High (≥7 msgs) | ≥7                   | 90 seconds  |
| Medium (3-6)   | 3-6                  | 180 seconds |
| Low (1-2)      | 1-2                  | 360 seconds |

If cooldown has elapsed, the checker finds the latest bot output and treats only later user messages as reply candidates. Older messages remain reference context. It refuses to run while ingestion or command turns are active, snapshots the runtime activity revision, and rechecks it after the probe, before sending, and between multiple messages.

1. **Phase 1 — Probe**: `probeGate()` runs the cheap model (`flashNoThink`) with `buildProbeSystemPrompt()` and lightweight `dismiss`/`send_message` tools. If probe dismisses or activity changes, stop here.
2. **Phase 2 — Full model**: If probe activates, `generateAiTurn()` runs with persistent tools disabled and candidate-image understanding conditionally available. Any new user or bot activity invalidates the result.

The proactive path uses `ProactiveCallbacks` interface (`sendText`, `sendSticker`, `sendChatAction`) to format messages, dispatch stickers, and show typing indicators — matching the handler path's formatting.

Transient proactive failures trigger bounded exponential backoff. Any non-throwing check, including a valid silent result, clears the consecutive-failure count; the checker continues scheduling until explicit shutdown. Admin `/status` exposes its timer, failure count, timestamps, and latest error.

## Diary System

The bot records structured conversational observations via the `writeDiary` AI tool. Compaction remains separate working memory and never substitutes for the diary archive.

### Observation Recording

- `writeDiary` creates, updates, supersedes, or retracts `DiaryObservationV2` documents in `diaryObservations`.
- Records include event/reaction/interpretation fields, confidence, salience, status, and optional stable subject uid/name/username snapshots.
- Subject uid participates in deduplication so observations about different people are not merged accidentally.

### Midnight Generation

An env-configurable interval timer (`checkAndGenerateDiary` in `src/libs/diary.ts`, default 60s) checks dates based on `APP_TIMEZONE`. It runs once at startup and scans the previous three dates, so restarts can catch up recent missing diaries:

1. After 00:02, it selects up to 12 active observations. If none survive selection, legacy `diary/{date}.entries` are used; if those are also absent, a bounded sample from that day's persisted runtime `events` provides fallback material.
2. Gemini 3.1 Pro Preview composes the diary. The text and a generation record (model, prompt/style versions, observation ids, usage/status) are saved to SQLite; errors and empty output receive up to three attempts.
3. The previous-day wordcloud artifact is generated or reused. Telegram channel publishing sends it as the photo caption when the diary fits 1024 characters, otherwise it sends the diary as following text.
4. GitHub publishing creates blobs, a tree, and one commit containing the Markdown and optional `source/img/diary/` image, then non-force updates `main`. Markdown uses root-relative `/img/diary/...` URLs.
5. If configured GitHub publishing succeeds, the bot polls Pages readiness. Gemini 3.5 Flash-Lite then reads the full diary and writes a restrained 1–2 sentence group notice regardless of GitHub availability; link state and challenge copy are appended deterministically. Notice generation and group delivery each receive up to three attempts. Successful delivery is recorded in SQLite; startup and interval checks retry an unsent notice from the persisted diary without repeating channel or GitHub publication.

### Admin Diary Commands

Private admin DMs provide `/diary` and `/diaryregen [date]` previews plus `/diaryobs`, `/diaryshow`, `/diaryedit`, and `/diaryretract` observation management. Preview/regeneration commands do not save or publish the generated diary.

### SQLite Records

```
diary row for YYYY-MM-DD
  ├── entries?: DiaryEntry[]              (legacy fallback)
  ├── diary?: string
  ├── generatedAt?: number
  └── generationRecords?: DiaryGenerationRecord[]

diary_observations row for id
  └── DiaryObservationV2

diary_notification_deliveries row for YYYY-MM-DD
  └── sentAt: number
```

### Timezone

All date formatting uses env-configurable timezone (`APP_TIMEZONE`, default `Asia/Shanghai`), centralized in `src/libs/time.ts` via `dayjs`. Functions: `todayDateStr()`, `yesterdayDateStr()`, `formatTimestamp()`, `formatSystemPromptTime()`.
