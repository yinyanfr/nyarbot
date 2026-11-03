import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { canonicalJson, isRecord, type FormalCollection, type SourceDocument } from "./model.js";

export type SqliteDatabase = InstanceType<typeof Database>;

const schemaPath = fileURLToPath(new URL("../schema.sql", import.meta.url));

function data(document: SourceDocument): Record<string, unknown> {
  if (!isRecord(document.data)) throw new Error(`Internal error: ${document.id} is not an object`);
  return document.data;
}

function nullable(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

export function createDatabase(path: string): SqliteDatabase {
  const db = new Database(path, { fileMustExist: false, timeout: 5_000 });
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync(schemaPath, "utf8"));
  return db;
}

export function insertFormalCollection(
  db: SqliteDatabase,
  collection: FormalCollection,
  documents: SourceDocument[],
): void {
  const source = (document: SourceDocument): string => canonicalJson(document.data);
  const insert = db.transaction(() => {
    for (const document of documents) {
      const d = data(document);
      if (collection === "users") {
        db.prepare("INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?)").run(
          document.id,
          d.uid,
          d.nickname,
          nullable(d.timeZone),
          nullable(d.nightyTimestamp),
          nullable(d.lastMorningGreet),
          source(document),
        );
        const memoryStatement = db.prepare("INSERT INTO user_memories VALUES (?, ?, ?)");
        for (const [position, memory] of (d.memories as string[]).entries())
          memoryStatement.run(document.id, position, memory);
      } else if (collection === "diary") {
        db.prepare("INSERT INTO diary VALUES (?, ?, ?, ?, ?)").run(
          document.id,
          d.date ?? document.id,
          nullable(d.diary),
          nullable(d.generatedAt),
          source(document),
        );
        const entryStatement = db.prepare("INSERT INTO diary_entries VALUES (?, ?, ?, ?)");
        for (const [position, entryValue] of (
          (d.entries as unknown[] | undefined) ?? []
        ).entries()) {
          const entry = entryValue as Record<string, unknown>;
          entryStatement.run(document.id, position, entry.ts, entry.content);
        }
        const generationStatement = db.prepare(
          "INSERT INTO diary_generation_records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        for (const [position, value] of (
          (d.generationRecords as unknown[] | undefined) ?? []
        ).entries()) {
          const generation = value as Record<string, unknown>;
          generationStatement.run(
            document.id,
            position,
            generation.date,
            generation.generatedAt,
            generation.modelProvider,
            generation.modelName,
            generation.promptVersion,
            generation.styleReferenceVersion,
            canonicalJson(generation.observationIds),
            nullable(generation.inputTokens),
            nullable(generation.outputTokens),
            generation.status,
            nullable(generation.error),
            canonicalJson(generation),
          );
        }
      } else if (collection === "diaryObservations") {
        db.prepare(
          "INSERT INTO diary_observations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          document.id,
          d.id,
          d.schemaVersion,
          nullable(d.occurredAt),
          d.recordedAt,
          d.localDate,
          nullable(d.subjectUid),
          nullable(d.subjectName),
          nullable(d.subjectUsername),
          d.event,
          nullable(d.exactQuote),
          nullable(d.immediateReaction),
          nullable(d.interpretation),
          nullable(d.unsaidThought),
          nullable(d.unresolvedQuestion),
          d.confidence,
          d.salience,
          d.tags === undefined ? null : canonicalJson(d.tags),
          d.sourceRefs === undefined ? null : canonicalJson(d.sourceRefs),
          d.status,
          nullable(d.supersedesId),
          source(document),
        );
      } else if (collection === "runtime") {
        db.prepare("INSERT INTO runtime_group VALUES (?, ?, ?, ?, ?, ?, ?)").run(
          document.id,
          d.summary,
          d.summaryCursorTs,
          nullable(d.lastProcessedMessageId),
          nullable(d.lastCompactedAt),
          d.updatedAt,
          source(document),
        );
      } else if (collection === "events") {
        db.prepare(
          "INSERT INTO runtime_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          document.id,
          d.chatId,
          nullable(d.messageId),
          nullable(d.updateId),
          d.kind,
          d.uid,
          d.name,
          nullable(d.username),
          d.text,
          canonicalJson(d.mediaRefs),
          canonicalJson(d.urls),
          d.replyTo === undefined ? null : canonicalJson(d.replyTo),
          d.ts,
          nullable(d.ignoredReason),
          source(document),
        );
      } else if (collection === "turns") {
        db.prepare(
          "INSERT INTO runtime_turns VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          document.id,
          d.kind,
          d.startedAt,
          d.completedAt,
          d.model,
          nullable(d.tier),
          d.needsSearch ? 1 : 0,
          canonicalJson(d.toolCalls),
          d.action,
          canonicalJson(d.messages),
          nullable(d.stickerFileId),
          nullable(d.inputTokens),
          nullable(d.outputTokens),
          nullable(d.cachedInputTokens),
          nullable(d.latencyMs),
          nullable(d.error),
          source(document),
        );
      } else {
        db.prepare("INSERT INTO runtime_compactions VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
          document.id,
          d.oldCursorTs,
          d.newCursorTs,
          d.summary,
          d.inputTokens,
          d.outputTokens,
          d.createdAt,
          source(document),
        );
      }
    }
  });
  insert();
}

export interface WordcloudCounts {
  group_messages: number;
  wordcloud_runs: number;
  wordcloud_publications: number;
}

export function importWordcloud(db: SqliteDatabase, sourcePath: string): WordcloudCounts {
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    const required: Record<string, readonly string[]> = {
      group_messages: [
        "chat_id",
        "message_id",
        "user_id",
        "display_name",
        "username",
        "is_bot",
        "text",
        "created_at",
        "edited_at",
      ],
      wordcloud_runs: ["date", "published_at"],
      wordcloud_publications: ["date", "slot", "published_at"],
    };
    const columns = (table: string): Set<string> =>
      new Set(
        (source.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
          (row) => row.name,
        ),
      );
    for (const [table, names] of Object.entries(required)) {
      const present = columns(table);
      if (present.size === 0)
        throw new Error(`Legacy wordcloud database is missing table ${table}`);
      for (const name of names)
        if (!present.has(name))
          throw new Error(`Legacy wordcloud table ${table} is missing column ${name}`);
    }
    const hasForwarded = columns("group_messages").has("is_forwarded");
    const runs = source
      .prepare("SELECT date, published_at FROM wordcloud_runs ORDER BY date")
      .raw()
      .all() as unknown[][];
    const publications = source
      .prepare("SELECT date, slot, published_at FROM wordcloud_publications ORDER BY date, slot")
      .raw()
      .all() as unknown[][];
    const messageRows = source
      .prepare(
        `SELECT chat_id, message_id, user_id, display_name, username, is_bot, ${hasForwarded ? "is_forwarded" : "0 AS is_forwarded"}, text, created_at, edited_at FROM group_messages ORDER BY chat_id, message_id`,
      )
      .raw()
      .all() as unknown[][];
    db.transaction(() => {
      const messageInsert = db.prepare(
        "INSERT INTO group_messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const row of messageRows) messageInsert.run(row);
      const runInsert = db.prepare("INSERT INTO wordcloud_runs VALUES (?, ?)");
      for (const row of runs) runInsert.run(row);
      const publicationInsert = db.prepare("INSERT INTO wordcloud_publications VALUES (?, ?, ?)");
      for (const row of publications) publicationInsert.run(row);
    })();
    return {
      group_messages: messageRows.length,
      wordcloud_runs: runs.length,
      wordcloud_publications: publications.length,
    };
  } finally {
    source.close();
  }
}

export const FORMAL_TABLES: Record<FormalCollection, string> = {
  users: "users",
  diary: "diary",
  diaryObservations: "diary_observations",
  runtime: "runtime_group",
  events: "runtime_events",
  turns: "runtime_turns",
  compactions: "runtime_compactions",
};
