import type { Message } from "grammy/types";
import type { PhotoSize } from "grammy/types";
import { getCachedImage } from "../services/firestore.js";
import { downloadTelegramFileAsDataUrl } from "../libs/telegram-image.js";
import { downloadTelegramStickerAsDataUrl } from "../libs/telegram-image.js";
import { fetchUrlContent, describeSticker } from "../libs/ai.js";
import { getReceivedSticker, cacheReceivedSticker } from "../libs/sticker-store.js";
import { logger } from "../libs/logger.js";
import type { BotContext, RequestState } from "./context.js";

export interface StickerContent {
  emoji: string;
  fileId: string;
  description: string;
}

/**
 * Parse raw message fields into structured state: text, entities, URLs, images, sticker.
 *
 * - URL detection combines entity-based extraction with a regex fallback so that
 *   bare URLs not tagged by Telegram are still picked up.
 * - Image handling downloads the largest size as a data URL (never putting the
 *   bot token into prompts) and uses the Firestore cache when available.
 * - Reply-to images: when the user replies to a message that contains photos,
 *   those photos are processed too (e.g. replying "what do you think?" to an image).
 * - Sticker handling: downloads sticker, describes via Gemini, caches to
 *   received_stickers for future reuse and potential adoption.
 */
export async function extractContent(
  ctx: BotContext,
  msg: Message,
  state: Pick<RequestState, "rawText" | "entities">,
): Promise<{
  urls: string[];
  photoFileIds: string[];
  imageDataUrls: string[];
  imageDescriptions: string[];
  stickerEmoji: string;
  stickerContent: StickerContent | null;
  urlFetchPromise: Promise<Map<string, string | null>>;
}> {
  // URLs — from both text and caption entity arrays
  const textUrls: string[] = (msg.entities ?? [])
    .filter((e) => e.type === "url")
    .map((e) => (msg.text ?? "").slice(e.offset, e.offset + e.length));
  const captionUrls: string[] = (msg.caption_entities ?? [])
    .filter((e) => e.type === "url")
    .map((e) => (msg.caption ?? "").slice(e.offset, e.offset + e.length));
  const urls: string[] = [...textUrls, ...captionUrls];

  // Regex fallback — run regardless of entity presence so bare URLs are never missed
  if (state.rawText) {
    const matches = state.rawText.match(/https?:\/\/[^\s]+/g) ?? [];
    for (const m of matches) {
      // Trim trailing punctuation that commonly gets swept up by the greedy regex
      const cleaned = m.replace(/[)\],.;:!?，。；：！？」』】》]+$/u, "");
      if (!urls.includes(cleaned)) urls.push(cleaned);
    }
  }

  const urlFetchPromise: Promise<Map<string, string | null>> =
    urls.length > 0
      ? Promise.all(
          urls.map(async (u) => {
            const content = await fetchUrlContent(u);
            return [u, content] as const;
          }),
        ).then((entries) => new Map(entries))
      : Promise.resolve(new Map());

  // Images — message's own photos and reply-to photos
  const photoFileIds: string[] = [];
  const imageDataUrls: string[] = [];
  const imageDescriptions: string[] = [];

  // Helper: process an array of PhotoSize and merge results into the output arrays.
  async function processPhotoArray(photos: PhotoSize[], source: string): Promise<void> {
    if (photos.length === 0) return;
    const largest = photos[photos.length - 1];
    if (!largest) return;

    try {
      const cached = await getCachedImage(largest.file_id);
      if (cached?.description) {
        imageDescriptions.push(cached.description);
        return;
      }
      const file = await ctx.api.getFile(largest.file_id);
      if (file.file_path) {
        const dataUrl = await downloadTelegramFileAsDataUrl(file.file_path);
        if (dataUrl) {
          imageDataUrls.push(dataUrl);
          photoFileIds.push(largest.file_id);
        }
      }
    } catch (err) {
      logger.warn({ err }, `failed to process photo (${source})`);
    }
  }

  // Process the message's own photos
  await processPhotoArray(msg.photo ?? [], "direct");

  // Process photos from the replied-to message (e.g. user replied "what do you think?" to an image)
  if (msg.reply_to_message?.photo && msg.reply_to_message.photo.length > 0) {
    await processPhotoArray(msg.reply_to_message.photo, "reply-to");
  }

  // Sticker — download and describe (cache-first)
  let stickerEmoji = "";
  let stickerContent: StickerContent | null = null;

  if (msg.sticker) {
    stickerEmoji = msg.sticker.emoji ?? "";
    const fileId = msg.sticker.file_id;

    // Check cache first
    const cached = await getReceivedSticker(fileId).catch(() => null);
    if (cached) {
      stickerContent = {
        emoji: cached.emoji[0] ?? stickerEmoji,
        fileId: cached.file_id,
        description: cached.description,
      };
    } else {
      // Download and describe
      try {
        const dataUrl = await downloadTelegramStickerAsDataUrl(fileId);
        if (dataUrl) {
          const desc = await describeSticker(dataUrl);
          if (!desc) {
            logger.warn({ fileId }, "sticker description failed, not caching");
            stickerContent = { emoji: stickerEmoji || "🐱", fileId, description: "" };
          } else {
            const emojis = stickerEmoji ? [stickerEmoji] : ["🐱"];
            await cacheReceivedSticker({
              file_id: fileId,
              emoji: emojis,
              description: desc,
              receivedAt: Date.now(),
            }).catch((err: unknown) => {
              logger.warn({ err, fileId }, "failed to cache received sticker");
            });
            stickerContent = { emoji: emojis[0] ?? stickerEmoji, fileId, description: desc };
          }
        }
      } catch (err) {
        logger.warn({ err, fileId }, "failed to process sticker");
      }
    }
  }

  return {
    urls,
    photoFileIds,
    imageDataUrls,
    imageDescriptions,
    stickerEmoji,
    stickerContent,
    urlFetchPromise,
  };
}
