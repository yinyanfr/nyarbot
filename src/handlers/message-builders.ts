import type { Message } from "grammy/types";
import { isTwitterStatusUrl } from "../libs/ai.js";
import { sanitizePromptText } from "../libs/prompt-safety.js";
import { MAX_BUFFER_TEXT } from "./constants.js";
import type { MediaRef } from "./extract-content.js";

export function getMessageSender(message: Message): {
  uid: string;
  name: string;
  username?: string;
} {
  if (message.sender_chat) {
    const chat = message.sender_chat;
    return {
      uid: `chat:${chat.id}`,
      name: chat.title ?? chat.username ?? "某个聊天身份",
      ...(chat.username ? { username: chat.username } : {}),
    };
  }
  return {
    uid: message.from?.id?.toString() ?? "",
    name: message.from?.first_name ?? "某人",
    ...(message.from?.username ? { username: message.from.username } : {}),
  };
}

function xmlEscape(text: string): string {
  return sanitizePromptText(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function buildUserMessage(params: {
  rawText: string;
  displayName: string;
  speakerUid: string;
  mediaRefs: MediaRef[];
  replyTo: Message | undefined;
  isRepliedToBot: boolean;
  isMentioned?: boolean;
  urls: string[];
}): string {
  const sections = [
    "<current_turn>",
    `  <speaker uid="${xmlEscape(params.speakerUid)}" name="${xmlEscape(params.displayName)}" />`,
    `  <trigger mode="${params.isMentioned || params.isRepliedToBot ? "passive_triggered" : "not_triggered"}" mentioned="${params.isMentioned ? "true" : "false"}" replied_to_bot="${params.isRepliedToBot ? "true" : "false"}" />`,
  ];
  const reply = params.replyTo;
  if (reply) {
    const sender = getMessageSender(reply);
    sections.push(
      `  <reply_to uid="${xmlEscape(sender.uid)}" name="${xmlEscape(sender.name)}" username="${xmlEscape(sender.username ?? "")}" message_id="${reply.message_id}">`,
    );
    const text = reply.text ?? reply.caption ?? "";
    if (text) sections.push(`    <quoted_text>${xmlEscape(text)}</quoted_text>`);
    else if (reply.photo?.length)
      sections.push(
        `    <quoted_media type="image" file_id="${xmlEscape(reply.photo.at(-1)?.file_id ?? "")}" />`,
      );
    else if (reply.sticker)
      sections.push(
        `    <quoted_media type="sticker" file_id="${xmlEscape(reply.sticker.file_id)}" emoji="${xmlEscape(reply.sticker.emoji ?? "")}" />`,
      );
    sections.push("    <note>reply_to 内容是被回复消息，不是当前说话人的新消息</note>");
    sections.push("  </reply_to>");
  }
  if (params.rawText) sections.push(`  <text>${xmlEscape(params.rawText)}</text>`);
  const media = params.mediaRefs.filter((item) => item.source === "current");
  if (media.length) {
    sections.push("  <media>");
    for (const item of media) {
      const attributes = [
        `file_id="${xmlEscape(item.fileId ?? "")}"`,
        item.thumbnailFileId ? `thumbnail_file_id="${xmlEscape(item.thumbnailFileId)}"` : "",
        item.emoji ? `emoji="${xmlEscape(item.emoji)}"` : "",
        item.filename ? `filename="${xmlEscape(item.filename)}"` : "",
        item.title ? `title="${xmlEscape(item.title)}"` : "",
      ].filter(Boolean);
      sections.push(`    <${item.type} ${attributes.join(" ")} />`);
    }
    sections.push("  </media>");
  }
  if (params.urls.length) {
    sections.push("  <links>");
    for (const url of params.urls) sections.push(`    <link url="${xmlEscape(url)}" />`);
    sections.push("  </links>");
  }
  sections.push("</current_turn>");
  return sections.join("\n");
}

export function buildBufferLine(params: {
  rawText: string;
  mediaRefs: MediaRef[];
  urls: string[];
  replyToInfo?: { uid: string; name: string; username?: string; text: string; messageId?: number };
}): string {
  const parts: string[] = [];
  if (params.replyToInfo) {
    const item = params.replyToInfo;
    parts.push(
      `[回复 uid ${item.uid} ${item.username ? `${item.name} (@${item.username})` : item.name}${item.messageId != null ? ` message_id=${item.messageId}` : ""}: "${item.text.slice(0, 100)}"]`,
    );
  }
  const urls = [
    ...params.urls.filter(isTwitterStatusUrl),
    ...params.urls.filter((url) => !isTwitterStatusUrl(url)),
  ];
  for (const url of urls)
    parts.push(`[链接: ${url.length > 120 ? `${url.slice(0, 117)}...` : url}]`);
  if (params.rawText) parts.push(params.rawText);
  for (const media of params.mediaRefs.filter((item) => item.source === "current")) {
    if (media.type === "image") parts.push(`[图片 file_id=${media.fileId ?? ""}]`);
    if (media.type === "sticker") parts.push(`[贴纸: ${media.emoji ?? ""}]`);
    if (media.type === "video")
      parts.push(`[视频 file_id=${media.fileId ?? ""} thumb=${media.thumbnailFileId ?? ""}]`);
    if (media.type === "animation")
      parts.push(`[GIF file_id=${media.fileId ?? ""} thumb=${media.thumbnailFileId ?? ""}]`);
    if (media.type === "video_note")
      parts.push(`[视频消息 file_id=${media.fileId ?? ""} thumb=${media.thumbnailFileId ?? ""}]`);
    if (media.type === "document")
      parts.push(
        `[文件 file_id=${media.fileId ?? ""} thumb=${media.thumbnailFileId ?? ""} ${media.filename ?? ""}]`,
      );
    if (media.type === "audio")
      parts.push(
        `[音频 file_id=${media.fileId ?? ""} thumb=${media.thumbnailFileId ?? ""} ${media.title ?? ""}]`,
      );
  }
  return parts.join(" ").slice(0, MAX_BUFFER_TEXT);
}

export function detectTrigger(params: {
  rawText: string;
  entities: { type: string; offset: number; length: number }[];
  replyTo: Message | undefined;
  botUsername: string;
  configuredBotUsername: string;
  botId: number;
}): { isMentioned: boolean; isRepliedToBot: boolean } {
  const usernames = new Set([
    `@${params.botUsername.toLowerCase()}`,
    `@${params.configuredBotUsername.toLowerCase()}`,
  ]);
  return {
    isMentioned: params.entities.some(
      (entity) =>
        entity.type === "mention" &&
        usernames.has(
          params.rawText.slice(entity.offset, entity.offset + entity.length).toLowerCase(),
        ),
    ),
    isRepliedToBot:
      params.replyTo?.from?.id === params.botId ||
      params.replyTo?.from?.username?.toLowerCase() === params.botUsername.toLowerCase(),
  };
}

export { xmlEscape };
