import type { Message } from "grammy/types";
import type { PhotoSize } from "grammy/types";
import type { Video } from "grammy/types";
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
  fileUniqueId: string;
  description: string;
  keywords: string[];
}

export interface MediaDescriptor {
  label: string;
  description: string;
}

export interface PendingMediaThumbnail {
  label: string;
  dataUrl: string;
  fileId: string;
}

/**
 * Parse raw message fields into structured state: text, entities, URLs, images, sticker, media thumbnails.
 *
 * - URL detection combines entity-based extraction with a regex fallback so that
 *   bare URLs not tagged by Telegram are still picked up.
 * - Image handling downloads the largest size as a data URL (never putting the
 *   bot token into prompts) and uses the Firestore cache when available.
 * - Reply-to images: when the user replies to a message that contains photos,
 *   those photos are processed too (e.g. replying "what do you think?" to an image).
 * - Sticker handling: downloads sticker, describes via Gemini, caches to
 *   received_stickers for future reuse and potential adoption.
 * - Media thumbnails: video, animation, GIF, video note, document, and audio
 *   thumbnails are extracted (via their tiny thumbnail/cover files, not the full
 *   media) and queued for AI description. Text-only markers fall back when no
 *   thumbnail is available.
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
  mediaDescriptors: MediaDescriptor[];
  pendingMediaThumbnails: PendingMediaThumbnail[];
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

  // Media thumbnails — video/animation/video_note/document/audio
  const mediaDescriptors: MediaDescriptor[] = [];
  const pendingMediaThumbnails: PendingMediaThumbnail[] = [];

  function getVideoThumb(video: Video): PhotoSize | undefined {
    if (video.cover?.length) return video.cover[video.cover.length - 1];
    return video.thumbnail;
  }

  async function processThumbnail(thumb: PhotoSize | undefined, label: string): Promise<void> {
    if (!thumb) {
      logger.info({ label }, "media: no thumbnail, using text-only marker");
      mediaDescriptors.push({ label, description: "" });
      return;
    }
    try {
      const cached = await getCachedImage(thumb.file_id);
      if (cached?.description) {
        logger.info({ label, fileId: thumb.file_id }, "media: cached description hit");
        mediaDescriptors.push({ label, description: cached.description });
        return;
      }
      const file = await ctx.api.getFile(thumb.file_id);
      if (file.file_path) {
        const dataUrl = await downloadTelegramFileAsDataUrl(file.file_path);
        if (dataUrl) {
          logger.info(
            { label, fileId: thumb.file_id },
            "media: thumbnail downloaded for describing",
          );
          pendingMediaThumbnails.push({ label, dataUrl, fileId: thumb.file_id });
          return;
        }
        logger.warn({ label, fileId: thumb.file_id }, "media: thumbnail download returned empty");
      } else {
        logger.warn({ label, fileId: thumb.file_id }, "media: getFile returned no file_path");
      }
      mediaDescriptors.push({ label, description: "" });
    } catch (err) {
      logger.warn({ err, label }, "failed to process media thumbnail");
      mediaDescriptors.push({ label, description: "" });
    }
  }

  // Process main message media
  if (msg.video) {
    await processThumbnail(getVideoThumb(msg.video), "视频");
  }
  if (msg.animation) {
    await processThumbnail(msg.animation.thumbnail, "GIF动画");
  }
  if (msg.video_note) {
    await processThumbnail(msg.video_note.thumbnail, "视频消息");
  }
  if (msg.document) {
    const label = msg.document.file_name ? `文件: ${msg.document.file_name}` : "文件";
    await processThumbnail(msg.document.thumbnail, label);
  }
  if (msg.audio) {
    const title = msg.audio.title || msg.audio.file_name;
    const label = title ? `音频: ${title}` : "音频";
    await processThumbnail(msg.audio.thumbnail, label);
  }

  // Process reply-to media thumbnails (same treatment as reply-to photos)
  const replyTo = msg.reply_to_message;
  if (replyTo?.video) {
    await processThumbnail(getVideoThumb(replyTo.video), "视频");
  }
  if (replyTo?.animation) {
    await processThumbnail(replyTo.animation.thumbnail, "GIF动画");
  }
  if (replyTo?.video_note) {
    await processThumbnail(replyTo.video_note.thumbnail, "视频消息");
  }
  if (replyTo?.document) {
    const label = replyTo.document.file_name ? `文件: ${replyTo.document.file_name}` : "文件";
    await processThumbnail(replyTo.document.thumbnail, label);
  }
  if (replyTo?.audio) {
    const title = replyTo.audio.title || replyTo.audio.file_name;
    const label = title ? `音频: ${title}` : "音频";
    await processThumbnail(replyTo.audio.thumbnail, label);
  }

  // Sticker — download and describe (cache-first)
  let stickerEmoji = "";
  let stickerContent: StickerContent | null = null;

  if (msg.sticker) {
    stickerEmoji = msg.sticker.emoji ?? "";
    const fileId = msg.sticker.file_id;
    const fileUniqueId = msg.sticker.file_unique_id;

    // Check cache first
    const cached = await getReceivedSticker(fileUniqueId).catch(() => null);
    if (cached) {
      if (cached.file_id !== fileId) {
        await cacheReceivedSticker({ ...cached, file_id: fileId }).catch((err: unknown) => {
          logger.warn({ err, fileId, fileUniqueId }, "failed to refresh sticker file_id");
        });
      }
      stickerContent = {
        emoji: cached.emoji[0] ?? stickerEmoji,
        fileId,
        fileUniqueId,
        description: cached.description,
        keywords: cached.keywords ?? [],
      };
    } else {
      // Download and describe
      try {
        const dataUrl = await downloadTelegramStickerAsDataUrl(fileId);
        if (dataUrl) {
          const result = await describeSticker(dataUrl);
          if (!result) {
            logger.warn({ fileId }, "sticker description failed, not caching");
            stickerContent = {
              emoji: stickerEmoji || "🐱",
              fileId,
              fileUniqueId,
              description: "",
              keywords: [],
            };
          } else {
            const emojis = stickerEmoji ? [stickerEmoji] : ["🐱"];
            await cacheReceivedSticker({
              file_unique_id: fileUniqueId,
              file_id: fileId,
              emoji: emojis,
              description: result.description,
              keywords: result.keywords,
              receivedAt: Date.now(),
            }).catch((err: unknown) => {
              logger.warn({ err, fileId }, "failed to cache received sticker");
            });
            stickerContent = {
              emoji: emojis[0] ?? stickerEmoji,
              fileId,
              fileUniqueId,
              description: result.description,
              keywords: result.keywords,
            };
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
    mediaDescriptors,
    pendingMediaThumbnails,
  };
}
