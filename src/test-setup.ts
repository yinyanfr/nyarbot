const testEnv = {
  BOT_USERNAME: "test_bot",
  BOT_API_KEY: "test-token",
  TG_ADMIN_UID: "1",
  TG_GROUP_ID: "-1",
  GLM_API_KEY: "test-key",
  DEEPSEEK_API_KEY: "test-key",
  TAVILY_API_KEY: "test-key",
  CF_AIG_TOKEN: "test-token",
  CF_ACCOUNT_ID: "test-account",
  DATABASE_BACKUP_PASSPHRASE: "test-passphrase-at-least-20-characters",
} as const;

Object.assign(process.env, testEnv);
