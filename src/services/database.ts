import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import config from "../configs/env.js";
import { SCHEMA_VERSION } from "./schema-version.js";

export type SqliteDatabase = InstanceType<typeof Database>;

let connection: SqliteDatabase | null = null;

function migrate(db: SqliteDatabase): void {
  let currentVersion = db.pragma("user_version", { simple: true }) as number;
  if (currentVersion === 0) {
    const hasMetadata = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_metadata'`)
      .get();
    if (hasMetadata) {
      const row = db
        .prepare(`SELECT value FROM schema_metadata WHERE key = 'schema_version'`)
        .get() as { value: string } | undefined;
      const metadataVersion = Number(row?.value);
      if (Number.isInteger(metadataVersion) && metadataVersion > 0) {
        currentVersion = metadataVersion;
        db.pragma(`user_version = ${currentVersion}`);
      }
    }
  }
  if (currentVersion > SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${currentVersion} is newer than supported version ${SCHEMA_VERSION}`,
    );
  }
  if (currentVersion === SCHEMA_VERSION) return;

  db.transaction(() => {
    if (currentVersion < 1) {
      db.exec(`
        CREATE TABLE schema_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        ) STRICT;

        CREATE TABLE users (
          firestore_id TEXT PRIMARY KEY,
          uid TEXT NOT NULL UNIQUE,
          nickname TEXT NOT NULL,
          timezone TEXT,
          nighty_timestamp INTEGER,
          last_morning_greet INTEGER,
          source_json TEXT NOT NULL
        ) STRICT;

        CREATE TABLE user_memories (
          user_firestore_id TEXT NOT NULL REFERENCES users(firestore_id) ON DELETE CASCADE,
          position INTEGER NOT NULL CHECK(position >= 0),
          memory TEXT NOT NULL,
          PRIMARY KEY (user_firestore_id, position)
        ) STRICT;

        CREATE TABLE diary (
          firestore_id TEXT PRIMARY KEY,
          date TEXT NOT NULL,
          generated_diary TEXT,
          generated_at INTEGER,
          source_json TEXT NOT NULL
        ) STRICT;

        CREATE TABLE diary_entries (
          diary_firestore_id TEXT NOT NULL REFERENCES diary(firestore_id) ON DELETE CASCADE,
          position INTEGER NOT NULL CHECK(position >= 0),
          ts INTEGER NOT NULL,
          content TEXT NOT NULL,
          PRIMARY KEY (diary_firestore_id, position)
        ) STRICT;

        CREATE TABLE diary_generation_records (
          diary_firestore_id TEXT NOT NULL REFERENCES diary(firestore_id) ON DELETE CASCADE,
          position INTEGER NOT NULL CHECK(position >= 0),
          date TEXT NOT NULL,
          generated_at TEXT NOT NULL,
          model_provider TEXT NOT NULL,
          model_name TEXT NOT NULL,
          prompt_version TEXT NOT NULL,
          style_reference_version TEXT NOT NULL,
          observation_ids_json TEXT NOT NULL,
          input_tokens INTEGER,
          output_tokens INTEGER,
          status TEXT NOT NULL CHECK(status IN ('success', 'failed')),
          error TEXT,
          source_json TEXT NOT NULL,
          PRIMARY KEY (diary_firestore_id, position)
        ) STRICT;

        CREATE TABLE diary_observations (
          firestore_id TEXT PRIMARY KEY,
          observation_id TEXT NOT NULL,
          schema_version INTEGER NOT NULL CHECK(schema_version = 2),
          occurred_at TEXT,
          recorded_at TEXT NOT NULL,
          local_date TEXT NOT NULL,
          subject_uid TEXT,
          subject_name TEXT,
          subject_username TEXT,
          event TEXT NOT NULL,
          exact_quote TEXT,
          immediate_reaction TEXT,
          interpretation TEXT,
          unsaid_thought TEXT,
          unresolved_question TEXT,
          confidence TEXT NOT NULL CHECK(confidence IN ('fact', 'inference', 'uncertain')),
          salience INTEGER NOT NULL CHECK(salience BETWEEN 1 AND 5),
          tags_json TEXT,
          source_refs_json TEXT,
          status TEXT NOT NULL CHECK(status IN ('active', 'superseded', 'retracted')),
          supersedes_id TEXT,
          source_json TEXT NOT NULL
        ) STRICT;
        CREATE INDEX idx_diary_observations_date_recorded
          ON diary_observations (local_date, recorded_at);
        CREATE INDEX idx_diary_observations_recent
          ON diary_observations (recorded_at, local_date, status);

        CREATE TABLE runtime_group (
          firestore_id TEXT PRIMARY KEY CHECK(firestore_id = 'group'),
          summary TEXT NOT NULL,
          summary_cursor_ts INTEGER NOT NULL,
          last_processed_message_id INTEGER,
          last_compacted_at INTEGER,
          updated_at INTEGER NOT NULL,
          source_json TEXT NOT NULL
        ) STRICT;

        CREATE TABLE runtime_events (
          firestore_id TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL,
          message_id INTEGER,
          update_id INTEGER,
          kind TEXT NOT NULL,
          uid TEXT NOT NULL,
          name TEXT NOT NULL,
          username TEXT,
          text TEXT NOT NULL,
          media_refs_json TEXT NOT NULL,
          urls_json TEXT NOT NULL,
          reply_to_json TEXT,
          ts INTEGER NOT NULL,
          ignored_reason TEXT,
          source_json TEXT NOT NULL
        ) STRICT;
        CREATE INDEX idx_runtime_events_ts ON runtime_events (ts);

        CREATE TABLE runtime_turns (
          firestore_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          completed_at INTEGER NOT NULL,
          model TEXT NOT NULL,
          tier TEXT,
          needs_search INTEGER NOT NULL,
          tool_calls_json TEXT NOT NULL,
          action TEXT NOT NULL,
          messages_json TEXT NOT NULL,
          sticker_file_id TEXT,
          input_tokens INTEGER,
          output_tokens INTEGER,
          cached_input_tokens INTEGER,
          latency_ms INTEGER,
          error TEXT,
          source_json TEXT NOT NULL
        ) STRICT;
        CREATE INDEX idx_runtime_turns_started_at ON runtime_turns (started_at);

        CREATE TABLE runtime_compactions (
          firestore_id TEXT PRIMARY KEY,
          old_cursor_ts INTEGER NOT NULL,
          new_cursor_ts INTEGER NOT NULL,
          summary TEXT NOT NULL,
          input_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          source_json TEXT NOT NULL
        ) STRICT;
        CREATE INDEX idx_runtime_compactions_created_at
          ON runtime_compactions (created_at, firestore_id);

        CREATE TABLE group_messages (
          chat_id TEXT NOT NULL,
          message_id INTEGER NOT NULL,
          user_id TEXT NOT NULL,
          display_name TEXT NOT NULL,
          username TEXT,
          is_bot INTEGER NOT NULL,
          is_forwarded INTEGER NOT NULL DEFAULT 0,
          text TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          edited_at INTEGER,
          PRIMARY KEY (chat_id, message_id)
        ) STRICT;
        CREATE INDEX idx_group_messages_created_at ON group_messages (created_at);
        CREATE INDEX idx_group_messages_chat_created_at
          ON group_messages (chat_id, created_at);

        CREATE TABLE wordcloud_runs (
          date TEXT PRIMARY KEY,
          published_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE wordcloud_publications (
          date TEXT NOT NULL,
          slot TEXT NOT NULL,
          published_at INTEGER NOT NULL,
          PRIMARY KEY (date, slot)
        ) STRICT;

        CREATE TABLE database_backup_runs (
          schedule_date TEXT PRIMARY KEY,
          completed_at INTEGER NOT NULL,
          archive_name TEXT NOT NULL,
          archive_bytes INTEGER NOT NULL
        ) STRICT;

        INSERT INTO schema_metadata (key, value) VALUES ('schema_version', '1');
      `);
    }
    if (currentVersion < 2) {
      db.exec(`
        CREATE TABLE diary_notification_deliveries (
          date TEXT PRIMARY KEY REFERENCES diary(firestore_id) ON DELETE CASCADE,
          sent_at INTEGER NOT NULL
        ) STRICT;

        INSERT INTO diary_notification_deliveries (date, sent_at)
          SELECT firestore_id, COALESCE(generated_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
          FROM diary
          WHERE generated_diary IS NOT NULL AND length(trim(generated_diary)) > 0;

        INSERT INTO schema_metadata (key, value) VALUES ('schema_version', '2')
          ON CONFLICT(key) DO UPDATE SET value = excluded.value;
      `);
    }
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();
}

export function initDatabase(databasePath = config.databasePath): SqliteDatabase {
  if (connection) return connection;
  const resolvedPath = databasePath === ":memory:" ? databasePath : path.resolve(databasePath);
  if (resolvedPath !== ":memory:") mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const opened = new Database(resolvedPath, { timeout: 5_000 });
  try {
    opened.pragma("journal_mode = WAL");
    opened.pragma("foreign_keys = ON");
    migrate(opened);
  } catch (err) {
    opened.close();
    throw err;
  }
  connection = opened;
  return opened;
}

export function getDatabase(): SqliteDatabase {
  return connection ?? initDatabase();
}

export function closeDatabase(): void {
  if (!connection) return;
  connection.close();
  connection = null;
}
