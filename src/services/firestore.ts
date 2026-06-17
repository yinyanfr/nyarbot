import { getFirestore, FieldValue, type Firestore, type Query } from "firebase-admin/firestore";
import type { DiaryEntry, DiaryGenerationRecord, DiaryObservationV2, User } from "../global.d.js";
import { dateStrForTimezone, parseTimestampInputForTimezone, todayDateStr } from "../libs/time.js";
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

// Lazy accessor: getFirestore() requires initializeApp() to have run first.
// Resolving it at module-evaluation time breaks because ESM imports are hoisted
// above the initFirebase() call in app.ts. Calling it on first use side-steps that.
let _db: Firestore | null = null;
function db(): Firestore {
  if (!_db) _db = getFirestore();
  return _db;
}

// Tunables
const MEMORY_MAX_ENTRIES = 30;
const DIARY_OBSERVATION_DEDUPE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

function isValidUser(data: unknown): data is User {
  const d = data as Record<string, unknown>;
  return (
    typeof d?.uid === "string" &&
    typeof d?.nickname === "string" &&
    Array.isArray(d?.memories) &&
    (d?.timeZone === undefined || typeof d.timeZone === "string")
  );
}

// ---------------------------------------------------------------------------
// In-process cache for getOrCreateUser
// ---------------------------------------------------------------------------
// The cache stores Promise<User> so concurrent calls for the same uid share
// the same in-flight transaction, eliminating the check-then-write race.
// TTL is modest (60s) so mutations from other sources remain visible.

const USER_CACHE_TTL_MS = 60_000;
interface CacheEntry {
  promise: Promise<User>;
  expiresAt: number;
}
const userCache = new Map<string, CacheEntry>();

export function invalidateUserCache(uid: string): void {
  userCache.delete(uid);
}

async function loadOrCreateUserTx(uid: string, firstName?: string): Promise<User> {
  const ref = db().collection("users").doc(uid);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const data = snap.data();
      if (isValidUser(data)) return data;
    }
    const user: User = { uid, nickname: firstName ?? "", memories: [] };
    tx.set(ref, user);
    return user;
  });
}

export async function getOrCreateUser(uid: string, firstName?: string): Promise<User> {
  const now = Date.now();
  const cached = userCache.get(uid);
  if (cached && cached.expiresAt > now) {
    return cached.promise;
  }
  const promise = loadOrCreateUserTx(uid, firstName).catch((err) => {
    userCache.delete(uid);
    throw err;
  });
  userCache.set(uid, { promise, expiresAt: now + USER_CACHE_TTL_MS });
  return promise;
}

export async function updateUserNickname(uid: string, nickname: string): Promise<void> {
  const normalizedNickname = prepareNicknameForStorage(nickname);
  if (!normalizedNickname) return;
  await db().collection("users").doc(uid).update({ nickname: normalizedNickname });
  invalidateUserCache(uid);
}

export async function updateUserTimeZone(uid: string, timeZone: string): Promise<void> {
  await db().collection("users").doc(uid).update({ timeZone });
  invalidateUserCache(uid);
}

export async function updateUserMemory(uid: string, memory: string): Promise<string[]> {
  const trimmed = prepareMemoryForStorage(memory);
  if (!trimmed) return [];

  // Use a transaction so the append-and-trim is atomic: without it, two
  // concurrent writes could both pass the length check and leave the list
  // over the cap.
  const result = await db().runTransaction(async (tx) => {
    const ref = db().collection("users").doc(uid);
    const snap = await tx.get(ref);
    const existing: string[] =
      snap.exists && Array.isArray(snap.data()?.memories)
        ? (snap.data()!.memories as string[])
        : [];

    // Exact-string dedup (FieldValue.arrayUnion does the same, but we need the
    // post-write length for trimming, so we duplicate the check here).
    if (existing.includes(trimmed)) return existing;

    const next = [...existing, trimmed];
    // Hard cap: drop the oldest entries. The LLM gets a running window of
    // the most recent N facts rather than an unbounded history.
    const trimmedList =
      next.length > MEMORY_MAX_ENTRIES ? next.slice(next.length - MEMORY_MAX_ENTRIES) : next;

    tx.update(ref, { memories: trimmedList });
    return trimmedList;
  });
  invalidateUserCache(uid);
  return result;
}

export async function overwriteUserMemories(
  uid: string,
  compressedMemories: string[],
  originalMemories: string[],
): Promise<void> {
  await db().runTransaction(async (tx) => {
    const ref = db().collection("users").doc(uid);
    const snap = await tx.get(ref);
    if (!snap.exists) return;

    const existing: string[] = Array.isArray(snap.data()?.memories)
      ? (snap.data()!.memories as string[])
      : [];

    // Remove the original (uncompressed) memories, keep any new ones added
    // during the compression window.
    const originalsSet = new Set(originalMemories);
    const newMemories = existing.filter((m) => !originalsSet.has(m));
    const merged = [...compressedMemories, ...newMemories];
    const capped =
      merged.length > MEMORY_MAX_ENTRIES
        ? merged.slice(merged.length - MEMORY_MAX_ENTRIES)
        : merged;
    tx.update(ref, { memories: capped });
  });
  invalidateUserCache(uid);
}

export async function removeUserMemory(uid: string, memory: string): Promise<boolean> {
  const normalizedTarget = prepareMemoryForStorage(memory);
  if (!normalizedTarget) return false;

  const removed = await db().runTransaction(async (tx) => {
    const ref = db().collection("users").doc(uid);
    const snap = await tx.get(ref);
    if (!snap.exists) return false;

    const existing: string[] = Array.isArray(snap.data()?.memories)
      ? (snap.data()!.memories as string[])
      : [];

    const next = existing.filter((entry) => normalizePromptData(entry, 160) !== normalizedTarget);
    if (next.length === existing.length) return false;

    tx.update(ref, { memories: next });
    return true;
  });

  invalidateUserCache(uid);
  return removed;
}

/** Count users with at least one memory. Used by /status. */
export async function countUsersWithMemories(): Promise<number> {
  const snap = await db().collection("users").get();
  let n = 0;
  for (const doc of snap.docs) {
    const m = doc.data().memories;
    if (Array.isArray(m) && m.length > 0) n++;
  }
  return n;
}

export async function setNightyTimestamp(uid: string, timestamp: number): Promise<void> {
  await db()
    .collection("users")
    .doc(uid)
    .update({ nightyTimestamp: timestamp, lastMorningGreet: FieldValue.delete() });
  invalidateUserCache(uid);
}

export async function setMorningGreeted(uid: string, timestamp: number): Promise<void> {
  await db().collection("users").doc(uid).update({ lastMorningGreet: timestamp });
  invalidateUserCache(uid);
}

function isValidDiaryObservation(data: unknown): data is DiaryObservationV2 {
  const d = data as Record<string, unknown>;
  return (
    d?.schemaVersion === 2 &&
    typeof d.id === "string" &&
    typeof d.recordedAt === "string" &&
    typeof d.localDate === "string" &&
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

function resolveObservationDate(occurredAt?: string): string {
  if (occurredAt) {
    const parsed = parseTimestampInputForTimezone(occurredAt, config.appTimezone);
    if (parsed != null) {
      return dateStrForTimezone(parsed, config.appTimezone);
    }
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
      ? patch.salience > existing.salience
        ? patch.salience
        : existing.salience
      : existing.salience,
    tags: Array.from(new Set([...(existing.tags ?? []), ...(patch.tags ?? [])])).slice(0, 8),
    sourceRefs: Array.from(
      new Set([...(existing.sourceRefs ?? []), ...(patch.sourceRefs ?? [])]),
    ).slice(0, 12),
  };
}

function toObservationDoc(observation: DiaryObservationV2): Record<string, unknown> {
  const fingerprint = buildObservationFingerprint(
    observation.localDate,
    observation.event,
    observation.sourceRefs ?? [],
  );
  return stripUndefined({ ...observation, fingerprint });
}

export interface DiaryObservationWriteResult {
  action: "created" | "merged" | "updated" | "retracted" | "ignored";
  observation?: DiaryObservationV2;
  previousObservation?: DiaryObservationV2;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Diary
// ---------------------------------------------------------------------------

export async function writeDiaryEntry(note: string): Promise<void> {
  const normalizedNote = prepareDiaryNoteForStorage(note);
  if (!normalizedNote) return;
  const date = todayDateStr();
  const entry: DiaryEntry = { ts: Date.now(), content: normalizedNote };
  await db()
    .collection("diary")
    .doc(date)
    .set(
      {
        date,
        entries: FieldValue.arrayUnion(entry),
      },
      { merge: true },
    );
}

export async function getDiaryEntries(date: string): Promise<DiaryEntry[]> {
  const doc = await db().collection("diary").doc(date).get();
  if (!doc.exists) return [];
  const data = doc.data();
  if (!data) return [];
  return Array.isArray(data.entries) ? (data.entries as DiaryEntry[]) : [];
}

export async function getDiaryObservation(id: string): Promise<DiaryObservationV2 | null> {
  const doc = await db().collection("diaryObservations").doc(id).get();
  if (!doc.exists) return null;
  const data = doc.data();
  return isValidDiaryObservation(data) ? data : null;
}

export async function listDiaryObservationsByDate(date: string): Promise<DiaryObservationV2[]> {
  const snap = await db().collection("diaryObservations").where("localDate", "==", date).get();
  return snap.docs
    .map((doc) => doc.data())
    .filter(isValidDiaryObservation)
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
}

export async function listActiveDiaryObservationsByDate(
  date: string,
): Promise<DiaryObservationV2[]> {
  const all = await listDiaryObservationsByDate(date);
  return all.filter((observation) => observation.status === "active");
}

async function listRecentDiaryObservationCandidates(
  localDate: string,
): Promise<DiaryObservationV2[]> {
  const cutoffIso = new Date(Date.now() - DIARY_OBSERVATION_DEDUPE_WINDOW_MS).toISOString();
  const snap = await db()
    .collection("diaryObservations")
    .where("recordedAt", ">=", cutoffIso)
    .get();
  return snap.docs
    .map((doc) => doc.data())
    .filter(isValidDiaryObservation)
    .filter((observation) => observation.status === "active" && observation.localDate === localDate)
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
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
  if (!sanitized) {
    return { action: "ignored", reason: "observation payload invalid" };
  }
  const localDate = resolveObservationDate(sanitized.occurredAt);
  const candidates = await listRecentDiaryObservationCandidates(localDate);
  const duplicate = candidates.find((candidate) => observationsLikelyMatch(candidate, sanitized));

  if (!duplicate && sanitized.salience <= 2) {
    return { action: "ignored", reason: "salience_too_low" };
  }

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
      ...(duplicate.supersedesId ? { supersedesId: duplicate.supersedesId } : {}),
    };
    await db().collection("diaryObservations").doc(duplicate.id).set(toObservationDoc(next));
    return { action: "merged", observation: next, previousObservation: duplicate };
  }

  const observation: DiaryObservationV2 = {
    schemaVersion: 2,
    id: globalThis.crypto.randomUUID(),
    recordedAt: new Date().toISOString(),
    localDate,
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
    ...(sanitized.tags && sanitized.tags.length > 0 ? { tags: sanitized.tags } : {}),
    ...(sanitized.sourceRefs && sanitized.sourceRefs.length > 0
      ? { sourceRefs: sanitized.sourceRefs }
      : {}),
    ...(sanitized.supersedesId ? { supersedesId: sanitized.supersedesId } : {}),
  };
  await db().collection("diaryObservations").doc(observation.id).set(toObservationDoc(observation));
  return { action: "created", observation };
}

export async function updateDiaryObservation(
  targetId: string,
  patch: Partial<DiaryObservationDraft>,
): Promise<DiaryObservationWriteResult> {
  const current = await getDiaryObservation(targetId);
  if (!current) return { action: "ignored", reason: "not_found" };
  const base = sanitizeDiaryObservationDraft({
    ...((patch.occurredAt ?? current.occurredAt)
      ? { occurredAt: patch.occurredAt ?? current.occurredAt }
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
    ...(base.tags && base.tags.length > 0 ? { tags: base.tags } : {}),
    ...(base.sourceRefs && base.sourceRefs.length > 0 ? { sourceRefs: base.sourceRefs } : {}),
  };
  await db().runTransaction(async (tx) => {
    tx.set(
      db().collection("diaryObservations").doc(current.id),
      { status: "superseded", supersededAt: new Date().toISOString() },
      { merge: true },
    );
    tx.set(db().collection("diaryObservations").doc(next.id), toObservationDoc(next));
  });
  return { action: "updated", observation: next, previousObservation: current };
}

export async function retractDiaryObservation(
  targetId: string,
  reason?: string,
): Promise<DiaryObservationWriteResult> {
  const current = await getDiaryObservation(targetId);
  if (!current) return { action: "ignored", reason: "not_found" };
  if (current.status === "retracted") {
    return { action: "ignored", reason: "already_retracted", observation: current };
  }
  const retractionReason = reason ? normalizePromptData(reason, 200) : "";
  const next: DiaryObservationV2 = {
    ...current,
    status: "retracted",
  };
  await db()
    .collection("diaryObservations")
    .doc(current.id)
    .set(
      stripUndefined({
        ...toObservationDoc(next),
        ...(retractionReason ? { retractionReason } : {}),
        retractedAt: new Date().toISOString(),
      }),
    );
  return { action: "retracted", observation: next, previousObservation: current };
}

export async function appendDiaryGenerationRecord(record: DiaryGenerationRecord): Promise<void> {
  await db()
    .collection("diary")
    .doc(record.date)
    .set(
      { generationRecords: FieldValue.arrayUnion(stripUndefined({ ...record })) },
      { merge: true },
    );
}

export async function writeGeneratedDiary(date: string, diary: string): Promise<void> {
  await db().collection("diary").doc(date).set({ diary, generatedAt: Date.now() }, { merge: true });
}

// ---------------------------------------------------------------------------
// Single-group agent runtime persistence
// ---------------------------------------------------------------------------

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

function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  for (const key of Object.keys(obj)) {
    if (obj[key] === undefined) {
      delete obj[key];
    }
  }
  return obj;
}

export async function loadRuntimeGroupState(): Promise<RuntimeGroupStateDoc> {
  const snap = await db().collection("runtime").doc("group").get();
  if (!snap.exists) {
    return { summary: "", summaryCursorTs: 0, updatedAt: Date.now() };
  }
  const data = snap.data() ?? {};
  return {
    summary: typeof data.summary === "string" ? data.summary : "",
    summaryCursorTs: typeof data.summaryCursorTs === "number" ? data.summaryCursorTs : 0,
    ...(typeof data.lastProcessedMessageId === "number"
      ? { lastProcessedMessageId: data.lastProcessedMessageId }
      : {}),
    ...(typeof data.lastCompactedAt === "number" ? { lastCompactedAt: data.lastCompactedAt } : {}),
    updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : Date.now(),
  };
}

export async function writeRuntimeGroupState(patch: Partial<RuntimeGroupStateDoc>): Promise<void> {
  await db()
    .collection("runtime")
    .doc("group")
    .set(stripUndefined({ ...patch, updatedAt: Date.now() }), { merge: true });
}

export async function appendRuntimeEvent(record: RuntimeEventRecord): Promise<void> {
  await db()
    .collection("events")
    .add(stripUndefined({ ...record }) as Record<string, unknown>);
}

export async function loadRecentRuntimeEvents(
  params: {
    afterTs?: number;
    limit?: number;
    newestFirst?: boolean;
  } = {},
): Promise<RuntimeEventRecord[]> {
  let query: Query = db().collection("events");
  if (params.afterTs != null) {
    query = query.where("ts", ">", params.afterTs);
  }
  const newestFirst = params.newestFirst ?? false;
  const snap = await query
    .orderBy("ts", newestFirst ? "desc" : "asc")
    .limit(params.limit ?? 240)
    .get();
  const records = snap.docs.map((doc) => doc.data() as RuntimeEventRecord);
  return newestFirst ? records.reverse() : records;
}

export async function appendTurnRecord(record: RuntimeTurnRecord): Promise<void> {
  await db()
    .collection("turns")
    .add(stripUndefined({ ...record }) as Record<string, unknown>);
}

export async function loadRecentTurnRecords(
  params: {
    afterTs?: number;
    limit?: number;
  } = {},
): Promise<RuntimeTurnRecord[]> {
  let query: Query = db().collection("turns");
  if (params.afterTs != null) {
    query = query.where("startedAt", ">", params.afterTs);
  }
  const snap = await query
    .orderBy("startedAt", "asc")
    .limit(params.limit ?? 120)
    .get();
  return snap.docs.map((doc) => doc.data() as RuntimeTurnRecord);
}

export async function appendCompactionRecord(record: RuntimeCompactionRecord): Promise<void> {
  await db()
    .collection("compactions")
    .add(stripUndefined({ ...record }) as Record<string, unknown>);
}
