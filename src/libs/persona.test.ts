import assert from "node:assert/strict";
import test from "node:test";

Object.assign(process.env, {
  BOT_USERNAME: "persona_bot",
  BOT_PERSONA_NAME: "Nyar",
  BOT_PERSONA_FULL_NAME: "Nyar Cat",
  BOT_PERSONA_READING: "nyar cat",
  BOT_API_KEY: "test-token",
  TG_ADMIN_UID: "1",
  TG_GROUP_ID: "-1",
  DEEPSEEK_API_KEY: "test",
  TAVILY_API_KEY: "test",
  CF_AIG_TOKEN: "test",
  CF_ACCOUNT_ID: "test",
  DATABASE_BACKUP_PASSPHRASE: "correct horse battery staple",
});

const { getPersonaIdentityLine, getPersonaLabel } = await import("./persona.js");

test("builds persona strings from configuration", () => {
  assert.equal(getPersonaLabel(), "Nyar（Nyar Cat，读作 nyar cat）");
  assert.equal(
    getPersonaIdentityLine(),
    "你的 Telegram 用户名是 @persona_bot，但你的名字是 Nyar。",
  );
});
