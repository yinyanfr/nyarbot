function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function parseNumberEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid environment variable: ${key} must be a non-negative number`);
  }
  return parsed;
}

function validateTimezone(timezone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return timezone;
  } catch {
    throw new Error(`Invalid environment variable: APP_TIMEZONE is not a valid IANA timezone`);
  }
}

const required = {
  BOT_USERNAME: process.env.BOT_USERNAME,
  BOT_API_KEY: process.env.BOT_API_KEY,
  TG_ADMIN_UID: process.env.TG_ADMIN_UID,
  TG_GROUP_ID: process.env.TG_GROUP_ID,
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  TAVILY_API_KEY: process.env.TAVILY_API_KEY,
  CF_AIG_TOKEN: process.env.CF_AIG_TOKEN,
  CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID,
} as const;

for (const [key, value] of Object.entries(required)) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

const config = {
  botUsername: requireEnv("BOT_USERNAME"),
  botPersonaName: process.env.BOT_PERSONA_NAME ?? "にゃる",
  botPersonaFullName: process.env.BOT_PERSONA_FULL_NAME ?? "晴海猫月",
  botPersonaReading: process.env.BOT_PERSONA_READING ?? "はるみ にゃる",
  botApiKey: process.env.BOT_API_KEY!,
  tgAdminUid: process.env.TG_ADMIN_UID!,
  tgGroupId: process.env.TG_GROUP_ID!,
  tgDiaryChannelId: process.env.TG_DIARY_CHANNEL_ID ?? "",
  deepseekApiKey: process.env.DEEPSEEK_API_KEY!,
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
  tavilyApiKey: process.env.TAVILY_API_KEY!,
  cfAigToken: process.env.CF_AIG_TOKEN!,
  cfAccountId: process.env.CF_ACCOUNT_ID!,
  cfAigGateway: process.env.CF_AIG_GATEWAY ?? "gem",
  githubToken: process.env.GITHUB_TOKEN ?? "",
  githubRepo: process.env.GITHUB_REPO ?? "",
  githubApiBase: process.env.GITHUB_API_BASE ?? "https://api.github.com",
  githubApiVersion: process.env.GITHUB_API_VERSION ?? "2022-11-28",
  appTimezone: validateTimezone(process.env.APP_TIMEZONE ?? "Asia/Shanghai"),
  logAppName: process.env.LOG_APP_NAME ?? "nyarbot",
  adminDmMinIntervalMs: parseNumberEnv("ADMIN_DM_MIN_INTERVAL_MS", 5_000),
  conversationBufferPath: process.env.CONVERSATION_BUFFER_PATH ?? "data/conversation-buffer.json",
  wordcloudDbPath: process.env.WORDCLOUD_DB_PATH ?? "data/wordcloud.sqlite",
  proactiveCheckIntervalMs: parseNumberEnv("PROACTIVE_CHECK_INTERVAL_MS", 15_000),
  proactiveWindowMs: parseNumberEnv("PROACTIVE_WINDOW_MS", 3 * 60 * 1000),
  proactiveMessageDelayMs: parseNumberEnv("PROACTIVE_MESSAGE_DELAY_MS", 400),
  proactiveMaxFailures: parseNumberEnv("PROACTIVE_MAX_FAILURES", 5),
  proactiveCooldownHighMs: parseNumberEnv("PROACTIVE_COOLDOWN_HIGH_MS", 90_000),
  proactiveCooldownMediumMs: parseNumberEnv("PROACTIVE_COOLDOWN_MEDIUM_MS", 180_000),
  proactiveCooldownLowMs: parseNumberEnv("PROACTIVE_COOLDOWN_LOW_MS", 360_000),
  botMessageDelayMs: parseNumberEnv("BOT_MESSAGE_DELAY_MS", 400),
  runtimeInitialDelayMs: parseNumberEnv("RUNTIME_INITIAL_DELAY_MS", 5_000),
  runtimeTypingExtendMs: parseNumberEnv("RUNTIME_TYPING_EXTEND_MS", 5_000),
  runtimeMaxDelayMs: parseNumberEnv("RUNTIME_MAX_DELAY_MS", 30_000),
  runtimeQuietWindowMs: parseNumberEnv("RUNTIME_QUIET_WINDOW_MS", 30_000),
  runtimeHotChatThreshold: parseNumberEnv("RUNTIME_HOT_CHAT_THRESHOLD", 10),
  runtimeQuietDurationMs: parseNumberEnv("RUNTIME_QUIET_DURATION_MS", 180_000),
  runtimeDuplicateTextWindowMs: parseNumberEnv("RUNTIME_DUPLICATE_TEXT_WINDOW_MS", 10_000),
  runtimeUserBurstWindowMs: parseNumberEnv("RUNTIME_USER_BURST_WINDOW_MS", 30_000),
  runtimeUserBurstThreshold: parseNumberEnv("RUNTIME_USER_BURST_THRESHOLD", 8),
  runtimeUserCooldownMs: parseNumberEnv("RUNTIME_USER_COOLDOWN_MS", 60_000),
  runtimeUrlFloodWindowMs: parseNumberEnv("RUNTIME_URL_FLOOD_WINDOW_MS", 60_000),
  runtimeUrlFloodThreshold: parseNumberEnv("RUNTIME_URL_FLOOD_THRESHOLD", 3),
  runtimeMediaFloodWindowMs: parseNumberEnv("RUNTIME_MEDIA_FLOOD_WINDOW_MS", 60_000),
  runtimeMediaFloodThreshold: parseNumberEnv("RUNTIME_MEDIA_FLOOD_THRESHOLD", 5),
  runtimeMediaFloodCooldownMs: parseNumberEnv("RUNTIME_MEDIA_FLOOD_COOLDOWN_MS", 300_000),
  runtimeMaxContextEstTokens: parseNumberEnv("RUNTIME_MAX_CONTEXT_EST_TOKENS", 12_000),
  runtimeWorkingWindowEstTokens: parseNumberEnv("RUNTIME_WORKING_WINDOW_EST_TOKENS", 4_000),
  runtimeMaxRecentEvents: parseNumberEnv("RUNTIME_MAX_RECENT_EVENTS", 120),
  runtimeRetainRecentEvents: parseNumberEnv("RUNTIME_RETAIN_RECENT_EVENTS", 40),
  diaryCheckIntervalMs: parseNumberEnv("DIARY_CHECK_INTERVAL_MS", 60_000),
  wordcloudCheckIntervalMs: parseNumberEnv("WORDCLOUD_CHECK_INTERVAL_MS", 60_000),
  bufferSaveIntervalMs: parseNumberEnv("BUFFER_SAVE_INTERVAL_MS", 300_000),
} as const;

export default config;
