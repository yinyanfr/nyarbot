import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const requiredEnv = {
  BOT_USERNAME: "test_bot",
  BOT_API_KEY: "test-token",
  TG_ADMIN_UID: "1",
  TG_GROUP_ID: "-1",
  DEEPSEEK_API_KEY: "test",
  TAVILY_API_KEY: "test",
  CF_AIG_TOKEN: "test",
  CF_ACCOUNT_ID: "test",
  DATABASE_BACKUP_PASSPHRASE: "correct horse battery staple",
};
Object.assign(process.env, requiredEnv);

test("unified persistence preserves users and runtime state", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nyarbot-persistence-test-"));
  const databasePath = path.join(directory, "nyarbot.sqlite");
  const databaseModule = await import("./database.js");
  const persistence = await import("./persistence.js");
  try {
    databaseModule.initDatabase(databasePath);
    const created = await persistence.getOrCreateUser("42", "Alice");
    assert.deepEqual(created, { uid: "42", nickname: "Alice", memories: [] });
    assert.deepEqual(await persistence.updateUserMemory("42", "likes tea"), ["likes tea"]);
    assert.deepEqual((await persistence.getOrCreateUser("42")).memories, ["likes tea"]);

    await persistence.appendRuntimeEventAndAdvance(
      {
        chatId: "-1",
        messageId: 9,
        kind: "user_message",
        uid: "42",
        name: "Alice",
        text: "hello",
        mediaRefs: [],
        urls: [],
        ts: 100,
      },
      9,
    );
    assert.equal((await persistence.loadRuntimeGroupState()).lastProcessedMessageId, 9);
    assert.equal((await persistence.loadRecentRuntimeEvents()).length, 1);

    await persistence.commitRuntimeCompaction(
      {
        oldCursorTs: 0,
        newCursorTs: 100,
        summary: "summary",
        inputTokens: 10,
        outputTokens: 5,
        createdAt: 200,
      },
      { summary: "summary", summaryCursorTs: 100, lastCompactedAt: 200 },
    );
    assert.equal((await persistence.loadRuntimeGroupState()).summaryCursorTs, 100);
    assert.equal(
      (
        databaseModule
          .getDatabase()
          .prepare("SELECT COUNT(*) AS count FROM runtime_compactions")
          .get() as { count: number }
      ).count,
      1,
    );
    assert.equal((databaseModule.getDatabase().pragma("foreign_key_check") as unknown[]).length, 0);
  } finally {
    databaseModule.closeDatabase();
    await rm(directory, { recursive: true, force: true });
  }
});
