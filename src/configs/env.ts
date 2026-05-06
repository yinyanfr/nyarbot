const required = {
  BOT_API_KEY: process.env.BOT_API_KEY,
  TG_ADMIN_UID: process.env.TG_ADMIN_UID,
  TG_GROUP_ID: process.env.TG_GROUP_ID,
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  TAVILY_API_KEY: process.env.TAVILY_API_KEY,
} as const;

for (const [key, value] of Object.entries(required)) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

const config = {
  botUsername: process.env.BOT_USERNAME ?? "nyarbot",
  botApiKey: process.env.BOT_API_KEY!,
  tgAdminUid: process.env.TG_ADMIN_UID!,
  tgGroupId: process.env.TG_GROUP_ID!,
  deepseekApiKey: process.env.DEEPSEEK_API_KEY!,
  tavilyApiKey: process.env.TAVILY_API_KEY!,
} as const;

export default config;
