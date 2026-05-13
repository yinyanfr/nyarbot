import {
  getStickerByEmoji,
  getRandomSticker,
  getAllStickerEmojis,
  getAllStickerDescriptions,
  getStickerByDescription,
  getAllStickerList,
  stickerStoreSize,
} from "./sticker-store.js";

/**
 * Get the Telegram file_id for a sticker by its emoji.
 * Returns null if no sticker matches (store not yet initialized or emoji not found).
 */
export function getStickerFileId(emoji: string): string | null {
  return getStickerByEmoji(emoji)?.file_id ?? null;
}

/**
 * Pick a random sticker emoji from the store.
 * Returns a fallback emoji if the store is empty.
 */
export function pickRandomStickerEmoji(): string {
  const sticker = getRandomSticker();
  return sticker?.emoji[0] ?? "🐱";
}

/**
 * Get all available sticker emojis as a tuple for Zod enum validation.
 * Returns a fallback if the store is empty.
 */
export function getStickerEmojis(): [string, ...string[]] {
  const emojis = getAllStickerEmojis();
  if (emojis.length === 0) return ["🐱"];
  return emojis as [string, ...string[]];
}

/**
 * Get emoji → description mapping for the sendSticker tool.
 */
export function getStickerDescriptions(): Record<string, string> {
  const descs = getAllStickerDescriptions();
  if (Object.keys(descs).length === 0) return { "🐱": "猫猫贴纸" };
  return descs;
}

/**
 * Number of stickers in the store. Returns 0 before initialization completes.
 */
export function stickerCount(): number {
  return stickerStoreSize();
}

/**
 * Get the Telegram file_id for a sticker by its description.
 * Returns null if no sticker matches.
 */
export function getStickerFileIdByDescription(description: string): string | null {
  return getStickerByDescription(description)?.file_id ?? null;
}

/**
 * Get the list of all stickers with description, keywords, and representative emoji,
 * formatted for the sendSticker tool description.
 * Returns a fallback if the store is empty.
 */
export function getStickerList(): { description: string; keywords: string[]; emoji: string }[] {
  const list = getAllStickerList();
  if (list.length === 0)
    return [{ description: "猫猫贴纸", keywords: ["猫猫", "可爱"], emoji: "🐱" }];
  return list;
}
