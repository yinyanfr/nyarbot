import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  RuntimeCompactionRecord,
  RuntimeEventRecord,
  RuntimeTurnRecord,
} from "./persistence.js";

Object.assign(process.env, {
  BOT_USERNAME: "test_bot",
  BOT_API_KEY: "test-token",
  TG_ADMIN_UID: "1",
  TG_GROUP_ID: "-100",
  DEEPSEEK_API_KEY: "test",
  TAVILY_API_KEY: "test",
  CF_AIG_TOKEN: "test",
  CF_ACCOUNT_ID: "test",
  DATABASE_BACKUP_PASSPHRASE: "correct horse battery staple",
  APP_TIMEZONE: "Asia/Shanghai",
});

const event = (messageId: number, ts: number): RuntimeEventRecord => ({
  chatId: "-100",
  messageId,
  kind: "user_message",
  uid: "42",
  name: "Alice",
  text: `message ${messageId}`,
  mediaRefs: [],
  urls: [],
  ts,
});

test("runtime events and turns roundtrip with ordering, dates, and limits", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nyarbot-runtime-test-"));
  const databaseModule = await import("./database.js");
  const persistence = await import("./persistence.js");
  try {
    databaseModule.initDatabase(path.join(directory, "runtime.sqlite"));
    const timestamps = [
      Date.parse("2026-08-11T15:59:59Z"),
      Date.parse("2026-08-11T16:00:00Z"),
      Date.parse("2026-08-12T03:00:00Z"),
      Date.parse("2026-08-12T15:59:59Z"),
      Date.parse("2026-08-12T16:00:00Z"),
    ];
    for (const [index, timestamp] of timestamps.entries()) {
      await persistence.appendRuntimeEvent(event(index + 1, timestamp));
    }
    assert.deepEqual(
      (await persistence.loadRuntimeEventsForLocalDate("2026-08-12", 2)).map(
        (item) => item.messageId,
      ),
      [2, 4],
    );
    assert.deepEqual(
      (await persistence.loadRecentRuntimeEvents({ newestFirst: true, limit: 2 })).map(
        (item) => item.messageId,
      ),
      [4, 5],
    );
    assert.deepEqual(
      (await persistence.loadRecentRuntimeEvents({ afterTs: timestamps[1]! })).map(
        (item) => item.messageId,
      ),
      [3, 4, 5],
    );

    const turn: RuntimeTurnRecord = {
      kind: "passive",
      startedAt: 10,
      completedAt: 20,
      model: "test-model",
      tier: "simple",
      needsSearch: true,
      toolCalls: [{ name: "send_message", argsPreview: "hello" }],
      action: "send",
      messages: ["hello"],
      inputTokens: 4,
      outputTokens: 2,
    };
    await persistence.appendTurnRecord(turn);
    assert.deepEqual(await persistence.loadRecentTurnRecords(), [turn]);
    assert.deepEqual(await persistence.loadRecentTurnRecords({ afterTs: 10 }), []);
  } finally {
    databaseModule.closeDatabase();
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime event advancement and compaction commits are atomic", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nyarbot-atomicity-test-"));
  const databaseModule = await import("./database.js");
  const persistence = await import("./persistence.js");
  try {
    const database = databaseModule.initDatabase(path.join(directory, "atomic.sqlite"));
    database.exec(
      "CREATE TRIGGER fail_group_insert BEFORE INSERT ON runtime_group BEGIN SELECT RAISE(ABORT, 'state failed'); END;",
    );
    await assert.rejects(
      persistence.appendRuntimeEventAndAdvance(event(1, 100), 1),
      /state failed/,
    );
    assert.equal(database.prepare("SELECT COUNT(*) FROM runtime_events").pluck().get(), 0);
    database.exec("DROP TRIGGER fail_group_insert");
    await persistence.writeRuntimeGroupState({ summary: "old", summaryCursorTs: 10 });
    database.exec(
      "CREATE TRIGGER fail_group_update BEFORE UPDATE ON runtime_group BEGIN SELECT RAISE(ABORT, 'state failed'); END;",
    );
    const compaction: RuntimeCompactionRecord = {
      oldCursorTs: 10,
      newCursorTs: 20,
      summary: "new",
      inputTokens: 5,
      outputTokens: 2,
      createdAt: 30,
    };
    await assert.rejects(
      persistence.commitRuntimeCompaction(compaction, {
        summary: "new",
        summaryCursorTs: 20,
        lastCompactedAt: 30,
      }),
      /state failed/,
    );
    assert.equal(database.prepare("SELECT COUNT(*) FROM runtime_compactions").pluck().get(), 0);
    assert.equal((await persistence.loadRuntimeGroupState()).summary, "old");
  } finally {
    databaseModule.closeDatabase();
    await rm(directory, { recursive: true, force: true });
  }
});
