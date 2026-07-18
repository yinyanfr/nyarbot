import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import config from "../configs/env.js";
import { logger } from "../libs/logger.js";
import { parseTimestampInputForTimezone } from "../libs/time.js";

export interface StoredGroupMessage {
  chatId: string;
  messageId: number;
  userId: string;
  displayName: string;
  username?: string;
  isBot: boolean;
  isForwarded: boolean;
  text: string;
  createdAt: number;
  editedAt?: number;
}

export interface ActiveUserStat {
  userId: string;
  displayName: string;
  username?: string;
  messageCount: number;
}

export type WordcloudPublicationSlot =
  | "daily_rollup_yesterday"
  | "same_day_noon"
  | "same_day_evening";

const DB_PATH = path.resolve(config.wordcloudDbPath);
const RETENTION_DAYS = 10;

type SqliteDatabase = InstanceType<typeof Database>;

let database: SqliteDatabase | null = null;

function db(): SqliteDatabase {
  if (database) return database;
  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const opened = new Database(DB_PATH, { timeout: 5_000 });
  opened.pragma("journal_mode = WAL");
  opened.pragma("foreign_keys = ON");
  opened.exec(`
    CREATE TABLE IF NOT EXISTS group_messages (
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

    CREATE INDEX IF NOT EXISTS idx_group_messages_created_at
      ON group_messages (created_at);

    CREATE INDEX IF NOT EXISTS idx_group_messages_chat_created_at
      ON group_messages (chat_id, created_at);

    CREATE TABLE IF NOT EXISTS wordcloud_runs (
      date TEXT PRIMARY KEY,
      published_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS wordcloud_publications (
      date TEXT NOT NULL,
      slot TEXT NOT NULL,
      published_at INTEGER NOT NULL,
      PRIMARY KEY (date, slot)
    ) STRICT;
  `);
  const hasIsForwarded = opened
    .prepare(
      `
        SELECT 1
        FROM pragma_table_info('group_messages')
        WHERE name = ?
      `,
    )
    .get("is_forwarded");
  if (!hasIsForwarded) {
    opened.exec(`
      ALTER TABLE group_messages
      ADD COLUMN is_forwarded INTEGER NOT NULL DEFAULT 0;
    `);
  }
  database = opened;
  return opened;
}

function toDayStartMs(date: string): number {
  return parseTimestampInputForTimezone(`${date} 00:00:00`, config.appTimezone) ?? 0;
}

export function initLocalWordcloudStore(): void {
  db();
}

export async function upsertGroupMessage(message: StoredGroupMessage): Promise<void> {
  db()
    .prepare(
      `
        INSERT INTO group_messages (
          chat_id,
          message_id,
          user_id,
          display_name,
          username,
          is_bot,
          is_forwarded,
          text,
          created_at,
          edited_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(chat_id, message_id) DO UPDATE SET
          user_id = excluded.user_id,
          display_name = excluded.display_name,
          username = excluded.username,
          is_bot = excluded.is_bot,
          is_forwarded = excluded.is_forwarded,
          text = excluded.text,
          created_at = excluded.created_at,
          edited_at = excluded.edited_at
      `,
    )
    .run(
      message.chatId,
      message.messageId,
      message.userId,
      message.displayName,
      message.username ?? null,
      message.isBot ? 1 : 0,
      message.isForwarded ? 1 : 0,
      message.text,
      message.createdAt,
      message.editedAt ?? null,
    );
}

export async function deleteStoredMessage(chatId: string, messageId: number): Promise<boolean> {
  const result = db()
    .prepare(
      `
        DELETE FROM group_messages
        WHERE chat_id = ? AND message_id = ?
      `,
    )
    .run(chatId, messageId);
  return Number(result.changes ?? 0) > 0;
}

export async function listStoredMessagesForDate(date: string): Promise<StoredGroupMessage[]> {
  const startMs = toDayStartMs(date);
  const endMs = startMs + 24 * 60 * 60 * 1000;
  const rows = db()
    .prepare(
      `
        SELECT chat_id, message_id, user_id, display_name, username, is_bot, is_forwarded, text, created_at, edited_at
        FROM group_messages
        WHERE chat_id = ?
          AND created_at >= ?
          AND created_at < ?
        ORDER BY created_at ASC, message_id ASC
      `,
    )
    .all(config.tgGroupId, startMs, endMs) as Record<string, unknown>[];

  return rows.map((row) => ({
    chatId: String(row.chat_id ?? ""),
    messageId: Number(row.message_id ?? 0),
    userId: String(row.user_id ?? ""),
    displayName: String(row.display_name ?? ""),
    ...(typeof row.username === "string" && row.username ? { username: row.username } : {}),
    isBot: Number(row.is_bot ?? 0) === 1,
    isForwarded: Number(row.is_forwarded ?? 0) === 1,
    text: String(row.text ?? ""),
    createdAt: Number(row.created_at ?? 0),
    ...(typeof row.edited_at === "number" ? { editedAt: row.edited_at } : {}),
  }));
}

export async function listTopActiveUsersForDate(
  date: string,
  limit = 5,
): Promise<ActiveUserStat[]> {
  const messages = await listStoredMessagesForDate(date);
  const stats = new Map<string, ActiveUserStat>();
  for (const message of messages) {
    if (message.isBot) continue;
    const current = stats.get(message.userId);
    if (!current) {
      stats.set(message.userId, {
        userId: message.userId,
        displayName: message.displayName,
        ...(message.username ? { username: message.username } : {}),
        messageCount: 1,
      });
      continue;
    }
    current.messageCount += 1;
    current.displayName = message.displayName || current.displayName;
    if (message.username) current.username = message.username;
  }

  return Array.from(stats.values())
    .sort((a, b) => {
      if (b.messageCount !== a.messageCount) return b.messageCount - a.messageCount;
      return a.userId.localeCompare(b.userId, "zh-CN");
    })
    .slice(0, limit);
}

export async function pruneStoredMessages(nowMs = Date.now()): Promise<number> {
  const cutoffMs = nowMs - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const result = db().prepare(`DELETE FROM group_messages WHERE created_at < ?`).run(cutoffMs);
  return Number(result.changes ?? 0);
}

export async function hasWordcloudRunForDate(date: string): Promise<boolean> {
  const row = db()
    .prepare(
      `
        SELECT date
        FROM wordcloud_runs
        WHERE date = ?
      `,
    )
    .get(date) as Record<string, unknown> | undefined;
  return typeof row?.date === "string";
}

export async function hasWordcloudPublication(
  date: string,
  slot: WordcloudPublicationSlot,
): Promise<boolean> {
  const row = db()
    .prepare(
      `
        SELECT date
        FROM wordcloud_publications
        WHERE date = ? AND slot = ?
      `,
    )
    .get(date, slot) as Record<string, unknown> | undefined;
  return typeof row?.date === "string";
}

export async function markWordcloudRunForDate(
  date: string,
  publishedAt = Date.now(),
): Promise<void> {
  db()
    .prepare(
      `
        INSERT INTO wordcloud_runs (date, published_at)
        VALUES (?, ?)
        ON CONFLICT(date) DO UPDATE SET
          published_at = excluded.published_at
      `,
    )
    .run(date, publishedAt);
}

export async function markWordcloudPublication(
  date: string,
  slot: WordcloudPublicationSlot,
  publishedAt = Date.now(),
): Promise<void> {
  db()
    .prepare(
      `
        INSERT INTO wordcloud_publications (date, slot, published_at)
        VALUES (?, ?, ?)
        ON CONFLICT(date, slot) DO UPDATE SET
          published_at = excluded.published_at
      `,
    )
    .run(date, slot, publishedAt);
}

export function closeLocalWordcloudStore(): void {
  if (!database) return;
  try {
    database.close();
  } catch (err) {
    logger.warn({ err }, "wordcloud store close failed");
  } finally {
    database = null;
  }
}
