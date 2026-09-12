import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

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
});

test("database creates, reopens, and enforces the current schema", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nyarbot-database-test-"));
  const databasePath = path.join(directory, "nested", "nyarbot.sqlite");
  const databaseModule = await import("./database.js");
  const { SCHEMA_VERSION } = await import("./schema-version.js");
  try {
    const database = databaseModule.initDatabase(databasePath);
    assert.equal(database.pragma("user_version", { simple: true }), SCHEMA_VERSION);
    assert.equal(database.pragma("journal_mode", { simple: true }), "wal");
    assert.equal(database.pragma("foreign_keys", { simple: true }), 1);
    assert.equal(
      database
        .prepare("SELECT value FROM schema_metadata WHERE key = 'schema_version'")
        .pluck()
        .get(),
      String(SCHEMA_VERSION),
    );
    assert.equal(
      database
        .prepare("SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = 'users'")
        .pluck()
        .get(),
      1,
    );
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = 'diary_notification_deliveries'",
        )
        .pluck()
        .get(),
      1,
    );

    database
      .prepare("INSERT INTO users (firestore_id, uid, nickname, source_json) VALUES (?, ?, ?, ?)")
      .run("u1", "u1", "Alice", "{}");
    databaseModule.closeDatabase();
    assert.equal(
      databaseModule.initDatabase(databasePath).prepare("SELECT nickname FROM users").pluck().get(),
      "Alice",
    );
  } finally {
    databaseModule.closeDatabase();
    await rm(directory, { recursive: true, force: true });
  }
});

test("database adopts legacy metadata and rejects newer schemas", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nyarbot-schema-test-"));
  const legacyPath = path.join(directory, "legacy.sqlite");
  const newerPath = path.join(directory, "newer.sqlite");
  const databaseModule = await import("./database.js");
  const { SCHEMA_VERSION } = await import("./schema-version.js");
  try {
    const legacy = databaseModule.initDatabase(legacyPath);
    legacy
      .prepare(
        `INSERT INTO diary (firestore_id, date, generated_diary, generated_at, source_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("2026-08-12", "2026-08-12", "existing diary", 123, "{}");
    legacy.exec("DROP TABLE diary_notification_deliveries");
    legacy.prepare("UPDATE schema_metadata SET value = '1' WHERE key = 'schema_version'").run();
    legacy.pragma("user_version = 1");
    databaseModule.closeDatabase();
    assert.equal(
      databaseModule.initDatabase(legacyPath).pragma("user_version", { simple: true }),
      SCHEMA_VERSION,
    );
    assert.equal(
      databaseModule
        .getDatabase()
        .prepare("SELECT sent_at FROM diary_notification_deliveries WHERE date = ?")
        .pluck()
        .get("2026-08-12"),
      123,
    );
    databaseModule.closeDatabase();

    const newer = new Database(newerPath);
    newer.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    newer.close();
    assert.throws(() => databaseModule.initDatabase(newerPath), /newer than supported version/);
    assert.equal(databaseModule.initDatabase(":memory:").open, true);
  } finally {
    databaseModule.closeDatabase();
    await rm(directory, { recursive: true, force: true });
  }
});
