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
  generateResponse,
  generateMorningGreeting,
  describeImage,
  generateLoveRejection,
} from "../libs/ai.js";
import {
  pushMessage,
  getHistory,
  formatHistoryAsContext,
  clearHistory,
} from "../libs/conversation-buffer.js";
import { MIAOHAHA_STICKERS } from "../libs/stickers.js";
import { touchBotActivity } from "../libs/proactive.js";
import { logger } from "../libs/logger.js";
import type { User } from "../global.d.ts";
import type { BotContext, BotInfo } from "./context.js";
import { MAX_BUFFER_TEXT, LOVE_REGEX, NIGHTY_REGEX, EIGHT_HOURS_MS } from "./constants.js";
import { matchCommand } from "./match-command.js";
import { extractContent } from "./extract-content.js";
import { replyAndTrack } from "./reply-and-track.js";
import { isDuplicateUpdate } from "./update-dedup.js";

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
  urlContents: Map<string, string | null>;
}): string {
  const {
    rawText,
    displayName,
    imageDescriptions,
    hasImage,
    stickerEmoji,
    replyTo,
    isRepliedToBot,
    urlContents,
  } = params;

  let msg = rawText;

  if (imageDescriptions.length > 0) {
    // Cache-hit path: feed the stored description so the model has context
    // without re-doing vision.
    const desc = imageDescriptions.map((d) => `[图片: ${d}]`).join("\n");
    msg = msg ? `${desc}\n${displayName}说: ${msg}` : desc;
  } else if (hasImage) {
    // Fresh image: the bytes are attached via `imageInputs`, so we just hint here.
    msg = msg ? `[图片见上]\n${displayName}说: ${msg}` : "[图片见上]";
  }

  if (stickerEmoji) {
    msg = (msg ? `${msg}\n` : "") + `[贴纸: ${stickerEmoji}]`;
  }

  if (replyTo && !isRepliedToBot) {
    const repliedText = replyTo.text ?? replyTo.caption ?? "";
    const repliedName = replyTo.from?.first_name ?? "某人";
    if (repliedText) {
      msg = `[回复 ${repliedName}: "${repliedText}"]\n${msg}`;
    }
  }

  // Append (not prepend) URL contents so the user's own words remain the headline.
  const urlLines: string[] = [];
  for (const [url, content] of urlContents) {
    urlLines.push(content ? `[链接 ${url}: ${content}]` : `[链接 ${url}: 无法获取内容]`);
  }
  if (urlLines.length > 0) {
    msg = `${msg}\n${urlLines.join("\n")}`;
  }

  return msg;
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
  urls: string[];
}): string {
  const parts: string[] = [];
  if (params.rawText) parts.push(params.rawText);
  if (params.stickerEmoji) parts.push(`[贴纸: ${params.stickerEmoji}]`);
  if (params.hasImageContext) parts.push("[图片]");
  if (params.urls.length > 0) parts.push(`[链接: ${params.urls.join(" ")}]`);
  return parts.join(" ").slice(0, MAX_BUFFER_TEXT);
}

/**
 * Aggregate distinct recent participants from the in-memory buffer so the LLM
 * knows which uids are safe to reference from memory tools.
 */
function collectRecentMembers(groupId: string): {
  recentMembers: { uid: string; name: string }[];
  allowedUids: Set<string>;
} {
  const history = getHistory(groupId);
  const map = new Map<string, string>();
  for (const entry of history) {
    if (entry.uid === "bot" || entry.uid === "system") continue;
    if (!map.has(entry.uid)) map.set(entry.uid, entry.name);
  }
  const recentMembers = Array.from(map.entries()).map(([uid, name]) => ({ uid, name }));
  return { recentMembers, allowedUids: new Set(map.keys()) };
}

/**
 * Stream an AI reply back to Telegram and bookkeep:
 *   - push the completed text into the group buffer
 *   - dispatch any sticker the model chose
 *   - cache image descriptions in Firestore for future reuse
 *   - reset proactive cooldown
 */
async function streamAiReply(params: {
  ctx: BotContext;
  replyToMessageId: number;
  user: User;
  userMessage: string;
  imageInputs: string[];
  photoFileIds: string[];
  systemHint: string | null;
}): Promise<void> {
  const { ctx, replyToMessageId, user, userMessage, imageInputs, photoFileIds, systemHint } =
    params;

  const history = getHistory(config.tgGroupId);
  const recentConversation = formatHistoryAsContext(history);
  const { recentMembers, allowedUids } = collectRecentMembers(config.tgGroupId);
  // The current speaker's uid should always be allowed even if they haven't
  // accumulated buffer entries yet (e.g. first message after /reset).
  allowedUids.add(user.uid);
  if (!recentMembers.some((m) => m.uid === user.uid)) {
    recentMembers.push({ uid: user.uid, name: user.nickname || "大哥哥" });
  }

  const { tier, needsSearch } = await classifyMessage(userMessage);

  const gen = generateResponse({
    userContext: user,
    userMessage,
    imageInputs,
    recentConversation,
    recentMembers,
    tier,
    needsSearch,
    allowedUids,
    ...(systemHint ? { systemHint } : {}),
  });

  try {
    await ctx.replyWithStream(gen.textStream, undefined, {
      reply_parameters: { message_id: replyToMessageId },
    });
    touchBotActivity();

    gen.text.then(
      (t) => {
        pushMessage(config.tgGroupId, "bot", config.botUsername, t.slice(0, MAX_BUFFER_TEXT));
      },
      (err: unknown) => {
        logger.warn({ err }, "streamAiReply: final text promise rejected");
      },
    );

    void (async () => {
      try {
        const emoji = await gen.stickerPromise;
        if (emoji && MIAOHAHA_STICKERS[emoji] && ctx.chat) {
          await ctx.api.sendSticker(ctx.chat.id, MIAOHAHA_STICKERS[emoji]);
        }
      } catch (err: unknown) {
        logger.warn({ err }, "streamAiReply: sticker dispatch failed");
      }
    })();

    // Cache image descriptions for future updates that reference the same file_id.
    for (let i = 0; i < photoFileIds.length; i++) {
      const fileId = photoFileIds[i];
      const img = imageInputs[i];
      if (!fileId || !img) continue;
      describeImage(img)
        .then((desc) => cacheImage(fileId, { description: desc }))
        .catch((err: unknown) => {
          logger.warn({ err, fileId }, "streamAiReply: image cache failed");
        });
    }
  } catch (err) {
    logger.error({ err }, "streamAiReply: stream failed");
    await ctx.reply("呜喵...出了点问题喵...").catch((replyErr: unknown) => {
      logger.warn({ err: replyErr }, "streamAiReply: fallback reply failed");
    });
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function setupHandlers(bot: Bot<BotContext>, botInfo: BotInfo): void {
  const botUsername = botInfo.username || config.botUsername;
  const botId = botInfo.id;

  bot.on("message", async (ctx) => {
    if (isDuplicateUpdate(ctx.update.update_id)) return;
    const msg = ctx.message;
    if (!msg) return;

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

    const { urls, photoFileIds, imageDataUrls, imageDescriptions, stickerEmoji, urlFetchPromise } =
      await extractContent(ctx, msg, { rawText, entities });

    // 4. Push user's message into the buffer ONCE, up front. Every later branch
    // now only needs to worry about pushing its own bot output.
    const bufferLine = buildBufferLine({
      rawText,
      stickerEmoji,
      hasImageContext: imageDataUrls.length > 0 || imageDescriptions.length > 0,
      urls,
    });
    if (bufferLine) {
      pushMessage(config.tgGroupId, from.id.toString(), displayName, bufferLine);
    }

    // 5. /help — public
    if (matchCommand(entities, rawText, "/help", botUsername)) {
      const helpText = `喵~ 我是 nyarbot，一只傲娇的高中生猫娘 AI！🎀

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
      const rejection = await generateLoveRejection(user);
      await replyAndTrack(ctx, rejection, msg.message_id);
      return;
    }

    // 7. Admin-only: /status, /reset
    if (matchCommand(entities, rawText, "/status", botUsername)) {
      if (from.id.toString() !== config.tgAdminUid) {
        await replyAndTrack(ctx, "哼，这是主人才能用的命令喵~", msg.message_id);
        return;
      }
      const historyLen = getHistory(config.tgGroupId).length;
      const uptime = process.uptime();
      const mins = Math.floor(uptime / 60);
      const hours = Math.floor(mins / 60);
      const uptimeStr = hours > 0 ? `${hours}h${mins % 60}m` : `${mins}m`;
      const mem = process.memoryUsage();
      const rssMb = Math.round(mem.rss / 1024 / 1024);
      // Fetch Firestore counts in parallel; if either fails, fall back to "?"
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
      const statusText = [
        "📊 nyarbot 状态",
        `运行时间: ${uptimeStr}`,
        `缓冲区消息数: ${historyLen}`,
        `记忆用户数: ${memUsers ?? "?"}`,
        `图片缓存数: ${cachedImgs ?? "?"}`,
        `内存 RSS: ${rssMb} MB`,
      ].join("\n");
      await replyAndTrack(ctx, statusText, msg.message_id);
      return;
    }

    if (matchCommand(entities, rawText, "/reset", botUsername)) {
      if (from.id.toString() !== config.tgAdminUid) {
        await replyAndTrack(ctx, "哼，这是主人才能用的命令喵~", msg.message_id);
        return;
      }
      clearHistory(config.tgGroupId);
      await replyAndTrack(ctx, "对话历史已清除喵~", msg.message_id);
      return;
    }

    // 8. Goodnight — /nighty command or matching Chinese/English text
    const isNightyCommand = matchCommand(entities, rawText, "/nighty", botUsername);
    const isNightyText = rawText ? NIGHTY_REGEX.test(rawText) : false;
    if (isNightyCommand || isNightyText) {
      await setNightyTimestamp(user.uid, Date.now());
      await replyAndTrack(ctx, `晚安 ${displayName}~ 🌙`, msg.message_id);
      return;
    }

    // 9. Trigger detection (@mention or reply-to-bot) — needed before morning logic
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

    // 10. Morning greeting logic
    //
    // Condition: user went to bed ≥ 8h ago and we haven't greeted them yet this cycle.
    //
    // When the user is ALSO actively pinging the bot, we don't want to send two
    // separate replies. Instead we mark the greeting as delivered and pass a
    // systemHint down to the AI so the reply naturally opens with a wake-up line.
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
        systemHint = `[系统提示: 该用户刚睡醒上线，请在回答开头带一句傲娇的早安，然后再回答 ta 的问题。]`;
      } else {
        // Standalone path: send greeting, then fall through to return.
        try {
          const greeting = await generateMorningGreeting(user);
          await setMorningGreeted(user.uid, now);
          await replyAndTrack(ctx, greeting, msg.message_id);
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
        pushMessage(
          config.tgGroupId,
          "system",
          "链接",
          `[链接内容: ${content.slice(0, MAX_BUFFER_TEXT)}]`,
        );
      }
    }

    // 12. If the bot wasn't pinged, we're done.
    if (!isMentioned && !isRepliedToBot) return;

    // 13. Love confession → templated rejection (no full AI pipeline needed)
    if (LOVE_REGEX.test(rawText)) {
      const rejection = await generateLoveRejection(user);
      await replyAndTrack(ctx, rejection, msg.message_id);
      return;
    }

    // 14. Main AI path
    const userMessage = buildUserMessage({
      rawText,
      displayName,
      imageDescriptions,
      hasImage: imageDataUrls.length > 0,
      stickerEmoji,
      replyTo,
      isRepliedToBot,
      urlContents,
    });

    await streamAiReply({
      ctx,
      replyToMessageId: msg.message_id,
      user,
      userMessage,
      imageInputs: imageDataUrls,
      photoFileIds,
      systemHint,
    });
  });

  // -------------------------------------------------------------------------
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
    pushMessage(
      config.tgGroupId,
      from.id.toString(),
      displayName,
      rawText.slice(0, MAX_BUFFER_TEXT),
    );

    // URL handling (simpler: no images in edit flow)
    const urls: string[] = [];
    for (const e of entities) {
      if (e.type === "url") urls.push(rawText.slice(e.offset, e.offset + e.length));
    }
    const regexMatches = rawText.match(/https?:\/\/[^\s]+/g) ?? [];
    for (const m of regexMatches) {
      const cleaned = m.replace(/[)\],.;:!?，。；：！？」』】》]+$/u, "");
      if (!urls.includes(cleaned)) urls.push(cleaned);
    }
    const { fetchUrlContent } = await import("../libs/ai.js");
    const urlContents = new Map<string, string | null>();
    if (urls.length > 0) {
      const entries = await Promise.all(
        urls.map(async (u) => [u, await fetchUrlContent(u)] as const),
      );
      for (const [u, c] of entries) {
        urlContents.set(u, c);
        if (c) {
          pushMessage(
            config.tgGroupId,
            "system",
            "链接",
            `[链接内容: ${c.slice(0, MAX_BUFFER_TEXT)}]`,
          );
        }
      }
    }

    // Love confession in edit
    if (LOVE_REGEX.test(rawText)) {
      const rejection = await generateLoveRejection(user);
      await replyAndTrack(ctx, rejection, msg.message_id);
      return;
    }

    const userMessage = buildUserMessage({
      rawText,
      displayName,
      imageDescriptions: [],
      hasImage: false,
      stickerEmoji: "",
      replyTo,
      isRepliedToBot,
      urlContents,
    });

    await streamAiReply({
      ctx,
      replyToMessageId: msg.message_id,
      user,
      userMessage,
      imageInputs: [],
      photoFileIds: [],
      systemHint: null,
    });
  });
}
