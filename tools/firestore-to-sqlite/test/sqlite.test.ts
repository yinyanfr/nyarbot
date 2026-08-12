import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { runChecks } from "../src/checks.js";
import { FORMAL_COLLECTIONS, type FormalCollection, type SourceDocument } from "../src/model.js";
import { createDatabase, importWordcloud, insertFormalCollection } from "../src/sqlite.js";
import { validateFormalDocument } from "../src/validate.js";

test("inserts formal documents, imports legacy wordcloud, and passes checks", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "nyarbot-migration-test-"));
  try {
    const legacyPath = path.join(directory, "legacy.sqlite");
    const legacy = new Database(legacyPath);
    legacy.exec(`
      CREATE TABLE group_messages (chat_id TEXT, message_id INTEGER, user_id TEXT, display_name TEXT, username TEXT, is_bot INTEGER, text TEXT, created_at INTEGER, edited_at INTEGER, PRIMARY KEY(chat_id, message_id));
      CREATE TABLE wordcloud_runs (date TEXT PRIMARY KEY, published_at INTEGER);
      CREATE TABLE wordcloud_publications (date TEXT, slot TEXT, published_at INTEGER, PRIMARY KEY(date, slot));
      INSERT INTO group_messages VALUES ('-1', 7, '42', 'Yan', NULL, 0, 'hi', 1000, NULL);
      INSERT INTO wordcloud_runs VALUES ('2026-01-01', 2000);
      INSERT INTO wordcloud_publications VALUES ('2026-01-01', 'same_day_noon', 2000);
    `);
    legacy.close();
    const source = new Map<FormalCollection, SourceDocument[]>(
      FORMAL_COLLECTIONS.map((name) => [name, []]),
    );
    source.set("users", [
      { id: "firestore-user-id", data: { uid: "42", nickname: "Yan", memories: ["likes cats"] } },
    ]);
    source.set("turns", [
      {
        id: "turn-without-sticker",
        data: {
          kind: "passive",
          startedAt: 100,
          completedAt: 200,
          model: "test-model",
          needsSearch: false,
          toolCalls: [],
          action: "send",
          messages: ["hello"],
          stickerFileId: null,
        },
      },
    ]);
    const db = createDatabase(path.join(directory, "output.sqlite"));
    for (const [collection, documents] of source) {
      for (const document of documents) validateFormalDocument(collection, document);
      insertFormalCollection(db, collection, documents);
    }
    const wordcloud = importWordcloud(db, legacyPath);
    const checks = runChecks(db, source, wordcloud);
    assert.equal(
      checks.every((check) => check.ok),
      true,
      JSON.stringify(checks),
    );
    assert.equal(db.pragma("user_version", { simple: true }), 1);
    assert.deepEqual(db.prepare("SELECT firestore_id, uid FROM users").get(), {
      firestore_id: "firestore-user-id",
      uid: "42",
    });
    assert.equal(
      (db.prepare("SELECT is_forwarded FROM group_messages").get() as { is_forwarded: number })
        .is_forwarded,
      0,
    );
    assert.equal(
      (
        db
          .prepare("SELECT sticker_file_id FROM runtime_turns WHERE firestore_id = ?")
          .get("turn-without-sticker") as { sticker_file_id: string | null }
      ).sticker_file_id,
      null,
    );
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
