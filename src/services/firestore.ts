import { getFirestore, FieldValue } from "firebase-admin/firestore";
import type { User } from "../global.d.ts";

const db = getFirestore();

function isValidUser(data: unknown): data is User {
  const d = data as Record<string, unknown>;
  return (
    typeof d?.uid === "string" && typeof d?.nickname === "string" && Array.isArray(d?.memories)
  );
}

export async function getOrCreateUser(uid: string, firstName?: string): Promise<User> {
  const ref = db.collection("users").doc(uid);
  const doc = await ref.get();
  if (doc.exists) {
    const data = doc.data();
    if (isValidUser(data)) return data;
  }
  const user: User = { uid, nickname: firstName ?? "", memories: [] };
  await ref.set(user);
  return user;
}

export async function updateUserNickname(uid: string, nickname: string): Promise<void> {
  await db.collection("users").doc(uid).update({ nickname });
}

export async function updateUserMemory(uid: string, memory: string): Promise<void> {
  await db
    .collection("users")
    .doc(uid)
    .update({
      memories: FieldValue.arrayUnion(memory),
    });
}

export async function removeUserMemory(uid: string, memory: string): Promise<void> {
  await db
    .collection("users")
    .doc(uid)
    .update({
      memories: FieldValue.arrayRemove(memory),
    });
}

export async function cacheImage(
  fileId: string,
  data: { description: string; url?: string },
): Promise<void> {
  await db
    .collection("images")
    .doc(fileId)
    .set({ fileId, ...data, cachedAt: Date.now() });
}

export async function getCachedImage(fileId: string): Promise<Record<string, unknown> | null> {
  const doc = await db.collection("images").doc(fileId).get();
  return doc.exists ? doc.data()! : null;
}

export async function setNightyTimestamp(uid: string, timestamp: number): Promise<void> {
  await db
    .collection("users")
    .doc(uid)
    .update({ nightyTimestamp: timestamp, lastMorningGreet: null });
}

export async function setMorningGreeted(uid: string, timestamp: number): Promise<void> {
  await db.collection("users").doc(uid).update({ lastMorningGreet: timestamp });
}
