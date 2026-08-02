# Configuration

## Environment Variables

All configuration is via `.env` (gitignored). Template at `.env.example`.

| Variable                | Required | Description                                                                         |
| ----------------------- | -------- | ----------------------------------------------------------------------------------- |
| `BOT_API_KEY`           | ✅       | Telegram Bot Token from [@BotFather](https://t.me/BotFather)                        |
| `BOT_PERSONA_NAME`      | ❌       | Persona display name in prompts/help text (default: `にゃる`)                       |
| `BOT_PERSONA_FULL_NAME` | ❌       | Persona full name (default: `晴海猫月`)                                             |
| `BOT_PERSONA_READING`   | ❌       | Persona reading annotation (default: `はるみ にゃる`)                               |
| `TG_ADMIN_UID`          | ✅       | Admin user ID for private status/reset, diary/observation, and wordcloud commands   |
| `TG_GROUP_ID`           | ✅       | Target group ID; other chats are ignored except supported admin DMs                 |
| `DEEPSEEK_API_KEY`      | ✅       | DeepSeek API key ([platform.deepseek.com](https://platform.deepseek.com))           |
| `TAVILY_API_KEY`        | ✅       | Tavily API key for web search and URL extraction ([tavily.com](https://tavily.com)) |
| `CF_AIG_TOKEN`          | ✅       | Cloudflare AI Gateway token for Gemini calls                                        |
| `CF_ACCOUNT_ID`         | ✅       | Cloudflare account ID for AI Gateway                                                |
| `BILIBILI_SESSDATA`     | ❌       | Bilibili login cookie for reliable subtitle access                                  |
| `BILIBILI_BILI_JCT`     | ❌       | Bilibili CSRF cookie; configure together with the other Bilibili credentials        |
| `BILIBILI_DEDEUSERID`   | ❌       | Bilibili user ID cookie; configure together with the other Bilibili credentials     |
| `BOT_USERNAME`          | ✅       | Telegram bot username (required; used for mention matching)                         |
| `GITHUB_TOKEN`          | ❌       | GitHub PAT for pushing diaries to Hexo blog (format `ghp_...`)                      |
| `GITHUB_REPO`           | ❌       | GitHub repo in `owner/repo` format (e.g., `yinyanfr/nyarbot-diary`)                 |
| `TG_DIARY_CHANNEL_ID`   | ❌       | Channel ID for full diary publishing, including the wordcloud image when available  |
| `LOG_LEVEL`             | ❌       | Pino log level (default: `info`)                                                    |
| `PORT`                  | ❌       | Unused (long polling, no webhook server)                                            |

Additional optional envs with defaults:

- `DEEPSEEK_BASE_URL` (`https://api.deepseek.com`)
- `CF_AIG_GATEWAY` (`gem`)
- `BILIBILI_REQUEST_TIMEOUT_MS` (`10000`), `BILIBILI_RATE_LIMIT_MS` (`500`),
  `BILIBILI_CACHE_SIZE` (`100`)
- `VIDEO_READ_TIMEOUT_MS` (`120000`), `VIDEO_TRANSCRIPT_MAX_CHARS` (`20000`)
- `GITHUB_API_BASE` (`https://api.github.com`)
- `GITHUB_API_VERSION` (`2022-11-28`)
- `APP_TIMEZONE` (`Asia/Shanghai`, validated as IANA timezone at startup)
- `LOG_APP_NAME`, `ADMIN_DM_MIN_INTERVAL_MS`
- `CONVERSATION_BUFFER_PATH`, `BUFFER_SAVE_INTERVAL_MS`
- `BOT_MESSAGE_DELAY_MS`
- Runtime/debounce/abuse/compaction:
  `RUNTIME_INITIAL_DELAY_MS` (default 5000),
  `RUNTIME_TYPING_EXTEND_MS` (5000),
  `RUNTIME_MAX_DELAY_MS` (30000),
  `RUNTIME_QUIET_WINDOW_MS` (30000),
  `RUNTIME_HOT_CHAT_THRESHOLD` (10),
  `RUNTIME_QUIET_DURATION_MS` (180000),
  `RUNTIME_USER_BURST_THRESHOLD` (8),
  `RUNTIME_USER_COOLDOWN_MS` (60000),
  `RUNTIME_URL_FLOOD_THRESHOLD` (3),
  `RUNTIME_MEDIA_FLOOD_THRESHOLD` (5),
  `RUNTIME_MEDIA_FLOOD_COOLDOWN_MS` (300000),
  `RUNTIME_MAX_CONTEXT_EST_TOKENS` (12000),
  `RUNTIME_WORKING_WINDOW_EST_TOKENS` (4000),
  `RUNTIME_MAX_RECENT_EVENTS` (120),
  `RUNTIME_RETAIN_RECENT_EVENTS` (40)
- `PROACTIVE_CHECK_INTERVAL_MS`, `PROACTIVE_WINDOW_MS`, `PROACTIVE_MESSAGE_DELAY_MS`,
  `PROACTIVE_MAX_FAILURES`, `PROACTIVE_COOLDOWN_HIGH_MS`,
  `PROACTIVE_COOLDOWN_MEDIUM_MS`, `PROACTIVE_COOLDOWN_LOW_MS`
- `DIARY_CHECK_INTERVAL_MS`
- `WORDCLOUD_DB_PATH` (`data/wordcloud.sqlite`)
- `WORDCLOUD_CHECK_INTERVAL_MS` (`60000`)

The current `.env.example` does not list the wordcloud variables; they remain optional and use the defaults above.

## Local Wordcloud Storage

- The wordcloud pipeline uses local SQLite, not Firestore.
- The database path is controlled by `WORDCLOUD_DB_PATH` and defaults to `data/wordcloud.sqlite`.
- Generated PNG artifacts are stored in `wordcloud-artifacts/` next to the SQLite database.
- `WORDCLOUD_CHECK_INTERVAL_MS` drives noon, evening, and post-rollover publication checks, not only midnight generation.
- Only the most recent 10 days of messages are retained.
- Only human users count; the bot itself and other bots are excluded.
- Command messages do not enter the wordcloud store. If a normal message is later edited into a command, it is removed from the local wordcloud database.
- Edited messages overwrite by the same `message_id`, so the wordcloud always uses the final text.
- Forwarded messages still count for the activity leaderboard and preview `messageCount`, but are excluded from the wordcloud body itself.
- Repeated occurrences of the same token inside one message count once.
- Rendering ships with a bundled full Source Han Sans variable font for Simplified Chinese, Traditional Chinese, Japanese, and Korean.

## Firebase

1. Create a Firebase project at [console.firebase.google.com](https://console.firebase.google.com)
2. Enable **Cloud Firestore** in the project
3. Generate a **service account key** JSON file: Project Settings → Service Accounts → Generate New Private Key
4. Save it as `src/services/serviceAccountKey.json` (gitignored)

Firestore collections used:

| Collection               | Document ID      | Fields                                                                      |
| ------------------------ | ---------------- | --------------------------------------------------------------------------- |
| `users/{uid}`            | Telegram user ID | `uid`, `nickname`, `memories[]`, `nightyTimestamp?`, `lastMorningGreet?`    |
| `diary/{date}`           | Date YYYY-MM-DD  | legacy `entries[]`, `diary?`, `generatedAt?`, `generationRecords[]`         |
| `diaryObservations/{id}` | Observation ID   | structured event/reaction fields, subject identity, confidence/status       |
| `runtime/group`          | Fixed document   | `summary`, `summaryCursorTs`, `lastProcessedMessageId?`, `lastCompactedAt?` |
| `events/{autoId}`        | Auto ID          | Append-only chat events, bot outputs, ignored reasons, URL/media refs       |
| `turns/{autoId}`         | Auto ID          | AI turn model, tool calls, action, token/cache usage, latency, errors       |
| `compactions/{autoId}`   | Auto ID          | Working-memory summary snapshots with cursor/token usage                    |

## DeepSeek Models

The bot uses two DeepSeek model IDs across three configured variants:

| Model               | Thinking                                  | Usage                                                                                    |
| ------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| `deepseek-v4-flash` | Disabled (`thinking: {type: "disabled"}`) | Classification, greetings, affection/reaction flows, and proactive probe                 |
| `deepseek-v4-flash` | Enabled (`thinking: {type: "enabled"}`)   | Complex conversations (tier=`complex`), tool-calling responses with send_message/dismiss |
| `deepseek-v4-pro`   | Enabled (`thinking: {type: "enabled"}`)   | Tech questions (tier=`tech`), tool-calling responses with send_message/dismiss           |

Thinking mode is injected via a custom `fetch` wrapper that modifies the request body before sending. Base URL is configurable via `DEEPSEEK_BASE_URL` (default `https://api.deepseek.com`, no `/v1` suffix).

Reply-facing DeepSeek calls reserve 12 seconds for fast paths and 45 seconds for thinking paths. Network/timeouts, 401–403, 408/409/429, and 5xx switch a reply to Gemini 3.5 Flash-Lite before any DeepSeek tool call, after which that reply stays on Gemini. Classification, subagents, URL extraction, compaction, and background memory compression remain DeepSeek-only.

## Cloudflare AI Gateway

Gemini calls are routed through Cloudflare AI Gateway for caching and observability. Gateway name is configurable via `CF_AIG_GATEWAY` (default `gem`); account ID (`CF_ACCOUNT_ID`) and API token (`CF_AIG_TOKEN`) must be set in `.env`.

- `gemini-3.5-flash-lite` through the native Google provider adapter: unavailable-DeepSeek reply fallback, Telegram/tweet image understanding, and full-diary notification copy. The native adapter preserves Gemini thought signatures across tool steps.
- `google-ai-studio/gemini-3.1-pro-preview`: midnight diary generation and admin `/diary` previews.

YouTube video understanding also uses Cloudflare AI Gateway with `gemini-3.5-flash-lite`. A restricted AI SDK URL-passthrough hook preserves the public YouTube URL as Gemini `fileData` even though the gateway wrapper does not advertise native URL support. The bot process does not contact Google directly or download the video, and each call accepts one video.

Bilibili reading accepts BV URLs, legacy `av<number>` URLs, and `b23.tv` short links. Legacy AV IDs are resolved to BV IDs through Bilibili's public view API before the pinned local `@xzxzzx/bilibili-mcp` process calls only `get_video_transcript` and `get_video_metadata`. No download or account mutation tools are exposed. If subtitles are unavailable, the result contains metadata only. Login cookies are optional for public metadata but normally required for reliable subtitles.

Media descriptions are cached only in-process for the current session. There is no runtime Firestore `images` cache.

## Tool-Call Architecture

The bot uses `generateText()` (not streaming) with the following tools exposed to the model:

| Tool                    | Purpose                                                                          |
| ----------------------- | -------------------------------------------------------------------------------- |
| `send_message`          | Send a message to the group — the only way to speak                              |
| `dismiss`               | Choose not to reply (binary speak/silence choice)                                |
| `saveMemory`            | Record a memory about a group member (uid validated)                             |
| `setNickname`           | Set/update a group member's preferred nickname                                   |
| `deleteMemory`          | Remove a specific memory about a group member                                    |
| `sendSticker`           | Select a sticker by emoji from the hardcoded pack; invalid emoji cancels sending |
| `writeDiary`            | Record an observational note about the conversation                              |
| `webSearch`             | Tavily search; disabled by runtime flood protection by returning a reason        |
| `describeTelegramMedia` | Inspect current-turn Telegram media on demand                                    |
| `fetchUrlContent`       | Fetch current-turn URLs on demand                                                |
| `readVideo`             | Read YouTube through native Gemini, or Bilibili subtitles with metadata fallback |
| `startSubagent`         | One-shot helper for URL/media/technical research; cannot send group messages     |

Tool schema is kept stable for KV-cache friendliness. When `needsSearch=true`, late binding adds a mandatory search hint; if the model sends without `webSearch`, the turn retries once.

Multi-step tool calling uses `stopWhen: stepCountIs(5)` to allow up to 5 steps (initial call + 4 tool-call rounds).
