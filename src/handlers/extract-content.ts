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
  isAnimated?: boolean;
  isVideo?: boolean;
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
  const urls: string[] = [];

  function collectUrlsFromMessage(message: Message): void {
    const collectEntities = (
      text: string,
      entities: Message["entities"] | Message["caption_entities"],
    ): void => {
      for (const entity of entities ?? []) {
        const url =
          entity.type === "url"
            ? text.slice(entity.offset, entity.offset + entity.length)
            : entity.type === "text_link"
              ? entity.url
              : null;
        if (url && !urls.includes(url)) urls.push(url);
      }
    };

    collectEntities(message.text ?? "", message.entities);
    collectEntities(message.caption ?? "", message.caption_entities);

    const rawText = message.text ?? message.caption ?? "";
    const matches = rawText.match(/https?:\/\/[^\s]+/g) ?? [];
    for (const match of matches) {
      const cleaned = match.replace(/[)\],.;:!?，。；：！？」』】》]+$/u, "");
      if (!urls.includes(cleaned)) urls.push(cleaned);
    }
  }

  collectUrlsFromMessage(msg);
  if (msg.reply_to_message) collectUrlsFromMessage(msg.reply_to_message);

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
        ...(m.sticker.is_animated ? { isAnimated: true } : {}),
        ...(m.sticker.is_video ? { isVideo: true } : {}),
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
