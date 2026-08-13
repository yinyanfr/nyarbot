import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "./env.js";

const base = {
  BOT_USERNAME: "bot",
  BOT_API_KEY: "token",
  TG_ADMIN_UID: "1",
  TG_GROUP_ID: "-1",
  QWEN_API_KEY: "key",
  DEEPSEEK_API_KEY: "key",
  TAVILY_API_KEY: "key",
  CF_AIG_TOKEN: "key",
  CF_ACCOUNT_ID: "account",
  DATABASE_BACKUP_PASSPHRASE: "12345678901234567890",
};

test("loads defaults and explicit overrides", () => {
  const config = loadConfig({ ...base, APP_TIMEZONE: "UTC", DATABASE_BACKUP_SCHEDULE: "23:59" });
  assert.equal(config.appTimezone, "UTC");
  assert.equal(config.databasePath, "data/nyarbot.sqlite");
  assert.equal(config.databaseBackupSchedule, "23:59");
  assert.equal(config.qwenBaseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1");
});

test("rejects every missing required setting", () => {
  for (const key of Object.keys(base)) {
    const env = { ...base } as NodeJS.ProcessEnv;
    delete env[key];
    assert.throws(() => loadConfig(env), new RegExp(key));
  }
});

test("validates numeric, timezone, passphrase, and schedule settings", () => {
  assert.throws(() => loadConfig({ ...base, BOT_MESSAGE_DELAY_MS: "-1" }), /non-negative/);
  assert.throws(() => loadConfig({ ...base, BILIBILI_CACHE_SIZE: "1.5" }), /positive integer/);
  assert.throws(() => loadConfig({ ...base, APP_TIMEZONE: "Mars\/Base" }), /IANA timezone/);
  assert.throws(() => loadConfig({ ...base, DATABASE_BACKUP_PASSPHRASE: "short" }), /20/);
  assert.throws(() => loadConfig({ ...base, DATABASE_BACKUP_SCHEDULE: "24:00" }), /HH:mm/);
  assert.equal(loadConfig({ ...base, BOT_MESSAGE_DELAY_MS: "0" }).botMessageDelayMs, 0);
});
