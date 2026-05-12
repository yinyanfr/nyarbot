import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { logger } from "./logger.js";

export interface StickerDoc {
  file_id: string;
  emoji: string[];
  description: string;
  source: "migration" | "adopted";
  adoptedAt?: number;
}

export interface ReceivedStickerDoc {
  file_id: string;
  emoji: string[];
  description: string;
  receivedAt: number;
}

let _db: Firestore | null = null;
function db(): Firestore {
  if (!_db) _db = getFirestore();
  return _db;
}

const cache = new Map<string, StickerDoc>();
let _readyResolve: (() => void) | null = null;
const _readyPromise = new Promise<void>((resolve) => {
  _readyResolve = resolve;
});

export function initStickerStore(): void {
  let firstSnapshot = true;

  db()
    .collection("stickers")
    .onSnapshot(
      (snapshot) => {
        for (const change of snapshot.docChanges()) {
          const data = change.doc.data() as StickerDoc;
          switch (change.type) {
            case "added":
            case "modified":
              cache.set(change.doc.id, data);
              break;
            case "removed":
              cache.delete(change.doc.id);
              break;
          }
        }
        if (firstSnapshot) {
          firstSnapshot = false;
          logger.info({ count: cache.size }, "sticker store initialized");
          _readyResolve?.();
        }
      },
      (err: unknown) => {
        logger.error({ err }, "sticker store onSnapshot error");
        if (firstSnapshot) {
          firstSnapshot = false;
          logger.warn("sticker store unavailable — running without stickers");
          _readyResolve?.();
        }
      },
    );
}

export async function stickerStoreReady(): Promise<void> {
  return _readyPromise;
}

export function getStickerByEmoji(emoji: string): StickerDoc | null {
  // Deterministic order: migration first, then adopted sorted by adoptedAt
  const sorted = [...cache.values()].sort((a, b) => {
    if (a.source !== b.source) return a.source === "migration" ? -1 : 1;
    return (a.adoptedAt ?? 0) - (b.adoptedAt ?? 0);
  });
  for (const doc of sorted) {
    if (doc.emoji.includes(emoji)) return doc;
  }
  return null;
}

export function getRandomSticker(): StickerDoc | null {
  const entries = [...cache.values()];
  if (entries.length === 0) return null;
  return entries[Math.floor(Math.random() * entries.length)]!;
}

export function getAllStickerEmojis(): string[] {
  const emojis = new Set<string>();
  for (const [, doc] of cache) {
    for (const e of doc.emoji) emojis.add(e);
  }
  return [...emojis];
}

export function getAllStickerDescriptions(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [, doc] of cache) {
    const desc = doc.description || doc.emoji.join("");
    for (const e of doc.emoji) result[e] = desc;
  }
  return result;
}

export function getStickerByDescription(description: string): StickerDoc | null {
  for (const [, doc] of cache) {
    if (doc.description === description) return doc;
  }
  for (const [, doc] of cache) {
    if (doc.description.includes(description) || description.includes(doc.description)) {
      return doc;
    }
  }
  return null;
}

export function getAllStickerList(): { description: string; emoji: string }[] {
  const result: { description: string; emoji: string }[] = [];
  for (const [, doc] of cache) {
    result.push({ description: doc.description, emoji: doc.emoji[0] ?? "" });
  }
  return result;
}

export function stickerStoreSize(): number {
  return cache.size;
}

export function hasSticker(fileId: string): boolean {
  return cache.has(fileId);
}

export function getStickerByFileId(fileId: string): StickerDoc | null {
  return cache.get(fileId) ?? null;
}

export async function saveSticker(data: StickerDoc): Promise<void> {
  await db().collection("stickers").doc(data.file_id).set(data, { merge: true });
  cache.set(data.file_id, data);
}

export async function getReceivedSticker(fileId: string): Promise<ReceivedStickerDoc | null> {
  const doc = await db().collection("received_stickers").doc(fileId).get();
  if (!doc.exists) return null;
  return doc.data() as ReceivedStickerDoc;
}

export async function cacheReceivedSticker(data: ReceivedStickerDoc): Promise<void> {
  await db().collection("received_stickers").doc(data.file_id).set(data);
}
