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

| Model               | Thinking                                  | Usage                                                                             |
| ------------------- | ----------------------------------------- | --------------------------------------------------------------------------------- |
| `deepseek-v4-flash` | Disabled (`thinking: {type: "disabled"}`) | Classification, greetings, love rejection, proactive check, URL/image description |
| `deepseek-v4-flash` | Enabled (`thinking: {type: "enabled"}`)   | Complex conversations (tier=`complex`) with tool calls                            |
| `deepseek-v4-pro`   | Enabled (`thinking: {type: "enabled"}`)   | Tech questions (tier=`tech`)                                                      |

Thinking mode is injected via a custom `fetch` wrapper that modifies the request body before sending. Base URL is `https://api.deepseek.com` (no `/v1` suffix).

## Cloudflare AI Gateway

Gemini vision calls are routed through Cloudflare AI Gateway for caching and observability. The gateway ID `gem` and account ID are hardcoded in `ai.ts`. The API token (`CF_AIG_TOKEN`) must be set in `.env`.

Model used: `google-ai-studio/gemini-2.5-flash` — fast, cheap, and supports vision input.
