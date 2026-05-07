import type { Message } from "grammy/types";
import { getCachedImage } from "../services/firestore.js";
import { downloadTelegramFileAsDataUrl } from "../libs/telegram-image.js";
import { fetchUrlContent } from "../libs/ai.js";
import { logger } from "../libs/logger.js";
import type { BotContext, RequestState } from "./context.js";

/**
 * Parse raw message fields into structured state: text, entities, URLs, images, sticker.
 *
 * - URL detection combines entity-based extraction with a regex fallback so that
 *   bare URLs not tagged by Telegram are still picked up.
 * - Image handling downloads the largest size as a data URL (never putting the
 *   bot token into prompts) and uses the Firestore cache when available.
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

  // Images — msg.photo is an array of sizes of the same image. Take the largest.
  const photos = msg.photo ?? [];
  const photoFileIds: string[] = [];
  const imageDataUrls: string[] = [];
  const imageDescriptions: string[] = [];

  if (photos.length > 0) {
    const largest = photos[photos.length - 1];
    if (largest) {
      try {
        const cached = await getCachedImage(largest.file_id);
        if (cached?.description) {
          imageDescriptions.push(cached.description);
        } else {
          const file = await ctx.api.getFile(largest.file_id);
          if (file.file_path) {
            const dataUrl = await downloadTelegramFileAsDataUrl(file.file_path);
            if (dataUrl) {
              imageDataUrls.push(dataUrl);
              photoFileIds.push(largest.file_id);
            }
          }
        }
      } catch (err) {
        logger.warn({ err }, "failed to process photo");
      }
    }
  }

  const stickerEmoji = msg.sticker?.emoji ?? "";

  return { urls, photoFileIds, imageDataUrls, imageDescriptions, stickerEmoji, urlFetchPromise };
}
