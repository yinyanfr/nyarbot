import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { logger } from "./logger.js";

export interface StickerDoc {
  file_unique_id: string;
  file_id: string;
  emoji: string[];
  description: string;
  keywords?: string[];
  source: "migration" | "adopted";
  adoptedAt?: number;
}

export interface ReceivedStickerDoc {
  file_unique_id: string;
  file_id: string;
  emoji: string[];
  description: string;
  keywords?: string[];
  receivedAt: number;
}

let _db: Firestore | null = null;
function db(): Firestore {
  if (!_db) _db = getFirestore();
  return _db;
}

const cache = new Map<string, StickerDoc>();
const fileIdToUniqueId = new Map<string, string>();

function removeFileIdMappingsForUniqueId(fileUniqueId: string): void {
  for (const [fileId, uniqueId] of fileIdToUniqueId) {
    if (uniqueId === fileUniqueId) fileIdToUniqueId.delete(fileId);
  }
}

function upsertFileIdMapping(fileUniqueId: string, fileId: string): void {
  removeFileIdMappingsForUniqueId(fileUniqueId);
  fileIdToUniqueId.set(fileId, fileUniqueId);
}

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
              upsertFileIdMapping(change.doc.id, data.file_id);
              break;
            case "removed":
              removeFileIdMappingsForUniqueId(change.doc.id);
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

export function getAllStickerList(): { description: string; keywords: string[]; emoji: string }[] {
  const result: { description: string; keywords: string[]; emoji: string }[] = [];
  for (const [, doc] of cache) {
    result.push({
      description: doc.description,
      keywords: doc.keywords ?? [],
      emoji: doc.emoji[0] ?? "",
    });
  }
  return result;
}

export function filterStickersByKeywords(
  keywords: string[],
  limit = 5,
): { description: string; emoji: string; fileId: string }[] {
  const scored: { doc: StickerDoc; score: number }[] = [];
  for (const [, doc] of cache) {
    const docKeywords = doc.keywords ?? [];
    if (docKeywords.length === 0) continue;
    let score = 0;
    for (const kw of keywords) {
      for (const dk of docKeywords) {
        if (dk === kw) score += 3;
        else if (dk.includes(kw) || kw.includes(dk)) score += 1;
      }
    }
    if (score > 0) scored.push({ doc, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const matched = scored.slice(0, limit).map((s) => ({
    description: s.doc.description,
    emoji: s.doc.emoji[0] ?? "",
    fileId: s.doc.file_id,
  }));
  if (matched.length > 0) return matched;

  // Fallback: no keyword matches — return stickers without keywords,
  // so the Flash model can still pick from them during semantic match.
  const noKeyword: { description: string; emoji: string; fileId: string }[] = [];
  for (const [, doc] of cache) {
    if (noKeyword.length >= limit) break;
    const docKeywords = doc.keywords ?? [];
    if (docKeywords.length === 0 && doc.description && doc.description.length >= 3) {
      noKeyword.push({
        description: doc.description,
        emoji: doc.emoji[0] ?? "",
        fileId: doc.file_id,
      });
    }
  }
  return noKeyword;
}

export function stickerStoreSize(): number {
  return cache.size;
}

export function hasSticker(fileId: string): boolean {
  return cache.has(fileId);
}

export function hasStickerByUniqueId(fileUniqueId: string): boolean {
  return cache.has(fileUniqueId);
}

export function getStickerByFileId(fileId: string): StickerDoc | null {
  const uniqueId = fileIdToUniqueId.get(fileId);
  if (uniqueId) return cache.get(uniqueId) ?? null;
  for (const [, doc] of cache) {
    if (doc.file_id === fileId) return doc;
  }
  return null;
}

export function getStickerByUniqueId(fileUniqueId: string): StickerDoc | null {
  return cache.get(fileUniqueId) ?? null;
}

export async function saveSticker(data: StickerDoc): Promise<void> {
  await db().collection("stickers").doc(data.file_unique_id).set(data, { merge: true });
  cache.set(data.file_unique_id, data);
  upsertFileIdMapping(data.file_unique_id, data.file_id);
}

export async function getReceivedSticker(fileUniqueId: string): Promise<ReceivedStickerDoc | null> {
  const doc = await db().collection("received_stickers").doc(fileUniqueId).get();
  if (!doc.exists) return null;
  return doc.data() as ReceivedStickerDoc;
}

export async function cacheReceivedSticker(data: ReceivedStickerDoc): Promise<void> {
  await db().collection("received_stickers").doc(data.file_unique_id).set(data, { merge: true });
}
