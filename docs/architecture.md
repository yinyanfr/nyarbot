# Architecture

nyarbot is a single-group Telegram bot written in TypeScript (ESM) with a catgirl persona.

## Data Flow

```
Telegram Update
    │
    ▼
app.ts (entry: init Firebase, create Bot, register handlers, start polling)
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
    │     └─ Sticker emoji extraction
    ├─ Buffer push (conversation-buffer.ts)
    ├─ Command routing (match-command.ts)
    │     ├─ /help
    │     ├─ /love → generateLoveRejection()
    │     ├─ /status (admin)
    │     └─ /reset (admin)
    ├─ Nighty detection → setNightyTimestamp()
    ├─ Morning greeting logic → generateMorningGreeting()
    ├─ Trigger detection (@mention / reply-to-bot)
    ├─ Await URL content (ai.ts → tavilyExtract)
    ├─ Fresh image description (ai.ts → Gemini)
    ├─ AI classification (classifyMessage)
    │     └─ simple → flashNoThinkModel
    │     └─ complex → flashThinkModel
    │     └─ tech → proThinkModel
    ├─ AI response (generateResponse)
    │     └─ System prompt (system-prompt.ts)
    │     └─ Tool calls: saveMemory, setNickname, deleteMemory, sendSticker
    │     └─ Optional: webSearch (tavilySearch, when needsSearch=true)
    │     └─ Streamed reply via sendMessage + editMessageText
    └─ Proactive checker (proactive.ts, 15s interval)
          └─ shouldSpeak() → sendMessage if non-SILENT
```

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
│  │  │ • good-morn  │ │  │ • tool-calling responses│ │ │
│  │  │ • love-rej   │ │  │                          │ │ │
│  │  │ • proactive  │ │  │                          │ │ │
│  │  │ • image desc │ │  │                          │ │ │
│  │  │ • URL desc   │ │  │                          │ │ │
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
└─────────────────────────────────────────────────────────┘
```

Why two providers?

- **DeepSeek v4** has no vision capability. Sending `image_url` content parts results in a 400 error.
- **Gemini 2.5 Flash** handles image understanding via the Cloudflare AI Gateway. Descriptions are generated at request time and injected as `[图片: description]` text into DeepSeek's prompt.

## Context Management

- **Conversation buffer**: In-memory ring buffer (max 30 entries per group, 500 chars per entry). Pushed on every user message and every bot reply. Used for `generateResponse` system prompt and `shouldSpeak` proactive check. Lost on process restart.
- **User data** (nickname, memories, nighty/morning timestamps): Persisted in Firestore. Cached in-process for 60 seconds.
- **Image cache**: Firestore `images/{fileId}` with 30-day TTL. On cache hit, the stored description is reused instead of re-downloading and re-describing the image.

## Streaming

Bot replies are streamed to Telegram using `sendMessage` (placeholder `"…"`) + `editMessageText` (updated every 800ms). The `@grammyjs/stream` plugin was removed because `sendMessageDraft` returns `TEXTDRAFT_PEER_INVALID` for bots in groups.

Tool calls (saveMemory, setNickname, etc.) during streaming use `stopWhen: stepCountIs(5)` to allow multi-step execution. This is essential for `webSearch` — without it the stream ends after the tool call without generating a final response.

## Proactive Speaking

Every 15 seconds, `proactive.ts` checks the last 3 minutes of buffer history:

| Activity level | Recent user messages | Cooldown    |
| -------------- | -------------------- | ----------- |
| High (≥7 msgs) | ≥7                   | 90 seconds  |
| Medium (3-6)   | 3-6                  | 180 seconds |
| Low (1-2)      | 1-2                  | 360 seconds |

If cooldown has elapsed, `shouldSpeak()` is called. The LLM returns either a short message or `SILENT`. The proactive checker stops after 5 consecutive failures.
