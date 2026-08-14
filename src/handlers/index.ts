import { Bot, InputFile } from "grammy";
import type { Message } from "grammy/types";
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
} from "../services/persistence.js";
import { deleteStoredMessage, upsertGroupMessage } from "../services/local-wordcloud-store.js";
import {
  classifyMessage,
  generateAiTurn,
  generateMorningGreeting,
  generateLoveResponse,
  generateShockResponse,
  generateStrokeResponse,
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
import { downloadTelegramFileAsDataUrl } from "../libs/telegram-image.js";
import { groupRuntime } from "../libs/group-runtime.js";
import type { DiaryObservationDraft } from "../libs/diary-observations.js";
import { decideLocalAiRoute } from "./ai-routing.js";
import { getDismissRetryCount } from "./ai-dispatch.js";
import {
  formatRollResult,
  parseRollCommand,
  parseShockCommand,
  parseStrokeCommand,
  rollDice,
} from "./command-parsers.js";
import { buildBufferLine, buildUserMessage, detectTrigger, xmlEscape } from "./message-builders.js";

// Delay between consecutive bot messages (ms) — mimics human typing rhythm.
const MESSAGE_DELAY_MS = config.botMessageDelayMs;

const RESET_REPLIES = [
  "刚才断片了喵",
  "前情提要被我吃掉了喵",
  "脑袋重启完成喵 刚才聊到哪了",
  "咳 刚才那段我不记得了喵",
] as const;

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

async function persistWordcloudMessage(
  params: {
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
  },
  upsert: typeof upsertGroupMessage = upsertGroupMessage,
): Promise<void> {
  await upsert({
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

function maybeAttachRecentMediaRefs(
  params: {
    groupId: string;
    rawText: string;
    mediaRefs: MediaRef[];
  },
  loadHistory: typeof getHistory = getHistory,
): MediaRef[] {
  if (params.mediaRefs.length > 0) return params.mediaRefs;
  if (!RECENT_MEDIA_FOLLOWUP_REGEX.test(params.rawText)) return params.mediaRefs;

  const history = loadHistory(params.groupId);
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
  isAnimated?: boolean;
  isVideo?: boolean;
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
    ...(ref.isAnimated ? { isAnimated: true } : {}),
    ...(ref.isVideo ? { isVideo: true } : {}),
    ...(ref.emoji ? { emoji: ref.emoji } : {}),
    ...(ref.filename ? { filename: ref.filename } : {}),
    ...(ref.title ? { title: ref.title } : {}),
  };
}

export interface RecentMediaDependencies {
  loadRecentRuntimeEvents: typeof loadRecentRuntimeEvents;
  getHistory: typeof getHistory;
}

const defaultRecentMediaDependencies: RecentMediaDependencies = {
  loadRecentRuntimeEvents,
  getHistory,
};

export async function attachRecentMediaRefs(
  params: {
    groupId: string;
    rawText: string;
    mediaRefs: MediaRef[];
  },
  dependencies: RecentMediaDependencies = defaultRecentMediaDependencies,
): Promise<MediaRef[]> {
  if (params.mediaRefs.length > 0) return params.mediaRefs;
  if (!RECENT_MEDIA_FOLLOWUP_REGEX.test(params.rawText)) return params.mediaRefs;

  try {
    const recentEvents = await dependencies.loadRecentRuntimeEvents({
      limit: 20,
      newestFirst: true,
    });
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

  return maybeAttachRecentMediaRefs(params, dependencies.getHistory);
}

/**
 * Aggregate distinct recent participants from the in-memory buffer for prompt context.
 */
function collectRecentMembers(
  groupId: string,
  loadHistory: typeof getHistory = getHistory,
): {
  recentMembers: { uid: string; name: string; username?: string }[];
} {
  const history = loadHistory(groupId);
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
function collectRecentBotMessages(
  groupId: string,
  count: number,
  loadHistory: typeof getHistory = getHistory,
): string[] {
  const history = loadHistory(groupId);
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
export interface AiTurnDependencies {
  classifyMessage: typeof classifyMessage;
  generateAiTurn: typeof generateAiTurn;
  rescueSendMessagesFromDraft: typeof rescueSendMessagesFromDraft;
  getHistory: typeof getHistory;
  formatHistoryAsContext: typeof formatHistoryAsContext;
  pushMessage: typeof pushMessage;
  touchBotActivity: typeof touchBotActivity;
  getStickerEmojiByFileId: typeof getStickerEmojiByFileId;
  getStickerFileId: typeof getStickerFileId;
  pickRandomStickerEmoji: typeof pickRandomStickerEmoji;
  downloadTelegramFileAsDataUrl: typeof downloadTelegramFileAsDataUrl;
  formatForTelegramHtml: typeof formatForTelegramHtml;
  replyAndTrack: typeof replyAndTrack;
  runtime: Pick<typeof groupRuntime, "loadContext" | "recordBotMessages" | "recordTurn">;
  delay: (ms: number) => Promise<void>;
}

const defaultAiTurnDependencies: AiTurnDependencies = {
  classifyMessage,
  generateAiTurn,
  rescueSendMessagesFromDraft,
  getHistory,
  formatHistoryAsContext,
  pushMessage,
  touchBotActivity,
  getStickerEmojiByFileId,
  getStickerFileId,
  pickRandomStickerEmoji,
  downloadTelegramFileAsDataUrl,
  formatForTelegramHtml,
  replyAndTrack,
  runtime: groupRuntime,
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

async function sendAiMessages(
  params: {
    ctx: BotContext;
    chatId: number;
    replyToMessageId: number;
    messages: string[];
    stickerFileId: string | null;
  },
  dependencies: AiTurnDependencies,
): Promise<{ messages: string[]; stickerFileId: string | null }> {
  const { ctx, chatId, replyToMessageId, messages, stickerFileId } = params;
  const sentMessages: string[] = [];
  let sentStickerFileId: string | null = null;

  const trackText = async (text: string): Promise<void> => {
    dependencies.touchBotActivity();
    dependencies.pushMessage(
      config.tgGroupId,
      "bot",
      config.botUsername,
      text.slice(0, MAX_BUFFER_TEXT),
    );
    await dependencies.runtime.recordBotMessages({ messages: [text] });
  };

  const trackSticker = async (fileId: string): Promise<void> => {
    dependencies.touchBotActivity();
    const emoji = dependencies.getStickerEmojiByFileId(fileId) ?? "🐱";
    dependencies.pushMessage(
      config.tgGroupId,
      "bot",
      config.botUsername,
      `[贴纸 ${emoji}: ${fileId}]`,
    );
    await dependencies.runtime.recordBotMessages({ messages: [], stickerFileId: fileId });
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
    const formatted = dependencies.formatForTelegramHtml(text);

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
      await dependencies.delay(MESSAGE_DELAY_MS);
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
export function createHandleAiTurn(dependencies: AiTurnDependencies = defaultAiTurnDependencies) {
  return async function handleAiTurn(params: {
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
    // Model and tool calls can take several seconds, so refresh the typing action periodically.
    const typingTimer = setInterval(() => {
      ctx.api.sendChatAction(chatId, "typing").catch(() => void 0);
    }, 4500);
    await ctx.api.sendChatAction(chatId, "typing").catch(() => void 0);

    const history = dependencies.getHistory(config.tgGroupId);
    const runtimeContext = await dependencies.runtime.loadContext().catch((err: unknown) => {
      logger.warn({ err }, "load runtime context failed, falling back to buffer");
      return null;
    });
    const recentConversation =
      runtimeContext?.recentEventsText || dependencies.formatHistoryAsContext(history);
    const { recentMembers } = collectRecentMembers(config.tgGroupId, dependencies.getHistory);
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

    const recentBotMessages = collectRecentBotMessages(
      config.tgGroupId,
      5,
      dependencies.getHistory,
    );

    const localRoute = decideLocalAiRoute({
      rawText: ctx.msg?.text ?? ctx.msg?.caption ?? "",
      isMentioned,
      isRepliedToBot,
      urls: urls ?? [],
      mediaRefs: (mediaRefs ?? []) as MediaRef[],
    });
    const { tier, needsSearch } = localRoute ?? (await dependencies.classifyMessage(userMessage));
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
          return await dependencies.downloadTelegramFileAsDataUrl(file.file_path);
        } catch (err) {
          logger.warn({ err, fileId }, "resolveTelegramFileAsDataUrl failed");
          return null;
        }
      };
      // Build the base systemHint, appending the mandatory-reply hint for
      // retries when the user explicitly triggered the bot.
      let currentHint = systemHint;
      let result = await dependencies.generateAiTurn({
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
        const maxRetries = getDismissRetryCount({
          action: result.action,
          tier,
          triggered: isTriggered,
          ...(result.dismissReason ? { dismissReason: result.dismissReason } : {}),
        });

        while (retries < maxRetries) {
          retries++;
          logger.info({ retries, tier }, "handleAiTurn: dismissing, retrying");

          await ctx.api.sendChatAction(chatId, "typing").catch(() => void 0);

          currentHint = currentHint
            ? `${currentHint}\n${MANDATORY_REPLY_HINT}`
            : MANDATORY_REPLY_HINT;

          result = await dependencies.generateAiTurn({
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
          const fallbackEmoji = dependencies.pickRandomStickerEmoji();
          let finalFallbackToolCalls = result.metrics?.toolCalls ?? [];
          let sentFallback: { messages: string[]; stickerFileId: string | null } = {
            messages: [],
            stickerFileId: null,
          };

          if (dismissFallbackMessages?.length) {
            sentFallback = await sendAiMessages(
              {
                ctx,
                chatId,
                replyToMessageId,
                messages: dismissFallbackMessages,
                stickerFileId: null,
              },
              dependencies,
            );
          } else if (result.rawText) {
            const rescued = await dependencies.rescueSendMessagesFromDraft({
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
            sentFallback = await sendAiMessages(
              {
                ctx,
                chatId,
                replyToMessageId,
                messages: fallbackMessages,
                stickerFileId: rescued?.messages.length
                  ? null
                  : dependencies.getStickerFileId(fallbackEmoji),
              },
              dependencies,
            );
          } else {
            const stickerFileId = dependencies.getStickerFileId(fallbackEmoji);
            sentFallback = await sendAiMessages(
              {
                ctx,
                chatId,
                replyToMessageId,
                messages: [],
                stickerFileId,
              },
              dependencies,
            );
          }

          const sentFallbackOutput =
            sentFallback.messages.length > 0 || sentFallback.stickerFileId !== null;

          await dependencies.runtime.recordTurn({
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
        await dependencies.runtime.recordTurn({
          kind: "passive",
          startedAt: Date.now() - (result.metrics?.latencyMs ?? 0),
          completedAt: Date.now(),
          model: result.metrics?.model ?? "unknown",
          tier,
          needsSearch,
          toolCalls: result.metrics?.toolCalls ?? [],
          action: "dismiss",
          messages: [],
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

      // result.action === "send"
      clearInterval(typingTimer);

      const sent = await sendAiMessages(
        {
          ctx,
          chatId,
          replyToMessageId,
          messages: result.messages,
          stickerFileId: result.stickerFileId,
        },
        dependencies,
      );
      const sentOutput = sent.messages.length > 0 || sent.stickerFileId !== null;
      await dependencies.runtime.recordTurn({
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
      await dependencies.replyAndTrack(ctx, "呜喵...出了点问题喵...", replyToMessageId);
      await dependencies.runtime.recordTurn({
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
  };
}

const handleAiTurn = createHandleAiTurn();

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export interface StatusDependencies {
  getHistory: typeof getHistory;
  countUsersWithMemories: typeof countUsersWithMemories;
  getRuntimeStatus: typeof groupRuntime.getStatusSnapshot;
  loadRuntimeContext: typeof groupRuntime.loadContext;
  getProactiveHealthSnapshot: typeof getProactiveHealthSnapshot;
  uptime: () => number;
  memoryUsage: () => NodeJS.MemoryUsage;
}

const defaultStatusDependencies: StatusDependencies = {
  getHistory,
  countUsersWithMemories,
  getRuntimeStatus: () => groupRuntime.getStatusSnapshot(),
  loadRuntimeContext: () => groupRuntime.loadContext(),
  getProactiveHealthSnapshot,
  uptime: () => process.uptime(),
  memoryUsage: () => process.memoryUsage(),
};

export function createBuildStatusText(
  dependencies: StatusDependencies = defaultStatusDependencies,
) {
  return async function buildStatusText(): Promise<string> {
    const historyLen = dependencies.getHistory(config.tgGroupId).length;
    const uptime = dependencies.uptime();
    const mins = Math.floor(uptime / 60);
    const hours = Math.floor(mins / 60);
    const uptimeStr = hours > 0 ? `${hours}h${mins % 60}m` : `${mins}m`;
    const mem = dependencies.memoryUsage();
    const rssMb = Math.round(mem.rss / 1024 / 1024);
    const memUsers = await dependencies.countUsersWithMemories().catch((err: unknown) => {
      logger.warn({ err }, "countUsersWithMemories failed");
      return null;
    });
    const runtimeStatus = dependencies.getRuntimeStatus();
    const proactiveHealth = dependencies.getProactiveHealthSnapshot();
    const formatHealthTime = (timestamp: number | null) =>
      timestamp == null ? "never" : formatTimestamp(timestamp, "MM-DD HH:mm:ss");
    const proactiveError = proactiveHealth.lastError?.replace(/\s+/g, " ").slice(0, 200) ?? "none";
    const runtimeContext = await dependencies.loadRuntimeContext().catch((err: unknown) => {
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
  };
}

const buildStatusText = createBuildStatusText();

export interface HandlerDependencies {
  isDuplicateUpdate: typeof isDuplicateUpdate;
  getOrCreateUser: typeof getOrCreateUser;
  extractContent: typeof extractContent;
  replyAndTrack: typeof replyAndTrack;
  getHistory: typeof getHistory;
  formatHistoryAsContext: typeof formatHistoryAsContext;
  pushMessage: typeof pushMessage;
  generateLoveResponse: typeof generateLoveResponse;
  generateMorningGreeting: typeof generateMorningGreeting;
  generateShockResponse: typeof generateShockResponse;
  generateStrokeResponse: typeof generateStrokeResponse;
  setMorningGreeted: typeof setMorningGreeted;
  setNightyTimestamp: typeof setNightyTimestamp;
  buildStatusText: typeof buildStatusText;
  generateDiaryForDate: typeof generateDiaryForDate;
  generateWordcloudPreviewForDateWithRetry: typeof generateWordcloudPreviewForDateWithRetry;
  listDiaryObservationsByDate: typeof listDiaryObservationsByDate;
  retractDiaryObservation: typeof retractDiaryObservation;
  updateDiaryObservation: typeof updateDiaryObservation;
  getDiaryObservation: typeof getDiaryObservation;
  resetRuntimeConversationSummary: typeof resetRuntimeConversationSummary;
  upsertGroupMessage: typeof upsertGroupMessage;
  deleteStoredMessage: typeof deleteStoredMessage;
  recentMedia: RecentMediaDependencies;
  runtime: Pick<
    typeof groupRuntime,
    | "beginIncomingActivity"
    | "ingestUserMessage"
    | "loadContext"
    | "schedulePassiveTurn"
    | "scheduleCommandTurn"
  >;
  handleAiTurn: typeof handleAiTurn;
}

const defaultHandlerDependencies: HandlerDependencies = {
  isDuplicateUpdate,
  getOrCreateUser,
  extractContent,
  replyAndTrack,
  getHistory,
  formatHistoryAsContext,
  pushMessage,
  generateLoveResponse,
  generateMorningGreeting,
  generateShockResponse,
  generateStrokeResponse,
  setMorningGreeted,
  setNightyTimestamp,
  buildStatusText,
  generateDiaryForDate,
  generateWordcloudPreviewForDateWithRetry,
  listDiaryObservationsByDate,
  retractDiaryObservation,
  updateDiaryObservation,
  getDiaryObservation,
  resetRuntimeConversationSummary,
  upsertGroupMessage,
  deleteStoredMessage,
  recentMedia: defaultRecentMediaDependencies,
  runtime: groupRuntime,
  handleAiTurn,
};

export function setupHandlers(
  bot: Bot<BotContext>,
  botInfo: BotInfo,
  overrides: Partial<HandlerDependencies> = {},
): void {
  const dependencies = { ...defaultHandlerDependencies, ...overrides };
  const botUsername = botInfo.username || config.botUsername;
  const botId = botInfo.id;

  const loadReactionContext = async (ctx: BotContext, user: User, senderUsername?: string) => {
    const history = dependencies.getHistory(config.tgGroupId);
    const runtimeContext = await dependencies.runtime.loadContext().catch((err: unknown) => {
      logger.warn({ err }, "reaction: load runtime context failed, falling back to buffer");
      return null;
    });
    const recentConversation =
      runtimeContext?.recentEventsText || dependencies.formatHistoryAsContext(history);
    const { recentMembers } = collectRecentMembers(config.tgGroupId, dependencies.getHistory);
    if (!recentMembers.some((member) => member.uid === user.uid)) {
      recentMembers.push({
        uid: user.uid,
        name: user.nickname || "大哥哥",
        ...(senderUsername ? { username: senderUsername } : {}),
      });
    }
    const replyTo = ctx.msg?.reply_to_message;
    if (replyTo?.from && replyTo.from.id !== ctx.me.id) {
      const replyUid = replyTo.from.id.toString();
      if (!recentMembers.some((member) => member.uid === replyUid)) {
        recentMembers.push({
          uid: replyUid,
          name: replyTo.from.first_name ?? "某人",
          ...(replyTo.from.username ? { username: replyTo.from.username } : {}),
        });
      }
    }
    return {
      recentConversation,
      recentMembers,
      ...(runtimeContext?.summary ? { conversationSummary: runtimeContext.summary } : {}),
    };
  };

  const scheduleReactionResponse = (params: {
    reaction: "shock" | "stroke";
    ctx: BotContext;
    messageId: number;
    user: User;
    args: { intensity?: number; extraText?: string };
    senderUsername?: string;
  }) => {
    const { reaction, ctx, messageId, user, args, senderUsername } = params;
    dependencies.runtime.scheduleCommandTurn({
      label: `${reaction}:${messageId}`,
      execute: async () => {
        try {
          const context = await loadReactionContext(ctx, user, senderUsername);
          const response =
            reaction === "shock"
              ? await dependencies.generateShockResponse(user, { ...args, ...context })
              : await dependencies.generateStrokeResponse(user, { ...args, ...context });
          await dependencies.replyAndTrack(
            ctx,
            response,
            messageId,
            true,
            reaction === "shock" ? "command_shock" : "command_stroke",
          );
        } catch (err) {
          logger.error({ err, reaction, messageId }, "reaction command failed");
          await dependencies.replyAndTrack(ctx, "呜喵...刚才没反应过来喵...", messageId);
        }
      },
    });
  };

  bot.use(async (ctx, next) => {
    const groupUpdate = ctx.update.message ?? ctx.update.edited_message;
    if (groupUpdate?.chat.id.toString() !== config.tgGroupId) {
      await next();
      return;
    }
    const release = dependencies.runtime.beginIncomingActivity();
    try {
      await next();
    } finally {
      release();
    }
  });

  bot.on("message", async (ctx) => {
    if (dependencies.isDuplicateUpdate(ctx.update.update_id)) return;
    const msg = ctx.message;
    if (!msg) return;

    // 0. Private chat — admin commands only
    if (ctx.chat?.type === "private") {
      if (!msg.from || msg.from.id.toString() !== config.tgAdminUid) return;
      const privText = msg.text ?? msg.caption ?? "";
      const privEntities = [...(msg.entities ?? []), ...(msg.caption_entities ?? [])];

      if (matchCommand(privEntities, privText, "/status", botUsername)) {
        const statusText = await dependencies.buildStatusText();
        await ctx.reply(statusText).catch((err: unknown) => {
          logger.warn({ err }, "private /status reply failed");
        });
        return;
      }

      if (matchCommand(privEntities, privText, "/reset", botUsername)) {
        clearHistory(config.tgGroupId);
        await dependencies.resetRuntimeConversationSummary().catch((err: unknown) => {
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
          const diary = await dependencies.generateDiaryForDate(todayDateStr());
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
          const preview = await dependencies.generateWordcloudPreviewForDateWithRetry(date);
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
          const observations = await dependencies.listDiaryObservationsByDate(date);
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
          const result = await dependencies.retractDiaryObservation(
            targetId,
            reasonParts.join(" "),
          );
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
          const result = await dependencies.updateDiaryObservation(
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
          const item = await dependencies.getDiaryObservation(targetId);
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
          const diary = await dependencies.generateDiaryForDate(date);
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
      await dependencies.replyAndTrack(
        ctx,
        `晚安安 ${replyName}~ 🌙`,
        msg.message_id,
        false,
        "command_nighty",
      );
      void dependencies
        .getOrCreateUser(from.id.toString(), from.first_name)
        .then((user) => dependencies.setNightyTimestamp(user.uid, Date.now()))
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

      await dependencies.replyAndTrack(ctx, resultText, msg.message_id, false, "command_roll");

      const releaseRollActivity = dependencies.runtime.beginIncomingActivity();
      void (async () => {
        const user = await dependencies.getOrCreateUser(from.id.toString(), from.first_name);
        const displayName = user.nickname || from.first_name || "大哥哥";
        const replyTo = msg.reply_to_message;
        const { isMentioned, isRepliedToBot } = detectTrigger({
          rawText,
          entities,
          replyTo,
          botUsername,
          configuredBotUsername: config.botUsername,
          botId,
        });
        const extracted = await dependencies.extractContent(ctx, msg, { rawText, entities });
        const urls = extracted.urls;
        const mediaRefs = await attachRecentMediaRefs(
          {
            groupId: config.tgGroupId,
            rawText,
            mediaRefs: extracted.mediaRefs,
          },
          dependencies.recentMedia,
        );
        const runtimeDecision = await dependencies.runtime.ingestUserMessage({
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

        dependencies.runtime.scheduleCommandTurn({
          label: `roll:${msg.message_id}`,
          execute: () =>
            dependencies.handleAiTurn({
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
    const user = await dependencies.getOrCreateUser(from.id.toString(), from.first_name);
    const displayName = user.nickname || from.first_name || "大哥哥";

    // 3. Extract content references (text, URLs, media file_ids, sticker emoji)
    const extracted = await dependencies.extractContent(ctx, msg, { rawText, entities });
    const urls = extracted.urls;
    const mediaRefs = await attachRecentMediaRefs(
      {
        groupId: config.tgGroupId,
        rawText,
        mediaRefs: extracted.mediaRefs,
      },
      dependencies.recentMedia,
    );

    // 3b. Trigger detection (@mention or reply-to-bot) — needed for buffer and later logic
    const replyTo = msg.reply_to_message;
    const { isMentioned, isRepliedToBot } = detectTrigger({
      rawText,
      entities,
      replyTo,
      botUsername,
      configuredBotUsername: config.botUsername,
      botId,
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
      await persistWordcloudMessage(
        {
          chatId: config.tgGroupId,
          messageId: msg.message_id,
          userId: from.id.toString(),
          displayName,
          ...(from.username ? { username: from.username } : {}),
          isBot: false,
          isForwarded: isForwardedMessage(msg),
          text: rawText,
          createdAt: (msg.date ?? Math.floor(Date.now() / 1000)) * 1000,
        },
        dependencies.upsertGroupMessage,
      ).catch((err: unknown) => {
        logger.warn({ err, messageId: msg.message_id }, "wordcloud: persist group message failed");
      });
    }
    const runtimeDecision = await dependencies.runtime.ingestUserMessage({
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
      dependencies.pushMessage(
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
      await dependencies.replyAndTrack(ctx, helpText, msg.message_id, false, "command_help");
      return;
    }

    // 6. /love — public
    if (matchCommand(entities, rawText, "/love", botUsername)) {
      const rejection = await dependencies.generateLoveResponse(user);
      await dependencies.replyAndTrack(ctx, rejection, msg.message_id, true, "command_love");
      return;
    }

    const shockArgs = parseShockCommand(entities, rawText, botUsername);
    if (shockArgs) {
      scheduleReactionResponse({
        reaction: "shock",
        ctx,
        messageId: msg.message_id,
        user,
        args: shockArgs,
        ...(from.username ? { senderUsername: from.username } : {}),
      });
      return;
    }

    const strokeArgs = parseStrokeCommand(entities, rawText, botUsername);
    if (strokeArgs) {
      scheduleReactionResponse({
        reaction: "stroke",
        ctx,
        messageId: msg.message_id,
        user,
        args: strokeArgs,
        ...(from.username ? { senderUsername: from.username } : {}),
      });
      return;
    }

    // 7. Admin-only: /status, /reset
    if (matchCommand(entities, rawText, "/status", botUsername)) {
      if (from.id.toString() !== config.tgAdminUid) {
        await dependencies.replyAndTrack(ctx, "哼，这是主人才能用的命令喵~", msg.message_id);
        return;
      }
      const statusText = await dependencies.buildStatusText();
      await dependencies.replyAndTrack(ctx, statusText, msg.message_id, false, "command_status");
      return;
    }

    if (matchCommand(entities, rawText, "/reset", botUsername)) {
      if (from.id.toString() !== config.tgAdminUid) {
        await dependencies.replyAndTrack(ctx, "哼，这是主人才能用的命令喵~", msg.message_id);
        return;
      }
      clearHistory(config.tgGroupId);
      await dependencies.resetRuntimeConversationSummary().catch((err: unknown) => {
        logger.warn({ err }, "group /reset runtime summary clear failed");
      });
      await dependencies.replyAndTrack(
        ctx,
        pickResetReply(),
        msg.message_id,
        false,
        "command_reset",
      );
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
        await dependencies.setMorningGreeted(user.uid, now);
        systemHint =
          "<system_hint><event>user_just_woke_up</event><rule>回答开头先说一句傲娇早安，再回答问题</rule></system_hint>";
      } else {
        // Standalone path: send greeting, then fall through to return.
        try {
          const greeting = await dependencies.generateMorningGreeting(user);
          await dependencies.setMorningGreeted(user.uid, now);
          await dependencies.replyAndTrack(ctx, greeting, msg.message_id, true, "morning_greeting");
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
      const rejection = await dependencies.generateLoveResponse(user);
      await dependencies.replyAndTrack(ctx, rejection, msg.message_id, true, "command_love");
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

    dependencies.runtime.schedulePassiveTurn({
      label: `message:${msg.message_id}`,
      execute: () =>
        dependencies.handleAiTurn({
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
    if (dependencies.isDuplicateUpdate(ctx.update.update_id)) return;
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
      await dependencies
        .deleteStoredMessage(config.tgGroupId, msg.message_id)
        .catch((err: unknown) => {
          logger.warn(
            { err, messageId: msg.message_id },
            "wordcloud: delete edited command message failed",
          );
        });
    } else if (!from.is_bot && !isCommandMessage) {
      const user = await dependencies.getOrCreateUser(from.id.toString(), from.first_name);
      const displayName = user.nickname || from.first_name || "大哥哥";
      await persistWordcloudMessage(
        {
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
        },
        dependencies.upsertGroupMessage,
      ).catch((err: unknown) => {
        logger.warn(
          { err, messageId: msg.message_id },
          "wordcloud: persist edited group message failed",
        );
      });
    }

    const replyTo = msg.reply_to_message;
    const { isMentioned, isRepliedToBot } = detectTrigger({
      rawText,
      entities,
      replyTo,
      botUsername,
      configuredBotUsername: config.botUsername,
      botId,
    });

    const strokeArgs = parseStrokeCommand(entities, rawText, botUsername);
    const shockArgs = parseShockCommand(entities, rawText, botUsername);
    const isReactionCommand = strokeArgs !== null || shockArgs !== null;

    if (!isMentioned && !isRepliedToBot && !isReactionCommand) return;

    const user = await dependencies.getOrCreateUser(from.id.toString(), from.first_name);
    const displayName = user.nickname || from.first_name || "大哥哥";

    const extracted = await dependencies.extractContent(ctx, msg, { rawText, entities });
    const urls = extracted.urls;
    const mediaRefs = await attachRecentMediaRefs(
      {
        groupId: config.tgGroupId,
        rawText,
        mediaRefs: extracted.mediaRefs,
      },
      dependencies.recentMedia,
    );
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
    const runtimeDecision = await dependencies.runtime.ingestUserMessage({
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
      triggered: isMentioned || isRepliedToBot || isReactionCommand,
    });
    if (runtimeDecision.ignoredReason === "non_content_edit") return;

    if (editedBuffer && runtimeDecision.accepted) {
      dependencies.pushMessage(
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
      const rejection = await dependencies.generateLoveResponse(user);
      await dependencies.replyAndTrack(ctx, rejection, msg.message_id, true, "command_love");
      return;
    }

    if (shockArgs) {
      scheduleReactionResponse({
        reaction: "shock",
        ctx,
        messageId: msg.message_id,
        user,
        args: shockArgs,
        ...(from.username ? { senderUsername: from.username } : {}),
      });
      return;
    }

    if (strokeArgs) {
      scheduleReactionResponse({
        reaction: "stroke",
        ctx,
        messageId: msg.message_id,
        user,
        args: strokeArgs,
        ...(from.username ? { senderUsername: from.username } : {}),
      });
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

    dependencies.runtime.schedulePassiveTurn({
      label: `edited:${msg.message_id}`,
      execute: () =>
        dependencies.handleAiTurn({
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
