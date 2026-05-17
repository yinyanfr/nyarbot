# Commands & Interactions

## Slash Commands

| Command   | Who        | Description                                                |
| --------- | ---------- | ---------------------------------------------------------- |
| `/help`   | Anyone     | Show help text                                             |
| `/love`   | Anyone     | Get affection scoring breakdown + tsundere response        |
| `/nighty` | Anyone     | Say goodnight; bot sends a morning greeting 8+ hours later |
| `/status` | Admin only | Show uptime, buffer size, memory count, image cache count  |
| `/reset`  | Admin only | Clear the conversation buffer                              |
| `/diary`  | Admin only | Generate today's diary preview (private chat only)         |

Admin-only commands check `TG_ADMIN_UID` against the sender's user ID.

## Natural Language Triggers

### @mention or Reply

When a user @mentions the bot or replies to one of its messages, the full AI pipeline is triggered:

1. **Classification** — `classifyMessage()` categorizes the message as `simple`, `complex`, or `tech`, and whether web search is needed.
2. **Model selection** — `simple` → flash-no-think, `complex` → flash-think, `tech` → pro-think.
3. **Tool-augmented generation** — `generateAiTurn()` runs with tools (send_message, dismiss, memory, nickname, sticker, optional web search).
4. **Dismiss retry** — If the model chooses `dismiss` despite being triggered, retries up to 3 times with escalating reply hints. Falls back to raw text or sticker if all retries fail.
5. **Output** — Messages formatted via `formatForTelegramHtml()` (Markdown→Telegram HTML), sent with typing indicator and optional sticker dispatch.

### Images

- **Direct & reply-to**: Images from the user's own message (`msg.photo`) and from the replied-to message (`msg.reply_to_message.photo`) are both processed.
- **Cached**: If the Telegram `file_id` was seen before and a Firestore description exists, the description is injected as `[图片: description]` text.
- **Fresh**: The image is downloaded as a data URL, sent to **Gemini 3 Flash Preview** for description, and the description is injected into DeepSeek's prompt as text. The description is then cached in Firestore (30-day TTL).
- **Buffer enrichment**: Image descriptions are included inline in the conversation buffer (`[图片: desc]` instead of bare `[图片]`), giving the proactive checker and subsequent triggered turns full image context.
- **Caching is unconditional**: All images are described and cached immediately, regardless of whether the bot was triggered — this ensures proactive context is always available.

### URLs

- URLs are extracted from both Telegram entities and a regex fallback.
- `fetchUrlContent()` uses a three-tier strategy:
  1. **Twitter/X status links** (`twitter.com`/`x.com`/`*/status/*`) → **fxtwitter API** (free, no auth). Extracts author, text, and up to 4 photos. Photos are sent to **Gemini 3 Flash Preview** in a single batch for ≤150-char Chinese descriptions. Quoted tweets are also extracted.
  2. **Other links** → direct `fetch()` with 8s timeout, extracting `<title>` and `<meta name="description">` from HTML.
  3. **Fallback** → Tavily Extract (AI-powered summarization).
- **Success**: Content is pushed to the conversation buffer:
  - Tweets → `[推文]: [Tweet url | @handle (Name): text | 配图: desc1; desc2]`
  - Normal links → `[链接]: [链接内容: title — desc]`
- **Failure**: Nothing is pushed to the buffer. In proactive mode, the bot stays silent. In triggered (passive) mode, the LLM sees `[链接 url: 无法获取内容]` and can ask the user to describe the link.
- **No persistent storage**: Link descriptions live only in the in-memory conversation buffer (max 30 entries).

### Stickers

Stickers are no longer described or cached. The bot only reads the emoji on incoming stickers for lightweight context and can send hardcoded stickers by emoji when responding.

When answering, the LLM can respond with:

- **Text + sticker**: Calls `send_message` then `sendSticker` — sticker is dispatched after text messages.
- **Sticker only**: Calls only `sendSticker` without `send_message` — sticker is sent with a reply reference.
- **No sticker**: Calls only `send_message` — plain text reply.

The `sendSticker` tool exposes the hardcoded emoji list. The LLM selects by providing an emoji. Invalid emoji cancels sticker sending.

### Videos, GIFs, Video Messages, Documents, and Audio

Telegram provides a free `thumbnail` field (a tiny JPEG, typically ≤320×320 and under 200 KB) on `Video`, `Animation` (GIF), `VideoNote`, `Document`, and `Audio` messages. This thumbnail is a separate file from the full media — no bytes from the actual video/document need to be downloaded.

The bot downloads thumbnails via `getFile(thumbnail_file_id)`, describes them through Gemini, and injects type-tagged descriptions into the AI prompt and conversation buffer:

| Media type      | Format                          | Thumbnail source                     |
| --------------- | ------------------------------- | ------------------------------------ |
| Video           | `[视频: description]`           | `cover` (largest size) → `thumbnail` |
| Animation (GIF) | `[GIF动画: description]`        | `thumbnail`                          |
| Video note      | `[视频消息: description]`       | `thumbnail`                          |
| Document        | `[文件: filename: description]` | `thumbnail`                          |
| Audio           | `[音频: title: description]`    | `thumbnail` (album cover)            |

- **Cached**: Thumbnail descriptions are cached in Firestore `images/{thumbnail_file_id}` — the same cache used for photos (shared 30-day TTL).
- **Text-only fallback**: If no thumbnail is available (rare), text markers like `[视频]` or `[文件: report.pdf]` are injected instead, so the bot at least knows media was sent.
- **Reply-to media**: Thumbnails from replied-to video/animation/video_note/document/audio messages are also processed, matching the existing reply-to photo behavior.
- **Zero sticker processing**: Stickers are not downloaded, described, cached, or migrated. Thumbnails are still pre-generated JPEG/WebP images by Telegram, so no video extraction is needed.
- **Unconditional caching**: All media thumbnails are described and cached regardless of trigger state — proactive context is always available.

### Goodnight / Good Morning

- **Goodnight**: `/nighty` command only → stores a `nightyTimestamp` in Firestore.
- **Good morning**: If a user with a `nightyTimestamp` ≥8 hours old sends a message:
  - If they also @mention/reply to the bot → a system hint is injected so the reply naturally opens with a wake-up greeting.
  - If not → a standalone morning greeting is generated and sent.

### Love Confession

Text matching `LOVE_REGEX` (我爱你, 喜欢你, 嫁给我, love, etc.) triggers `generateLoveResponse()` — a dedicated prompt that scores affection based on the user's memories (freeform scoring criteria, memory-based items, total score) and delivers a persona-consistent tsundere response.

## LLM Tools

The `generateAiTurn()` function exposes these tools to the model:

| Tool           | Description                                                                       |
| -------------- | --------------------------------------------------------------------------------- |
| `send_message` | Send a message to the group — the only way to speak; can be called multiple times |
| `dismiss`      | Choose not to reply (binary speak/silence choice)                                 |
| `saveMemory`   | Record a memory about a group member (uid must be from the recent members list)   |
| `setNickname`  | Set/update a group member's preferred nickname                                    |
| `deleteMemory` | Remove a specific memory about a group member                                     |
| `sendSticker`  | Select a sticker by emoji from the hardcoded pack; invalid emoji cancels sending  |
| `writeDiary`   | Record a diary observation about the current conversation                         |
| `webSearch`    | Tavily search (only attached when `needsSearch=true` from classification)         |

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
