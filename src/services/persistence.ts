import type { DiaryEntry, DiaryGenerationRecord, DiaryObservationV2, User } from "../global.d.js";
import {
  dateRangeForTimezone,
  dateStrForTimezone,
  parseTimestampInputForTimezone,
  todayDateStr,
} from "../libs/time.js";
import {
  normalizePromptData,
  prepareDiaryNoteForStorage,
  prepareMemoryForStorage,
  prepareNicknameForStorage,
} from "../libs/prompt-safety.js";
import {
  buildObservationFingerprint,
  observationsLikelyMatch,
  sanitizeDiaryObservationDraft,
  type DiaryObservationDraft,
} from "../libs/diary-observations.js";
import config from "../configs/env.js";
import { getDatabase } from "./database.js";

const MEMORY_MAX_ENTRIES = 30;
const DIARY_OBSERVATION_DEDUPE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const DIARY_OBSERVATION_SAME_SOURCE_MERGE_WINDOW_MS = 2 * 60 * 1000;

interface UserRow {
  firestore_id: string;
  uid: string;
  nickname: string;
  timezone: string | null;
  nighty_timestamp: number | null;
  last_morning_greet: number | null;
}

interface JsonRow {
  source_json: string;
}

function parseJson<T>(json: string): T | null {
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

function toUser(row: UserRow): User {
  const memories = getDatabase()
    .prepare(`SELECT memory FROM user_memories WHERE user_firestore_id = ? ORDER BY position ASC`)
    .pluck()
    .all(row.firestore_id) as string[];
  return {
    uid: row.uid,
    nickname: row.nickname,
    memories,
    ...(row.timezone !== null ? { timeZone: row.timezone } : {}),
    ...(row.nighty_timestamp !== null ? { nightyTimestamp: row.nighty_timestamp } : {}),
    ...(row.last_morning_greet !== null ? { lastMorningGreet: row.last_morning_greet } : {}),
  };
}

function getUserRow(uid: string): UserRow | undefined {
  return getDatabase()
    .prepare(
      `SELECT firestore_id, uid, nickname, timezone, nighty_timestamp, last_morning_greet
       FROM users WHERE uid = ?`,
    )
    .get(uid) as UserRow | undefined;
}

function requireUpdatedUser(changes: number, uid: string): void {
  if (changes === 0) throw new Error(`User not found: ${uid}`);
}

function replaceUserMemories(userId: string, memories: string[]): void {
  getDatabase().prepare(`DELETE FROM user_memories WHERE user_firestore_id = ?`).run(userId);
  const insert = getDatabase().prepare(
    `INSERT INTO user_memories (user_firestore_id, position, memory) VALUES (?, ?, ?)`,
  );
  memories.forEach((memory, position) => insert.run(userId, position, memory));
}

const USER_CACHE_TTL_MS = 60_000;
interface CacheEntry {
  promise: Promise<User>;
  expiresAt: number;
}
const userCache = new Map<string, CacheEntry>();

export function invalidateUserCache(uid: string): void {
  userCache.delete(uid);
}

function loadOrCreateUser(uid: string, firstName?: string): User {
  return getDatabase().transaction((): User => {
    const existing = getUserRow(uid);
    if (existing) return toUser(existing);
    const user: User = { uid, nickname: firstName ?? "", memories: [] };
    getDatabase()
      .prepare(`INSERT INTO users (firestore_id, uid, nickname, source_json) VALUES (?, ?, ?, ?)`)
      .run(uid, uid, user.nickname, JSON.stringify(user));
    return user;
  })();
}

export async function getOrCreateUser(uid: string, firstName?: string): Promise<User> {
  const now = Date.now();
  const cached = userCache.get(uid);
  if (cached && cached.expiresAt > now) return cached.promise;
  const promise = Promise.resolve().then(() => loadOrCreateUser(uid, firstName));
  userCache.set(uid, { promise, expiresAt: now + USER_CACHE_TTL_MS });
  void promise.catch(() => userCache.delete(uid));
  return promise;
}

export async function updateUserNickname(uid: string, nickname: string): Promise<void> {
  const normalizedNickname = prepareNicknameForStorage(nickname);
  if (!normalizedNickname) return;
  const result = getDatabase()
    .prepare(`UPDATE users SET nickname = ? WHERE uid = ?`)
    .run(normalizedNickname, uid);
  requireUpdatedUser(result.changes, uid);
  invalidateUserCache(uid);
}

export async function updateUserTimeZone(uid: string, timeZone: string): Promise<void> {
  const result = getDatabase()
    .prepare(`UPDATE users SET timezone = ? WHERE uid = ?`)
    .run(timeZone, uid);
  requireUpdatedUser(result.changes, uid);
  invalidateUserCache(uid);
}

export async function updateUserMemory(uid: string, memory: string): Promise<string[]> {
  const trimmed = prepareMemoryForStorage(memory);
  if (!trimmed) return [];
  const result = getDatabase().transaction(() => {
    const row = getUserRow(uid);
    if (!row) throw new Error(`User not found: ${uid}`);
    const existing = toUser(row).memories;
    if (existing.includes(trimmed)) return existing;
    const next = [...existing, trimmed];
    const capped = next.length > MEMORY_MAX_ENTRIES ? next.slice(-MEMORY_MAX_ENTRIES) : next;
    replaceUserMemories(row.firestore_id, capped);
    return capped;
  })();
  invalidateUserCache(uid);
  return result;
}

export async function overwriteUserMemories(
  uid: string,
  compressedMemories: string[],
  originalMemories: string[],
): Promise<void> {
  getDatabase().transaction(() => {
    const row = getUserRow(uid);
    if (!row) return;
    const originals = new Set(originalMemories);
    const newMemories = toUser(row).memories.filter((entry) => !originals.has(entry));
    const merged = [...compressedMemories, ...newMemories];
    const capped = merged.length > MEMORY_MAX_ENTRIES ? merged.slice(-MEMORY_MAX_ENTRIES) : merged;
    replaceUserMemories(row.firestore_id, capped);
  })();
  invalidateUserCache(uid);
}

export async function removeUserMemory(uid: string, memory: string): Promise<boolean> {
  const target = prepareMemoryForStorage(memory);
  if (!target) return false;
  const removed = getDatabase().transaction(() => {
    const row = getUserRow(uid);
    if (!row) return false;
    const existing = toUser(row).memories;
    const next = existing.filter((entry) => normalizePromptData(entry, 160) !== target);
    if (next.length === existing.length) return false;
    replaceUserMemories(row.firestore_id, next);
    return true;
  })();
  invalidateUserCache(uid);
  return removed;
}

export async function countUsersWithMemories(): Promise<number> {
  const row = getDatabase()
    .prepare(`SELECT COUNT(DISTINCT user_firestore_id) AS count FROM user_memories`)
    .get() as { count: number };
  return row.count;
}

export async function setNightyTimestamp(uid: string, timestamp: number): Promise<void> {
  const result = getDatabase()
    .prepare(`UPDATE users SET nighty_timestamp = ?, last_morning_greet = NULL WHERE uid = ?`)
    .run(timestamp, uid);
  requireUpdatedUser(result.changes, uid);
  invalidateUserCache(uid);
}

export async function setMorningGreeted(uid: string, timestamp: number): Promise<void> {
  const result = getDatabase()
    .prepare(`UPDATE users SET last_morning_greet = ? WHERE uid = ?`)
    .run(timestamp, uid);
  requireUpdatedUser(result.changes, uid);
  invalidateUserCache(uid);
}

function isValidDiaryObservation(data: unknown): data is DiaryObservationV2 {
  const d = data as Record<string, unknown>;
  return (
    d?.schemaVersion === 2 &&
    typeof d.id === "string" &&
    typeof d.recordedAt === "string" &&
    typeof d.localDate === "string" &&
    (d.subjectUid === undefined || typeof d.subjectUid === "string") &&
    (d.subjectName === undefined || typeof d.subjectName === "string") &&
    (d.subjectUsername === undefined || typeof d.subjectUsername === "string") &&
    typeof d.event === "string" &&
    (d.occurredAt === undefined || typeof d.occurredAt === "string") &&
    (d.exactQuote === undefined || typeof d.exactQuote === "string") &&
    (d.immediateReaction === undefined || typeof d.immediateReaction === "string") &&
    (d.interpretation === undefined || typeof d.interpretation === "string") &&
    (d.unsaidThought === undefined || typeof d.unsaidThought === "string") &&
    (d.unresolvedQuestion === undefined || typeof d.unresolvedQuestion === "string") &&
    (d.confidence === "fact" || d.confidence === "inference" || d.confidence === "uncertain") &&
    [1, 2, 3, 4, 5].includes(Number(d.salience)) &&
    (d.tags === undefined || Array.isArray(d.tags)) &&
    (d.sourceRefs === undefined || Array.isArray(d.sourceRefs)) &&
    (d.status === "active" || d.status === "superseded" || d.status === "retracted") &&
    (d.supersedesId === undefined || typeof d.supersedesId === "string")
  );
}

function parseObservation(row: JsonRow | undefined): DiaryObservationV2 | null {
  if (!row) return null;
  const value = parseJson<unknown>(row.source_json);
  return isValidDiaryObservation(value) ? value : null;
}

function resolveObservationDate(occurredAt?: string): string {
  if (occurredAt) {
    const parsed = parseTimestampInputForTimezone(occurredAt, config.appTimezone);
    if (parsed != null) return dateStrForTimezone(parsed, config.appTimezone);
  }
  return todayDateStr();
}

function mergeObservationFields(
  existing: DiaryObservationV2,
  patch: DiaryObservationDraft,
  options: { preferPatchConfidence: boolean; preferPatchSalience: boolean },
): DiaryObservationDraft {
  return {
    ...((patch.occurredAt ?? existing.occurredAt)
      ? { occurredAt: patch.occurredAt ?? existing.occurredAt }
      : {}),
    ...((patch.subjectUid ?? existing.subjectUid)
      ? { subjectUid: patch.subjectUid ?? existing.subjectUid }
      : {}),
    ...((patch.subjectName ?? existing.subjectName)
      ? { subjectName: patch.subjectName ?? existing.subjectName }
      : {}),
    ...((patch.subjectUsername ?? existing.subjectUsername)
      ? { subjectUsername: patch.subjectUsername ?? existing.subjectUsername }
      : {}),
    event: patch.event,
    ...((patch.exactQuote ?? existing.exactQuote)
      ? { exactQuote: patch.exactQuote ?? existing.exactQuote }
      : {}),
    ...((patch.immediateReaction ?? existing.immediateReaction)
      ? { immediateReaction: patch.immediateReaction ?? existing.immediateReaction }
      : {}),
    ...((patch.interpretation ?? existing.interpretation)
      ? { interpretation: patch.interpretation ?? existing.interpretation }
      : {}),
    ...((patch.unsaidThought ?? existing.unsaidThought)
      ? { unsaidThought: patch.unsaidThought ?? existing.unsaidThought }
      : {}),
    ...((patch.unresolvedQuestion ?? existing.unresolvedQuestion)
      ? { unresolvedQuestion: patch.unresolvedQuestion ?? existing.unresolvedQuestion }
      : {}),
    confidence: options.preferPatchConfidence ? patch.confidence : existing.confidence,
    salience: options.preferPatchSalience
      ? (Math.max(patch.salience, existing.salience) as DiaryObservationDraft["salience"])
      : existing.salience,
    tags: Array.from(new Set([...(existing.tags ?? []), ...(patch.tags ?? [])])).slice(0, 8),
    sourceRefs: Array.from(
      new Set([...(existing.sourceRefs ?? []), ...(patch.sourceRefs ?? [])]),
    ).slice(0, 12),
  };
}

function observationPayload(observation: DiaryObservationV2): string {
  const fingerprint = buildObservationFingerprint(
    observation.localDate,
    observation.event,
    observation.sourceRefs ?? [],
    observation.subjectUid,
  );
  return JSON.stringify({ ...observation, fingerprint });
}

function saveObservation(observation: DiaryObservationV2): void {
  getDatabase()
    .prepare(
      `INSERT INTO diary_observations (
         firestore_id, observation_id, schema_version, occurred_at, recorded_at, local_date,
         subject_uid, subject_name, subject_username, event, exact_quote, immediate_reaction,
         interpretation, unsaid_thought, unresolved_question, confidence, salience, tags_json,
         source_refs_json, status, supersedes_id, source_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(firestore_id) DO UPDATE SET
         observation_id = excluded.observation_id, schema_version = excluded.schema_version,
         occurred_at = excluded.occurred_at, recorded_at = excluded.recorded_at,
         local_date = excluded.local_date, subject_uid = excluded.subject_uid,
         subject_name = excluded.subject_name, subject_username = excluded.subject_username,
         event = excluded.event, exact_quote = excluded.exact_quote,
         immediate_reaction = excluded.immediate_reaction,
         interpretation = excluded.interpretation, unsaid_thought = excluded.unsaid_thought,
         unresolved_question = excluded.unresolved_question, confidence = excluded.confidence,
         salience = excluded.salience, tags_json = excluded.tags_json,
         source_refs_json = excluded.source_refs_json, status = excluded.status,
         supersedes_id = excluded.supersedes_id, source_json = excluded.source_json`,
    )
    .run(
      observation.id,
      observation.id,
      observation.schemaVersion,
      observation.occurredAt ?? null,
      observation.recordedAt,
      observation.localDate,
      observation.subjectUid ?? null,
      observation.subjectName ?? null,
      observation.subjectUsername ?? null,
      observation.event,
      observation.exactQuote ?? null,
      observation.immediateReaction ?? null,
      observation.interpretation ?? null,
      observation.unsaidThought ?? null,
      observation.unresolvedQuestion ?? null,
      observation.confidence,
      observation.salience,
      observation.tags ? JSON.stringify(observation.tags) : null,
      observation.sourceRefs ? JSON.stringify(observation.sourceRefs) : null,
      observation.status,
      observation.supersedesId ?? null,
      observationPayload(observation),
    );
}

export interface DiaryObservationWriteResult {
  action: "created" | "merged" | "updated" | "retracted" | "ignored";
  observation?: DiaryObservationV2;
  previousObservation?: DiaryObservationV2;
  reason?: string;
}

function ensureDiary(date: string): void {
  getDatabase()
    .prepare(
      `INSERT INTO diary (firestore_id, date, source_json) VALUES (?, ?, ?)
       ON CONFLICT(firestore_id) DO NOTHING`,
    )
    .run(date, date, JSON.stringify({ date }));
}

export async function writeDiaryEntry(note: string): Promise<void> {
  const content = prepareDiaryNoteForStorage(note);
  if (!content) return;
  const date = todayDateStr();
  getDatabase().transaction(() => {
    ensureDiary(date);
    const row = getDatabase()
      .prepare(
        `SELECT COALESCE(MAX(position), -1) + 1 AS position
         FROM diary_entries WHERE diary_firestore_id = ?`,
      )
      .get(date) as { position: number };
    getDatabase()
      .prepare(
        `INSERT INTO diary_entries (diary_firestore_id, position, ts, content)
         VALUES (?, ?, ?, ?)`,
      )
      .run(date, row.position, Date.now(), content);
  })();
}

export async function getDiaryEntries(date: string): Promise<DiaryEntry[]> {
  return getDatabase()
    .prepare(
      `SELECT ts, content FROM diary_entries
       WHERE diary_firestore_id = ? ORDER BY position ASC`,
    )
    .all(date) as DiaryEntry[];
}

export async function getGeneratedDiary(date: string): Promise<string | null> {
  const row = getDatabase()
    .prepare(`SELECT generated_diary FROM diary WHERE firestore_id = ?`)
    .get(date) as { generated_diary: string | null } | undefined;
  return row?.generated_diary?.trim() ? row.generated_diary : null;
}

export async function getDiaryObservation(id: string): Promise<DiaryObservationV2 | null> {
  const row = getDatabase()
    .prepare(`SELECT source_json FROM diary_observations WHERE firestore_id = ?`)
    .get(id) as JsonRow | undefined;
  return parseObservation(row);
}

function listObservations(sql: string, ...params: unknown[]): DiaryObservationV2[] {
  return (
    getDatabase()
      .prepare(sql)
      .all(...params) as JsonRow[]
  )
    .map((row) => parseObservation(row))
    .filter((value): value is DiaryObservationV2 => value !== null);
}

export async function listDiaryObservationsByDate(date: string): Promise<DiaryObservationV2[]> {
  return listObservations(
    `SELECT source_json FROM diary_observations WHERE local_date = ? ORDER BY recorded_at ASC`,
    date,
  );
}

export async function listActiveDiaryObservationsByDate(
  date: string,
): Promise<DiaryObservationV2[]> {
  return listObservations(
    `SELECT source_json FROM diary_observations
     WHERE local_date = ? AND status = 'active' ORDER BY recorded_at ASC`,
    date,
  );
}

function recentObservationCandidates(localDate: string): DiaryObservationV2[] {
  const cutoff = new Date(Date.now() - DIARY_OBSERVATION_DEDUPE_WINDOW_MS).toISOString();
  return listObservations(
    `SELECT source_json FROM diary_observations
     WHERE recorded_at >= ? AND local_date = ? AND status = 'active' ORDER BY recorded_at ASC`,
    cutoff,
    localDate,
  );
}

function shouldMergeObservationBySharedSource(
  candidate: DiaryObservationV2,
  draft: DiaryObservationDraft,
): boolean {
  if (candidate.subjectUid && draft.subjectUid && candidate.subjectUid !== draft.subjectUid)
    return false;
  const candidateRefs = new Set(candidate.sourceRefs ?? []);
  const draftRefs = new Set(draft.sourceRefs ?? []);
  if (candidateRefs.size === 0 || draftRefs.size === 0) return false;
  if (![...draftRefs].some((ref) => candidateRefs.has(ref))) return false;
  const recordedAt = Date.parse(candidate.recordedAt);
  return (
    !Number.isNaN(recordedAt) &&
    Date.now() - recordedAt <= DIARY_OBSERVATION_SAME_SOURCE_MERGE_WINDOW_MS
  );
}

export async function createDiaryObservation(params: {
  observation: Partial<DiaryObservationDraft>;
  sourceRefs?: string[];
}): Promise<DiaryObservationWriteResult> {
  const preferPatchConfidence = params.observation.confidence !== undefined;
  const preferPatchSalience = params.observation.salience !== undefined;
  const sanitized = sanitizeDiaryObservationDraft({
    ...params.observation,
    sourceRefs: [...(params.observation.sourceRefs ?? []), ...(params.sourceRefs ?? [])],
  });
  if (!sanitized) return { action: "ignored", reason: "observation payload invalid" };

  return getDatabase().transaction((): DiaryObservationWriteResult => {
    const localDate = resolveObservationDate(sanitized.occurredAt);
    const duplicate = recentObservationCandidates(localDate).find(
      (candidate) =>
        observationsLikelyMatch(candidate, sanitized) ||
        shouldMergeObservationBySharedSource(candidate, sanitized),
    );
    if (duplicate) {
      const next: DiaryObservationV2 = {
        ...duplicate,
        ...mergeObservationFields(duplicate, sanitized, {
          preferPatchConfidence,
          preferPatchSalience,
        }),
        schemaVersion: 2,
        id: duplicate.id,
        localDate: duplicate.localDate,
        recordedAt: duplicate.recordedAt,
        status: "active",
        ...(duplicate.subjectUid || sanitized.subjectUid
          ? { subjectUid: sanitized.subjectUid ?? duplicate.subjectUid }
          : {}),
        ...(duplicate.subjectName || sanitized.subjectName
          ? { subjectName: sanitized.subjectName ?? duplicate.subjectName }
          : {}),
        ...(duplicate.subjectUsername || sanitized.subjectUsername
          ? { subjectUsername: sanitized.subjectUsername ?? duplicate.subjectUsername }
          : {}),
        ...(duplicate.supersedesId ? { supersedesId: duplicate.supersedesId } : {}),
      };
      saveObservation(next);
      return { action: "merged", observation: next, previousObservation: duplicate };
    }
    const observation: DiaryObservationV2 = {
      schemaVersion: 2,
      id: globalThis.crypto.randomUUID(),
      recordedAt: new Date().toISOString(),
      localDate,
      ...(sanitized.subjectUid ? { subjectUid: sanitized.subjectUid } : {}),
      ...(sanitized.subjectName ? { subjectName: sanitized.subjectName } : {}),
      ...(sanitized.subjectUsername ? { subjectUsername: sanitized.subjectUsername } : {}),
      event: sanitized.event,
      confidence: sanitized.confidence,
      salience: sanitized.salience,
      status: "active",
      ...(sanitized.occurredAt ? { occurredAt: sanitized.occurredAt } : {}),
      ...(sanitized.exactQuote ? { exactQuote: sanitized.exactQuote } : {}),
      ...(sanitized.immediateReaction ? { immediateReaction: sanitized.immediateReaction } : {}),
      ...(sanitized.interpretation ? { interpretation: sanitized.interpretation } : {}),
      ...(sanitized.unsaidThought ? { unsaidThought: sanitized.unsaidThought } : {}),
      ...(sanitized.unresolvedQuestion ? { unresolvedQuestion: sanitized.unresolvedQuestion } : {}),
      ...(sanitized.tags?.length ? { tags: sanitized.tags } : {}),
      ...(sanitized.sourceRefs?.length ? { sourceRefs: sanitized.sourceRefs } : {}),
      ...(sanitized.supersedesId ? { supersedesId: sanitized.supersedesId } : {}),
    };
    saveObservation(observation);
    return { action: "created", observation };
  })();
}

export async function updateDiaryObservation(
  targetId: string,
  patch: Partial<DiaryObservationDraft>,
): Promise<DiaryObservationWriteResult> {
  return getDatabase().transaction((): DiaryObservationWriteResult => {
    const current = parseObservation(
      getDatabase()
        .prepare(`SELECT source_json FROM diary_observations WHERE firestore_id = ?`)
        .get(targetId) as JsonRow | undefined,
    );
    if (!current) return { action: "ignored", reason: "not_found" };
    const base = sanitizeDiaryObservationDraft({
      ...((patch.occurredAt ?? current.occurredAt)
        ? { occurredAt: patch.occurredAt ?? current.occurredAt }
        : {}),
      ...((patch.subjectUid ?? current.subjectUid)
        ? { subjectUid: patch.subjectUid ?? current.subjectUid }
        : {}),
      ...((patch.subjectName ?? current.subjectName)
        ? { subjectName: patch.subjectName ?? current.subjectName }
        : {}),
      ...((patch.subjectUsername ?? current.subjectUsername)
        ? { subjectUsername: patch.subjectUsername ?? current.subjectUsername }
        : {}),
      event: patch.event ?? current.event,
      ...((patch.exactQuote ?? current.exactQuote)
        ? { exactQuote: patch.exactQuote ?? current.exactQuote }
        : {}),
      ...((patch.immediateReaction ?? current.immediateReaction)
        ? { immediateReaction: patch.immediateReaction ?? current.immediateReaction }
        : {}),
      ...((patch.interpretation ?? current.interpretation)
        ? { interpretation: patch.interpretation ?? current.interpretation }
        : {}),
      ...((patch.unsaidThought ?? current.unsaidThought)
        ? { unsaidThought: patch.unsaidThought ?? current.unsaidThought }
        : {}),
      ...((patch.unresolvedQuestion ?? current.unresolvedQuestion)
        ? { unresolvedQuestion: patch.unresolvedQuestion ?? current.unresolvedQuestion }
        : {}),
      confidence: patch.confidence ?? current.confidence,
      salience: patch.salience ?? current.salience,
      ...((patch.tags ?? current.tags) ? { tags: patch.tags ?? current.tags } : {}),
      ...((patch.sourceRefs ?? current.sourceRefs)
        ? { sourceRefs: patch.sourceRefs ?? current.sourceRefs }
        : {}),
      supersedesId: current.id,
    });
    if (!base) return { action: "ignored", reason: "invalid_patch" };
    const next: DiaryObservationV2 = {
      schemaVersion: 2,
      id: globalThis.crypto.randomUUID(),
      recordedAt: new Date().toISOString(),
      localDate: resolveObservationDate(base.occurredAt),
      ...(base.subjectUid ? { subjectUid: base.subjectUid } : {}),
      ...(base.subjectName ? { subjectName: base.subjectName } : {}),
      ...(base.subjectUsername ? { subjectUsername: base.subjectUsername } : {}),
      event: base.event,
      confidence: base.confidence,
      salience: base.salience,
      status: "active",
      supersedesId: current.id,
      ...(base.occurredAt ? { occurredAt: base.occurredAt } : {}),
      ...(base.exactQuote ? { exactQuote: base.exactQuote } : {}),
      ...(base.immediateReaction ? { immediateReaction: base.immediateReaction } : {}),
      ...(base.interpretation ? { interpretation: base.interpretation } : {}),
      ...(base.unsaidThought ? { unsaidThought: base.unsaidThought } : {}),
      ...(base.unresolvedQuestion ? { unresolvedQuestion: base.unresolvedQuestion } : {}),
      ...(base.tags?.length ? { tags: base.tags } : {}),
      ...(base.sourceRefs?.length ? { sourceRefs: base.sourceRefs } : {}),
    };
    saveObservation({ ...current, status: "superseded" });
    saveObservation(next);
    return { action: "updated", observation: next, previousObservation: current };
  })();
}

export async function retractDiaryObservation(
  targetId: string,
  reason?: string,
): Promise<DiaryObservationWriteResult> {
  return getDatabase().transaction((): DiaryObservationWriteResult => {
    const current = parseObservation(
      getDatabase()
        .prepare(`SELECT source_json FROM diary_observations WHERE firestore_id = ?`)
        .get(targetId) as JsonRow | undefined,
    );
    if (!current) return { action: "ignored", reason: "not_found" };
    if (current.status === "retracted")
      return { action: "ignored", reason: "already_retracted", observation: current };
    const next: DiaryObservationV2 = { ...current, status: "retracted" };
    const extra = {
      ...next,
      ...(reason && normalizePromptData(reason, 200)
        ? { retractionReason: normalizePromptData(reason, 200) }
        : {}),
      retractedAt: new Date().toISOString(),
    };
    getDatabase()
      .prepare(`UPDATE diary_observations SET status = ?, source_json = ? WHERE firestore_id = ?`)
      .run(next.status, JSON.stringify(extra), current.id);
    return { action: "retracted", observation: next, previousObservation: current };
  })();
}

export async function appendDiaryGenerationRecord(record: DiaryGenerationRecord): Promise<void> {
  getDatabase().transaction(() => {
    ensureDiary(record.date);
    const payload = JSON.stringify(record);
    const duplicate = getDatabase()
      .prepare(
        `SELECT 1 FROM diary_generation_records
         WHERE diary_firestore_id = ? AND source_json = ?`,
      )
      .get(record.date, payload);
    if (duplicate) return;
    const row = getDatabase()
      .prepare(
        `SELECT COALESCE(MAX(position), -1) + 1 AS position
         FROM diary_generation_records WHERE diary_firestore_id = ?`,
      )
      .get(record.date) as { position: number };
    getDatabase()
      .prepare(
        `INSERT INTO diary_generation_records (
           diary_firestore_id, position, date, generated_at, model_provider, model_name,
           prompt_version, style_reference_version, observation_ids_json, input_tokens,
           output_tokens, status, error, source_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.date,
        row.position,
        record.date,
        record.generatedAt,
        record.modelProvider,
        record.modelName,
        record.promptVersion,
        record.styleReferenceVersion,
        JSON.stringify(record.observationIds),
        record.inputTokens ?? null,
        record.outputTokens ?? null,
        record.status,
        record.error ?? null,
        payload,
      );
  })();
}

export async function writeGeneratedDiary(date: string, diary: string): Promise<void> {
  getDatabase().transaction(() => {
    ensureDiary(date);
    getDatabase()
      .prepare(
        `UPDATE diary SET generated_diary = ?, generated_at = ?, source_json = ?
         WHERE firestore_id = ?`,
      )
      .run(diary, Date.now(), JSON.stringify({ date, diary }), date);
  })();
}

export interface RuntimeGroupStateDoc {
  summary: string;
  summaryCursorTs: number;
  lastProcessedMessageId?: number;
  lastCompactedAt?: number;
  updatedAt: number;
}

export interface RuntimeMediaRef {
  type: string;
  source?: string;
  fileId?: string;
  thumbnailFileId?: string;
  isAnimated?: boolean;
  isVideo?: boolean;
  emoji?: string;
  filename?: string;
  title?: string;
}

export interface RuntimeReplyRef {
  uid: string;
  name: string;
  username?: string;
  text?: string;
  messageId?: number;
}

export interface RuntimeEventRecord {
  chatId: string;
  messageId?: number;
  updateId?: number;
  kind: "user_message" | "edited_message" | "bot_message" | "command" | "system";
  uid: string;
  name: string;
  username?: string;
  text: string;
  mediaRefs: RuntimeMediaRef[];
  urls: string[];
  replyTo?: RuntimeReplyRef;
  ts: number;
  ignoredReason?: string;
}

export interface RuntimeTurnToolCall {
  name: string;
  argsPreview?: string;
  resultPreview?: string;
}

export interface RuntimeTurnRecord {
  kind: "passive" | "proactive" | "retry" | "subagent" | "compaction";
  startedAt: number;
  completedAt: number;
  model: string;
  tier?: "simple" | "complex" | "tech";
  needsSearch: boolean;
  toolCalls: RuntimeTurnToolCall[];
  action: "send" | "dismiss" | "error";
  messages: string[];
  stickerFileId?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  latencyMs?: number;
  error?: string;
}

export interface RuntimeCompactionRecord {
  oldCursorTs: number;
  newCursorTs: number;
  summary: string;
  inputTokens: number;
  outputTokens: number;
  createdAt: number;
}

export async function loadRuntimeGroupState(): Promise<RuntimeGroupStateDoc> {
  const row = getDatabase()
    .prepare(`SELECT source_json FROM runtime_group WHERE firestore_id = 'group'`)
    .get() as JsonRow | undefined;
  const data = row ? parseJson<Record<string, unknown>>(row.source_json) : null;
  return {
    summary: typeof data?.summary === "string" ? data.summary : "",
    summaryCursorTs: typeof data?.summaryCursorTs === "number" ? data.summaryCursorTs : 0,
    ...(typeof data?.lastProcessedMessageId === "number"
      ? { lastProcessedMessageId: data.lastProcessedMessageId }
      : {}),
    ...(typeof data?.lastCompactedAt === "number" ? { lastCompactedAt: data.lastCompactedAt } : {}),
    updatedAt: typeof data?.updatedAt === "number" ? data.updatedAt : Date.now(),
  };
}

export async function writeRuntimeGroupState(patch: Partial<RuntimeGroupStateDoc>): Promise<void> {
  writeRuntimeGroupStateSync(patch);
}

function writeRuntimeGroupStateSync(patch: Partial<RuntimeGroupStateDoc>): void {
  getDatabase().transaction(() => {
    const row = getDatabase()
      .prepare(`SELECT source_json FROM runtime_group WHERE firestore_id = 'group'`)
      .get() as JsonRow | undefined;
    const current = row ? (parseJson<Record<string, unknown>>(row.source_json) ?? {}) : {};
    const state = { ...current, ...patch, updatedAt: Date.now() };
    getDatabase()
      .prepare(
        `INSERT INTO runtime_group (
           firestore_id, summary, summary_cursor_ts, last_processed_message_id,
           last_compacted_at, updated_at, source_json
         ) VALUES ('group', ?, ?, ?, ?, ?, ?)
         ON CONFLICT(firestore_id) DO UPDATE SET summary = excluded.summary,
           summary_cursor_ts = excluded.summary_cursor_ts,
           last_processed_message_id = excluded.last_processed_message_id,
           last_compacted_at = excluded.last_compacted_at, updated_at = excluded.updated_at,
           source_json = excluded.source_json`,
      )
      .run(
        typeof state.summary === "string" ? state.summary : "",
        typeof state.summaryCursorTs === "number" ? state.summaryCursorTs : 0,
        typeof state.lastProcessedMessageId === "number" ? state.lastProcessedMessageId : null,
        typeof state.lastCompactedAt === "number" ? state.lastCompactedAt : null,
        state.updatedAt,
        JSON.stringify(state),
      );
  })();
}

export async function resetRuntimeConversationSummary(): Promise<void> {
  await writeRuntimeGroupState({ summary: "", summaryCursorTs: Date.now(), lastCompactedAt: 0 });
}

export async function appendRuntimeEvent(record: RuntimeEventRecord): Promise<void> {
  insertRuntimeEvent(record);
}

function insertRuntimeEvent(record: RuntimeEventRecord): void {
  getDatabase()
    .prepare(
      `INSERT INTO runtime_events (
         firestore_id, chat_id, message_id, update_id, kind, uid, name, username, text,
         media_refs_json, urls_json, reply_to_json, ts, ignored_reason, source_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      globalThis.crypto.randomUUID(),
      record.chatId,
      record.messageId ?? null,
      record.updateId ?? null,
      record.kind,
      record.uid,
      record.name,
      record.username ?? null,
      record.text,
      JSON.stringify(record.mediaRefs),
      JSON.stringify(record.urls),
      record.replyTo ? JSON.stringify(record.replyTo) : null,
      record.ts,
      record.ignoredReason ?? null,
      JSON.stringify(record),
    );
}

export async function appendRuntimeEventAndAdvance(
  record: RuntimeEventRecord,
  lastProcessedMessageId: number,
): Promise<void> {
  getDatabase().transaction(() => {
    insertRuntimeEvent(record);
    writeRuntimeGroupStateSync({ lastProcessedMessageId });
  })();
}

function parsePayloadRows<T>(rows: JsonRow[]): T[] {
  return rows
    .map((row) => parseJson<T>(row.source_json))
    .filter((value): value is T => value !== null);
}

export async function loadRecentRuntimeEvents(
  params: { afterTs?: number; limit?: number; newestFirst?: boolean } = {},
): Promise<RuntimeEventRecord[]> {
  const limit = params.limit ?? 240;
  const where = params.afterTs != null ? "WHERE ts > ?" : "";
  const bindings = params.afterTs != null ? [params.afterTs, limit] : [limit];
  const direction = params.newestFirst ? "DESC" : "ASC";
  const rows = getDatabase()
    .prepare(
      `SELECT source_json FROM runtime_events ${where}
       ORDER BY ts ${direction}, firestore_id ${direction} LIMIT ?`,
    )
    .all(...bindings) as JsonRow[];
  const records = parsePayloadRows<RuntimeEventRecord>(rows);
  return params.newestFirst ? records.reverse() : records;
}

export async function loadRuntimeEventsForLocalDate(
  date: string,
  limit = 240,
): Promise<RuntimeEventRecord[]> {
  const range = dateRangeForTimezone(date, config.appTimezone);
  if (!range) return [];
  const boundedLimit = Math.max(1, Math.floor(limit));
  const firstLimit = Math.ceil(boundedLimit / 2);
  const lastLimit = boundedLimit - firstLimit;
  const select = (direction: "ASC" | "DESC", rowLimit: number) =>
    getDatabase()
      .prepare(
        `SELECT firestore_id, source_json FROM runtime_events
         WHERE ts >= ? AND ts < ?
         ORDER BY ts ${direction}, firestore_id ${direction} LIMIT ?`,
      )
      .all(range.startMs, range.endMs, rowLimit) as (JsonRow & { firestore_id: string })[];
  const rows = [...select("ASC", firstLimit), ...(lastLimit > 0 ? select("DESC", lastLimit) : [])];
  const unique = new Map(rows.map((row) => [row.firestore_id, row]));
  return parsePayloadRows<RuntimeEventRecord>([...unique.values()]).sort((a, b) => a.ts - b.ts);
}

export async function appendTurnRecord(record: RuntimeTurnRecord): Promise<void> {
  getDatabase()
    .prepare(
      `INSERT INTO runtime_turns (
         firestore_id, kind, started_at, completed_at, model, tier, needs_search,
         tool_calls_json, action, messages_json, sticker_file_id, input_tokens,
         output_tokens, cached_input_tokens, latency_ms, error, source_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      globalThis.crypto.randomUUID(),
      record.kind,
      record.startedAt,
      record.completedAt,
      record.model,
      record.tier ?? null,
      record.needsSearch ? 1 : 0,
      JSON.stringify(record.toolCalls),
      record.action,
      JSON.stringify(record.messages),
      record.stickerFileId ?? null,
      record.inputTokens ?? null,
      record.outputTokens ?? null,
      record.cachedInputTokens ?? null,
      record.latencyMs ?? null,
      record.error ?? null,
      JSON.stringify(record),
    );
}

export async function loadRecentTurnRecords(
  params: { afterTs?: number; limit?: number } = {},
): Promise<RuntimeTurnRecord[]> {
  const where = params.afterTs != null ? "WHERE started_at > ?" : "";
  const bindings =
    params.afterTs != null ? [params.afterTs, params.limit ?? 120] : [params.limit ?? 120];
  const rows = getDatabase()
    .prepare(
      `SELECT source_json FROM runtime_turns ${where}
       ORDER BY started_at ASC, firestore_id ASC LIMIT ?`,
    )
    .all(...bindings) as JsonRow[];
  return parsePayloadRows<RuntimeTurnRecord>(rows);
}

export async function appendCompactionRecord(record: RuntimeCompactionRecord): Promise<void> {
  insertCompactionRecord(record);
}

function insertCompactionRecord(record: RuntimeCompactionRecord): void {
  getDatabase()
    .prepare(
      `INSERT INTO runtime_compactions (
         firestore_id, old_cursor_ts, new_cursor_ts, summary, input_tokens,
         output_tokens, created_at, source_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      globalThis.crypto.randomUUID(),
      record.oldCursorTs,
      record.newCursorTs,
      record.summary,
      record.inputTokens,
      record.outputTokens,
      record.createdAt,
      JSON.stringify(record),
    );
}

export async function commitRuntimeCompaction(
  record: RuntimeCompactionRecord,
  state: Pick<RuntimeGroupStateDoc, "summary" | "summaryCursorTs" | "lastCompactedAt">,
): Promise<void> {
  getDatabase().transaction(() => {
    insertCompactionRecord(record);
    writeRuntimeGroupStateSync(state);
  })();
}
