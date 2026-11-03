import { randomUUID } from "node:crypto";
import { getDatabase } from "./database.js";
import {
  memoryKeywords,
  sanitizeUserMemory,
  type MemoryQuery,
  type UserMemory,
  type UserMemoryDraft,
} from "../libs/user-memory.js";
import { normalizePromptData } from "../libs/prompt-safety.js";

interface MemoryRow {
  id: string;
  subject_uid: string;
  content: string;
  kind: UserMemory["kind"];
  occurred_at: number | null;
  recorded_at: number | null;
  importance: UserMemory["importance"];
  confidence: UserMemory["confidence"];
  exact_quote: string | null;
  reflection: string | null;
  tags_json: string;
  source_refs_json: string;
  expires_at: number | null;
  status: UserMemory["status"];
  supersedes_id: string | null;
  origin: UserMemory["origin"];
}

function decode(row: MemoryRow): UserMemory {
  return {
    id: row.id,
    subjectUid: row.subject_uid,
    content: row.content,
    kind: row.kind,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    importance: row.importance,
    confidence: row.confidence,
    exactQuote: row.exact_quote,
    reflection: row.reflection,
    tags: JSON.parse(row.tags_json) as string[],
    sourceRefs: JSON.parse(row.source_refs_json) as string[],
    expiresAt: row.expires_at,
    status: row.status,
    supersedesId: row.supersedes_id,
    origin: row.origin,
  };
}

const DAY_MS = 86_400_000;
export const MEMORY_COMPACTION_TRIGGER = 60;
const MEMORY_TARGET_COUNT = 48;
const MEMORY_TEXT_TRIGGER = 16_000;
const MEMORY_TEXT_TARGET = 12_000;

/** Synchronous transaction: no background model can overwrite concurrent new facts. */
export function compactUserMemories(uid: string, currentTime = Date.now()): number {
  const db = getDatabase();
  return db.transaction(() => {
    const rows = db
      .prepare("SELECT * FROM user_memory_records WHERE subject_uid = ?")
      .all(uid) as MemoryRow[];
    const size = (row: MemoryRow) =>
      row.content.length +
      (row.exact_quote?.length ?? 0) +
      (row.reflection?.length ?? 0) +
      row.tags_json.length;
    if (
      rows.length <= MEMORY_COMPACTION_TRIGGER &&
      rows.reduce((sum, row) => sum + size(row), 0) <= MEMORY_TEXT_TRIGGER
    )
      return 0;
    const eligible = rows
      .filter((row) => {
        if (row.status !== "active" || (row.expires_at !== null && row.expires_at <= currentTime))
          return false;
        if (row.recorded_at === null) return row.importance > 1;
        const retention = [0, 7, 30, 90][row.importance];
        return retention === undefined || currentTime - row.recorded_at <= retention * DAY_MS;
      })
      .sort(
        (a, b) =>
          b.importance - a.importance ||
          (b.recorded_at ?? -1) - (a.recorded_at ?? -1) ||
          a.id.localeCompare(b.id),
      );
    const keep = new Set<string>();
    let chars = 0;
    for (const row of eligible) {
      if (keep.size >= MEMORY_TARGET_COUNT || chars + size(row) > MEMORY_TEXT_TARGET) continue;
      keep.add(row.id);
      chars += size(row);
    }
    const remove = db.prepare("DELETE FROM user_memory_records WHERE subject_uid = ? AND id = ?");
    let removed = 0;
    for (const row of rows) if (!keep.has(row.id)) removed += remove.run(uid, row.id).changes;
    return removed;
  })();
}

export async function saveUserMemory(
  uid: string,
  draft: UserMemoryDraft,
  sourceRefs: string[] = [],
  currentTime = Date.now(),
): Promise<UserMemory> {
  const input = sanitizeUserMemory(draft);
  if (!input) throw new Error("Invalid or unsafe memory");
  if (input.occurredAt !== undefined && input.occurredAt > currentTime)
    throw new Error("Memory occurrence is in the future");
  if (input.expiresAt !== undefined && input.expiresAt <= currentTime)
    throw new Error("Memory already expired");
  const db = getDatabase();
  return db.transaction(() => {
    const previous = input.supersedesId
      ? (db
          .prepare(
            "SELECT * FROM user_memory_records WHERE id = ? AND subject_uid = ? AND status = 'active'",
          )
          .get(input.supersedesId, uid) as MemoryRow | undefined)
      : undefined;
    if (input.supersedesId && !previous)
      throw new Error("Memory to revise not found for this user");
    // Exact facts only: never merge unrelated memories or refresh their original timestamps.
    const duplicate = db
      .prepare(
        "SELECT * FROM user_memory_records WHERE subject_uid = ? AND content = ? AND kind = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > ?) AND (expires_at IS ?)",
      )
      .get(uid, input.content, input.kind, currentTime, input.expiresAt ?? null) as
      | MemoryRow
      | undefined;
    if (duplicate && !previous) {
      return decode(duplicate);
    }
    const id = randomUUID();
    const refs = [
      ...new Set(sourceRefs.map((ref) => normalizePromptData(ref, 160)).filter(Boolean)),
    ].slice(0, 12);
    db.prepare(
      `INSERT INTO user_memory_records (id, subject_uid, content, kind, occurred_at, recorded_at, importance, confidence, exact_quote, reflection, tags_json, source_refs_json, expires_at, status, supersedes_id, origin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, 'conversation')`,
    ).run(
      id,
      uid,
      input.content,
      input.kind,
      input.occurredAt ?? null,
      currentTime,
      input.importance,
      input.confidence,
      input.exactQuote ?? null,
      input.reflection ?? null,
      JSON.stringify(input.tags ?? []),
      JSON.stringify(refs),
      input.expiresAt ?? null,
      previous?.id ?? null,
    );
    if (previous)
      db.prepare("UPDATE user_memory_records SET status = 'superseded' WHERE id = ?").run(
        previous.id,
      );
    compactUserMemories(uid, currentTime);
    // A newly recorded low-priority memory may itself be removed when the budget is full.
    const saved = db.prepare("SELECT * FROM user_memory_records WHERE id = ?").get(id) as
      | MemoryRow
      | undefined;
    if (!saved) throw new Error("Memory budget reserved for more important records");
    return decode(saved);
  })();
}

export async function recallUserMemories(
  uid: string,
  query: MemoryQuery = {},
  currentTime = Date.now(),
): Promise<UserMemory[]> {
  const limit = Math.max(1, Math.min(10, Math.trunc(query.limit ?? 5)));
  if (!Number.isFinite(limit)) return [];
  const params: (string | number)[] = [uid, currentTime];
  const filters = [
    "subject_uid = ?",
    "status = 'active'",
    "(expires_at IS NULL OR expires_at > ?)",
  ];
  if (query.since !== undefined) {
    filters.push("recorded_at >= ?");
    params.push(query.since);
  }
  if (query.until !== undefined) {
    filters.push("recorded_at <= ?");
    params.push(query.until);
  }
  let score = "0";
  let scoreParams: string[] = [];
  if (query.mode === "recent") {
    filters.push("recorded_at IS NOT NULL");
  } else {
    const keywords = memoryKeywords(query.query ?? "");
    if (!keywords.length) return [];
    const matching = keywords.map(
      () => "(instr(lower(content), ?) > 0 OR instr(lower(tags_json), ?) > 0)",
    );
    const keywordParams = keywords.flatMap((word) => [word, word]);
    filters.push(`(${matching.join(" OR ")})`);
    params.push(...keywordParams);
    score = keywords
      .map(
        () =>
          "(CASE WHEN instr(lower(content), ?) > 0 THEN 2 ELSE 0 END + CASE WHEN instr(lower(tags_json), ?) > 0 THEN 1 ELSE 0 END)",
      )
      .join(" + ");
    scoreParams = keywordParams;
  }
  const order =
    query.mode === "recent"
      ? "recorded_at DESC, id ASC"
      : "score DESC, importance DESC, recorded_at DESC, id ASC";
  return (
    getDatabase()
      .prepare(
        `SELECT *, (${score}) AS score FROM user_memory_records WHERE ${filters.join(" AND ")} ORDER BY ${order} LIMIT ?`,
      )
      .all(...scoreParams, ...params, limit) as MemoryRow[]
  ).map(decode);
}

/** Forget the whole revision chain, not just its visible head. */
export async function deleteUserMemory(uid: string, id: string): Promise<boolean> {
  const db = getDatabase();
  return db.transaction(() => {
    const target = db
      .prepare("SELECT id FROM user_memory_records WHERE id = ? AND subject_uid = ?")
      .get(id, uid);
    if (!target) return false;
    const result = db
      .prepare(
        `WITH RECURSIVE chain(id) AS (
      SELECT id FROM user_memory_records WHERE id = ? AND subject_uid = ?
      UNION SELECT r.id FROM user_memory_records r JOIN chain c ON r.supersedes_id = c.id WHERE r.subject_uid = ?
      UNION SELECT r.supersedes_id FROM user_memory_records r JOIN chain c ON r.id = c.id WHERE r.subject_uid = ? AND r.supersedes_id IS NOT NULL
    ) DELETE FROM user_memory_records WHERE subject_uid = ? AND id IN (SELECT id FROM chain)`,
      )
      .run(id, uid, uid, uid, uid);
    return result.changes > 0;
  })();
}
