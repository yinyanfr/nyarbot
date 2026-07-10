import type { Message } from "grammy/types";
import type { BotContext, RequestState } from "./context.js";

export type MediaRefType =
  | "image"
  | "sticker"
  | "video"
  | "animation"
  | "video_note"
  | "document"
  | "audio";

export interface MediaRef {
  type: MediaRefType;
  source: "current" | "reply_to";
  fileId?: string;
  thumbnailFileId?: string;
  emoji?: string;
  filename?: string;
  title?: string;
}

/**
 * Parse raw message fields into structured state: text, entities, URLs, sticker,
 * and raw media references (file_id / thumbnail_file_id).
 *
 * - URL detection combines entity-based extraction with a regex fallback so that
 *   bare URLs not tagged by Telegram are still picked up.
 * - Images/media are not downloaded or described here.
 * - Reply-to images/media are preserved as references too.
 * - Sticker handling: only reads sticker emoji for lightweight context.
 */
export async function extractContent(
  _ctx: BotContext,
  msg: Message,
  state: Pick<RequestState, "rawText" | "entities">,
): Promise<{
  urls: string[];
  stickerEmoji: string;
  mediaRefs: MediaRef[];
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

  const mediaRefs: MediaRef[] = [];

  function collectFromMessage(m: Message, source: "current" | "reply_to"): void {
    const photo = m.photo?.[m.photo.length - 1];
    if (photo?.file_id) {
      mediaRefs.push({ type: "image", source, fileId: photo.file_id });
    }

    if (m.sticker) {
      mediaRefs.push({
        type: "sticker",
        source,
        fileId: m.sticker.file_id,
        ...(m.sticker.thumbnail?.file_id ? { thumbnailFileId: m.sticker.thumbnail.file_id } : {}),
        emoji: m.sticker.emoji ?? "",
      });
    }

    if (m.video) {
      const thumb = m.video.cover?.[m.video.cover.length - 1] ?? m.video.thumbnail;
      mediaRefs.push({
        type: "video",
        source,
        fileId: m.video.file_id,
        ...(thumb?.file_id ? { thumbnailFileId: thumb.file_id } : {}),
      });
    }

    if (m.animation) {
      mediaRefs.push({
        type: "animation",
        source,
        fileId: m.animation.file_id,
        ...(m.animation.thumbnail?.file_id
          ? { thumbnailFileId: m.animation.thumbnail.file_id }
          : {}),
      });
    }

    if (m.video_note) {
      mediaRefs.push({
        type: "video_note",
        source,
        fileId: m.video_note.file_id,
        ...(m.video_note.thumbnail?.file_id
          ? { thumbnailFileId: m.video_note.thumbnail.file_id }
          : {}),
      });
    }

    if (m.document) {
      mediaRefs.push({
        type: "document",
        source,
        fileId: m.document.file_id,
        ...(m.document.file_name ? { filename: m.document.file_name } : {}),
        ...(m.document.thumbnail?.file_id ? { thumbnailFileId: m.document.thumbnail.file_id } : {}),
      });
    }

    if (m.audio) {
      mediaRefs.push({
        type: "audio",
        source,
        fileId: m.audio.file_id,
        ...(m.audio.title || m.audio.file_name
          ? { title: m.audio.title || m.audio.file_name }
          : {}),
        ...(m.audio.thumbnail?.file_id ? { thumbnailFileId: m.audio.thumbnail.file_id } : {}),
      });
    }
  }

  collectFromMessage(msg, "current");
  if (msg.reply_to_message) collectFromMessage(msg.reply_to_message, "reply_to");

  // Sticker emoji (current message only)
  let stickerEmoji = "";

  if (msg.sticker) {
    stickerEmoji = msg.sticker.emoji ?? "";
  }

  return {
    urls,
    stickerEmoji,
    mediaRefs,
  };
}
