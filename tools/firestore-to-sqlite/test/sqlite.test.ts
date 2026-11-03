import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { runChecks } from "../src/checks.js";
import { FORMAL_COLLECTIONS, type FormalCollection, type SourceDocument } from "../src/model.js";
import {
  createDatabase,
  FORMAL_TABLES,
  importWordcloud,
  insertFormalCollection,
} from "../src/sqlite.js";

function temporaryDirectory(): string {
  return mkdtempSync(path.join(os.tmpdir(), "nyarbot-migration-test-"));
}

function createLegacy(pathname: string, forwarded: boolean): void {
  const db = new Database(pathname);
  db.exec(`
    CREATE TABLE group_messages (
      chat_id TEXT, message_id INTEGER, user_id TEXT, display_name TEXT, username TEXT,
      is_bot INTEGER, ${forwarded ? "is_forwarded INTEGER," : ""} text TEXT,
      created_at INTEGER, edited_at INTEGER, PRIMARY KEY(chat_id, message_id)
    );
    CREATE TABLE wordcloud_runs (date TEXT PRIMARY KEY, published_at INTEGER);
    CREATE TABLE wordcloud_publications (date TEXT, slot TEXT, published_at INTEGER, PRIMARY KEY(date, slot));
    INSERT INTO group_messages VALUES ('-1', 7, '42', 'Yan', NULL, 0, ${forwarded ? "1," : ""} 'hi', 1000, NULL);
    INSERT INTO wordcloud_runs VALUES ('2026-01-01', 2000);
    INSERT INTO wordcloud_publications VALUES ('2026-01-01', 'same_day_noon', 2000);
  `);
  db.close();
}

const formal = new Map<FormalCollection, SourceDocument[]>([
  [
    "users",
    [
      {
        id: "user-doc",
        data: {
          uid: "42",
          nickname: "Yan",
          memories: ["cats", "tea"],
          timeZone: "UTC",
          nightyTimestamp: 10,
          lastMorningGreet: 11,
        },
      },
    ],
  ],
  [
    "diary",
    [
      {
        id: "diary-doc",
        data: {
          date: "2026-01-01",
          diary: "generated",
          generatedAt: 20,
          entries: [{ ts: 1, content: "entry" }],
          generationRecords: [
            {
              date: "2026-01-01",
              generatedAt: "now",
              modelProvider: "google",
              modelName: "model",
              promptVersion: "1",
              styleReferenceVersion: "1",
              observationIds: ["o1"],
              inputTokens: 2,
              outputTokens: 3,
              status: "success",
              error: null,
            },
          ],
        },
      },
    ],
  ],
  [
    "diaryObservations",
    [
      {
        id: "observation-doc",
        data: {
          id: "o1",
          schemaVersion: 2,
          occurredAt: null,
          recordedAt: "now",
          localDate: "2026-01-01",
          subjectUid: "42",
          subjectName: "Yan",
          subjectUsername: null,
          event: "event",
          exactQuote: null,
          immediateReaction: "reaction",
          interpretation: "interpretation",
          unsaidThought: null,
          unresolvedQuestion: null,
          confidence: "fact",
          salience: 5,
          tags: ["tag"],
          sourceRefs: ["source"],
          status: "active",
          supersedesId: null,
        },
      },
    ],
  ],
  [
    "runtime",
    [
      {
        id: "group",
        data: {
          summary: "summary",
          summaryCursorTs: 1,
          lastProcessedMessageId: 2,
          lastCompactedAt: 3,
          updatedAt: 4,
        },
      },
    ],
  ],
  [
    "events",
    [
      {
        id: "event-doc",
        data: {
          chatId: "-1",
          messageId: 1,
          updateId: 2,
          kind: "user_message",
          uid: "42",
          name: "Yan",
          username: null,
          text: "hello",
          mediaRefs: [{}],
          urls: [],
          replyTo: { id: 1 },
          ts: 5,
          ignoredReason: null,
        },
      },
    ],
  ],
  [
    "turns",
    [
      {
        id: "turn-doc",
        data: {
          kind: "passive",
          startedAt: 6,
          completedAt: 7,
          model: "model",
          tier: "simple",
          needsSearch: false,
          toolCalls: [{}],
          action: "send",
          messages: ["hello"],
          stickerFileId: null,
          inputTokens: 1,
          outputTokens: 2,
          cachedInputTokens: 3,
          latencyMs: 4,
          error: null,
        },
      },
    ],
  ],
  [
    "compactions",
    [
      {
        id: "compaction-doc",
        data: {
          oldCursorTs: 1,
          newCursorTs: 2,
          summary: "summary",
          inputTokens: 3,
          outputTokens: 4,
          createdAt: 5,
        },
      },
    ],
  ],
]);

test("every formal collection insert branch writes normalized and source data", () => {
  const directory = temporaryDirectory();
  const db = createDatabase(path.join(directory, "output.sqlite"));
  try {
    for (const [collection, documents] of formal) insertFormalCollection(db, collection, documents);
    for (const collection of FORMAL_COLLECTIONS) {
      assert.equal(
        (
          db.prepare(`SELECT count(*) count FROM ${FORMAL_TABLES[collection]}`).get() as {
            count: number;
          }
        ).count,
        1,
        collection,
      );
    }
    assert.equal(
      (db.prepare("SELECT count(*) count FROM user_memories").get() as { count: number }).count,
      2,
    );
    assert.equal(
      (db.prepare("SELECT content FROM diary_entries").get() as { content: string }).content,
      "entry",
    );
    assert.equal(
      (db.prepare("SELECT status FROM diary_generation_records").get() as { status: string })
        .status,
      "success",
    );
    assert.equal(
      (db.prepare("SELECT tags_json FROM diary_observations").get() as { tags_json: string })
        .tags_json,
      '["tag"]',
    );
    assert.equal(
      (db.prepare("SELECT needs_search FROM runtime_turns").get() as { needs_search: number })
        .needs_search,
      0,
    );
    assert.throws(
      () => insertFormalCollection(db, "users", [{ id: "bad", data: null }]),
      /Internal error/,
    );
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const forwarded of [false, true]) {
  test(`legacy wordcloud import supports ${forwarded ? "new" : "old"} forwarded schema`, () => {
    const directory = temporaryDirectory();
    const legacyPath = path.join(directory, "legacy.sqlite");
    createLegacy(legacyPath, forwarded);
    const db = createDatabase(path.join(directory, "output.sqlite"));
    try {
      assert.deepEqual(importWordcloud(db, legacyPath), {
        group_messages: 1,
        wordcloud_runs: 1,
        wordcloud_publications: 1,
      });
      assert.equal(
        (db.prepare("SELECT is_forwarded FROM group_messages").get() as { is_forwarded: number })
          .is_forwarded,
        forwarded ? 1 : 0,
      );
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("legacy wordcloud import reports missing files, tables, and columns", () => {
  const directory = temporaryDirectory();
  const output = createDatabase(path.join(directory, "output.sqlite"));
  try {
    assert.throws(() => importWordcloud(output, path.join(directory, "missing.sqlite")));
    const missingTablePath = path.join(directory, "missing-table.sqlite");
    new Database(missingTablePath).close();
    assert.throws(() => importWordcloud(output, missingTablePath), /missing table group_messages/);
    const missingColumnPath = path.join(directory, "missing-column.sqlite");
    const malformed = new Database(missingColumnPath);
    malformed.exec(`
      CREATE TABLE group_messages (chat_id TEXT);
      CREATE TABLE wordcloud_runs (date TEXT, published_at INTEGER);
      CREATE TABLE wordcloud_publications (date TEXT, slot TEXT, published_at INTEGER);
    `);
    malformed.close();
    assert.throws(() => importWordcloud(output, missingColumnPath), /missing column message_id/);
  } finally {
    output.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy wordcloud import propagates incompatible row failures", () => {
  const directory = temporaryDirectory();
  const legacyPath = path.join(directory, "legacy.sqlite");
  createLegacy(legacyPath, true);
  const legacy = new Database(legacyPath);
  legacy.prepare("UPDATE group_messages SET is_bot = 2").run();
  legacy.close();
  const output = createDatabase(path.join(directory, "output.sqlite"));
  try {
    assert.throws(() => importWordcloud(output, legacyPath), /CHECK constraint failed/);
    assert.equal(
      (output.prepare("SELECT count(*) count FROM group_messages").get() as { count: number })
        .count,
      0,
    );
  } finally {
    output.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("checks pass matching data and expose count, hash, semantic, and metadata mismatches", () => {
  const directory = temporaryDirectory();
  const db = createDatabase(path.join(directory, "output.sqlite"));
  try {
    for (const [collection, documents] of formal) insertFormalCollection(db, collection, documents);
    const matching = runChecks(db, formal, {
      group_messages: 0,
      wordcloud_runs: 0,
      wordcloud_publications: 0,
    });
    assert.equal(
      matching.every((check) => check.ok),
      true,
      JSON.stringify(matching),
    );
    db.prepare("DELETE FROM schema_metadata WHERE key = 'migration_checks'").run();
    db.prepare("UPDATE runtime_turns SET completed_at = 0, source_json = ?").run("{}");
    const mismatchedSource = new Map(formal);
    mismatchedSource.set("users", []);
    const mismatches = runChecks(db, mismatchedSource, {
      group_messages: 1,
      wordcloud_runs: 0,
      wordcloud_publications: 0,
    });
    for (const name of [
      "count:users",
      "hash:turns",
      "count:wordcloud:group_messages",
      "semantic:turn_duration",
    ]) {
      assert.equal(mismatches.find((check) => check.name === name)?.ok, false, name);
    }
    assert.equal(
      (
        db
          .prepare("SELECT count(*) count FROM schema_metadata WHERE key = 'migration_checks'")
          .get() as { count: number }
      ).count,
      1,
    );
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
