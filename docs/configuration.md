# Configuration

## Environment Variables

All configuration is via `.env` (gitignored). Template at `.env.example`.

| Variable           | Required | Description                                                                         |
| ------------------ | -------- | ----------------------------------------------------------------------------------- |
| `BOT_API_KEY`      | ✅       | Telegram Bot Token from [@BotFather](https://t.me/BotFather)                        |
| `TG_ADMIN_UID`     | ✅       | Your Telegram user ID (used for `/status` and `/reset` access control)              |
| `TG_GROUP_ID`      | ✅       | Target group ID — bot ignores messages from all other chats/private                 |
| `DEEPSEEK_API_KEY` | ✅       | DeepSeek API key ([platform.deepseek.com](https://platform.deepseek.com))           |
| `TAVILY_API_KEY`   | ✅       | Tavily API key for web search and URL extraction ([tavily.com](https://tavily.com)) |
| `CF_AIG_TOKEN`     | ✅       | Cloudflare AI Gateway token for Gemini vision calls                                 |
| `BOT_USERNAME`     | ❌       | Bot username (default: `nyarbot`)                                                   |
| `LOG_LEVEL`        | ❌       | Pino log level (default: `info`)                                                    |
| `PORT`             | ❌       | Unused (long polling, no webhook server)                                            |

## Firebase

1. Create a Firebase project at [console.firebase.google.com](https://console.firebase.google.com)
2. Enable **Cloud Firestore** in the project
3. Generate a **service account key** JSON file: Project Settings → Service Accounts → Generate New Private Key
4. Save it as `src/services/serviceAccountKey.json` (gitignored)

Firestore collections used:

| Collection        | Document ID      | Fields                                                                   |
| ----------------- | ---------------- | ------------------------------------------------------------------------ |
| `users/{uid}`     | Telegram user ID | `uid`, `nickname`, `memories[]`, `nightyTimestamp?`, `lastMorningGreet?` |
| `images/{fileId}` | Telegram file_id | `fileId`, `description`, `cachedAt`                                      |

## DeepSeek Models

The bot uses two models with two thinking-mode variants each:

| Model               | Thinking                                  | Usage                                                                                    |
| ------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| `deepseek-v4-flash` | Disabled (`thinking: {type: "disabled"}`) | Classification, greetings, love rejection, probe gate, image/URL description             |
| `deepseek-v4-flash` | Enabled (`thinking: {type: "enabled"}`)   | Complex conversations (tier=`complex`), tool-calling responses with send_message/dismiss |
| `deepseek-v4-pro`   | Enabled (`thinking: {type: "enabled"}`)   | Tech questions (tier=`tech`), tool-calling responses with send_message/dismiss           |

Thinking mode is injected via a custom `fetch` wrapper that modifies the request body before sending. Base URL is `https://api.deepseek.com` (no `/v1` suffix).

## Cloudflare AI Gateway

Gemini vision calls are routed through Cloudflare AI Gateway for caching and observability. The gateway ID `gem` and account ID are hardcoded in `ai.ts`. The API token (`CF_AIG_TOKEN`) must be set in `.env`.

Model used: `google-ai-studio/gemini-2.5-flash` — fast, cheap, and supports vision input.

## Tool-Call Architecture

The bot uses `generateText()` (not streaming) with the following tools exposed to the model:

| Tool           | Purpose                                                                |
| -------------- | ---------------------------------------------------------------------- |
| `send_message` | Send a message to the group — the only way to speak                    |
| `dismiss`      | Choose not to reply (binary speak/silence choice)                      |
| `saveMemory`   | Record a memory about a group member (uid validated)                   |
| `setNickname`  | Set/update a group member's preferred nickname                         |
| `deleteMemory` | Remove a specific memory about a group member                          |
| `sendSticker`  | Select a Miaohaha sticker emoji to send (standalone or alongside text) |
| `webSearch`    | Tavily search (only when `needsSearch=true` from classification)       |

When `needsSearch=true`, a mandatory instruction is appended to ensure the model calls `webSearch` before answering.

Multi-step tool calling uses `stopWhen: stepCountIs(5)` to allow up to 5 steps (initial call + 4 tool-call rounds).
