# Architecture

nyarbot is a single-group Telegram bot written in TypeScript (ESM) with a catgirl persona.

## Data Flow

```
Telegram Update
    │
    ▼
app.ts (entry: init Firebase, create Bot, register handlers, start proactive checker)
    │
    ▼
handlers/index.ts (setupHandlers)
    │
    ├─ Update dedup (update-dedup.ts)
    ├─ Group filter (tgGroupId)
    ├─ User resolution (firestore.ts → 60s in-process cache)
    ├─ Content extraction (extract-content.ts)
    │     ├─ URL detection (entity + regex fallback)
    │     ├─ Image: cache lookup → download → Gemini description
    │     │     (includes reply-to images: msg.reply_to_message.photo)
    │     ├─ Media thumbnails: video/animation/video_note/document/audio
    │     │     → cache lookup (thumbnail file_id) → download thumbnail
    │     │     → Gemini description (shared image cache)
    │     │     (includes reply-to media; no ffmpeg — Telegram pre-generates thumbnails)
    │     └─ Sticker: cache lookup (received_stickers) → download →
    │           convert format (webm→webp via ffmpeg) → Gemini description
    │           → cache to received_stickers (only if description succeeds)
    ├─ Buffer push (conversation-buffer.ts)
    │     └─ Images: push inline descriptions ("[图片: desc]" not just "[图片]")
    │     └─ Media: push type-tagged descriptions ("[视频: desc]", "[GIF动画: desc]", etc.)
    ├─ Image caching (firestore.ts) — cache ALL images immediately after Gemini describes them
    ├─ Command routing (match-command.ts)
    │     ├─ /help
    │     ├─ /love → generateLoveRejection()
    │     ├─ /status (admin)
    │     └─ /reset (admin)
    ├─ Nighty detection → setNightyTimestamp()
    ├─ Morning greeting logic → generateMorningGreeting()
    ├─ Trigger detection (@mention / reply-to-bot)
    ├─ Await URL content (ai.ts → fetchUrlContent)
    │     ├─ Twitter/X status links → fxtwitter API (free) → Gemini photo descriptions
    │     ├─ Other links → direct fetch (extract <title> + <meta description>)
    │     └─ Fallback → Tavily Extract (ai-powered summarization)
    ├─ URL content buffer push
    │     ├─ Successful fetches → pushed as system entries ("[推文]" or "[链接]")
    │     └─ Failed fetches → silently ignored (no buffer entry, no proactive noise)
    ├─ Fresh image description (ai.ts → Gemini)
    ├─ AI classification (classifyMessage)
    │     └─ simple → flashNoThinkModel
    │     └─ complex → flashThinkModel
    │     └─ tech → proThinkModel
    ├─ AI turn (handleAiTurn → generateAiTurn)
    │     ├─ System prompt (buildSystemPrompt + buildLateBindingPrompt)
    │     ├─ Tool calls: send_message, dismiss, saveMemory, setNickname,
    │     │               deleteMemory, sendSticker, adoptSticker
    │     ├─ Conditional: webSearch (tavilySearch, when needsSearch=true)
    │     ├─ Dismiss retry (up to 3×, escalating reply hint)
    │     ├─ Format output (formatForTelegramHtml: Markdown → Telegram HTML)
    │     └─ Send via sendAiMessages (typing indicator, stagger delay, sticker dispatch)
    └─ Proactive checker (proactive.ts, 15s interval)
          ├─ Phase 1: probeGate() — cheap model checks topic relevance
          └─ Phase 2: generateAiTurn() — full model generates reply
                └─ ProactiveCallbacks: sendText, sendSticker, sendChatAction
```

## Tool-Call Architecture

Instead of streaming raw text, the bot uses a **tool-call architecture** where the model must explicitly call `send_message` to speak. Raw text output is treated as inner monologue (invisible to users). This reshapes the probability distribution — silence is a structural choice via the `dismiss` tool, not just a prompt instruction.

### Available Tools

| Tool           | Purpose                                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `send_message` | Send a message to the group (required to speak; can be called multiple times)                                                                                                        |
| `dismiss`      | Choose not to reply (binary speak/silence choice)                                                                                                                                    |
| `saveMemory`   | Record a memory about a group member (uid validated against recent members)                                                                                                          |
| `setNickname`  | Set/update a group member's preferred nickname                                                                                                                                       |
| `deleteMemory` | Remove a specific memory about a group member                                                                                                                                        |
| `sendSticker`  | Select a sticker by its Chinese description (numbered list), with multi-level fallback: exact/substring → DeepSeek Flash semantic match → emoji → random. Returns file_id directly.  |
| `adoptSticker` | Adopt a user-sent sticker into the bot's library (from `received_stickers` cache). Sets `stickerFileId` so the sticker is sent to chat. Rejects stickers without valid descriptions. |
| `webSearch`    | Tavily search (only attached when `needsSearch=true` from classification)                                                                                                            |

### AiTurnResult

```typescript
type AiTurnResult =
  | { action: "send"; messages: string[]; stickerFileId: string | null }
  | { action: "dismiss"; rawText?: string };
```

- **`send`**: One or more messages + optional sticker (file_id). Sent via `sendAiMessages()` which formats Markdown→HTML, staggers messages (400ms), and dispatches stickers directly by file_id.
- **`dismiss`**: Model chose silence. `rawText` captures any inner monologue as fallback for retry.

### Dismiss Retry

When the bot is triggered (@mention or reply) but the model chooses `dismiss`, the handler retries up to 3 times. Each retry appends an escalating hint:

> `[系统提示：用户明确@了你或回复了你，你必须回复，不要选择沉默。]`

If all retries still dismiss:

- If `rawText` exists → send it as a single message + random sticker
- If `rawText` is empty → send just a random sticker (as reply)

## AI Model Routing

```
┌─────────────────────────────────────────────────────────┐
│                  DeepSeek API                           │
│  ┌──────────────────┐  ┌─────────────────────────────┐ │
│  │  deepseek-v4-flash                               │ │
│  │  ┌──────────────┐ │  ┌──────────────────────────┐ │ │
│  │  │ No-think     │ │  │ Think (enabled)          │ │ │
│  │  │ (disabled)   │ │  │                          │ │ │
│  │  │              │ │  │                          │ │ │
│  │  │ • classify   │ │  │ • complex conversations  │ │ │
│  │  │ • good-morn  │ │  │ • tool-calling responses │ │ │
│  │  │ • love-rej   │ │  │   (send_message, dismiss │ │ │
│  │  │ • image desc │ │  │    saveMemory, etc.)     │ │ │
│  │  │ • URL desc   │ │  │                          │ │ │
│  │  │ • probe gate │ │  │                          │ │ │
│  │  └──────────────┘ │  └──────────────────────────┘ │ │
│  └──────────────────┘                                │ │
│  ┌──────────────────┐                                │ │
│  │  deepseek-v4-pro  │                                │ │
│  │  Think (enabled)  │                                │ │
│  │                    │                                │ │
│  │  • tech questions  │                                │ │
│  └──────────────────┘                                │ │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  Cloudflare AI Gateway → Gemini 2.5 Flash              │
│                                                          │
│  • describeImage() — vision descriptions for DeepSeek    │
│  • describeTweetPhotos() — tweet photo descriptions      │
└─────────────────────────────────────────────────────────┘
```

### Why two providers?

- **DeepSeek v4** has no vision capability. Sending `image_url` content parts results in a 400 error.
- **Gemini 2.5 Flash** handles image understanding via the Cloudflare AI Gateway. Descriptions are generated at request time and injected as `[图片: description]` text into DeepSeek's prompt.

### Forced Web Search

When `classifyMessage()` returns `needsSearch=true`, the `webSearch` tool (Tavily) is included in the tool set. Additionally, a mandatory instruction is appended to the user prompt:

> `<强制指令：这条消息涉及需要最新/实时信息的内容，你必须先调用 webSearch 工具搜索后再回答。不要凭记忆回答，务必搜索。>`

This prevents the model from skipping the search tool call.

## Context Management

- **Conversation buffer**: In-memory ring buffer (max 60 entries per group, 500 chars per entry). Pushed on every user message and every bot reply. Used for `buildSystemPrompt` and `probeGate` proactive check. Lost on process restart. Image entries include inline Gemini descriptions (e.g. `[图片: a cat sleeping]`); URL entries only include successfully fetched content (tweets: `[推文]: [Tweet url | @x: text | 配图: ...]`, normal: `[链接内容]: title — desc`). Raw URLs never enter the buffer to avoid proactive noise on unfetchable links.
- **User data** (nickname, memories, nighty/morning timestamps): Persisted in Firestore. Cached in-process for 60 seconds.
- **Image cache**: Firestore `images/{fileId}` with 30-day TTL. On cache hit, the stored description is reused instead of re-downloading and re-describing the image.

## Prompt Architecture

### System Prompt (`buildSystemPrompt`)

Built per-turn with:

- Catgirl persona and naturalness guidelines (based on human vs AI chat analysis)
- Current user context (nickname, uid, memories)
- Recent members list (for uid validation in memory/nickname tools)
- Recent chat history

### Late-Binding Prompt (`buildLateBindingPrompt`)

Appended per-turn with dynamic feedback:

- Whether the bot was @mentioned or replied-to
- Human-likeness feedback: if recent bot messages end with `。` too often or average length > 40 chars, a reminder is injected

### Probe Prompt (`buildProbeSystemPrompt`)

A lean variant for the proactive probe gate — persona only, no per-user memories or naturalness guidelines.

## Message Output Pipeline

1. **`generateAiTurn()`** returns `AiTurnResult` (`send` or `dismiss`)
2. **Dismiss retry** (triggered path only): up to 3 retries with escalating hints
3. **`sendAiMessages()`**:
   - Formats each message via `formatForTelegramHtml()` (Markdown → Telegram HTML, LaTeX → Unicode)
   - First message replies to the user's message; subsequent messages are standalone
   - Staggers messages with 400ms delay (mimics human typing)
   - Dispatches sticker after all text messages (or sticker-only with reply reference)
   - Falls back to plain text if HTML parsing fails
4. **Buffer push**: Each sent message is pushed to the conversation buffer

## Proactive Speaking (Two-Stage Probe)

Every 15 seconds, `proactive.ts` checks the last 3 minutes of buffer history:

| Activity level | Recent user messages | Cooldown    |
| -------------- | -------------------- | ----------- |
| High (≥7 msgs) | ≥7                   | 90 seconds  |
| Medium (3-6)   | 3-6                  | 180 seconds |
| Low (1-2)      | 1-2                  | 360 seconds |

If cooldown has elapsed:

1. **Phase 1 — Probe**: `probeGate()` runs the cheap model (`flashNoThink`) with `buildProbeSystemPrompt()` and lightweight `dismiss`/`send_message` tools. If probe dismisses, stop here.
2. **Phase 2 — Full model**: If probe activates, `generateAiTurn()` runs the full model with all tools, `tier: "simple"` and `systemHint: null`.

The proactive path uses `ProactiveCallbacks` interface (`sendText`, `sendSticker`, `sendChatAction`) to format messages, dispatch stickers, and show typing indicators — matching the handler path's formatting.

The proactive checker stops after 5 consecutive failures.
