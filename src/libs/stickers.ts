const HARDCODED_STICKERS: Record<string, string> = {
  "😟": "CAACAgQAAxUAAWn7XfOLviBCGbaABERYcVitEgh5AALkEAACVx-JUpCvszWBeKWVOwQ",
  "❔": "CAACAgQAAxUAAWn7XfNe4nr4IE-9Ul6Qi3Z29-WXAALmDAAC7peJUrEHq3uhAhZMOwQ",
  "🙃": "CAACAgQAAxUAAWn7XfPOykZxYkiQN-bq18p9VB-0AAInEAACGv2JUtPsDLhNZLttOwQ",
  "🎉": "CAACAgQAAxUAAWn7XfP6Y64T65Wn0pd9P-QCTx2rAALLDQACMrOIUi5yVeOUcc1WOwQ",
  "😏": "CAACAgQAAxUAAWn7XfOUUQpwGEjjug_roy-rktSfAALWDQACTTWJUgW9Dz1qweo3OwQ",
  "🥺": "CAACAgQAAxUAAWn7XfPa_Pu1Z1RmFZXNVF8hayKHAALIDQACpliJUmoD-P2XTiWkOwQ",
  "💕": "CAACAgQAAxUAAWn7XfMtio2aohAuSGT7s65rJZ29AAKMDwACXIeJUlnR9NXg7020OwQ",
  "😀": "CAACAgQAAxUAAWn7XfNHDLw2Rs4ljiSFyGtc6y3mAALnFAAC0RaJUkvGz2f2CqxwOwQ",
  "🤔": "CAACAgQAAxUAAWn7XfNzPtUty7S4LEzyIZJLtndAAAJuDwACaTeIUiYlj2J30W5hOwQ",
  "☕️": "CAACAgQAAxUAAWn7XfPfs8d2w4OnSafe3lfuvXNkAAJJEgACUe2IUq1qnM1GoHzDOwQ",
  "😐": "CAACAgQAAxUAAWn7XfOSF6jVjCcw6UJFEQxSik5ZAALvDQACum6JUiyeIMIQLZSvOwQ",
  "🫤": "CAACAgQAAxUAAWn7XfPiQMLcz3e3cDBFsBs4dI4SAAKEDwACgY6RUlIbLdZSnXmaOwQ",
  "😔": "CAACAgQAAxUAAWn7XfMzzpqlSkVWzi32PT-vZm57AAIkDgACbpqIUo4inUPrm1IGOwQ",
  "👮": "CAACAgQAAxUAAWn7XfPC3Fd97DRUBgTqTXROj01lAAI2DwACYxSJUvExPRQpskD0OwQ",
  "😭": "CAACAgQAAxUAAWn7XfPnEoRpykXAtw05zpBz_c_nAAInEAACrxuJUvaAoU9oUCu4OwQ",
  "😮": "CAACAgQAAxUAAWn7XfOmFy8cVzIogpYabzIxVyhHAAIWDgAC5daJUseEKV_cNVyDOwQ",
  "😯": "CAACAgQAAxUAAWn7XfOTqpOpZmXcpkPlaWSYoJxtAALuDAACTXmQUsRCGjHpKjUQOwQ",
  "😛": "CAACAgQAAxUAAWn7XfPU6wFpuWMODfoxjRK_QMO9AAJ0DwAC0_6IUj27Xt-R1-fZOwQ",
  "🐱": "CAACAgQAAxUAAWn7XfNXaYEiCKUMH3bD4JDr6mk2AAJeEgAC43aJUiGBCEXJRnFSOwQ",
  "🌟": "CAACAgQAAxUAAWn7XfNCV5jt9cRDOx91tbeOnevkAAJvDwAC5l2JUkos-HjmOl3kOwQ",
  "🤝": "CAACAgQAAxUAAWn7XfPcAk6EhbMumYmj-Cdq77AJAAIEDwAC54WIUj-bwz7TQQABRTsE",
  "😶": "CAACAgQAAxUAAWn7XfP-oZw5RPKlWedt8biEh2JtAALSEgAC7-2IUsVeb_a2QeB2OwQ",
  "🙌": "CAACAgQAAxUAAWn7XfMVkRh-1IxVNUPTIjj-ooY6AALyDgACPpqRUlly0cUQmCd1OwQ",
  "👏": "CAACAgQAAxUAAWn7XfNU5ii4PGVMJcCQTurizdMUAAJYDgAC81eIUpjc5FJxEiQlOwQ",
  "😢": "CAACAgQAAxUAAWn7XfPQQL8G7SSzZdBfPxRZUfmiAAKpDgAC_AyIUoKo75CnL9qcOwQ",
  "👊": "CAACAgQAAxUAAWn7XfMK0AZvAh9wc3mh5AtVsGMiAAIpDwACeBWRUlECPcGJGfrkOwQ",
  "🤭": "CAACAgQAAxUAAWn7XfMWRJOBDqj1Vqc4pOcSWB1LAAKhDgACgtqJUiUO4uNfIp-gOwQ",
  "😠": "CAACAgQAAxUAAWn7XfMrdr9_K-LTNHwDOylAIKqqAAJbDAACb8yRUiIM8E4h5q4QOwQ",
  "😒": "CAACAgQAAxUAAWn7XfNkUd4vkJKk8u0nyZYrNpLhAALcDQACBfuIUqLtahMXgr5fOwQ",
};

const STICKER_EMOJIS = Object.keys(HARDCODED_STICKERS);

const FILE_ID_TO_EMOJI = new Map<string, string>(
  Object.entries(HARDCODED_STICKERS).map(([emoji, fileId]) => [fileId, emoji]),
);

/**
 * Get the Telegram file_id for a sticker by its emoji.
 * Returns null if no sticker matches (store not yet initialized or emoji not found).
 */
export function getStickerFileId(emoji: string): string | null {
  return HARDCODED_STICKERS[emoji] ?? null;
}

/**
 * Pick a random sticker emoji from the store.
 * Returns a fallback emoji if the store is empty.
 */
export function pickRandomStickerEmoji(): string {
  if (STICKER_EMOJIS.length === 0) return "🐱";
  const idx = Math.floor(Math.random() * STICKER_EMOJIS.length);
  return STICKER_EMOJIS[idx] ?? "🐱";
}

/**
 * Get all available sticker emojis as a tuple for Zod enum validation.
 * Returns a fallback if the store is empty.
 */
export function getStickerEmojis(): [string, ...string[]] {
  if (STICKER_EMOJIS.length === 0) return ["🐱"];
  return STICKER_EMOJIS as [string, ...string[]];
}

/**
 * Get emoji → description mapping for the sendSticker tool.
 */
export function getStickerDescriptions(): Record<string, string> {
  const descriptions: Record<string, string> = {};
  for (const emoji of STICKER_EMOJIS) descriptions[emoji] = `${emoji} 贴纸`;
  return descriptions;
}

/**
 * Number of stickers in the store. Returns 0 before initialization completes.
 */
export function stickerCount(): number {
  return STICKER_EMOJIS.length;
}

/**
 * Get the Telegram file_id for a sticker by its description.
 * Returns null if no sticker matches.
 */
export function getStickerFileIdByDescription(description: string): string | null {
  const trimmed = description.trim();
  for (const emoji of STICKER_EMOJIS) {
    if (trimmed.includes(emoji) || `${emoji} 贴纸` === trimmed) {
      return HARDCODED_STICKERS[emoji] ?? null;
    }
  }
  return null;
}

/**
 * Get the list of all stickers with description, keywords, and representative emoji,
 * formatted for the sendSticker tool description.
 * Returns a fallback if the store is empty.
 */
export function getStickerList(): string[] {
  return [...STICKER_EMOJIS];
}

export function getStickerEmojiByFileId(fileId: string): string | null {
  return FILE_ID_TO_EMOJI.get(fileId) ?? null;
}
