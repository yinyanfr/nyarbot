import { getFirestore, FieldValue, type Firestore } from "firebase-admin/firestore";
import type { User } from "../global.d.ts";
import { todayDateStr } from "../libs/time.js";

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

function isValidUser(data: unknown): data is User {
  const d = data as Record<string, unknown>;
  return (
    typeof d?.uid === "string" && typeof d?.nickname === "string" && Array.isArray(d?.memories)
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
  await db().collection("users").doc(uid).update({ nickname });
  invalidateUserCache(uid);
}

export async function updateUserMemory(uid: string, memory: string): Promise<string[]> {
  const trimmed = memory.trim();
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

export async function removeUserMemory(uid: string, memory: string): Promise<void> {
  await db()
    .collection("users")
    .doc(uid)
    .update({
      memories: FieldValue.arrayRemove(memory),
    });
  invalidateUserCache(uid);
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

// ---------------------------------------------------------------------------
// Diary
// ---------------------------------------------------------------------------

import type { DiaryEntry } from "../global.d.js";

export async function writeDiaryEntry(note: string): Promise<void> {
  const date = todayDateStr();
  const entry: DiaryEntry = { ts: Date.now(), content: note };
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

export async function writeGeneratedDiary(date: string, diary: string): Promise<void> {
  await db().collection("diary").doc(date).set({ diary, generatedAt: Date.now() }, { merge: true });
}
