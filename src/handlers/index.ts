import { Bot, InputFile } from "grammy";
import type { Message } from "grammy/types";
import OpenCC from "opencc-js";
import config from "../configs/env.js";
import {
  getDiaryObservation,
  getOrCreateUser,
  loadRecentRuntimeEvents,
  listDiaryObservationsByDate,
  retractDiaryObservation,
  resetRuntimeConversationSummary,
  setNightyTimestamp,
  setMorningGreeted,
  countUsersWithMemories,
  updateDiaryObservation,
} from "../services/firestore.js";
import { deleteStoredMessage, upsertGroupMessage } from "../services/local-wordcloud-store.js";
import {
  classifyMessage,
  generateAiTurn,
  generateMorningGreeting,
  generateLoveResponse,
  generateShockResponse,
  generateStrokeResponse,
  isTwitterStatusUrl,
  rescueSendMessagesFromDraft,
} from "../libs/ai.js";
import type { RichMediaRef } from "../libs/ai.js";
import {
  pushMessage,
  getHistory,
  formatHistoryAsContext,
  clearHistory,
} from "../libs/conversation-buffer.js";
import {
  getStickerEmojiByFileId,
  getStickerFileId,
  pickRandomStickerEmoji,
} from "../libs/stickers.js";
import { getProactiveHealthSnapshot, touchBotActivity } from "../libs/proactive.js";
import { generateDiaryForDate } from "../libs/diary.js";
import { generateWordcloudPreviewForDateWithRetry } from "../libs/wordcloud.js";
import { formatTimestamp, todayDateStr } from "../libs/time.js";
import { logger } from "../libs/logger.js";
import type { User } from "../global.d.js";
import type { BotContext, BotInfo } from "./context.js";
import { MAX_BUFFER_TEXT, LOVE_REGEX, EIGHT_HOURS_MS } from "./constants.js";
import { matchCommand } from "./match-command.js";
import { extractContent } from "./extract-content.js";
import type { MediaRef } from "./extract-content.js";
import { replyAndTrack } from "./reply-and-track.js";
import { isDuplicateUpdate } from "./update-dedup.js";
import { formatForTelegramHtml } from "../libs/format-telegram.js";
import { getPersonaLabel } from "../libs/persona.js";
import { sanitizePromptText } from "../libs/prompt-safety.js";
import { downloadTelegramFileAsDataUrl } from "../libs/telegram-image.js";
import { groupRuntime } from "../libs/group-runtime.js";
import { isSupportedVideoUrl } from "../libs/video.js";
import type { DiaryObservationDraft } from "../libs/diary-observations.js";

// Delay between consecutive bot messages (ms) — mimics human typing rhythm.
const MESSAGE_DELAY_MS = config.botMessageDelayMs;

const RESET_REPLIES = [
  "刚才断片了喵",
  "前情提要被我吃掉了喵",
  "脑袋重启完成喵 刚才聊到哪了",
  "咳 刚才那段我不记得了喵",
] as const;

const SIMPLE_CASUAL_MESSAGE_REGEX =
  /^(?:在吗|在嘛|早|早安|晚安|午安|下午好|晚上好|哈哈+|哈+|草+|6+|666+|笑死|绷不住|确实|懂了|好耶|好哦|好喔|好吧|谢谢|谢啦|牛|可爱|可爱捏|什么鬼|啥|这啥|真的假的|啊\??|哦+|喵+|？+|\?+|!+|！+|嗯+|呜+|欸+|诶+)$/u;
const DETAILED_REQUEST_REGEX = /认真|详细|解释(?:一下|清楚|清楚点)?|展开讲|细说|具体说说|说详细点/u;
const REALTIME_REQUEST_REGEX =
  /最新|刚刚发生|实时(?:消息|资讯|信息|数据)?|新闻|版本(?:号)?|更新(?:了没|了吗|内容)?|价格|股价|汇率|天气|日期|几点|时间|几号|星期几|发布(?:了没|了吗|时间)?|官网/u;
const CURRENT_FACT_QUESTION_REGEX =
  /(?:现在(?:几点|几[号點]|是什么时间|幾點|幾號)|今天(?:几号|星期几|多少号|日期|天氣|天气)|(?:現在|今天).*(?:幾點|几點|幾號|几号|星期幾|星期几|天氣|天气))/u;
const TECHNICAL_SIGNAL_REGEX =
  /```|`[^`]+`|\b(?:api|sdk|json|sql|http|https|node|npm|pnpm|yarn|git|docker|typescript|javascript|python|java|rust|go|react|vue|astro|firebase|eslint|prettier|pm2|linux|nginx|redis)\b|(?:报错|报錯|错误|錯誤|异常|例外|堆栈|堆疊|代码|代碼|函数|函數|编译|編譯|语法|語法|类型|類型|接口|介面|实现|實現|性能|架构|原理|命令|脚本|日誌|日志|矩阵|矩陣|微积分|微積分|线代|線代|高数|高數|数学|數學|证明|證明|定理|极限|極限|导数|導數|积分|積分|概率|機率|統計|统计|traceback|exception|stack trace|tsconfig|package\.json|pnpm-lock|npm run|import |export |const |let |var |class )/iu;
const traditionalToSimplified = OpenCC.Converter({ from: "t", to: "cn" });

interface LocalAiRoute {
  tier: "simple" | "complex" | "tech";
  needsSearch: boolean;
  preferAdvisor: boolean;
  allowPersistentTools: boolean;
  usedLocalRoute: boolean;
  reason: string;
}

function pickResetReply(): string {
  const idx = Math.floor(Math.random() * RESET_REPLIES.length);
  return RESET_REPLIES[idx] ?? RESET_REPLIES[0];
}

function isCommandLikeMessage(
  entities: { type: string; offset: number; length: number }[],
): boolean {
  return entities.some((entity) => entity.type === "bot_command");
}

function isForwardedMessage(msg: Message): boolean {
  return msg.forward_origin != null || msg.is_automatic_forward === true;
}

async function persistWordcloudMessage(params: {
  chatId: string;
  messageId: number;
  userId: string;
  displayName: string;
  username?: string;
  isBot: boolean;
  isForwarded: boolean;
  text: string;
  createdAt: number;
  editedAt?: number;
}): Promise<void> {
  await upsertGroupMessage({
    chatId: params.chatId,
    messageId: params.messageId,
    userId: params.userId,
    displayName: params.displayName,
    ...(params.username ? { username: params.username } : {}),
    isBot: params.isBot,
    isForwarded: params.isForwarded,
    text: params.text,
    createdAt: params.createdAt,
    ...(params.editedAt ? { editedAt: params.editedAt } : {}),
  });
}

function countSentenceLikeSegments(text: string): number {
  return text
    .split(/[\n。！？!?]+/u)
    .map((part) => part.trim())
    .filter(Boolean).length;
}

function normalizeLocalRouteText(text: string): string {
  return traditionalToSimplified(text);
}

function decideLocalAiRoute(params: {
  rawText: string;
  isMentioned: boolean;
  isRepliedToBot: boolean;
  urls: string[];
  mediaRefs: RichMediaRef[];
}): LocalAiRoute | null {
  const { rawText, isMentioned, isRepliedToBot, urls, mediaRefs } = params;
  const normalized = normalizeLocalRouteText(rawText).replace(/\s+/g, " ").trim();
  const currentMedia = mediaRefs.filter((media) => media.source === "current");
  const hasCurrentMedia = currentMedia.length > 0;
  const hasNonStickerMedia = currentMedia.some((media) => media.type !== "sticker");
  const hasUrls = urls.length > 0;
  const hasOnlyVideoUrls = hasUrls && urls.every(isSupportedVideoUrl);
  const asksCurrentFact = CURRENT_FACT_QUESTION_REGEX.test(normalized);
  const needsSearch =
    (hasUrls && !hasOnlyVideoUrls) || REALTIME_REQUEST_REGEX.test(normalized) || asksCurrentFact;
  const looksTechnical = TECHNICAL_SIGNAL_REGEX.test(normalized);
  const wantsDetailedAnswer = DETAILED_REQUEST_REGEX.test(normalized);
  const isTriggered = isMentioned || isRepliedToBot;

  if (looksTechnical) {
    return {
      tier: "tech",
      needsSearch,
      preferAdvisor: true,
      allowPersistentTools: true,
      usedLocalRoute: true,
      reason: "technical_signal",
    };
  }

  if (wantsDetailedAnswer) {
    return {
      tier: "complex",
      needsSearch,
      preferAdvisor: true,
      allowPersistentTools: true,
      usedLocalRoute: true,
      reason: "explicit_detailed_request",
    };
  }

  if (hasNonStickerMedia) {
    return {
      tier: "simple",
      needsSearch,
      preferAdvisor: true,
      allowPersistentTools: true,
      usedLocalRoute: true,
      reason: "current_non_sticker_media_present",
    };
  }

  if (hasCurrentMedia && !hasUrls && normalized.length <= 16) {
    return {
      tier: "simple",
      needsSearch,
      preferAdvisor: false,
      allowPersistentTools: false,
      usedLocalRoute: true,
      reason: "sticker_or_light_media_chat",
    };
  }

  if (isTriggered && hasOnlyVideoUrls && !needsSearch) {
    return {
      tier: "simple",
      needsSearch: false,
      preferAdvisor: true,
      allowPersistentTools: true,
      usedLocalRoute: true,
      reason: "video_url_present",
    };
  }

  const shortLen = normalized.length > 0 && normalized.length <= 24;
  const mediumLen = normalized.length > 0 && normalized.length <= 48;
  const shortSentenceCount = countSentenceLikeSegments(normalized) <= 2;
  const mediumSentenceCount = countSentenceLikeSegments(normalized) <= 3;
  const looksCasual = SIMPLE_CASUAL_MESSAGE_REGEX.test(normalized);
  if (
    isTriggered &&
    !hasUrls &&
    !needsSearch &&
    !hasCurrentMedia &&
    shortLen &&
    shortSentenceCount &&
    looksCasual
  ) {
    return {
      tier: "simple",
      needsSearch,
      preferAdvisor: false,
      allowPersistentTools: false,
      usedLocalRoute: true,
      reason: "short_casual_triggered_chat",
    };
  }

  if (isTriggered && !hasUrls && !hasCurrentMedia && shortLen && shortSentenceCount) {
    return {
      tier: "simple",
      needsSearch,
      preferAdvisor: false,
      allowPersistentTools: true,
      usedLocalRoute: true,
      reason: "short_triggered_chat",
    };
  }

  if (isTriggered && !hasUrls && !hasCurrentMedia && mediumLen && mediumSentenceCount) {
    return {
      tier: "simple",
      needsSearch,
      preferAdvisor: false,
      allowPersistentTools: true,
      usedLocalRoute: true,
      reason: "medium_triggered_chat",
    };
  }

  if (needsSearch) {
    return {
      tier: "complex",
      needsSearch: true,
      preferAdvisor: true,
      allowPersistentTools: true,
      usedLocalRoute: true,
      reason: "realtime_or_search_request",
    };
  }

  return null;
}

function isReplyTargetMissingError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("message to be replied not found");
}

async function sendTextMessageWithReplyFallback(params: {
  ctx: BotContext;
  chatId: number;
  text: string;
  formatted: string;
  replyToMessageId?: number;
}): Promise<void> {
  const { ctx, chatId, text, formatted, replyToMessageId } = params;

  const sendPlain = async (withReply: boolean): Promise<void> => {
    const sendParams: Record<string, unknown> = {};
    if (withReply && replyToMessageId !== undefined) {
      sendParams.reply_parameters = { message_id: replyToMessageId };
    }
    await ctx.api.sendMessage(chatId, text, sendParams);
  };

  try {
    const sendParams: Record<string, unknown> = { parse_mode: "HTML" };
    if (replyToMessageId !== undefined) {
      sendParams.reply_parameters = { message_id: replyToMessageId };
    }
    await ctx.api.sendMessage(chatId, formatted, sendParams);
    return;
  } catch (err) {
    if (isReplyTargetMissingError(err) && replyToMessageId !== undefined) {
      logger.info(
        { replyToMessageId },
        "sendAiMessages: reply target missing, retrying without reply",
      );
      try {
        await ctx.api.sendMessage(chatId, formatted, { parse_mode: "HTML" });
        return;
      } catch {
        await sendPlain(false);
        return;
      }
    }
  }

  try {
    await sendPlain(replyToMessageId !== undefined);
  } catch (err) {
    if (isReplyTargetMissingError(err) && replyToMessageId !== undefined) {
      logger.info(
        { replyToMessageId },
        "sendAiMessages: plain-text reply target missing, retrying without reply",
      );
      await sendPlain(false);
      return;
    }
    throw err;
  }
}

async function sendStickerWithReplyFallback(params: {
  ctx: BotContext;
  chatId: number;
  stickerFileId: string;
  replyToMessageId?: number;
}): Promise<void> {
  const { ctx, chatId, stickerFileId, replyToMessageId } = params;
  try {
    if (replyToMessageId === undefined) {
      await ctx.api.sendSticker(chatId, stickerFileId);
      return;
    }
    await ctx.api.sendSticker(chatId, stickerFileId, {
      reply_parameters: { message_id: replyToMessageId },
    });
  } catch (err) {
    if (isReplyTargetMissingError(err) && replyToMessageId !== undefined) {
      logger.info(
        { replyToMessageId },
        "sendAiMessages: sticker reply target missing, retrying without reply",
      );
      await ctx.api.sendSticker(chatId, stickerFileId);
      return;
    }
    throw err;
  }
}

function formatDiaryObservationSummary(
  date: string,
  items: Awaited<ReturnType<typeof listDiaryObservationsByDate>>,
): string {
  if (items.length === 0) return `${date} 没有 observation`;
  return [
    `${date} observations (${items.length})`,
    ...items.map((item) => {
      const extras = [
        `status=${item.status}`,
        `confidence=${item.confidence}`,
        `salience=${item.salience}`,
        item.subjectUid ? `subject=${item.subjectUid}` : "",
        item.supersedesId ? `supersedes=${item.supersedesId}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      const refs = item.sourceRefs?.length ? ` refs=${item.sourceRefs.join(",")}` : "";
      return `- ${item.id} ${extras}\n  event: ${item.event}${refs}`;
    }),
  ].join("\n");
}

function buildDiaryPatchFromJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function findCommandEntity(
  entities: { type: string; offset: number; length: number }[],
  text: string,
  command: string,
  botUsername: string,
): { offset: number; length: number } | null {
  for (const entity of entities) {
    if (entity.type !== "bot_command") continue;
    const raw = text.slice(entity.offset, entity.offset + entity.length);
    if (raw === command || raw === `${command}@${botUsername}`) {
      return { offset: entity.offset, length: entity.length };
    }
  }
  return null;
}

function parseShockCommand(
  entities: { type: string; offset: number; length: number }[],
  text: string,
  botUsername: string,
): { intensity?: number; extraText?: string } | null {
  const commandEntity = findCommandEntity(entities, text, "/shock", botUsername);
  if (!commandEntity) return null;

  const remainder = text.slice(commandEntity.offset + commandEntity.length).trim();
  if (!remainder) return {};

  const match = remainder.match(/^([+-]?\d+)(?:\s+(.*))?$/s);
  if (match) {
    const intensity = Number.parseInt(match[1] ?? "", 10);
    const extraText = match[2]?.trim();
    return {
      intensity,
      ...(extraText ? { extraText } : {}),
    };
  }

  return { extraText: remainder };
}

function parseStrokeCommand(
  entities: { type: string; offset: number; length: number }[],
  text: string,
  botUsername: string,
): { intensity?: number; extraText?: string } | null {
  const commandEntity = findCommandEntity(entities, text, "/stroke", botUsername);
  if (!commandEntity) return null;

  const remainder = text.slice(commandEntity.offset + commandEntity.length).trim();
  if (!remainder) return {};

  const match = remainder.match(/^([+-]?\d+)(?:\s+(.*))?$/s);
  if (match) {
    const intensity = Number.parseInt(match[1] ?? "", 10);
    const extraText = match[2]?.trim();
    return {
      intensity,
      ...(extraText ? { extraText } : {}),
    };
  }

  return { extraText: remainder };
}

type RollCommandParseResult =
  | { kind: "ok"; count: number; sides: number; notation: string }
  | { kind: "error"; message: string };

function parseRollCommand(
  entities: { type: string; offset: number; length: number }[],
  text: string,
  botUsername: string,
): RollCommandParseResult | null {
  const commandEntity = findCommandEntity(entities, text, "/roll", botUsername);
  if (!commandEntity) return null;

  const remainder = text.slice(commandEntity.offset + commandEntity.length).trim();
  if (!remainder) {
    return { kind: "ok", count: 1, sides: 20, notation: "1d20" };
  }

  const match = remainder.match(/^(\d+)d(\d+)$/iu);
  if (!match) {
    return { kind: "error", message: "用法是 /roll 或 /roll 2d6 这种格式喵~" };
  }

  const count = Number.parseInt(match[1] ?? "", 10);
  const sides = Number.parseInt(match[2] ?? "", 10);

  if (!Number.isInteger(count) || count <= 0 || count > 20) {
    return { kind: "error", message: "骰子数量只能是 1 到 20 的正整数喵~" };
  }
  if (!Number.isInteger(sides) || sides < 2 || sides > 99999) {
    return { kind: "error", message: "骰子面数只能是 2 到 99999 的正整数喵~" };
  }

  return { kind: "ok", count, sides, notation: `${count}d${sides}` };
}

function rollDice(params: { count: number; sides: number }): { results: number[]; total: number } {
  const results = Array.from(
    { length: params.count },
    () => Math.floor(Math.random() * params.sides) + 1,
  );
  const total = results.reduce((sum, value) => sum + value, 0);
  return { results, total };
}

function formatRollResult(params: { notation: string; results: number[]; total: number }): string {
  if (params.results.length === 1) {
    return `掷出了 ${params.notation}：${params.results[0]}`;
  }
  return `掷出了 ${params.notation}：${params.results.join(" + ")} = ${params.total}`;
}

function xmlEscape(text: string): string {
  return sanitizePromptText(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * Build the user-facing text for the AI call by stitching together the raw
 * text with raw media/link references and reply-to context.
 */
function buildUserMessage(params: {
  rawText: string;
  displayName: string;
  mediaRefs: MediaRef[];
  replyTo: Message | undefined;
  isRepliedToBot: boolean;
  isMentioned?: boolean;
  urls: string[];
}): string {
  const { rawText, displayName, mediaRefs, replyTo, isRepliedToBot, isMentioned, urls } = params;

  const sections: string[] = [];
  sections.push("<current_turn>");
  sections.push(`  <speaker name="${xmlEscape(displayName)}" />`);
  sections.push(
    `  <trigger mode="${isMentioned || isRepliedToBot ? "passive_triggered" : "not_triggered"}" mentioned="${isMentioned ? "true" : "false"}" replied_to_bot="${isRepliedToBot ? "true" : "false"}" />`,
  );

  if (replyTo && !isRepliedToBot) {
    const replyUid = replyTo.from?.id?.toString() ?? "";
    const replyFirstName = replyTo.from?.first_name ?? "某人";
    const replyUsername = replyTo.from?.username;
    const replyName = replyUsername ? `${replyFirstName} (@${replyUsername})` : replyFirstName;
    sections.push(`  <reply_to uid="${xmlEscape(replyUid)}" name="${xmlEscape(replyName)}">`);
    const replyText = replyTo.text ?? replyTo.caption ?? "";
    if (replyText) {
      sections.push(`    <quoted_text>${xmlEscape(replyText)}</quoted_text>`);
    } else if (replyTo.photo?.length) {
      const photo = replyTo.photo[replyTo.photo.length - 1];
      sections.push(
        `    <quoted_media type="image" file_id="${xmlEscape(photo?.file_id ?? "")}" />`,
      );
    } else if (replyTo.sticker) {
      sections.push(
        `    <quoted_media type="sticker" file_id="${xmlEscape(replyTo.sticker.file_id)}" emoji="${xmlEscape(replyTo.sticker.emoji ?? "")}" />`,
      );
    } else if (replyTo.video) {
      const thumb =
        replyTo.video.cover?.[replyTo.video.cover.length - 1] ?? replyTo.video.thumbnail;
      sections.push(
        `    <quoted_media type="video" file_id="${xmlEscape(replyTo.video.file_id)}" thumbnail_file_id="${xmlEscape(thumb?.file_id ?? "")}" />`,
      );
    } else if (replyTo.animation) {
      sections.push(
        `    <quoted_media type="animation" file_id="${xmlEscape(replyTo.animation.file_id)}" thumbnail_file_id="${xmlEscape(replyTo.animation.thumbnail?.file_id ?? "")}" />`,
      );
    } else if (replyTo.video_note) {
      sections.push(
        `    <quoted_media type="video_note" file_id="${xmlEscape(replyTo.video_note.file_id)}" thumbnail_file_id="${xmlEscape(replyTo.video_note.thumbnail?.file_id ?? "")}" />`,
      );
    } else if (replyTo.document) {
      sections.push(
        `    <quoted_media type="document" file_id="${xmlEscape(replyTo.document.file_id)}" thumbnail_file_id="${xmlEscape(replyTo.document.thumbnail?.file_id ?? "")}" filename="${xmlEscape(replyTo.document.file_name ?? "")}" />`,
      );
    } else if (replyTo.audio) {
      sections.push(
        `    <quoted_media type="audio" file_id="${xmlEscape(replyTo.audio.file_id)}" thumbnail_file_id="${xmlEscape(replyTo.audio.thumbnail?.file_id ?? "")}" title="${xmlEscape(replyTo.audio.title || replyTo.audio.file_name || "")}" />`,
      );
    }
    sections.push("    <note>reply_to 内容是被回复消息，不是当前说话人的新消息</note>");
    sections.push("  </reply_to>");
  }

  if (rawText) {
    sections.push(`  <text>${xmlEscape(rawText)}</text>`);
  }

  const currentMedia = mediaRefs.filter((m) => m.source === "current");
  if (currentMedia.length > 0) {
    sections.push("  <media>");
    for (const media of currentMedia) {
      if (media.type === "image") {
        sections.push(`    <image file_id="${xmlEscape(media.fileId ?? "")}" />`);
      } else if (media.type === "sticker") {
        sections.push(
          `    <sticker file_id="${xmlEscape(media.fileId ?? "")}" emoji="${xmlEscape(media.emoji ?? "")}" />`,
        );
      } else if (media.type === "video") {
        sections.push(
          `    <video file_id="${xmlEscape(media.fileId ?? "")}" thumbnail_file_id="${xmlEscape(media.thumbnailFileId ?? "")}" />`,
        );
      } else if (media.type === "animation") {
        sections.push(
          `    <animation file_id="${xmlEscape(media.fileId ?? "")}" thumbnail_file_id="${xmlEscape(media.thumbnailFileId ?? "")}" />`,
        );
      } else if (media.type === "video_note") {
        sections.push(
          `    <video_note file_id="${xmlEscape(media.fileId ?? "")}" thumbnail_file_id="${xmlEscape(media.thumbnailFileId ?? "")}" />`,
        );
      } else if (media.type === "document") {
        sections.push(
          `    <document file_id="${xmlEscape(media.fileId ?? "")}" thumbnail_file_id="${xmlEscape(media.thumbnailFileId ?? "")}" filename="${xmlEscape(media.filename ?? "")}" />`,
        );
      } else if (media.type === "audio") {
        sections.push(
          `    <audio file_id="${xmlEscape(media.fileId ?? "")}" thumbnail_file_id="${xmlEscape(media.thumbnailFileId ?? "")}" title="${xmlEscape(media.title ?? "")}" />`,
        );
      }
    }
    sections.push("  </media>");
  }

  if (urls.length > 0) {
    sections.push("  <links>");
    for (const url of urls) {
      sections.push(`    <link url="${xmlEscape(url)}" />`);
    }
    sections.push("  </links>");
  }

  sections.push("</current_turn>");
  return sections.join("\n");
}

/**
 * Compute the rolling buffer line for the user's message — a compact string
 * combining text, media markers, and URLs. Pushed to the conversation buffer
 * exactly once per update, at the top of the handler.
 */
function buildBufferLine(params: {
  rawText: string;
  mediaRefs: MediaRef[];
  urls: string[];
  replyToInfo?: { uid: string; name: string; username?: string; text: string };
}): string {
  const parts: string[] = [];
  if (params.replyToInfo?.text) {
    const ri = params.replyToInfo;
    const userLabel = ri.username ? `${ri.name} (@${ri.username})` : ri.name;
    parts.push(`[回复 ${ri.uid} ${userLabel}: "${ri.text.slice(0, 100)}"]`);
  }
  if (params.urls.length > 0) {
    const prioritizedUrls = [
      ...params.urls.filter(isTwitterStatusUrl),
      ...params.urls.filter((url) => !isTwitterStatusUrl(url)),
    ];
    for (const url of prioritizedUrls) {
      const compact = url.length > 120 ? `${url.slice(0, 117)}...` : url;
      parts.push(`[链接: ${compact}]`);
    }
  }
  if (params.rawText) parts.push(params.rawText);
  const currentMedia = params.mediaRefs.filter((m) => m.source === "current");
  if (currentMedia.length > 0) {
    for (const media of currentMedia) {
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
  }
  return parts.join(" ").slice(0, MAX_BUFFER_TEXT);
}

const MEMORY_CANDIDATE_PATTERNS: { type: string; regex: RegExp; hint: string }[] = [
  {
    type: "nickname",
    regex: /(?:我叫|叫我|可以叫我|喊我|昵称是|名字是)/u,
    hint: "当前轮可能出现了称呼/昵称信息",
  },
  {
    type: "timezone",
    regex: /(?:时区|UTC[+-]?\d{1,2}|GMT[+-]?\d{1,2}|Asia\/[A-Za-z_]+)/u,
    hint: "当前轮可能出现了时区信息",
  },
  {
    type: "location",
    regex:
      /(?:我住在|人在|回老家|我在[^\n]{0,20}(?:上班|工作|读书)|在[^\n]{1,20}(?:上班|工作|读书))/u,
    hint: "当前轮可能出现了常驻地/地区/生活地点信息",
  },
  {
    type: "project",
    regex: /(?:(?:最近|这阵子|这几天)?在做|正在做|还在做|维护.+项目|开发.+项目|做.+毕设|写.+论文)/u,
    hint: "当前轮可能出现了持续项目或近期会反复提到的近况",
  },
  {
    type: "preference",
    regex: /(?:最喜欢|比较喜欢|更喜欢|爱吃|不吃|偏好|只会用|习惯用|平时都用|一般都用|常用的是)/u,
    hint: "当前轮可能出现了偏好/习惯/常用工具信息",
  },
  {
    type: "account",
    regex: /(?:号叫|账号叫|角色叫|ID叫|我的猫娘叫|我家.+叫)/u,
    hint: "当前轮可能出现了账号名/角色名/长期会复用的命名信息",
  },
];

function detectMemoryCandidateHints(rawText: string): string[] {
  const trimmed = rawText.trim();
  if (!trimmed) return [];

  const hints = MEMORY_CANDIDATE_PATTERNS.filter((item) => item.regex.test(trimmed)).map(
    (item) => item.hint,
  );

  return Array.from(new Set(hints));
}

const RECENT_MEDIA_FOLLOWUP_REGEX =
  /这张图|这个图|刚才那张图|上一张图|那张图|这图|那图|图里|图片里|截图里|看图|识图|帮我看图|图上|上面写了什么|这是什么|啥意思|解释一下/u;

function parseMediaRefsFromBufferText(text: string): MediaRef[] {
  const refs: MediaRef[] = [];

  for (const match of text.matchAll(/\[图片 file_id=([^\]\s]+)\]/g)) {
    const fileId = match[1];
    if (!fileId) continue;
    refs.push({ type: "image", source: "reply_to", fileId });
  }
  for (const match of text.matchAll(/\[视频 file_id=([^\]\s]+) thumb=([^\]\s]*)\]/g)) {
    const fileId = match[1];
    if (!fileId) continue;
    refs.push({
      type: "video",
      source: "reply_to",
      fileId,
      ...(match[2] ? { thumbnailFileId: match[2] } : {}),
    });
  }
  for (const match of text.matchAll(/\[GIF file_id=([^\]\s]+) thumb=([^\]\s]*)\]/g)) {
    const fileId = match[1];
    if (!fileId) continue;
    refs.push({
      type: "animation",
      source: "reply_to",
      fileId,
      ...(match[2] ? { thumbnailFileId: match[2] } : {}),
    });
  }
  for (const match of text.matchAll(/\[视频消息 file_id=([^\]\s]+) thumb=([^\]\s]*)\]/g)) {
    const fileId = match[1];
    if (!fileId) continue;
    refs.push({
      type: "video_note",
      source: "reply_to",
      fileId,
      ...(match[2] ? { thumbnailFileId: match[2] } : {}),
    });
  }
  for (const match of text.matchAll(/\[文件 file_id=([^\]\s]+) thumb=([^\]\s]*)\s*([^\]]*)\]/g)) {
    const fileId = match[1];
    if (!fileId) continue;
    refs.push({
      type: "document",
      source: "reply_to",
      fileId,
      ...(match[2] ? { thumbnailFileId: match[2] } : {}),
      ...(match[3]?.trim() ? { filename: match[3].trim() } : {}),
    });
  }
  for (const match of text.matchAll(/\[音频 file_id=([^\]\s]+) thumb=([^\]\s]*)\s*([^\]]*)\]/g)) {
    const fileId = match[1];
    if (!fileId) continue;
    refs.push({
      type: "audio",
      source: "reply_to",
      fileId,
      ...(match[2] ? { thumbnailFileId: match[2] } : {}),
      ...(match[3]?.trim() ? { title: match[3].trim() } : {}),
    });
  }

  return refs;
}

function maybeAttachRecentMediaRefs(params: {
  groupId: string;
  rawText: string;
  mediaRefs: MediaRef[];
}): MediaRef[] {
  if (params.mediaRefs.length > 0) return params.mediaRefs;
  if (!RECENT_MEDIA_FOLLOWUP_REGEX.test(params.rawText)) return params.mediaRefs;

  const history = getHistory(params.groupId);
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (!entry || entry.uid === "bot" || entry.uid === "system") continue;
    if (Array.isArray(entry.mediaRefs)) {
      const refs = entry.mediaRefs
        .filter((ref) => ref?.source === "current")
        .map(mapRuntimeMediaRefToMediaRef)
        .filter(Boolean) as MediaRef[];
      if (refs.length > 0) return refs;
      continue;
    }
    const refs = parseMediaRefsFromBufferText(entry.text);
    if (refs.length > 0) {
      logger.info(
        { matchedText: params.rawText, sourceUid: entry.uid, recoveredRefs: refs.length },
        "attached recent media refs for follow-up",
      );
      return refs;
    }
  }

  return params.mediaRefs;
}

function mapRuntimeMediaRefToMediaRef(ref: {
  type: string;
  source?: string;
  fileId?: string;
  thumbnailFileId?: string;
  emoji?: string;
  filename?: string;
  title?: string;
}): MediaRef | null {
  if (
    ref.type !== "image" &&
    ref.type !== "sticker" &&
    ref.type !== "video" &&
    ref.type !== "animation" &&
    ref.type !== "video_note" &&
    ref.type !== "document" &&
    ref.type !== "audio"
  ) {
    return null;
  }

  return {
    type: ref.type,
    source: "reply_to",
    ...(ref.fileId ? { fileId: ref.fileId } : {}),
    ...(ref.thumbnailFileId ? { thumbnailFileId: ref.thumbnailFileId } : {}),
    ...(ref.emoji ? { emoji: ref.emoji } : {}),
    ...(ref.filename ? { filename: ref.filename } : {}),
    ...(ref.title ? { title: ref.title } : {}),
  };
}

async function attachRecentMediaRefs(params: {
  groupId: string;
  rawText: string;
  mediaRefs: MediaRef[];
}): Promise<MediaRef[]> {
  if (params.mediaRefs.length > 0) return params.mediaRefs;
  if (!RECENT_MEDIA_FOLLOWUP_REGEX.test(params.rawText)) return params.mediaRefs;

  try {
    const recentEvents = await loadRecentRuntimeEvents({ limit: 20, newestFirst: true });
    for (let i = recentEvents.length - 1; i >= 0; i--) {
      const event = recentEvents[i];
      if (!event || event.uid === "bot" || event.uid === "system") continue;
      const refs = event.mediaRefs
        .filter((ref) => ref.source === "current")
        .map(mapRuntimeMediaRefToMediaRef)
        .filter(Boolean) as MediaRef[];
      if (refs.length > 0) {
        logger.info(
          { matchedText: params.rawText, sourceUid: event.uid, recoveredRefs: refs.length },
          "attached recent media refs from runtime events",
        );
        return refs;
      }
    }
  } catch (err) {
    logger.warn({ err }, "failed to recover recent media refs from runtime events");
  }

  return maybeAttachRecentMediaRefs(params);
}

/**
 * Aggregate distinct recent participants from the in-memory buffer for prompt context.
 */
function collectRecentMembers(groupId: string): {
  recentMembers: { uid: string; name: string; username?: string }[];
} {
  const history = getHistory(groupId);
  const map = new Map<string, { name: string; username?: string }>();
  for (const entry of history) {
    if (entry.uid === "bot" || entry.uid === "system") continue;
    if (!map.has(entry.uid))
      map.set(entry.uid, {
        name: entry.name,
        ...(entry.username ? { username: entry.username } : {}),
      });
  }
  const recentMembers = Array.from(map.entries()).map(([uid, info]) => ({
    uid,
    name: info.name,
    ...(info.username ? { username: info.username } : {}),
  }));
  return { recentMembers };
}

/**
 * Collect recent bot messages from the buffer for human-likeness feedback.
 */
function collectRecentBotMessages(groupId: string, count: number): string[] {
  const history = getHistory(groupId);
  const botMessages: string[] = [];
  for (let i = history.length - 1; i >= 0 && botMessages.length < count; i--) {
    const entry = history[i];
    if (entry && entry.uid === "bot") {
      botMessages.unshift(entry.text);
    }
  }
  return botMessages;
}

/**
 * Send one or more messages from the AI turn to Telegram, formatting as HTML
 * where appropriate and dispatching any sticker selected by the model.
 */
async function sendAiMessages(params: {
  ctx: BotContext;
  chatId: number;
  replyToMessageId: number;
  messages: string[];
  stickerFileId: string | null;
}): Promise<{ messages: string[]; stickerFileId: string | null }> {
  const { ctx, chatId, replyToMessageId, messages, stickerFileId } = params;
  const sentMessages: string[] = [];
  let sentStickerFileId: string | null = null;

  const trackText = async (text: string): Promise<void> => {
    touchBotActivity();
    pushMessage(config.tgGroupId, "bot", config.botUsername, text.slice(0, MAX_BUFFER_TEXT));
    await groupRuntime.recordBotMessages({ messages: [text] });
  };

  const trackSticker = async (fileId: string): Promise<void> => {
    touchBotActivity();
    const emoji = getStickerEmojiByFileId(fileId) ?? "🐱";
    pushMessage(config.tgGroupId, "bot", config.botUsername, `[贴纸 ${emoji}: ${fileId}]`);
    await groupRuntime.recordBotMessages({ messages: [], stickerFileId: fileId });
  };

  if (messages.length === 0) {
    // No text messages — if there's a sticker, send it with a reply reference
    if (stickerFileId) {
      try {
        await sendStickerWithReplyFallback({
          ctx,
          chatId,
          stickerFileId,
          replyToMessageId,
        });
        sentStickerFileId = stickerFileId;
        await trackSticker(stickerFileId);
      } catch (err) {
        logger.warn({ err, stickerFileId }, "sendAiMessages: sticker dispatch failed");
      }
    }
    return { messages: sentMessages, stickerFileId: sentStickerFileId };
  }

  // First message replies to the user's message; subsequent messages are
  // sent standalone (like a human typing follow-up lines).
  let textDispatchFailed = false;
  for (let i = 0; i < messages.length; i++) {
    const text = messages[i]!;
    const formatted = formatForTelegramHtml(text);

    try {
      await sendTextMessageWithReplyFallback({
        ctx,
        chatId,
        text,
        formatted,
        ...(i === 0 ? { replyToMessageId } : {}),
      });
      sentMessages.push(text);
      await trackText(text);
    } catch (err) {
      logger.warn({ err, i }, "sendAiMessages: failed to send message");
      textDispatchFailed = true;
      break;
    }

    // Stagger messages to mimic human typing rhythm, but not after the last one
    if (i < messages.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, MESSAGE_DELAY_MS));
    }
  }

  // Dispatch sticker after all text messages, if any
  if (stickerFileId && !textDispatchFailed) {
    try {
      await ctx.api.sendSticker(chatId, stickerFileId);
      sentStickerFileId = stickerFileId;
      await trackSticker(stickerFileId);
    } catch (err) {
      logger.warn({ err, stickerFileId }, "sendAiMessages: sticker dispatch failed");
    }
  }

  return { messages: sentMessages, stickerFileId: sentStickerFileId };
}

const MANDATORY_REPLY_HINT =
  "<mandatory_reply_hint><rule>用户明确@了你或回复了你</rule><action>必须回复，不要选择沉默</action></mandatory_reply_hint>";

/**
 * Handle an AI turn: classify the message, run the full AI pipeline with
 * tool-call architecture, and send results to Telegram.
 *
 * When the user explicitly @-mentioned or replied to the bot, dismiss results
 * are retried with escalating hints based on the classification tier:
 *   - tech (pro model): no retry — dismisses are sent as fallback immediately
 *   - simple/complex: 1 retry, then fallback if still dismissed
 *   - proactive: no retry (dismiss = silence)
 */
async function handleAiTurn(params: {
  ctx: BotContext;
  replyToMessageId: number;
  user: User;
  userMessage: string;
  systemHint: string | null;
  isMentioned: boolean;
  isRepliedToBot: boolean;
  mediaRefs: RichMediaRef[];
  urls: string[];
  sourceRefs?: string[];
  senderUsername?: string;
  runtimeStatus?: string;
  allowWebSearch?: boolean;
  allowMediaTools?: boolean;
  memoryCandidateHints?: string[];
  forceReply?: boolean;
  dismissFallbackMessages?: string[];
}): Promise<void> {
  const {
    ctx,
    replyToMessageId,
    user,
    userMessage,
    systemHint,
    isMentioned,
    isRepliedToBot,
    mediaRefs,
    urls,
    sourceRefs,
    senderUsername,
    runtimeStatus,
    allowWebSearch,
    allowMediaTools,
    memoryCandidateHints,
    forceReply,
    dismissFallbackMessages,
  } = params;

  const chatId = ctx.chatId;
  if (chatId === undefined) throw new Error("no chat in context");

  // Signal "typing..." while the AI generates.
  // Because DeepSeek can take 10-20s, refresh the typing action every 4.5s.
  const typingTimer = setInterval(() => {
    ctx.api.sendChatAction(chatId, "typing").catch(() => void 0);
  }, 4500);
  await ctx.api.sendChatAction(chatId, "typing").catch(() => void 0);

  const history = getHistory(config.tgGroupId);
  const runtimeContext = await groupRuntime.loadContext().catch((err: unknown) => {
    logger.warn({ err }, "load runtime context failed, falling back to buffer");
    return null;
  });
  const recentConversation = runtimeContext?.recentEventsText || formatHistoryAsContext(history);
  const { recentMembers } = collectRecentMembers(config.tgGroupId);
  if (!recentMembers.some((m) => m.uid === user.uid)) {
    recentMembers.push({
      uid: user.uid,
      name: user.nickname || "大哥哥",
      ...(senderUsername ? { username: senderUsername } : {}),
    });
  }
  const replyTo = ctx.msg?.reply_to_message;
  if (replyTo && replyTo.from && replyTo.from.id !== ctx.me.id) {
    const replyUid = replyTo.from.id.toString();
    if (!recentMembers.some((m) => m.uid === replyUid)) {
      recentMembers.push({
        uid: replyUid,
        name: replyTo.from.first_name ?? "某人",
        ...(replyTo.from.username ? { username: replyTo.from.username } : {}),
      });
    }
  }

  const recentBotMessages = collectRecentBotMessages(config.tgGroupId, 5);

  const localRoute = decideLocalAiRoute({
    rawText: ctx.msg?.text ?? ctx.msg?.caption ?? "",
    isMentioned,
    isRepliedToBot,
    urls: urls ?? [],
    mediaRefs: (mediaRefs ?? []) as MediaRef[],
  });
  const { tier, needsSearch } = localRoute ?? (await classifyMessage(userMessage));
  if (localRoute) {
    logger.info(
      {
        tier: localRoute.tier,
        needsSearch: localRoute.needsSearch,
        preferAdvisor: localRoute.preferAdvisor,
        allowPersistentTools: localRoute.allowPersistentTools,
        reason: localRoute.reason,
      },
      "handleAiTurn: applied local AI routing",
    );
  }
  const isTriggered = isMentioned || isRepliedToBot || forceReply === true;

  try {
    const resolveTelegramFileAsDataUrl = async (fileId: string): Promise<string | null> => {
      try {
        const file = await ctx.api.getFile(fileId);
        if (!file.file_path) return null;
        return await downloadTelegramFileAsDataUrl(file.file_path);
      } catch (err) {
        logger.warn({ err, fileId }, "resolveTelegramFileAsDataUrl failed");
        return null;
      }
    };

    // Build the base systemHint, appending the mandatory-reply hint for
    // retries when the user explicitly triggered the bot.
    let currentHint = systemHint;
    let result = await generateAiTurn({
      userContext: user,
      userMessage,
      recentConversation,
      recentMembers,
      tier,
      needsSearch,
      systemHint: currentHint,
      wasMentioned: isMentioned,
      wasRepliedTo: isRepliedToBot,
      recentBotMessages,
      mediaRefs,
      urls,
      ...(sourceRefs ? { sourceRefs } : {}),
      resolveTelegramFileAsDataUrl,
      allowRichContentTools: isTriggered,
      ...(runtimeContext?.summary ? { conversationSummary: runtimeContext.summary } : {}),
      ...(runtimeStatus ? { runtimeStatus } : {}),
      ...(allowWebSearch != null ? { allowWebSearch } : {}),
      ...(allowMediaTools != null ? { allowMediaTools } : {}),
      ...(memoryCandidateHints?.length ? { memoryCandidateHints } : {}),
      isRetryTurn: false,
      allowPersistentTools: localRoute?.allowPersistentTools ?? true,
      ...(localRoute?.preferAdvisor ? { preferAdvisor: true } : {}),
    });

    // Retry on dismiss when the user explicitly triggered the bot.
    // tech tier: no retry, just send the fallback.
    // simple/complex tier: 1 retry, then fallback.
    if (
      result.action === "dismiss" &&
      isTriggered &&
      result.dismissReason !== "twitter_fetch_failed"
    ) {
      let retries = 0;
      const maxRetries = tier === "tech" ? 0 : 1;

      while (retries < maxRetries) {
        retries++;
        logger.info({ retries, tier }, "handleAiTurn: dismissing, retrying");

        await ctx.api.sendChatAction(chatId, "typing").catch(() => void 0);

        currentHint = currentHint
          ? `${currentHint}\n${MANDATORY_REPLY_HINT}`
          : MANDATORY_REPLY_HINT;

        result = await generateAiTurn({
          userContext: user,
          userMessage,
          recentConversation,
          recentMembers,
          tier,
          needsSearch,
          systemHint: currentHint,
          wasMentioned: isMentioned,
          wasRepliedTo: isRepliedToBot,
          recentBotMessages,
          mediaRefs,
          urls,
          ...(sourceRefs ? { sourceRefs } : {}),
          resolveTelegramFileAsDataUrl,
          allowRichContentTools: isTriggered,
          ...(runtimeContext?.summary ? { conversationSummary: runtimeContext.summary } : {}),
          ...(runtimeStatus ? { runtimeStatus } : {}),
          ...(allowWebSearch != null ? { allowWebSearch } : {}),
          ...(allowMediaTools != null ? { allowMediaTools } : {}),
          ...(memoryCandidateHints?.length ? { memoryCandidateHints } : {}),
          isRetryTurn: true,
          allowPersistentTools: localRoute?.allowPersistentTools ?? true,
          ...(localRoute?.preferAdvisor ? { preferAdvisor: true } : {}),
        });

        if (
          result.action === "send" ||
          (result.action === "dismiss" && result.dismissReason === "twitter_fetch_failed")
        ) {
          break;
        }
      }

      if (result.action === "dismiss" && result.dismissReason !== "twitter_fetch_failed") {
        clearInterval(typingTimer);
        logger.info("handleAiTurn: dismissed after retries, sending fallback");
        const fallbackEmoji = pickRandomStickerEmoji();
        let finalFallbackToolCalls = result.metrics?.toolCalls ?? [];
        let sentFallback: { messages: string[]; stickerFileId: string | null } = {
          messages: [],
          stickerFileId: null,
        };

        if (dismissFallbackMessages?.length) {
          sentFallback = await sendAiMessages({
            ctx,
            chatId,
            replyToMessageId,
            messages: dismissFallbackMessages,
            stickerFileId: null,
          });
        } else if (result.rawText) {
          const rescued = await rescueSendMessagesFromDraft({
            userContext: user,
            userMessage,
            recentConversation,
            recentMembers,
            recentBotMessages,
            rawDraft: result.rawText,
          });
          const fallbackMessages = rescued?.messages.length ? rescued.messages : [result.rawText];
          if (rescued?.messages.length) {
            finalFallbackToolCalls = [...finalFallbackToolCalls, ...rescued.toolCalls];
            logger.info(
              {
                rescuedMessages: rescued.messages.length,
                rescueToolCalls: rescued.toolCalls.length,
              },
              "handleAiTurn: rescued raw draft via send_message",
            );
          }
          sentFallback = await sendAiMessages({
            ctx,
            chatId,
            replyToMessageId,
            messages: fallbackMessages,
            stickerFileId: rescued?.messages.length ? null : getStickerFileId(fallbackEmoji),
          });
        } else {
          const stickerFileId = getStickerFileId(fallbackEmoji);
          sentFallback = await sendAiMessages({
            ctx,
            chatId,
            replyToMessageId,
            messages: [],
            stickerFileId,
          });
        }

        const sentFallbackOutput =
          sentFallback.messages.length > 0 || sentFallback.stickerFileId !== null;

        await groupRuntime.recordTurn({
          kind: "passive",
          startedAt: Date.now() - (result.metrics?.latencyMs ?? 0),
          completedAt: Date.now(),
          model: result.metrics?.model ?? "unknown",
          tier,
          needsSearch,
          toolCalls: finalFallbackToolCalls,
          action: sentFallbackOutput ? "send" : "error",
          messages: sentFallback.messages,
          stickerFileId: sentFallback.stickerFileId,
          ...(!sentFallbackOutput ? { error: "telegram fallback dispatch failed" } : {}),
          ...(result.metrics?.inputTokens != null
            ? { inputTokens: result.metrics.inputTokens }
            : {}),
          ...(result.metrics?.outputTokens != null
            ? { outputTokens: result.metrics.outputTokens }
            : {}),
          ...(result.metrics?.cachedInputTokens != null
            ? { cachedInputTokens: result.metrics.cachedInputTokens }
            : {}),
          ...(result.metrics?.latencyMs != null ? { latencyMs: result.metrics.latencyMs } : {}),
        });
        return;
      }
    }

    if (result.action === "dismiss") {
      clearInterval(typingTimer);
      logger.info(
        { dismissReason: result.dismissReason ?? "model_dismissed" },
        "handleAiTurn: turn dismissed (silence)",
      );
      await groupRuntime.recordTurn({
        kind: "passive",
        startedAt: Date.now() - (result.metrics?.latencyMs ?? 0),
        completedAt: Date.now(),
        model: result.metrics?.model ?? "unknown",
        tier,
        needsSearch,
        toolCalls: result.metrics?.toolCalls ?? [],
        action: "dismiss",
        messages: [],
        ...(result.metrics?.inputTokens != null ? { inputTokens: result.metrics.inputTokens } : {}),
        ...(result.metrics?.outputTokens != null
          ? { outputTokens: result.metrics.outputTokens }
          : {}),
        ...(result.metrics?.cachedInputTokens != null
          ? { cachedInputTokens: result.metrics.cachedInputTokens }
          : {}),
        ...(result.metrics?.latencyMs != null ? { latencyMs: result.metrics.latencyMs } : {}),
      });
      return;
    }

    // result.action === "send"
    clearInterval(typingTimer);

    const sent = await sendAiMessages({
      ctx,
      chatId,
      replyToMessageId,
      messages: result.messages,
      stickerFileId: result.stickerFileId,
    });
    const sentOutput = sent.messages.length > 0 || sent.stickerFileId !== null;
    await groupRuntime.recordTurn({
      kind: "passive",
      startedAt: Date.now() - (result.metrics?.latencyMs ?? 0),
      completedAt: Date.now(),
      model: result.metrics?.model ?? "unknown",
      tier,
      needsSearch,
      toolCalls: result.metrics?.toolCalls ?? [],
      action: sentOutput ? "send" : "error",
      messages: sent.messages,
      stickerFileId: sent.stickerFileId,
      ...(!sentOutput ? { error: "telegram dispatch failed" } : {}),
      ...(result.metrics?.inputTokens != null ? { inputTokens: result.metrics.inputTokens } : {}),
      ...(result.metrics?.outputTokens != null
        ? { outputTokens: result.metrics.outputTokens }
        : {}),
      ...(result.metrics?.cachedInputTokens != null
        ? { cachedInputTokens: result.metrics.cachedInputTokens }
        : {}),
      ...(result.metrics?.latencyMs != null ? { latencyMs: result.metrics.latencyMs } : {}),
    });
  } catch (err) {
    clearInterval(typingTimer);
    logger.error({ err }, "handleAiTurn: AI turn failed");
    await replyAndTrack(ctx, "呜喵...出了点问题喵...", replyToMessageId);
    await groupRuntime.recordTurn({
      kind: "passive",
      startedAt: Date.now(),
      completedAt: Date.now(),
      model: "unknown",
      needsSearch: false,
      toolCalls: [],
      action: "error",
      messages: [],
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function buildStatusText(): Promise<string> {
  const historyLen = getHistory(config.tgGroupId).length;
  const uptime = process.uptime();
  const mins = Math.floor(uptime / 60);
  const hours = Math.floor(mins / 60);
  const uptimeStr = hours > 0 ? `${hours}h${mins % 60}m` : `${mins}m`;
  const mem = process.memoryUsage();
  const rssMb = Math.round(mem.rss / 1024 / 1024);
  const memUsers = await countUsersWithMemories().catch((err: unknown) => {
    logger.warn({ err }, "countUsersWithMemories failed");
    return null;
  });
  const runtimeStatus = groupRuntime.getStatusSnapshot();
  const proactiveHealth = getProactiveHealthSnapshot();
  const formatHealthTime = (timestamp: number | null) =>
    timestamp == null ? "never" : formatTimestamp(timestamp, "MM-DD HH:mm:ss");
  const proactiveError = proactiveHealth.lastError?.replace(/\s+/g, " ").slice(0, 200) ?? "none";
  const runtimeContext = await groupRuntime.loadContext().catch((err: unknown) => {
    logger.warn({ err }, "status runtime context failed");
    return null;
  });
  return [
    `📊 ${config.botPersonaName} 状态`,
    `运行时间: ${uptimeStr}`,
    `缓冲区消息数: ${historyLen}`,
    `Runtime: running=${runtimeStatus.running} debouncing=${runtimeStatus.debouncing} dirty=${runtimeStatus.dirty}`,
    `Quiet 剩余: ${Math.ceil(runtimeStatus.quietRemainingMs / 1000)}s`,
    `Proactive: running=${proactiveHealth.running} scheduled=${proactiveHealth.scheduled} stopped=${proactiveHealth.stopped} failures=${proactiveHealth.consecutiveFailures}`,
    `Proactive checks: last=${formatHealthTime(proactiveHealth.lastCheckAt)} success=${formatHealthTime(proactiveHealth.lastSuccessAt)} failure=${formatHealthTime(proactiveHealth.lastFailureAt)}`,
    `Proactive error: ${proactiveError}`,
    `Summary cursor: ${runtimeContext?.summaryCursorTs ?? 0}`,
    `Recent events: ${runtimeContext?.recentEvents.length ?? "?"}`,
    `记忆用户数: ${memUsers ?? "?"}`,
    `内存 RSS: ${rssMb} MB`,
  ].join("\n");
}

export function setupHandlers(bot: Bot<BotContext>, botInfo: BotInfo): void {
  const botUsername = botInfo.username || config.botUsername;
  const botId = botInfo.id;

  bot.use(async (ctx, next) => {
    const groupUpdate = ctx.update.message ?? ctx.update.edited_message;
    if (groupUpdate?.chat.id.toString() !== config.tgGroupId) {
      await next();
      return;
    }
    const release = groupRuntime.beginIncomingActivity();
    try {
      await next();
    } finally {
      release();
    }
  });

  bot.on("message", async (ctx) => {
    if (isDuplicateUpdate(ctx.update.update_id)) return;
    const msg = ctx.message;
    if (!msg) return;

    // 0. Private chat — admin commands only
    if (ctx.chat?.type === "private") {
      if (!msg.from || msg.from.id.toString() !== config.tgAdminUid) return;
      const privText = msg.text ?? msg.caption ?? "";
      const privEntities = [...(msg.entities ?? []), ...(msg.caption_entities ?? [])];

      if (matchCommand(privEntities, privText, "/status", botUsername)) {
        const statusText = await buildStatusText();
        await ctx.reply(statusText).catch((err: unknown) => {
          logger.warn({ err }, "private /status reply failed");
        });
        return;
      }

      if (matchCommand(privEntities, privText, "/reset", botUsername)) {
        clearHistory(config.tgGroupId);
        await resetRuntimeConversationSummary().catch((err: unknown) => {
          logger.warn({ err }, "private /reset runtime summary clear failed");
        });
        await ctx.reply(pickResetReply()).catch((err: unknown) => {
          logger.warn({ err }, "private /reset reply failed");
        });
        return;
      }

      if (matchCommand(privEntities, privText, "/diary", botUsername)) {
        await ctx.reply("正在生成今日日记...").catch(() => void 0);
        try {
          const diary = await generateDiaryForDate(todayDateStr());
          if (!diary) {
            await ctx.reply("今天还没有日记记录喵~");
            return;
          }
          await ctx.reply(diary);
        } catch (err) {
          logger.error({ err }, "private /diary failed");
          await ctx.reply("生成日记时出错了喵...").catch(() => void 0);
        }
        return;
      }

      if (matchCommand(privEntities, privText, "/wordcloud", botUsername)) {
        const date = privText.replace(/^\/wordcloud(?:@\w+)?\s*/u, "").trim() || todayDateStr();
        await ctx.reply(`正在生成词云 ${date}...`).catch(() => void 0);
        try {
          const preview = await generateWordcloudPreviewForDateWithRetry(date);
          if (!preview) {
            await ctx.reply("这一天没有足够的聊天记录可生成词云喵。").catch(() => void 0);
            return;
          }
          await ctx
            .replyWithPhoto(new InputFile(preview.image, `${date}-wordcloud.png`), {
              caption: preview.caption,
            })
            .catch(async () => {
              await ctx.reply(preview.caption).catch(() => void 0);
            });
        } catch (err) {
          logger.error({ err, date }, "private /wordcloud failed");
          await ctx.reply("生成词云失败了喵...").catch(() => void 0);
        }
        return;
      }

      if (matchCommand(privEntities, privText, "/diaryobs", botUsername)) {
        const date = privText.replace(/^\/diaryobs(?:@\w+)?\s*/u, "").trim() || todayDateStr();
        try {
          const observations = await listDiaryObservationsByDate(date);
          await ctx.reply(formatDiaryObservationSummary(date, observations));
        } catch (err) {
          logger.error({ err, date }, "private /diaryobs failed");
          await ctx.reply("查看 observation 失败了喵...").catch(() => void 0);
        }
        return;
      }

      if (matchCommand(privEntities, privText, "/diaryretract", botUsername)) {
        const remainder = privText.replace(/^\/diaryretract(?:@\w+)?\s*/u, "").trim();
        const [targetId, ...reasonParts] = remainder.split(/\s+/u).filter(Boolean);
        if (!targetId) {
          await ctx.reply("用法: /diaryretract <observationId> [reason]").catch(() => void 0);
          return;
        }
        try {
          const result = await retractDiaryObservation(targetId, reasonParts.join(" "));
          await ctx.reply(
            result.action === "retracted"
              ? `已撤销 ${targetId}`
              : `撤销失败: ${result.reason ?? "unknown"}`,
          );
        } catch (err) {
          logger.error({ err, targetId }, "private /diaryretract failed");
          await ctx.reply("撤销 observation 失败了喵...").catch(() => void 0);
        }
        return;
      }

      if (matchCommand(privEntities, privText, "/diaryedit", botUsername)) {
        const remainder = privText.replace(/^\/diaryedit(?:@\w+)?\s*/u, "").trim();
        const firstSpace = remainder.indexOf(" ");
        const targetId = firstSpace >= 0 ? remainder.slice(0, firstSpace).trim() : remainder;
        const jsonText = firstSpace >= 0 ? remainder.slice(firstSpace + 1).trim() : "";
        if (!targetId || !jsonText) {
          await ctx.reply("用法: /diaryedit <observationId> <json patch>").catch(() => void 0);
          return;
        }
        const patch = buildDiaryPatchFromJson(jsonText);
        if (!patch) {
          await ctx.reply("patch 必须是 JSON 对象").catch(() => void 0);
          return;
        }
        try {
          const result = await updateDiaryObservation(
            targetId,
            patch as Partial<DiaryObservationDraft>,
          );
          await ctx.reply(
            result.action === "updated"
              ? `已修正 ${targetId} -> ${result.observation?.id ?? "unknown"}`
              : `修正失败: ${result.reason ?? "unknown"}`,
          );
        } catch (err) {
          logger.error({ err, targetId }, "private /diaryedit failed");
          await ctx.reply("修正 observation 失败了喵...").catch(() => void 0);
        }
        return;
      }

      if (matchCommand(privEntities, privText, "/diaryshow", botUsername)) {
        const targetId = privText.replace(/^\/diaryshow(?:@\w+)?\s*/u, "").trim();
        if (!targetId) {
          await ctx.reply("用法: /diaryshow <observationId>").catch(() => void 0);
          return;
        }
        try {
          const item = await getDiaryObservation(targetId);
          if (!item) {
            await ctx.reply("没找到这条 observation").catch(() => void 0);
            return;
          }
          await ctx.reply(JSON.stringify(item, null, 2)).catch(() => void 0);
        } catch (err) {
          logger.error({ err, targetId }, "private /diaryshow failed");
          await ctx.reply("查看 observation 详情失败了喵...").catch(() => void 0);
        }
        return;
      }

      if (matchCommand(privEntities, privText, "/diaryregen", botUsername)) {
        const date = privText.replace(/^\/diaryregen(?:@\w+)?\s*/u, "").trim() || todayDateStr();
        await ctx.reply(`正在重生日记 ${date}...`).catch(() => void 0);
        try {
          const diary = await generateDiaryForDate(date);
          await ctx.reply(diary ?? "生成失败或返回空内容").catch(() => void 0);
        } catch (err) {
          logger.error({ err, date }, "private /diaryregen failed");
          await ctx.reply("重生日记失败了喵...").catch(() => void 0);
        }
        return;
      }

      return;
    }

    // 1. Group filter
    if (ctx.chat.id.toString() !== config.tgGroupId) return;

    const from = msg.from;
    if (!from) return;

    const rawText = msg.text ?? msg.caption ?? "";
    const entities = [...(msg.entities ?? []), ...(msg.caption_entities ?? [])];

    if (matchCommand(entities, rawText, "/nighty", botUsername)) {
      const replyName = from.first_name || "大哥哥";
      await replyAndTrack(ctx, `晚安安 ${replyName}~ 🌙`, msg.message_id, false, "command_nighty");
      void getOrCreateUser(from.id.toString(), from.first_name)
        .then((user) => setNightyTimestamp(user.uid, Date.now()))
        .catch((err: unknown) => {
          logger.warn({ err, uid: from.id.toString() }, "failed to persist /nighty timestamp");
        });
      return;
    }

    const rollArgs = parseRollCommand(entities, rawText, botUsername);
    if (rollArgs) {
      let resultText: string;
      let systemHint: string;
      let dismissFallbackMessages: string[];
      if (rollArgs.kind === "ok") {
        const roll = rollDice({ count: rollArgs.count, sides: rollArgs.sides });
        resultText = formatRollResult({
          notation: rollArgs.notation,
          results: roll.results,
          total: roll.total,
        });
        systemHint = `<system_hint><event>command_roll</event><rule>用户刚刚使用了 /roll，程序已经发送了掷骰结果：${xmlEscape(resultText)}。你现在必须顺着上下文自然接一句，可以吐槽运气、调侃结果或接住话题，但不要机械重复完整结果。</rule></system_hint>`;
        dismissFallbackMessages = ["这手气看着就很有节目效果，哼。"];
      } else {
        resultText = rollArgs.message;
        systemHint = `<system_hint><event>command_roll_invalid</event><rule>用户刚刚使用了格式或范围错误的 /roll，程序已经发送了错误提示：${xmlEscape(resultText)}。你现在必须顺着上下文自然吐槽一下这次错误输入，语气可以调侃一点，但不要和程序提示完全重复。</rule></system_hint>`;
        dismissFallbackMessages = ["连骰子格式都能写歪，你是想先把我绕晕吗喵。"];
      }

      await replyAndTrack(ctx, resultText, msg.message_id, false, "command_roll");

      const releaseRollActivity = groupRuntime.beginIncomingActivity();
      void (async () => {
        const user = await getOrCreateUser(from.id.toString(), from.first_name);
        const displayName = user.nickname || from.first_name || "大哥哥";
        const replyTo = msg.reply_to_message;
        const isRepliedToBot =
          replyTo?.from?.username?.toLowerCase() === botUsername.toLowerCase() ||
          replyTo?.from?.id === botId;
        const isMentioned = entities.some((e) => {
          if (e.type !== "mention") return false;
          const mention = rawText.slice(e.offset, e.offset + e.length);
          return (
            mention.toLowerCase() === `@${botUsername.toLowerCase()}` ||
            mention.toLowerCase() === `@${config.botUsername.toLowerCase()}`
          );
        });
        const extracted = await extractContent(ctx, msg, { rawText, entities });
        const urls = extracted.urls;
        const mediaRefs = await attachRecentMediaRefs({
          groupId: config.tgGroupId,
          rawText,
          mediaRefs: extracted.mediaRefs,
        });
        const runtimeDecision = await groupRuntime.ingestUserMessage({
          chatId: config.tgGroupId,
          messageId: msg.message_id,
          updateId: ctx.update.update_id,
          kind: "command",
          uid: from.id.toString(),
          name: displayName,
          ...(from.username ? { username: from.username } : {}),
          text: rawText,
          mediaRefs,
          urls,
          ...(replyTo && !isRepliedToBot
            ? {
                replyTo: {
                  uid: replyTo.from?.id?.toString() ?? "",
                  name: replyTo.from?.first_name ?? "某人",
                  ...(replyTo.from?.username ? { username: replyTo.from.username } : {}),
                  text: replyTo.text ?? replyTo.caption ?? "",
                  ...(replyTo.message_id != null ? { messageId: replyTo.message_id } : {}),
                },
              }
            : {}),
          ts: Date.now(),
          triggered: true,
        });

        const userMessage = buildUserMessage({
          rawText,
          displayName,
          mediaRefs,
          replyTo,
          isRepliedToBot,
          isMentioned,
          urls,
        });

        groupRuntime.scheduleCommandTurn({
          label: `roll:${msg.message_id}`,
          execute: () =>
            handleAiTurn({
              ctx,
              replyToMessageId: msg.message_id,
              user,
              userMessage,
              systemHint,
              isMentioned,
              isRepliedToBot,
              mediaRefs,
              urls,
              sourceRefs: [`tg:${config.tgGroupId}:roll:${msg.message_id}`],
              ...(from.username ? { senderUsername: from.username } : {}),
              ...(runtimeDecision.lateBindingStatus
                ? { runtimeStatus: runtimeDecision.lateBindingStatus }
                : {}),
              allowWebSearch: runtimeDecision.allowWebSearch,
              allowMediaTools: runtimeDecision.allowMediaTools,
              forceReply: true,
              dismissFallbackMessages,
            }),
        });
      })()
        .catch((err: unknown) => {
          logger.warn({ err, messageId: msg.message_id }, "failed to schedule /roll follow-up");
        })
        .finally(releaseRollActivity);
      return;
    }

    // 2. Resolve user
    const user = await getOrCreateUser(from.id.toString(), from.first_name);
    const displayName = user.nickname || from.first_name || "大哥哥";

    // 3. Extract content references (text, URLs, media file_ids, sticker emoji)
    const extracted = await extractContent(ctx, msg, { rawText, entities });
    const urls = extracted.urls;
    const mediaRefs = await attachRecentMediaRefs({
      groupId: config.tgGroupId,
      rawText,
      mediaRefs: extracted.mediaRefs,
    });

    // 3b. Trigger detection (@mention or reply-to-bot) — needed for buffer and later logic
    const replyTo = msg.reply_to_message;
    const isRepliedToBot =
      replyTo?.from?.username?.toLowerCase() === botUsername.toLowerCase() ||
      replyTo?.from?.id === botId;
    const isMentioned = entities.some((e) => {
      if (e.type !== "mention") return false;
      const mention = rawText.slice(e.offset, e.offset + e.length);
      return (
        mention.toLowerCase() === `@${botUsername.toLowerCase()}` ||
        mention.toLowerCase() === `@${config.botUsername.toLowerCase()}`
      );
    });

    // 4. Push user's message into the buffer ONCE, up front.
    let replyToInfo: { uid: string; name: string; username?: string; text: string } | undefined;
    if (replyTo && !isRepliedToBot) {
      replyToInfo = {
        uid: replyTo.from?.id?.toString() ?? "",
        name: replyTo.from?.first_name ?? "某人",
        text: replyTo.text ?? replyTo.caption ?? "",
      };
      if (replyTo.from?.username) {
        replyToInfo.username = replyTo.from.username;
      }
    }

    const bufferLine = buildBufferLine({
      rawText,
      mediaRefs,
      urls,
      ...(replyToInfo ? { replyToInfo } : {}),
    });
    const isCommandMessage = isCommandLikeMessage(entities);
    if (!from.is_bot && !isCommandMessage) {
      await persistWordcloudMessage({
        chatId: config.tgGroupId,
        messageId: msg.message_id,
        userId: from.id.toString(),
        displayName,
        ...(from.username ? { username: from.username } : {}),
        isBot: false,
        isForwarded: isForwardedMessage(msg),
        text: rawText,
        createdAt: (msg.date ?? Math.floor(Date.now() / 1000)) * 1000,
      }).catch((err: unknown) => {
        logger.warn({ err, messageId: msg.message_id }, "wordcloud: persist group message failed");
      });
    }
    const runtimeDecision = await groupRuntime.ingestUserMessage({
      chatId: config.tgGroupId,
      messageId: msg.message_id,
      updateId: ctx.update.update_id,
      kind: isCommandMessage ? "command" : "user_message",
      uid: from.id.toString(),
      name: displayName,
      ...(from.username ? { username: from.username } : {}),
      text: bufferLine || rawText,
      mediaRefs,
      urls,
      ...(replyToInfo
        ? {
            replyTo: {
              uid: replyToInfo.uid,
              name: replyToInfo.name,
              ...(replyToInfo.username ? { username: replyToInfo.username } : {}),
              text: replyToInfo.text,
              ...(replyTo?.message_id != null ? { messageId: replyTo.message_id } : {}),
            },
          }
        : {}),
      ts: Date.now(),
      triggered: isMentioned || isRepliedToBot,
    });

    if (bufferLine && runtimeDecision.accepted) {
      pushMessage(
        config.tgGroupId,
        from.id.toString(),
        displayName,
        bufferLine,
        from.username ?? undefined,
        "normal",
        mediaRefs,
      );
    }

    // 5. /help — public
    if (matchCommand(entities, rawText, "/help", botUsername)) {
      const helpText = `喵~ 我是${getPersonaLabel()}，一只傲娇的高中生猫娘 AI！🎀

我的用户名是 @${botUsername}，名字是 ${config.botPersonaName} 喵~

你可以这样跟我互动：
• @我 或 回复我 — 和我聊天
• /roll [1d20|2d6|3d20] — 掷骰子，我会先报结果再接话
• /shock [0-200|想说的话] — 电我一下，也可以带强度或顺便说话
• /stroke [1-200|想说的话] — 撸撸本喵，也可以带力度或边撸边说话
• /nighty — 跟我说晚安，8小时后我会发早安问候
• 发图片 — 我会看看是什么然后吐槽
• 让我「叫我XX」— 我会记住你的昵称
• 让我「记住XXX」— 我会记住关于你的事情

遇到编程/技术问题也可以认真问我，我会收起步猫娘模式帮你喵~`;
      await replyAndTrack(ctx, helpText, msg.message_id, false, "command_help");
      return;
    }

    // 6. /love — public
    if (matchCommand(entities, rawText, "/love", botUsername)) {
      const rejection = await generateLoveResponse(user);
      await replyAndTrack(ctx, rejection, msg.message_id, true, "command_love");
      return;
    }

    const shockArgs = parseShockCommand(entities, rawText, botUsername);
    if (shockArgs) {
      const shocked = await generateShockResponse(user, shockArgs);
      await replyAndTrack(ctx, shocked, msg.message_id, true, "command_shock");
      return;
    }

    const strokeArgs = parseStrokeCommand(entities, rawText, botUsername);
    if (strokeArgs) {
      const stroked = await generateStrokeResponse(user, strokeArgs);
      await replyAndTrack(ctx, stroked, msg.message_id, true, "command_stroke");
      return;
    }

    // 7. Admin-only: /status, /reset
    if (matchCommand(entities, rawText, "/status", botUsername)) {
      if (from.id.toString() !== config.tgAdminUid) {
        await replyAndTrack(ctx, "哼，这是主人才能用的命令喵~", msg.message_id);
        return;
      }
      const statusText = await buildStatusText();
      await replyAndTrack(ctx, statusText, msg.message_id, false, "command_status");
      return;
    }

    if (matchCommand(entities, rawText, "/reset", botUsername)) {
      if (from.id.toString() !== config.tgAdminUid) {
        await replyAndTrack(ctx, "哼，这是主人才能用的命令喵~", msg.message_id);
        return;
      }
      clearHistory(config.tgGroupId);
      await resetRuntimeConversationSummary().catch((err: unknown) => {
        logger.warn({ err }, "group /reset runtime summary clear failed");
      });
      await replyAndTrack(ctx, pickResetReply(), msg.message_id, false, "command_reset");
      return;
    }

    // 10. Morning greeting logic
    let systemHint: string | null = null;
    const now = Date.now();
    const needsMorningGreet =
      !!user.nightyTimestamp &&
      now - user.nightyTimestamp >= EIGHT_HOURS_MS &&
      (!user.lastMorningGreet || user.lastMorningGreet <= user.nightyTimestamp);

    if (needsMorningGreet) {
      if (isMentioned || isRepliedToBot) {
        // Merged path: AI reply will include the greeting opener.
        await setMorningGreeted(user.uid, now);
        systemHint =
          "<system_hint><event>user_just_woke_up</event><rule>回答开头先说一句傲娇早安，再回答问题</rule></system_hint>";
      } else {
        // Standalone path: send greeting, then fall through to return.
        try {
          const greeting = await generateMorningGreeting(user);
          await setMorningGreeted(user.uid, now);
          await replyAndTrack(ctx, greeting, msg.message_id, true, "morning_greeting");
        } catch (err) {
          logger.error({ err, uid: user.uid }, "failed to send morning greeting");
        }
      }
    }

    // 11. If the bot wasn't pinged, we're done.
    if (!isMentioned && !isRepliedToBot) return;
    if (!runtimeDecision.allowAiTrigger) {
      logger.info(
        {
          ignoredReason: runtimeDecision.ignoredReason,
          runtimeStatus: runtimeDecision.lateBindingStatus,
        },
        "runtime blocked AI trigger",
      );
      return;
    }

    // Reset proactive cooldown immediately to prevent double-reply.
    touchBotActivity();

    // 12. Love confession → memory-based affection scoring
    if (LOVE_REGEX.test(rawText)) {
      const rejection = await generateLoveResponse(user);
      await replyAndTrack(ctx, rejection, msg.message_id, true, "command_love");
      return;
    }

    // 13. Main AI path — tool-call architecture
    const userMessage = buildUserMessage({
      rawText,
      displayName,
      mediaRefs,
      replyTo,
      isRepliedToBot,
      isMentioned,
      urls,
    });
    const memoryCandidateHints = detectMemoryCandidateHints(rawText);

    groupRuntime.schedulePassiveTurn({
      label: `message:${msg.message_id}`,
      execute: () =>
        handleAiTurn({
          ctx,
          replyToMessageId: msg.message_id,
          user,
          userMessage,
          systemHint,
          isMentioned,
          isRepliedToBot,
          mediaRefs,
          urls,
          sourceRefs: [`tg:${config.tgGroupId}:message:${msg.message_id}`],
          ...(from.username ? { senderUsername: from.username } : {}),
          ...(runtimeDecision.lateBindingStatus
            ? { runtimeStatus: runtimeDecision.lateBindingStatus }
            : {}),
          allowWebSearch: runtimeDecision.allowWebSearch,
          allowMediaTools: runtimeDecision.allowMediaTools,
          ...(memoryCandidateHints.length ? { memoryCandidateHints } : {}),
        }),
    });
  });

  // ---------------------------------------------------------------------------
  // Edited messages — treat as corrections: only re-reply when the user is
  // still @-mentioning or replying to the bot. Command edits can still be
  // handled when they map to explicit handlers like /shock.
  // -------------------------------------------------------------------------
  bot.on("edited_message", async (ctx) => {
    if (isDuplicateUpdate(ctx.update.update_id)) return;
    const msg = ctx.editedMessage;
    if (!msg) return;
    if (ctx.chat.id.toString() !== config.tgGroupId) return;

    const from = msg.from;
    if (!from) return;

    // Bot editing its own messages should never loop back in
    if (from.username?.toLowerCase() === botUsername.toLowerCase() || from.id === botId) return;

    const rawText = msg.text ?? msg.caption ?? "";

    const entities = [...(msg.entities ?? []), ...(msg.caption_entities ?? [])];
    const isCommandMessage = isCommandLikeMessage(entities);
    if (!from.is_bot && isCommandMessage) {
      await deleteStoredMessage(config.tgGroupId, msg.message_id).catch((err: unknown) => {
        logger.warn(
          { err, messageId: msg.message_id },
          "wordcloud: delete edited command message failed",
        );
      });
    } else if (!from.is_bot && !isCommandMessage) {
      const user = await getOrCreateUser(from.id.toString(), from.first_name);
      const displayName = user.nickname || from.first_name || "大哥哥";
      await persistWordcloudMessage({
        chatId: config.tgGroupId,
        messageId: msg.message_id,
        userId: from.id.toString(),
        displayName,
        ...(from.username ? { username: from.username } : {}),
        isBot: false,
        isForwarded: isForwardedMessage(msg),
        text: rawText,
        createdAt: (msg.date ?? Math.floor(Date.now() / 1000)) * 1000,
        ...(msg.edit_date != null ? { editedAt: msg.edit_date * 1000 } : {}),
      }).catch((err: unknown) => {
        logger.warn(
          { err, messageId: msg.message_id },
          "wordcloud: persist edited group message failed",
        );
      });
    }

    const isMentioned = entities.some((e) => {
      if (e.type !== "mention") return false;
      const mention = rawText.slice(e.offset, e.offset + e.length);
      return (
        mention.toLowerCase() === `@${botUsername.toLowerCase()}` ||
        mention.toLowerCase() === `@${config.botUsername.toLowerCase()}`
      );
    });
    const replyTo = msg.reply_to_message;
    const isRepliedToBot =
      replyTo?.from?.username?.toLowerCase() === botUsername.toLowerCase() ||
      replyTo?.from?.id === botId;

    const strokeArgs = parseStrokeCommand(entities, rawText, botUsername);
    if (strokeArgs) {
      const user = await getOrCreateUser(from.id.toString(), from.first_name);
      const stroked = await generateStrokeResponse(user, strokeArgs);
      await replyAndTrack(ctx, stroked, msg.message_id, true, "command_stroke");
      return;
    }

    if (!isMentioned && !isRepliedToBot) return;

    const user = await getOrCreateUser(from.id.toString(), from.first_name);
    const displayName = user.nickname || from.first_name || "大哥哥";

    const extracted = await extractContent(ctx, msg, { rawText, entities });
    const urls = extracted.urls;
    const mediaRefs = await attachRecentMediaRefs({
      groupId: config.tgGroupId,
      rawText,
      mediaRefs: extracted.mediaRefs,
    });
    let replyToInfo: { uid: string; name: string; username?: string; text: string } | undefined;
    if (replyTo && !isRepliedToBot) {
      replyToInfo = {
        uid: replyTo.from?.id?.toString() ?? "",
        name: replyTo.from?.first_name ?? "某人",
        text: replyTo.text ?? replyTo.caption ?? "",
      };
      if (replyTo.from?.username) {
        replyToInfo.username = replyTo.from.username;
      }
    }
    const editedBuffer = buildBufferLine({
      rawText,
      mediaRefs,
      urls,
      ...(replyToInfo ? { replyToInfo } : {}),
    });
    const runtimeDecision = await groupRuntime.ingestUserMessage({
      chatId: config.tgGroupId,
      messageId: msg.message_id,
      updateId: ctx.update.update_id,
      ...(msg.edit_date != null ? { editDate: msg.edit_date } : {}),
      kind: "edited_message",
      uid: from.id.toString(),
      name: displayName,
      ...(from.username ? { username: from.username } : {}),
      text: editedBuffer || rawText,
      mediaRefs,
      urls,
      ...(replyToInfo
        ? {
            replyTo: {
              uid: replyToInfo.uid,
              name: replyToInfo.name,
              ...(replyToInfo.username ? { username: replyToInfo.username } : {}),
              text: replyToInfo.text,
              ...(replyTo?.message_id != null ? { messageId: replyTo.message_id } : {}),
            },
          }
        : {}),
      ts: Date.now(),
      triggered: isMentioned || isRepliedToBot,
    });
    if (runtimeDecision.ignoredReason === "non_content_edit") return;

    if (editedBuffer && runtimeDecision.accepted) {
      pushMessage(
        config.tgGroupId,
        from.id.toString(),
        displayName,
        editedBuffer.slice(0, MAX_BUFFER_TEXT),
        from.username ?? undefined,
        "normal",
        mediaRefs,
      );
    }

    // Love confession in edit
    if (LOVE_REGEX.test(rawText)) {
      const rejection = await generateLoveResponse(user);
      await replyAndTrack(ctx, rejection, msg.message_id, true, "command_love");
      return;
    }

    const shockArgs = parseShockCommand(entities, rawText, botUsername);
    if (shockArgs) {
      const shocked = await generateShockResponse(user, shockArgs);
      await replyAndTrack(ctx, shocked, msg.message_id, true, "command_shock");
      return;
    }

    if (!runtimeDecision.allowAiTrigger) {
      logger.info(
        {
          ignoredReason: runtimeDecision.ignoredReason,
          runtimeStatus: runtimeDecision.lateBindingStatus,
        },
        "runtime blocked edited-message AI trigger",
      );
      return;
    }

    if (!rawText) return;

    const userMessage = buildUserMessage({
      rawText,
      displayName,
      mediaRefs,
      replyTo,
      isRepliedToBot,
      isMentioned,
      urls,
    });
    const memoryCandidateHints = detectMemoryCandidateHints(rawText);

    groupRuntime.schedulePassiveTurn({
      label: `edited:${msg.message_id}`,
      execute: () =>
        handleAiTurn({
          ctx,
          replyToMessageId: msg.message_id,
          user,
          userMessage,
          systemHint: null,
          isMentioned,
          isRepliedToBot,
          mediaRefs,
          urls,
          sourceRefs: [`tg:${config.tgGroupId}:edited:${msg.message_id}:${msg.edit_date ?? 0}`],
          ...(from.username ? { senderUsername: from.username } : {}),
          ...(runtimeDecision.lateBindingStatus
            ? { runtimeStatus: runtimeDecision.lateBindingStatus }
            : {}),
          allowWebSearch: runtimeDecision.allowWebSearch,
          allowMediaTools: runtimeDecision.allowMediaTools,
          ...(memoryCandidateHints.length ? { memoryCandidateHints } : {}),
        }),
    });
  });
}
