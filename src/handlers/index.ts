import { Bot } from "grammy";
import type { Message } from "grammy/types";
import config from "../configs/env.js";
import {
  getOrCreateUser,
  cacheImage,
  setNightyTimestamp,
  setMorningGreeted,
  countUsersWithMemories,
  countCachedImages,
} from "../services/firestore.js";
import {
  classifyMessage,
  generateAiTurn,
  generateMorningGreeting,
  describeImage,
  generateLoveResponse,
} from "../libs/ai.js";
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
import type { MediaDescriptor } from "./extract-content.js";
import { replyAndTrack } from "./reply-and-track.js";
import { isDuplicateUpdate } from "./update-dedup.js";
import { formatForTelegramHtml } from "../libs/format-telegram.js";
import { getPersonaLabel } from "../libs/persona.js";

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
 * text with media context, reply-to context, and fetched URL summaries.
 */
function buildUserMessage(params: {
  rawText: string;
  displayName: string;
  imageDescriptions: string[];
  hasImage: boolean;
  stickerEmoji: string;
  replyTo: Message | undefined;
  isRepliedToBot: boolean;
  isMentioned?: boolean;
  urlContents: Map<string, string | null>;
  mediaDescriptors?: MediaDescriptor[];
}): string {
  const {
    rawText,
    displayName,
    imageDescriptions,
    hasImage,
    stickerEmoji,
    mediaDescriptors,
    replyTo,
    isRepliedToBot,
    isMentioned,
    urlContents,
  } = params;

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
      sections.push('    <quoted_media type="image" />');
    } else if (replyTo.sticker) {
      sections.push(
        `    <quoted_media type="sticker" emoji="${xmlEscape(replyTo.sticker.emoji ?? "")}" />`,
      );
    } else if (replyTo.video) {
      sections.push('    <quoted_media type="video" />');
    } else if (replyTo.animation) {
      sections.push('    <quoted_media type="animation" />');
    } else if (replyTo.video_note) {
      sections.push('    <quoted_media type="video_note" />');
    } else if (replyTo.document) {
      sections.push(
        `    <quoted_media type="document" filename="${xmlEscape(replyTo.document.file_name ?? "")}" />`,
      );
    } else if (replyTo.audio) {
      sections.push(
        `    <quoted_media type="audio" title="${xmlEscape(replyTo.audio.title || replyTo.audio.file_name || "")}" />`,
      );
    }
    sections.push("    <note>reply_to 内容是被回复消息，不是当前说话人的新消息</note>");
    sections.push("  </reply_to>");
  }

  if (rawText) {
    sections.push(`  <text>${xmlEscape(rawText)}</text>`);
  }

  if (
    imageDescriptions.length > 0 ||
    hasImage ||
    stickerEmoji ||
    (mediaDescriptors && mediaDescriptors.length > 0)
  ) {
    sections.push("  <media>");
    if (imageDescriptions.length > 0) {
      for (const desc of imageDescriptions) {
        sections.push(`    <image><description>${xmlEscape(desc)}</description></image>`);
      }
    } else if (hasImage) {
      sections.push('    <image status="present_but_undescribed" />');
    }
    if (stickerEmoji) {
      sections.push(`    <sticker><emoji>${xmlEscape(stickerEmoji)}</emoji></sticker>`);
    }
    if (mediaDescriptors?.length) {
      for (const md of mediaDescriptors) {
        const label = xmlEscape(md.label);
        if (md.description) {
          sections.push(
            `    <media_item label="${label}" thumbnail_only="true"><description>${xmlEscape(md.description)}</description></media_item>`,
          );
        } else {
          sections.push(`    <media_item label="${label}" thumbnail_only="true" />`);
        }
      }
    }
    sections.push("  </media>");
  }

  const urlLines: string[] = [];
  for (const [url, content] of urlContents) {
    if (content) {
      urlLines.push(
        `    <link url="${xmlEscape(url)}" status="success"><summary>${xmlEscape(content)}</summary></link>`,
      );
    } else {
      urlLines.push(
        `    <link url="${xmlEscape(url)}" status="failed"><error>无法获取内容</error></link>`,
      );
    }
  }
  if (urlLines.length > 0) {
    sections.push("  <links>");
    sections.push(...urlLines);
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
  stickerEmoji: string;
  hasImageContext: boolean;
  imageDescriptions: string[];
  mediaDescriptors?: MediaDescriptor[];
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
  if (params.stickerEmoji) parts.push(`[贴纸: ${params.stickerEmoji}]`);
  if (params.hasImageContext) {
    if (params.imageDescriptions.length > 0) {
      const desc = params.imageDescriptions.join(" | ");
      parts.push(`[图片: ${desc}]`);
    } else {
      parts.push("[图片]");
    }
  }
  if (params.mediaDescriptors?.length) {
    for (const md of params.mediaDescriptors) {
      const line = md.description ? `[${md.label}: ${md.description}]` : `[${md.label}]`;
      parts.push(line);
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
  senderUsername?: string;
}): Promise<void> {
  const {
    ctx,
    replyToMessageId,
    user,
    userMessage,
    systemHint,
    isMentioned,
    isRepliedToBot,
    senderUsername,
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
  const recentConversation = formatHistoryAsContext(history);
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

        return;
      }
    }

    if (result.action === "dismiss") {
      clearInterval(typingTimer);
      logger.info("handleAiTurn: model chose to dismiss (silence)");
      return;
    }

    // result.action === "send"
    clearInterval(typingTimer);
    touchBotActivity();

    // Push all messages to the conversation buffer
    for (const msg of result.messages) {
      pushMessage(config.tgGroupId, "bot", config.botUsername, msg.slice(0, MAX_BUFFER_TEXT));
    }

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
  } catch (err) {
    clearInterval(typingTimer);
    logger.error({ err }, "handleAiTurn: AI turn failed");
    await ctx.reply("呜喵...出了点问题喵...").catch((replyErr: unknown) => {
      logger.warn({ err: replyErr }, "handleAiTurn: fallback reply failed");
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
  const [memUsers, cachedImgs] = await Promise.all([
    countUsersWithMemories().catch((err: unknown) => {
      logger.warn({ err }, "countUsersWithMemories failed");
      return null;
    }),
    countCachedImages().catch((err: unknown) => {
      logger.warn({ err }, "countCachedImages failed");
      return null;
    }),
  ]);
  return [
    `📊 ${config.botPersonaName} 状态`,
    `运行时间: ${uptimeStr}`,
    `缓冲区消息数: ${historyLen}`,
    `记忆用户数: ${memUsers ?? "?"}`,
    `图片缓存数: ${cachedImgs ?? "?"}`,
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

    // 3. Extract content (text, URLs, images, sticker)
    const rawText = msg.text ?? msg.caption ?? "";
    const entities = [...(msg.entities ?? []), ...(msg.caption_entities ?? [])];

    const {
      urls,
      photoFileIds,
      imageDataUrls,
      imageDescriptions: cachedImageDescriptions,
      stickerEmoji,
      urlFetchPromise,
      mediaDescriptors: cachedMediaDescriptors,
      pendingMediaThumbnails,
    } = await extractContent(ctx, msg, { rawText, entities });

    const stickerDisplay = stickerEmoji;

    // Merge cached descriptions with fresh Gemini-described images.
    const imageDescriptions = [...cachedImageDescriptions];
    for (const imgUrl of imageDataUrls) {
      try {
        const desc = await describeImage(imgUrl, rawText);
        imageDescriptions.push(desc);
      } catch (err) {
        logger.warn({ err }, "failed to describe image");
      }
    }

    // Describe media thumbnails (video/animation/video_note/document/audio)
    const mediaDescriptors: MediaDescriptor[] = [...cachedMediaDescriptors];
    for (const pt of pendingMediaThumbnails) {
      try {
        const mediaType = pt.label.replace(/:.*$/, "");
        const desc = await describeImage(pt.dataUrl, rawText, mediaType);
        logger.info({ label: pt.label, desc: desc.slice(0, 80) }, "media thumbnail described");
        mediaDescriptors.push({ label: pt.label, description: desc });
        if (desc) {
          cacheImage(pt.fileId, { description: desc }).catch((err: unknown) => {
            logger.warn({ err, fileId: pt.fileId }, "media thumbnail cache failed");
          });
        }
      } catch (err) {
        logger.warn({ err, label: pt.label }, "failed to describe media thumbnail");
        mediaDescriptors.push({ label: pt.label, description: "" });
      }
    }

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
      stickerEmoji: stickerDisplay,
      hasImageContext: imageDataUrls.length > 0 || imageDescriptions.length > 0,
      imageDescriptions,
      mediaDescriptors,
      urls,
      ...(replyToInfo ? { replyToInfo } : {}),
    });
    if (bufferLine) {
      pushMessage(
        config.tgGroupId,
        from.id.toString(),
        displayName,
        bufferLine,
        from.username ?? undefined,
      );
    }

    // 4b. Cache fresh image descriptions so future turns (and proactive) see them
    for (let i = 0; i < photoFileIds.length; i++) {
      const fileId = photoFileIds[i];
      const descIdx = cachedImageDescriptions.length + i;
      const desc = imageDescriptions[descIdx];
      if (fileId && desc) {
        cacheImage(fileId, { description: desc }).catch((err: unknown) => {
          logger.warn({ err, fileId }, "image cache failed");
        });
      }
    }

    // 5. /help — public
    if (matchCommand(entities, rawText, "/help", botUsername)) {
      const helpText = `喵~ 我是${getPersonaLabel()}，一只傲娇的高中生猫娘 AI！🎀

我的用户名是 @${botUsername}，名字是 ${config.botPersonaName} 喵~

你可以这样跟我互动：
• @我 或 回复我 — 和我聊天
• /nighty — 跟我说晚安，8小时后我会发早安问候
• 发图片 — 我会看看是什么然后吐槽
• 让我「叫我XX」— 我会记住你的昵称
• 让我「记住XXX」— 我会记住关于你的事情

遇到编程/技术问题也可以认真问我，我会收起步猫娘模式帮你喵~`;
      await replyAndTrack(ctx, helpText, msg.message_id);
      return;
    }

    // 6. /love — public
    if (matchCommand(entities, rawText, "/love", botUsername)) {
      const rejection = await generateLoveResponse(user);
      await replyAndTrack(ctx, rejection, msg.message_id, true);
      return;
    }

    // 7. Admin-only: /status, /reset
    if (matchCommand(entities, rawText, "/status", botUsername)) {
      if (from.id.toString() !== config.tgAdminUid) {
        await replyAndTrack(ctx, "哼，这是主人才能用的命令喵~", msg.message_id);
        return;
      }
      const statusText = await buildStatusText();
      await replyAndTrack(ctx, statusText, msg.message_id);
      return;
    }

    if (matchCommand(entities, rawText, "/reset", botUsername)) {
      if (from.id.toString() !== config.tgAdminUid) {
        await replyAndTrack(ctx, "哼，这是主人才能用的命令喵~", msg.message_id);
        return;
      }
      clearHistory(config.tgGroupId);
      await replyAndTrack(ctx, pickResetReply(), msg.message_id);
      return;
    }

    // 8. Goodnight — /nighty command only
    if (matchCommand(entities, rawText, "/nighty", botUsername)) {
      await setNightyTimestamp(user.uid, Date.now());
      await replyAndTrack(ctx, `晚安 ${displayName}~ 🌙`, msg.message_id);
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
          await replyAndTrack(ctx, greeting, msg.message_id, true);
          touchBotActivity();
          pushMessage(
            config.tgGroupId,
            "bot",
            config.botUsername,
            greeting.slice(0, MAX_BUFFER_TEXT),
          );
        } catch (err) {
          logger.error({ err, uid: user.uid }, "failed to send morning greeting");
        }
      }
    }

    // 11. Await URL extractions — their summaries feed both the AI prompt
    //     and the buffer (as "system" entries).
    const urlContents = await urlFetchPromise;
    for (const [, content] of urlContents) {
      if (content) {
        if (content.startsWith("[Tweet ")) {
          pushMessage(config.tgGroupId, "system", "推文", content.slice(0, MAX_BUFFER_TEXT));
        } else {
          pushMessage(
            config.tgGroupId,
            "system",
            "链接",
            `[链接内容: ${content.slice(0, MAX_BUFFER_TEXT)}]`,
          );
        }
      }
    }

    // 12. If the bot wasn't pinged, we're done.
    if (!isMentioned && !isRepliedToBot) return;

    // Reset proactive cooldown immediately to prevent double-reply.
    touchBotActivity();

    // 13. Love confession → memory-based affection scoring
    if (LOVE_REGEX.test(rawText)) {
      const rejection = await generateLoveResponse(user);
      await replyAndTrack(ctx, rejection, msg.message_id, true);
      touchBotActivity();
      pushMessage(config.tgGroupId, "bot", config.botUsername, rejection.slice(0, MAX_BUFFER_TEXT));
      return;
    }

    // 14. Main AI path — tool-call architecture
    const userMessage = buildUserMessage({
      rawText,
      displayName,
      imageDescriptions,
      hasImage: imageDataUrls.length > 0,
      stickerEmoji: stickerDisplay,
      replyTo,
      isRepliedToBot,
      isMentioned,
      urlContents,
      mediaDescriptors,
    });

    await handleAiTurn({
      ctx,
      replyToMessageId: msg.message_id,
      user,
      userMessage,
      systemHint,
      isMentioned,
      isRepliedToBot,
      ...(from.username ? { senderUsername: from.username } : {}),
    });
  });

  // ---------------------------------------------------------------------------
  // Edited messages — treat as corrections: only re-reply when the user is
  // still @-mentioning or replying to the bot. Commands / goodnight / images
  // are intentionally skipped.
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
    if (!rawText) return;

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
    pushMessage(
      config.tgGroupId,
      from.id.toString(),
      displayName,
      editedBuffer.slice(0, MAX_BUFFER_TEXT),
      from.username ?? undefined,
    );

    // Use extractContent for consistent parsing of URLs and other entities
    // We don't process images/stickers during edits, so those arrays will just be empty.
    const { urlFetchPromise } = await extractContent(ctx, msg, { rawText, entities });
    const urlContents = await urlFetchPromise;

    for (const [, content] of urlContents) {
      if (content) {
        if (content.startsWith("[Tweet ")) {
          pushMessage(config.tgGroupId, "system", "推文", content.slice(0, MAX_BUFFER_TEXT));
        } else {
          pushMessage(
            config.tgGroupId,
            "system",
            "链接",
            `[链接内容: ${content.slice(0, MAX_BUFFER_TEXT)}]`,
          );
        }
      }
    }

    // Love confession in edit
    if (LOVE_REGEX.test(rawText)) {
      const rejection = await generateLoveResponse(user);
      await replyAndTrack(ctx, rejection, msg.message_id, true);
      touchBotActivity();
      pushMessage(config.tgGroupId, "bot", config.botUsername, rejection.slice(0, MAX_BUFFER_TEXT));
      return;
    }

    const userMessage = buildUserMessage({
      rawText,
      displayName,
      imageDescriptions: [],
      hasImage: false,
      stickerEmoji: "",
      mediaDescriptors: [],
      replyTo,
      isRepliedToBot,
      isMentioned,
      urlContents,
    });

    await handleAiTurn({
      ctx,
      replyToMessageId: msg.message_id,
      user,
      userMessage,
      systemHint: null,
      isMentioned,
      isRepliedToBot,
      ...(from.username ? { senderUsername: from.username } : {}),
    });
  });
}
