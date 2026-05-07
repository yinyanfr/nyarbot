import { Bot, type Context } from "grammy";
import { type StreamFlavor } from "@grammyjs/stream";
import config from "../configs/env.js";
import {
  getOrCreateUser,
  getCachedImage,
  cacheImage,
  setNightyTimestamp,
  setMorningGreeted,
} from "../services/firestore.js";
import {
  classifyMessage,
  generateResponse,
  generateMorningGreeting,
  describeImage,
  generateLoveRejection,
  fetchUrlContent,
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

type BotContext = StreamFlavor<Context>;

const MAX_BUFFER_TEXT = 500;

export function setupHandlers(
  bot: Bot<BotContext>,
  botInfo: { id: number; username?: string },
): void {
  const botUsername = botInfo.username || config.botUsername;
  const botId = botInfo.id;

  bot.on("message", async (ctx) => {
    const msg = ctx.message;
    if (!msg) return;

    // ---- 1. Group filter ----
    if (ctx.chat.id.toString() !== config.tgGroupId) return;

    const from = msg.from;
    if (!from) return;

    // ---- 2. Get or create user ----
    const user = await getOrCreateUser(from.id.toString(), from.first_name);
    const displayName = user.nickname || from.first_name || "大哥哥";

    // ---- 3. Extract text & entities ----
    const rawText = msg.text ?? msg.caption ?? "";
    const msgEntities = [...(msg.entities ?? []), ...(msg.caption_entities ?? [])];

    // ---- 3b. Extract URLs ----
    const urlEntities = msgEntities.filter((e) => e.type === "url");
    const urls: string[] = urlEntities.map((e) => rawText.slice(e.offset, e.offset + e.length));
    // Regex fallback for bare URLs not captured as entities
    if (urls.length === 0 && rawText) {
      const matches = rawText.match(/https?:\/\/[^\s]+/g);
      if (matches) urls.push(...matches);
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

    // ---- 4. Process images ----
    const photos = msg.photo ?? [];
    const imageUrls: string[] = [];
    const imageFileIds: string[] = [];
    const imageContexts: string[] = [];
    for (const photo of photos.slice(-1)) {
      // Only the largest (last) photo is used for vision context
      try {
        const cached = await getCachedImage(photo.file_id);
        if (cached?.description && typeof cached.description === "string") {
          imageContexts.push(cached.description);
          continue;
        }
        const file = await ctx.api.getFile(photo.file_id);
        if (file.file_path) {
          const url = `https://api.telegram.org/file/bot${config.botApiKey}/${file.file_path}`;
          imageUrls.push(url);
          imageFileIds.push(photo.file_id);
          imageContexts.push(url);
        }
      } catch (err) {
        logger.warn(err, "failed to fetch photo");
      }
    }

    // ---- 5. Process sticker ----
    const stickerEmoji = msg.sticker?.emoji ?? "";

    // ---- 5b. /help command ----
    const isHelpCommand = msgEntities.some(
      (e) =>
        e.type === "bot_command" &&
        (rawText.slice(e.offset, e.offset + e.length) === "/help" ||
          rawText.slice(e.offset, e.offset + e.length) === `/help@${botUsername}`),
    );
    if (isHelpCommand) {
      const helpText = `喵~ 我是 nyarbot，一只傲娇的高中生猫娘 AI！🎀

你可以这样跟我互动：
• @我 或 回复我 — 和我聊天
• /nighty — 跟我说晚安，8小时后我会发早安问候
• 发图片 — 我会看看是什么然后吐槽
• 让我「叫我XX」— 我会记住你的昵称
• 让我「记住XXX」— 我会记住关于你的事情

遇到编程/技术问题也可以认真问我，我会收起步猫娘模式帮你喵~`;
      await ctx.reply(helpText, { reply_to_message_id: msg.message_id });
      pushMessage(config.tgGroupId, "bot", config.botUsername, helpText);
      touchBotActivity();
      return;
    }

    // ---- 5c. /love command ----
    const isLoveCommand = msgEntities.some(
      (e) => e.type === "bot_command" && rawText.slice(e.offset, e.offset + e.length) === "/love",
    );
    if (isLoveCommand) {
      const rejection = await generateLoveRejection(user);
      await ctx.reply(rejection, { reply_to_message_id: msg.message_id });
      pushMessage(config.tgGroupId, "bot", config.botUsername, rejection);
      touchBotActivity();
      return;
    }

    // ---- 5d. Admin commands ----
    // I'll leave these commands for all group members since i trust them
    const isStatusCommand = msgEntities.some(
      (e) => e.type === "bot_command" && rawText.slice(e.offset, e.offset + e.length) === "/status",
    );
    if (isStatusCommand) {
      const historyLen = getHistory(config.tgGroupId).length;
      const uptime = process.uptime();
      const mins = Math.floor(uptime / 60);
      const statusText = `📊 nyarbot 状态\n运行时间: ${mins} 分钟\n缓冲区消息数: ${historyLen}\n记忆用户数: (需要查 DB)`;
      await ctx.reply(statusText, { reply_to_message_id: msg.message_id });
      return;
    }

    const isResetCommand = msgEntities.some(
      (e) => e.type === "bot_command" && rawText.slice(e.offset, e.offset + e.length) === "/reset",
    );
    if (isResetCommand) {
      clearHistory(config.tgGroupId);
      await ctx.reply("对话历史已清除喵~", { reply_to_message_id: msg.message_id });
      return;
    }

    // ---- 6. Goodnight detection ----
    const isNightyCommand = msgEntities.some(
      (e) =>
        e.type === "bot_command" &&
        (rawText.slice(e.offset, e.offset + e.length) === "/nighty" ||
          rawText.slice(e.offset, e.offset + e.length) === `/nighty@${botUsername}`),
    );
    const nightyRegex =
      /晚安|[晚睌]安|我要睡了|睡觉了|去睡了|睡了哦|先睡了|gn\b|good\s*night|nite\b/i;
    const isNightyText = rawText ? nightyRegex.test(rawText) : false;

    if (isNightyCommand || isNightyText) {
      const now = Date.now();
      await setNightyTimestamp(user.uid, now);
      const nightyReply = `晚安 ${displayName}~ 🌙`;
      await ctx.reply(nightyReply, { reply_to_message_id: msg.message_id });
      pushMessage(config.tgGroupId, "bot", config.botUsername, nightyReply);
      touchBotActivity();
      return;
    }

    // ---- 7. Morning greeting check ----
    const EIGHT_HOURS = 8 * 60 * 60 * 1000;
    const now = Date.now();
    if (
      user.nightyTimestamp &&
      now - user.nightyTimestamp >= EIGHT_HOURS &&
      (!user.lastMorningGreet || user.lastMorningGreet <= user.nightyTimestamp)
    ) {
      try {
        const greeting = await generateMorningGreeting(user);
        await setMorningGreeted(user.uid, now);
        await ctx.reply(greeting, { reply_to_message_id: msg.message_id });
        pushMessage(config.tgGroupId, "bot", config.botUsername, greeting);
        // Continue to normal flow — user may also want a triggered response
      } catch (err) {
        logger.error(err, "failed to send morning greeting");
      }
    }

    // ---- 8. Push message to conversation buffer (merge text + media) ----
    const bufferParts: string[] = [];
    if (rawText) bufferParts.push(rawText);
    if (stickerEmoji) bufferParts.push(`[贴纸: ${stickerEmoji}]`);
    if (imageContexts.length > 0) bufferParts.push("[图片]");
    if (urls.length > 0) bufferParts.push(`[链接: ${urls.join(" ")}]`);
    const bufferText = bufferParts.join(" ").slice(0, MAX_BUFFER_TEXT);
    if (bufferText) {
      pushMessage(config.tgGroupId, from.id.toString(), displayName, bufferText);
    }

    // ---- 9. Check trigger: @mention or replied to ----
    const isMentioned = msgEntities.some((e) => {
      if (e.type !== "mention") return false;
      const raw = msg.text ?? msg.caption ?? "";
      const mention = raw.slice(e.offset, e.offset + e.length);
      return (
        mention.toLowerCase() === `@${botUsername.toLowerCase()}` ||
        mention.toLowerCase() === `@${config.botUsername.toLowerCase()}`
      );
    });

    const replyTo = msg.reply_to_message;
    const isRepliedToBot =
      replyTo?.from?.username?.toLowerCase() === botUsername.toLowerCase() ||
      replyTo?.from?.id === botId;

    if (!isMentioned && !isRepliedToBot) {
      // Push URL content to buffer when ready (for proactive context)
      urlFetchPromise
        .then((map) => {
          for (const [, content] of map) {
            if (content) {
              pushMessage(
                config.tgGroupId,
                "system",
                "链接",
                `[链接内容: ${content.slice(0, MAX_BUFFER_TEXT)}]`,
              );
            }
          }
        })
        .catch(() => {
          /* ignore */
        });
      return;
    }

    // ---- 10. Await URL content ----
    const urlContents = await urlFetchPromise;
    // Push fetched URL content to buffer
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

    // ---- 11. Love confession detection ----
    const loveRegex =
      /我喜欢你|我爱你|我们结婚|嫁给我|做我女|当我女|交往|love\s*you|跟我在一起|和我在一起/i;
    if (loveRegex.test(rawText)) {
      const rejection = await generateLoveRejection(user);
      await ctx.reply(rejection, { reply_to_message_id: msg.message_id });
      pushMessage(config.tgGroupId, "bot", config.botUsername, rejection);
      touchBotActivity();
      return;
    }

    // ---- 12. Build recent conversation context ----
    const history = getHistory(config.tgGroupId);
    const recentConversation = formatHistoryAsContext(history);

    // ---- 13. Build user message with media context ----
    let userMessage = rawText;
    if (imageContexts.length > 0) {
      const imgLine = imageContexts.map((ic) => `[图片: ${ic}]`).join("\n");
      userMessage = imgLine + (rawText ? `\n${displayName}说: ${rawText}` : "");
    }
    if (stickerEmoji) {
      userMessage = (userMessage ? `${userMessage}\n` : "") + `[贴纸: ${stickerEmoji}]`;
    }
    if (replyTo && !isRepliedToBot) {
      const repliedText = replyTo.text ?? replyTo.caption ?? "";
      if (repliedText) {
        userMessage = `[回复: "${repliedText}"]\n${userMessage}`;
      }
    }
    // Add URL content to user message
    for (const [url, content] of urlContents) {
      if (content) {
        userMessage = `[链接 ${url}: ${content}]\n${userMessage}`;
      } else {
        userMessage = `[链接 ${url}: 无法获取内容]\n${userMessage}`;
      }
    }

    // ---- 14. Classify message ----
    const { tier, needsSearch } = await classifyMessage(userMessage);

    // ---- 15. Generate & stream response ----
    const {
      textStream,
      stickerPromise,
      text: fullText,
    } = generateResponse({
      userContext: user,
      userMessage,
      imageUrls,
      recentConversation,
      tier,
      needsSearch,
    });

    try {
      await ctx.replyWithStream(textStream, undefined, {
        reply_to_message_id: msg.message_id,
      });

      // Reset proactive cooldown since bot just spoke
      touchBotActivity();

      // Push bot's own response to the buffer after streaming completes
      fullText.then(
        (t) => {
          pushMessage(config.tgGroupId, "bot", config.botUsername, t.slice(0, MAX_BUFFER_TEXT));
        },
        () => {
          /* ignore */
        },
      );

      // Send sticker as follow-up if the LLM chose one
      stickerPromise.then((emoji) => {
        if (emoji && MIAOHAHA_STICKERS[emoji]) {
          ctx.api
            .sendSticker(ctx.chat.id!, MIAOHAHA_STICKERS[emoji]!)
            // would be natural that stickers don't reply to messages
            .catch(() => {
              /* ignore */
            });
        }
      });

      // Cache image descriptions for future reuse
      for (let i = 0; i < imageFileIds.length; i++) {
        const fileId = imageFileIds[i]!;
        const url = imageUrls[i]!;
        describeImage(url)
          .then((desc) => cacheImage(fileId, { description: desc, url }))
          .catch((err) => {
            logger.warn(err, "failed to cache image description");
          });
      }
    } catch (err) {
      logger.error(err, "failed to stream reply");
      await ctx.reply("呜喵...出了点问题喵...").catch(() => {
        // Ignore reply failure
      });
    }
  });

  // ---- Edited message handler ----
  bot.on("edited_message", async (ctx) => {
    const msg = ctx.editedMessage;
    if (!msg) return;

    if (ctx.chat.id.toString() !== config.tgGroupId) return;

    const from = msg.from;
    if (!from) return;

    // Don't respond to bot editing its own messages
    if (from.username?.toLowerCase() === botUsername.toLowerCase() || from.id === botId) return;

    const rawText = msg.text ?? msg.caption ?? "";
    if (!rawText) return;

    const msgEntities = [...(msg.entities ?? []), ...(msg.caption_entities ?? [])];

    // Extract URLs
    const urlEntities = msgEntities.filter((e) => e.type === "url");
    const urls: string[] = urlEntities.map((e) => rawText.slice(e.offset, e.offset + e.length));
    if (urls.length === 0 && rawText) {
      const matches = rawText.match(/https?:\/\/[^\s]+/g);
      if (matches) urls.push(...matches);
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

    // Check trigger: @mention or replied to
    const isMentioned = msgEntities.some((e) => {
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

    // Await URL content
    const urlContents = await urlFetchPromise;
    // Push fetched URL content to buffer
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

    // Love confession detection
    const loveRegex =
      /我喜欢你|我爱你|我们结婚|嫁给我|做我女|当我女|交往|love\s*you|跟我在一起|和我在一起/i;
    if (loveRegex.test(rawText)) {
      const user = await getOrCreateUser(from.id.toString(), from.first_name);
      const rejection = await generateLoveRejection(user);
      await ctx.reply(rejection, { reply_to_message_id: msg.message_id });
      pushMessage(config.tgGroupId, "bot", config.botUsername, rejection);
      touchBotActivity();
      return;
    }

    const user = await getOrCreateUser(from.id.toString(), from.first_name);
    const displayName = user.nickname || from.first_name || "大哥哥";

    // Push edited message to buffer
    pushMessage(
      config.tgGroupId,
      from.id.toString(),
      displayName,
      rawText.slice(0, MAX_BUFFER_TEXT),
    );

    const history = getHistory(config.tgGroupId);
    const recentConversation = formatHistoryAsContext(history);

    let userMessage = rawText;
    if (replyTo && !isRepliedToBot) {
      const repliedText = replyTo.text ?? replyTo.caption ?? "";
      if (repliedText) {
        userMessage = `[回复: "${repliedText}"]\n${userMessage}`;
      }
    }
    // Add URL content to user message
    for (const [url, content] of urlContents) {
      if (content) {
        userMessage = `[链接 ${url}: ${content}]\n${userMessage}`;
      } else {
        userMessage = `[链接 ${url}: 无法获取内容]\n${userMessage}`;
      }
    }

    const { tier, needsSearch } = await classifyMessage(userMessage);

    const {
      textStream,
      stickerPromise,
      text: fullText,
    } = generateResponse({
      userContext: user,
      userMessage,
      imageUrls: [],
      recentConversation,
      tier,
      needsSearch,
    });

    try {
      await ctx.replyWithStream(textStream, undefined, {
        reply_to_message_id: msg.message_id,
      });

      touchBotActivity();

      fullText.then(
        (t) => {
          pushMessage(config.tgGroupId, "bot", config.botUsername, t.slice(0, MAX_BUFFER_TEXT));
        },
        () => {
          /* ignore */
        },
      );

      stickerPromise.then((emoji) => {
        if (emoji && MIAOHAHA_STICKERS[emoji]) {
          ctx.api.sendSticker(ctx.chat.id!, MIAOHAHA_STICKERS[emoji]!).catch(() => {
            /* ignore */
          });
        }
      });
    } catch (err) {
      logger.error(err, "failed to stream reply for edited message");
    }
  });
}
