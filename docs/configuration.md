# Configuration

## Environment Variables

All configuration is via `.env` (gitignored). Template at `.env.example`.

| Variable                | Required | Description                                                                         |
| ----------------------- | -------- | ----------------------------------------------------------------------------------- |
| `BOT_API_KEY`           | ✅       | Telegram Bot Token from [@BotFather](https://t.me/BotFather)                        |
| `BOT_PERSONA_NAME`      | ❌       | Persona display name in prompts/help text (default: `にゃる`)                       |
| `BOT_PERSONA_FULL_NAME` | ❌       | Persona full name (default: `晴海猫月`)                                             |
| `BOT_PERSONA_READING`   | ❌       | Persona reading annotation (default: `はるみ にゃる`)                               |
| `TG_ADMIN_UID`          | ✅       | Your Telegram user ID (used for `/status` and `/reset` access control)              |
| `TG_GROUP_ID`           | ✅       | Target group ID — bot ignores messages from all other chats/private                 |
| `DEEPSEEK_API_KEY`      | ✅       | DeepSeek API key ([platform.deepseek.com](https://platform.deepseek.com))           |
| `TAVILY_API_KEY`        | ✅       | Tavily API key for web search and URL extraction ([tavily.com](https://tavily.com)) |
| `CF_AIG_TOKEN`          | ✅       | Cloudflare AI Gateway token for Gemini vision calls                                 |
| `CF_ACCOUNT_ID`         | ✅       | Cloudflare account ID for AI Gateway                                                |
| `BOT_USERNAME`          | ✅       | Telegram bot username (required; used for mention matching)                         |
| `GITHUB_TOKEN`          | ❌       | GitHub PAT for pushing diaries to Hexo blog (format `ghp_...`)                      |
| `GITHUB_REPO`           | ❌       | GitHub repo in `owner/repo` format (e.g., `yinyanfr/nyarbot-diary`)                 |
| `LOG_LEVEL`             | ❌       | Pino log level (default: `info`)                                                    |
| `PORT`                  | ❌       | Unused (long polling, no webhook server)                                            |

Additional optional envs with defaults:

- `DEEPSEEK_BASE_URL` (`https://api.deepseek.com`)
- `CF_AIG_GATEWAY` (`gem`)
- `GITHUB_API_BASE` (`https://api.github.com`)
- `GITHUB_API_VERSION` (`2022-11-28`)
- `APP_TIMEZONE` (`Asia/Shanghai`, validated as IANA timezone at startup)
- `LOG_APP_NAME`, `ADMIN_DM_MIN_INTERVAL_MS`
- `CONVERSATION_BUFFER_PATH`, `BUFFER_SAVE_INTERVAL_MS`
- `BOT_MESSAGE_DELAY_MS`
- `PROACTIVE_CHECK_INTERVAL_MS`, `PROACTIVE_WINDOW_MS`, `PROACTIVE_MESSAGE_DELAY_MS`,
  `PROACTIVE_MAX_FAILURES`, `PROACTIVE_COOLDOWN_HIGH_MS`,
  `PROACTIVE_COOLDOWN_MEDIUM_MS`, `PROACTIVE_COOLDOWN_LOW_MS`
- `DIARY_CHECK_INTERVAL_MS`

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
| `diary/{date}`    | Date YYYY-MM-DD  | `date`, `entries[]`, `diary?`, `generatedAt?`                            |

## DeepSeek Models

The bot uses two models with two thinking-mode variants each:

| Model               | Thinking                                  | Usage                                                                                      |
| ------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| `deepseek-v4-flash` | Disabled (`thinking: {type: "disabled"}`) | Classification, greetings, affection-scoring love reply, probe gate, image/URL description |
| `deepseek-v4-flash` | Enabled (`thinking: {type: "enabled"}`)   | Complex conversations (tier=`complex`), tool-calling responses with send_message/dismiss   |
| `deepseek-v4-pro`   | Enabled (`thinking: {type: "enabled"}`)   | Tech questions (tier=`tech`), tool-calling responses with send_message/dismiss             |
| `deepseek-v4-pro`   | Enabled (`thinking: {type: "enabled"}`)   | Diary generation (midnight summary and `/diary` command)                                   |

Thinking mode is injected via a custom `fetch` wrapper that modifies the request body before sending. Base URL is configurable via `DEEPSEEK_BASE_URL` (default `https://api.deepseek.com`, no `/v1` suffix).

## Cloudflare AI Gateway

Gemini vision calls are routed through Cloudflare AI Gateway for caching and observability. Gateway name is configurable via `CF_AIG_GATEWAY` (default `gem`); account ID (`CF_ACCOUNT_ID`) and API token (`CF_AIG_TOKEN`) must be set in `.env`.

Model used: `google-ai-studio/gemini-3-flash-preview` — fast, cheap, and supports vision input. Also used for batch tweet photo description in `describeTweetPhotos()`.

## Tool-Call Architecture

The bot uses `generateText()` (not streaming) with the following tools exposed to the model:

| Tool           | Purpose                                                                          |
| -------------- | -------------------------------------------------------------------------------- |
| `send_message` | Send a message to the group — the only way to speak                              |
| `dismiss`      | Choose not to reply (binary speak/silence choice)                                |
| `saveMemory`   | Record a memory about a group member (uid validated)                             |
| `setNickname`  | Set/update a group member's preferred nickname                                   |
| `deleteMemory` | Remove a specific memory about a group member                                    |
| `sendSticker`  | Select a sticker by emoji from the hardcoded pack; invalid emoji cancels sending |
| `writeDiary`   | Record an observational note about the conversation                              |
| `webSearch`    | Tavily search (only when `needsSearch=true` from classification)                 |

When `needsSearch=true`, a mandatory instruction is appended to ensure the model calls `webSearch` before answering.

Multi-step tool calling uses `stopWhen: stepCountIs(5)` to allow up to 5 steps (initial call + 4 tool-call rounds).
