import { Bot } from "grammy";
import type { Message } from "grammy/types";
import config from "../configs/env.js";
import {
  getOrCreateUser,
  setNightyTimestamp,
  setMorningGreeted,
  countUsersWithMemories,
} from "../services/firestore.js";
import {
  classifyMessage,
  generateAiTurn,
  generateMorningGreeting,
  generateLoveResponse,
  generateShockResponse,
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
import { touchBotActivity } from "../libs/proactive.js";
import { generateDiaryForDate } from "../libs/diary.js";
import { todayDateStr } from "../libs/time.js";
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

function xmlEscape(text: string): string {
  return text
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
  if (params.urls.length > 0) {
    for (const url of params.urls) {
      const compact = url.length > 120 ? `${url.slice(0, 117)}...` : url;
      parts.push(`[链接: ${compact}]`);
    }
  }
  return parts.join(" ").slice(0, MAX_BUFFER_TEXT);
}

/**
 * Aggregate distinct recent participants from the in-memory buffer so the LLM
 * knows which uids are safe to reference from memory tools.
 */
function collectRecentMembers(groupId: string): {
  recentMembers: { uid: string; name: string; username?: string }[];
  allowedUids: Set<string>;
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
  return { recentMembers, allowedUids: new Set(map.keys()) };
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
}): Promise<void> {
  const { ctx, chatId, replyToMessageId, messages, stickerFileId } = params;

  if (messages.length === 0) {
    // No text messages — if there's a sticker, send it with a reply reference
    if (stickerFileId) {
      try {
        await ctx.api.sendSticker(chatId, stickerFileId, {
          reply_parameters: { message_id: replyToMessageId },
        });
      } catch (err) {
        logger.warn({ err, stickerFileId }, "sendAiMessages: sticker dispatch failed");
      }
    }
    return;
  }

  // First message replies to the user's message; subsequent messages are
  // sent standalone (like a human typing follow-up lines).
  for (let i = 0; i < messages.length; i++) {
    const text = messages[i]!;
    const formatted = formatForTelegramHtml(text);
    const sendParams: Record<string, unknown> = {};

    if (i === 0) {
      sendParams.reply_parameters = { message_id: replyToMessageId };
    }

    try {
      // Try HTML formatting first, fall back to plain text
      try {
        await ctx.api.sendMessage(chatId, formatted, {
          ...sendParams,
          parse_mode: "HTML",
        });
      } catch {
        await ctx.api.sendMessage(chatId, text, sendParams);
      }
    } catch (err) {
      logger.warn({ err, i }, "sendAiMessages: failed to send message");
    }

    // Stagger messages to mimic human typing rhythm, but not after the last one
    if (i < messages.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, MESSAGE_DELAY_MS));
    }
  }

  // Dispatch sticker after all text messages, if any
  if (stickerFileId) {
    try {
      await ctx.api.sendSticker(chatId, stickerFileId);
    } catch (err) {
      logger.warn({ err, stickerFileId }, "sendAiMessages: sticker dispatch failed");
    }
  }
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
  senderUsername?: string;
  runtimeStatus?: string;
  allowWebSearch?: boolean;
  allowMediaTools?: boolean;
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
    senderUsername,
    runtimeStatus,
    allowWebSearch,
    allowMediaTools,
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
  const { recentMembers, allowedUids } = collectRecentMembers(config.tgGroupId);
  // The current speaker's uid should always be allowed even if they haven't
  // accumulated buffer entries yet (e.g. first message after /reset).
  allowedUids.add(user.uid);
  if (!recentMembers.some((m) => m.uid === user.uid)) {
    recentMembers.push({
      uid: user.uid,
      name: user.nickname || "大哥哥",
      ...(senderUsername ? { username: senderUsername } : {}),
    });
  }

  const recentBotMessages = collectRecentBotMessages(config.tgGroupId, 5);

  const { tier, needsSearch } = await classifyMessage(userMessage);
  const isTriggered = isMentioned || isRepliedToBot;

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
      allowedUids,
      systemHint: currentHint,
      wasMentioned: isMentioned,
      wasRepliedTo: isRepliedToBot,
      recentBotMessages,
      mediaRefs,
      urls,
      resolveTelegramFileAsDataUrl,
      allowRichContentTools: isTriggered,
      ...(runtimeContext?.summary ? { conversationSummary: runtimeContext.summary } : {}),
      ...(runtimeStatus ? { runtimeStatus } : {}),
      ...(allowWebSearch != null ? { allowWebSearch } : {}),
      ...(allowMediaTools != null ? { allowMediaTools } : {}),
    });

    // Retry on dismiss when the user explicitly triggered the bot.
    // tech tier: no retry, just send the fallback.
    // simple/complex tier: 1 retry, then fallback.
    if (result.action === "dismiss" && isTriggered) {
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
          allowedUids,
          systemHint: currentHint,
          wasMentioned: isMentioned,
          wasRepliedTo: isRepliedToBot,
          recentBotMessages,
          mediaRefs,
          urls,
          resolveTelegramFileAsDataUrl,
          allowRichContentTools: isTriggered,
          ...(runtimeContext?.summary ? { conversationSummary: runtimeContext.summary } : {}),
          ...(runtimeStatus ? { runtimeStatus } : {}),
          ...(allowWebSearch != null ? { allowWebSearch } : {}),
          ...(allowMediaTools != null ? { allowMediaTools } : {}),
        });

        if (result.action === "send") break;
      }

      if (result.action === "dismiss") {
        clearInterval(typingTimer);
        logger.info("handleAiTurn: dismissed after retries, sending fallback");
        const fallbackEmoji = pickRandomStickerEmoji();

        if (result.rawText) {
          touchBotActivity();
          pushMessage(
            config.tgGroupId,
            "bot",
            config.botUsername,
            result.rawText.slice(0, MAX_BUFFER_TEXT),
          );
          await groupRuntime.recordBotMessages({ messages: [result.rawText] });
          await sendAiMessages({
            ctx,
            chatId,
            replyToMessageId,
            messages: [result.rawText],
            stickerFileId: getStickerFileId(fallbackEmoji),
          });
        } else {
          touchBotActivity();
          const stickerFileId = getStickerFileId(fallbackEmoji);
          pushMessage(
            config.tgGroupId,
            "bot",
            config.botUsername,
            `[贴纸 ${fallbackEmoji}: ${stickerFileId || "unknown"}]`,
          );
          await groupRuntime.recordBotMessages({
            messages: [],
            stickerFileId,
          });
          if (stickerFileId) {
            try {
              await ctx.api.sendSticker(chatId, stickerFileId, {
                reply_parameters: { message_id: replyToMessageId },
              });
            } catch (err) {
              logger.warn({ err, emoji: fallbackEmoji }, "handleAiTurn: fallback sticker failed");
            }
          }
        }

        await groupRuntime.recordTurn({
          kind: "passive",
          startedAt: Date.now() - (result.metrics?.latencyMs ?? 0),
          completedAt: Date.now(),
          model: result.metrics?.model ?? "unknown",
          tier,
          needsSearch,
          toolCalls: result.metrics?.toolCalls ?? [],
          action: result.rawText ? "send" : "dismiss",
          messages: result.rawText ? [result.rawText] : [],
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
      logger.info("handleAiTurn: model chose to dismiss (silence)");
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
    touchBotActivity();

    // Push all messages to the conversation buffer
    for (const msg of result.messages) {
      pushMessage(config.tgGroupId, "bot", config.botUsername, msg.slice(0, MAX_BUFFER_TEXT));
    }
    await groupRuntime.recordBotMessages({
      messages: result.messages,
      stickerFileId: result.stickerFileId,
    });

    // Sticker-only: push a sticker marker so the buffer stays coherent
    if (result.messages.length === 0 && result.stickerFileId) {
      const emoji = getStickerEmojiByFileId(result.stickerFileId) ?? "🐱";
      pushMessage(
        config.tgGroupId,
        "bot",
        config.botUsername,
        `[贴纸 ${emoji}: ${result.stickerFileId}]`,
      );
    }

    await sendAiMessages({
      ctx,
      chatId,
      replyToMessageId,
      messages: result.messages,
      stickerFileId: result.stickerFileId,
    });
    await groupRuntime.recordTurn({
      kind: "passive",
      startedAt: Date.now() - (result.metrics?.latencyMs ?? 0),
      completedAt: Date.now(),
      model: result.metrics?.model ?? "unknown",
      tier,
      needsSearch,
      toolCalls: result.metrics?.toolCalls ?? [],
      action: "send",
      messages: result.messages,
      stickerFileId: result.stickerFileId,
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
    await ctx.reply("呜喵...出了点问题喵...").catch((replyErr: unknown) => {
      logger.warn({ err: replyErr }, "handleAiTurn: fallback reply failed");
    });
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
    `Summary cursor: ${runtimeContext?.summaryCursorTs ?? 0}`,
    `Recent events: ${runtimeContext?.recentEvents.length ?? "?"}`,
    `记忆用户数: ${memUsers ?? "?"}`,
    `内存 RSS: ${rssMb} MB`,
  ].join("\n");
}

export function setupHandlers(bot: Bot<BotContext>, botInfo: BotInfo): void {
  const botUsername = botInfo.username || config.botUsername;
  const botId = botInfo.id;

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

      return;
    }

    // 1. Group filter
    if (ctx.chat.id.toString() !== config.tgGroupId) return;

    const from = msg.from;
    if (!from) return;

    // 2. Resolve user
    const user = await getOrCreateUser(from.id.toString(), from.first_name);
    const displayName = user.nickname || from.first_name || "大哥哥";

    // 3. Extract content references (text, URLs, media file_ids, sticker emoji)
    const rawText = msg.text ?? msg.caption ?? "";
    const entities = [...(msg.entities ?? []), ...(msg.caption_entities ?? [])];

    const { urls, mediaRefs } = await extractContent(ctx, msg, { rawText, entities });

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
    const isCommandMessage = entities.some((entity) => entity.type === "bot_command");
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
      );
    }

    // 5. /help — public
    if (matchCommand(entities, rawText, "/help", botUsername)) {
      const helpText = `喵~ 我是${getPersonaLabel()}，一只傲娇的高中生猫娘 AI！🎀

我的用户名是 @${botUsername}，名字是 ${config.botPersonaName} 喵~

你可以这样跟我互动：
• @我 或 回复我 — 和我聊天
• /shock [0-200|想说的话] — 电我一下，也可以带强度或顺便说话
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
      await replyAndTrack(ctx, pickResetReply(), msg.message_id, false, "command_reset");
      return;
    }

    // 8. Goodnight — /nighty command only
    if (matchCommand(entities, rawText, "/nighty", botUsername)) {
      await setNightyTimestamp(user.uid, Date.now());
      await replyAndTrack(ctx, `晚安 ${displayName}~ 🌙`, msg.message_id, false, "command_nighty");
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
          ...(from.username ? { senderUsername: from.username } : {}),
          ...(runtimeDecision.lateBindingStatus
            ? { runtimeStatus: runtimeDecision.lateBindingStatus }
            : {}),
          allowWebSearch: runtimeDecision.allowWebSearch,
          allowMediaTools: runtimeDecision.allowMediaTools,
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
    if (!isMentioned && !isRepliedToBot) return;

    const user = await getOrCreateUser(from.id.toString(), from.first_name);
    const displayName = user.nickname || from.first_name || "大哥哥";

    // Push the edited text into the buffer so the AI sees the correction
    let editedBuffer = rawText;
    if (replyTo && !isRepliedToBot) {
      const replyText = replyTo.text ?? replyTo.caption ?? "";
      const replyFirstName = replyTo.from?.first_name ?? "某人";
      const replyUsername = replyTo.from?.username;
      const replyName = replyUsername ? `${replyFirstName} (@${replyUsername})` : replyFirstName;
      if (replyText) {
        editedBuffer = `[回复 ${replyTo.from?.id?.toString() ?? ""} ${replyName}: "${replyText.slice(0, 100)}"] ${rawText}`;
      }
    }
    const { urls, mediaRefs } = await extractContent(ctx, msg, { rawText, entities });
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
      ts: Date.now(),
      triggered: isMentioned || isRepliedToBot,
    });
    if (editedBuffer && runtimeDecision.accepted) {
      pushMessage(
        config.tgGroupId,
        from.id.toString(),
        displayName,
        editedBuffer.slice(0, MAX_BUFFER_TEXT),
        from.username ?? undefined,
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
          ...(from.username ? { senderUsername: from.username } : {}),
          ...(runtimeDecision.lateBindingStatus
            ? { runtimeStatus: runtimeDecision.lateBindingStatus }
            : {}),
          allowWebSearch: runtimeDecision.allowWebSearch,
          allowMediaTools: runtimeDecision.allowMediaTools,
        }),
    });
  });
}
