# Commands & Interactions

## Slash Commands

| Command             | Who        | Description                                                          |
| ------------------- | ---------- | -------------------------------------------------------------------- |
| `/help`             | Anyone     | Show help text                                                       |
| `/love`             | Anyone     | Get affection scoring breakdown + tsundere response                  |
| `/shock`            | Anyone     | Zap the bot and trigger a shocked / frazzled reaction                |
| `/stroke`           | Anyone     | Pet the bot and trigger a frazzled reaction                          |
| `/nighty`           | Anyone     | Say goodnight; bot sends a morning greeting 8+ hours later           |
| `/status`           | Admin only | Show uptime, buffer size, memory user count                          |
| `/reset`            | Admin only | Clear the conversation buffer and runtime summary                    |
| `/diary`            | Admin only | Generate today's diary preview (private chat only)                   |
| `/wordcloud [date]` | Admin only | Generate a wordcloud preview for a specific date (private chat only) |

Admin-only commands check `TG_ADMIN_UID` against the sender's user ID.

## Natural Language Triggers

### @mention or Reply

When a user @mentions the bot or replies to one of its messages, the full AI pipeline is triggered:

1. **Classification** — `classifyMessage()` categorizes the message as `simple`, `complex`, or `tech`, and whether web search is needed.
2. **Model selection** — `simple` → flash-no-think, `complex` → flash-think, `tech` → pro-think.
3. **Tool-augmented generation** — `generateAiTurn()` runs with tools (send_message, dismiss, memory, nickname, sticker, optional web search).
4. **Dismiss retry** — If the model chooses `dismiss` despite being triggered, retries up to 3 times with escalating reply hints. Falls back to raw text or sticker if all retries fail; if there is a raw draft, the handler first tries to rescue it into real `send_message` output.
5. **Output** — Messages formatted via `formatForTelegramHtml()` (Markdown→Telegram HTML), sent with typing indicator and optional sticker dispatch.

Before classification, the handler runs a lightweight local route so short chats, technical questions, detailed requests, and current-fact queries can be fast-pathed without always invoking `classifyMessage()`.

### Special Context Records

- Some bot outputs that do **not** originate from `send_message` are still written into the conversation buffer, such as `/love`, `/shock`, `/stroke`, `/reset`, standalone morning greetings, and daily diary notifications.
- In XML history, these entries carry a `kind="..."` attribute so the model can treat them as real prior events rather than ordinary user chat lines.

### Images & Media

- The handler no longer pre-downloads or pre-describes media.
- Context now includes raw Telegram references only (`file_id` / `thumbnail_file_id`) for current-turn and reply-to media.
- During **passive replies** (@mention/reply), the model can call `describeTelegramMedia` on demand when media content is actually needed.
- During **proactive replies**, media/link tools are disabled to avoid unconditional fetches.

### URLs

- URLs are extracted from Telegram entities + regex fallback.
- No eager fetch is performed in handlers.
- During **passive replies**, the model can call `fetchUrlContent` on demand.
- `fetchUrlContent` uses a three-tier strategy:
  1. **Twitter/X status links** → FxEmbed API v2 (`/2/status/{id}`)
  2. **Other links** → direct `fetch()` + HTML title/meta description extraction
  3. **Fallback** → Tavily Extract summarization
- URL content cache is in-memory (session-scoped), not persisted to Firestore.

### Stickers

Stickers are no longer described or cached. The bot only reads the emoji on incoming stickers for lightweight context and can send hardcoded stickers by emoji when responding.

When answering, the LLM can respond with:

- **Text + sticker**: Calls `send_message` then `sendSticker` — sticker is dispatched after text messages.
- **Sticker only**: Calls only `sendSticker` without `send_message` — sticker is sent with a reply reference.
- **No sticker**: Calls only `send_message` — plain text reply.

The `sendSticker` tool exposes the hardcoded emoji list. The LLM selects by providing an emoji. Invalid emoji cancels sticker sending.

### Wordcloud Preview and Counting Rules

- `/wordcloud [date]` is available only in admin DMs; without an explicit date it previews today.
- Preview captions adapt to the requested date and say “today”, “yesterday”, or the explicit date instead of hard-coding “yesterday”.
- Forwarded messages still count toward the activity leaderboard and `messageCount`, but their forwarded text is excluded from the wordcloud body.
- When forwarded messages are present for that day, the caption explicitly calls out that counting rule.

### Videos, GIFs, Video Messages, Documents, and Audio

- The context preserves `file_id` and `thumbnail_file_id` references for these media types.
- The model can decide whether to call `describeTelegramMedia` and which file id to inspect.
- No eager thumbnail download/description is done in the message handler.

### Goodnight / Good Morning

- **Goodnight**: `/nighty` command only → stores a `nightyTimestamp` in Firestore.
- **Good morning**: If a user with a `nightyTimestamp` ≥8 hours old sends a message:
  - If they also @mention/reply to the bot → a system hint is injected so the reply naturally opens with a wake-up greeting.
  - If not → a standalone morning greeting is generated and sent.

### Love Confession

Text matching `LOVE_REGEX` (我爱你, 喜欢你, 嫁给我, love, etc.) triggers `generateLoveResponse()` — a dedicated prompt that scores affection based on the user's memories (freeform scoring criteria, memory-based items, total score) and delivers a persona-consistent tsundere response.

## LLM Tools

The `generateAiTurn()` function exposes these tools to the model:

| Tool                    | Description                                                                       |
| ----------------------- | --------------------------------------------------------------------------------- |
| `send_message`          | Send a message to the group — the only way to speak; can be called multiple times |
| `dismiss`               | Choose not to reply (binary speak/silence choice)                                 |
| `saveMemory`            | Record a memory about a group member (uid must be from the recent members list)   |
| `setNickname`           | Set/update a group member's preferred nickname                                    |
| `deleteMemory`          | Remove a specific memory about a group member                                     |
| `sendSticker`           | Select a sticker by emoji from the hardcoded pack; invalid emoji cancels sending  |
| `describeTelegramMedia` | On-demand media description by `file_id` / `thumbnail_file_id` (passive only)     |
| `fetchUrlContent`       | On-demand URL extraction/summarization for links in current turn (passive only)   |
| `writeDiary`            | Record a diary observation about the current conversation                         |
| `webSearch`             | Tavily search (only attached when `needsSearch=true` from classification)         |

If a web search already succeeded during prefetch before generation, that counts as the turn's required search; the model only needs to call `webSearch` again when the prefetched result is still insufficient.

All memory/nickname tools validate the `uid` against `allowedUids` (the set of UIDs present in the recent conversation buffer) before writing to Firestore.

### Tool Call Flow

```
User message → classifyMessage() → generateAiTurn()
                                        │
                                        ├─ Model calls send_message → text added to messages[]
                                        ├─ Model calls dismiss → dismissed = true
                                        ├─ Model calls saveMemory → Firestore write
                                        ├─ Model calls setNickname → Firestore write
                                        ├─ Model calls deleteMemory → Firestore delete
                                         ├─ Model calls sendSticker → file_id selected for dispatch
                                         ├─ Model calls writeDiary → Firestore diary write
                                         ├─ Model calls webSearch → Tavily search executed
                                        │
                                        ▼
                                 AiTurnResult
                                  ├─ { action: "send", messages, stickerFileId }
                                  └─ { action: "dismiss", rawText? }
```

### Dismiss Retry (Triggered Path Only)

When the user explicitly @mentions or replies to the bot and the model chooses `dismiss`:

1. Retry up to 3 times, each time appending `[系统提示：用户明确@了你或回复了你，你必须回复，不要选择沉默。]` to `systemHint`.
2. After all retries, if still `dismiss`:
   - If `rawText` exists (model produced inner monologue) → send `rawText` as message + random sticker as fallback.
   - If `rawText` is empty → send only a random sticker (with reply reference).

Proactive messages are NOT retried — silence is a valid and expected outcome when the bot speaks unprompted.

## Message Formatting

All bot output is processed through `formatForTelegramHtml()` before sending:

- **Code blocks**: ` ```code``` ` → `<pre><code>`
- **Inline code**: `` `code` `` → `<code>`
- **Bold**: `**text**` → `<b>text</b>`
- **Italic**: `*text*` → `<i>text</i>`
- **Strikethrough**: `~~text~~` → `<s>text</s>`
- **Links**: `[text](url)` → `<a href="url">text</a>`
- **LaTeX math**: `$...$` → `<code>` with Unicode conversion, `$$...$$` → `<pre><code>`
- Falls back to plain text if HTML parsing fails

## Typing Indicator

A `sendChatAction("typing")` is sent at the start of `handleAiTurn()` and after each dismiss retry, so users see "typing..." while the AI generates.
