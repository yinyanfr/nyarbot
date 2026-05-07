# Commands & Interactions

## Slash Commands

| Command | Who | Description |
| --- | --- | --- |
| `/help` | Anyone | Show help text |
| `/love` | Anyone | Receive a tsundere rejection |
| `/nighty` | Anyone | Say goodnight; bot sends a morning greeting 8+ hours later |
| `/status` | Admin only | Show uptime, buffer size, memory count, image cache count |
| `/reset` | Admin only | Clear the conversation buffer |

Admin-only commands check `TG_ADMIN_UID` against the sender's user ID.

## Natural Language Triggers

### @mention or Reply
When a user @mentions the bot or replies to one of its messages, the full AI pipeline is triggered:

1. **Classification** — `classifyMessage()` categorizes the message as `simple`, `complex`, or `tech`, and whether web search is needed.
2. **Model selection** — `simple` → flash-no-think, `complex` → flash-think, `tech` → pro-think.
3. **Tool-augmented streaming** — `generateResponse()` streams a reply with optional tool calls (memory, nickname, sticker, web search).
4. **Post-processing** — Sticker dispatch, image cache write.

### Images
- **Cached**: If the Telegram `file_id` was seen before and a Firestore description exists, the description is injected as `[图片: description]` text.
- **Fresh**: The image is downloaded as a data URL, sent to **Gemini 2.5 Flash** for description, and the description is injected into DeepSeek's prompt as text. The description is then cached in Firestore (30-day TTL).

### URLs
- URLs are extracted from both Telegram entities and a regex fallback.
- When the bot is triggered (@mention/reply), `fetchUrlContent()` uses Tavily's `urlExtract` tool + DeepSeek summarization.
- When the bot is NOT triggered, URL content is still extracted asynchronously and pushed to the conversation buffer as a system entry — this gives the proactive checker context.

### Stickers
Telegram sticker emoji are extracted and sent to the LLM as `[贴纸: emoji]`. The LLM can respond with a `sendSticker` tool call using one of the Miaohaha pack emojis.

### Goodnight / Good Morning
- **Goodnight**: `/nighty` command or text matching the regex (晚安, night, 睡了, etc.) → stores a `nightyTimestamp` in Firestore.
- **Good morning**: If a user with a `nightyTimestamp` ≥8 hours old sends a message:
  - If they also @mention/reply to the bot → a system hint is injected so the reply naturally opens with a wake-up greeting.
  - If not → a standalone morning greeting is generated and sent.

### Love Confession
Text matching `LOVE_REGEX` (我爱你, 喜欢你, 嫁给我, love, etc.) triggers `generateLoveRejection()` — a dedicated prompt that uses the user's memories to craft a personalized tsundere rejection.

## LLM Tools

The `generateResponse()` function exposes these tools to the model:

| Tool | Description |
| --- | --- |
| `saveMemory` | Record a memory about a group member (uid must be from the recent members list) |
| `setNickname` | Set/update a group member's preferred nickname |
| `deleteMemory` | Remove a specific memory about a group member |
| `sendSticker` | Select a Miaohaha sticker emoji to send alongside the reply |
| `webSearch` | Tavily search (only attached when `needsSearch=true` from classification) |

All memory/nickname tools validate the `uid` against `allowedUids` (the set of UIDs present in the recent conversation buffer) before writing to Firestore.