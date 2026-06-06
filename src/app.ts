import "dotenv/config";
import { Bot, InlineKeyboard } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { setupHandlers } from "./handlers/index.js";
import config from "./configs/env.js";
import { initFirebase } from "./services/index.js";
import { startProactiveChecker, stopProactiveChecker, touchBotActivity } from "./libs/proactive.js";
import type { ProactiveCallbacks } from "./libs/proactive.js";
import { logger, initAdminNotify } from "./libs/logger.js";
import { formatForTelegramHtml } from "./libs/format-telegram.js";
import { checkAndGenerateDiary, initDiaryCallbacks } from "./libs/diary.js";
import { saveConversationBuffer, loadConversationBuffer } from "./libs/conversation-buffer.js";
import { pushMessage, type HistoryEntryKind } from "./libs/conversation-buffer.js";

let diaryTimer: ReturnType<typeof setInterval> | undefined;
let bufferSaveTimer: ReturnType<typeof setInterval> | undefined;

initFirebase();

type BotContext = import("./handlers/context.js").BotContext;

const bot = new Bot<BotContext>(config.botApiKey);

// Auto-retry: handles 429 rate limit errors so the bot doesn't crash
bot.api.config.use(autoRetry());

async function main(): Promise<void> {
  // Populate bot.botInfo before registering handlers so there's no window in
  // which polling is live but handlers are absent. Avoids dropped updates at
  // startup and obviates onStart's role as a registration site.
  await bot.init();
  const botInfo = bot.botInfo;
  logger.info(`nyarbot starting as @${botInfo.username}`);

  // Forward warn/error logs to admin DM from now on
  initAdminNotify(bot.api);

  setupHandlers(bot, botInfo);

  // Restore conversation context from last session
  await loadConversationBuffer();

  const proactiveCallbacks: ProactiveCallbacks = {
    sendText: async (text: string) => {
      const formatted = formatForTelegramHtml(text);
      try {
        await bot.api.sendMessage(config.tgGroupId, formatted, { parse_mode: "HTML" });
      } catch {
        await bot.api.sendMessage(config.tgGroupId, text);
      }
    },
    sendSticker: async (stickerFileId: string) => {
      try {
        await bot.api.sendSticker(config.tgGroupId, stickerFileId);
      } catch (err) {
        logger.warn({ err, stickerFileId }, "proactive: sticker dispatch failed");
      }
    },
    sendChatAction: async (action) => {
      try {
        await bot.api.sendChatAction(config.tgGroupId, action);
      } catch {
        // Best-effort; typing indicators are non-critical
      }
    },
  };

  startProactiveChecker(proactiveCallbacks);

  initDiaryCallbacks({
    sendText: async (text, kind: HistoryEntryKind = "normal", options) => {
      const formatted = formatForTelegramHtml(text);
      const reply_markup =
        options?.inlineKeyboardText && options.inlineKeyboardUrl
          ? new InlineKeyboard().url(options.inlineKeyboardText, options.inlineKeyboardUrl)
          : undefined;
      try {
        await bot.api.sendMessage(config.tgGroupId, formatted, {
          parse_mode: "HTML",
          ...(reply_markup ? { reply_markup } : {}),
        });
      } catch {
        await bot.api.sendMessage(config.tgGroupId, text, {
          ...(reply_markup ? { reply_markup } : {}),
        });
      }
      pushMessage(config.tgGroupId, "bot", config.botUsername, text, undefined, kind);
      touchBotActivity();
    },
    sendChannelText: async (text) => {
      if (!config.tgDiaryChannelId) return;
      const formatted = formatForTelegramHtml(text);
      try {
        await bot.api.sendMessage(config.tgDiaryChannelId, formatted, { parse_mode: "HTML" });
        logger.info(
          { chatId: config.tgDiaryChannelId },
          "diary: channel publish succeeded via HTML",
        );
      } catch (htmlErr) {
        logger.warn(
          { err: htmlErr, chatId: config.tgDiaryChannelId },
          "diary: channel HTML publish failed, retrying with plain text",
        );
        try {
          await bot.api.sendMessage(config.tgDiaryChannelId, text);
          logger.info(
            { chatId: config.tgDiaryChannelId },
            "diary: channel publish succeeded via plain text",
          );
        } catch (textErr) {
          logger.error(
            { err: textErr, chatId: config.tgDiaryChannelId },
            "diary: channel plain-text publish failed",
          );
          throw textErr;
        }
      }
    },
  });

  // Midnight diary generation: check interval configurable by env
  diaryTimer = setInterval(checkAndGenerateDiary, config.diaryCheckIntervalMs);
  diaryTimer.unref?.();

  // Periodic buffer save: interval configurable by env
  bufferSaveTimer = setInterval(() => {
    saveConversationBuffer().catch(() => void 0);
  }, config.bufferSaveIntervalMs);
  bufferSaveTimer.unref?.();

  await bot.start({
    onStart(info) {
      logger.info(`nyarbot polling as @${info.username}`);
    },
  });
}

main().catch((err: unknown) => {
  logger.error({ err }, "fatal startup error");
  process.exit(1);
});

// Graceful shutdown
process.once("SIGINT", () => {
  stopProactiveChecker();
  if (diaryTimer) clearInterval(diaryTimer);
  if (bufferSaveTimer) clearInterval(bufferSaveTimer);
  saveConversationBuffer().catch(() => void 0);
  void bot.stop();
});
process.once("SIGTERM", () => {
  stopProactiveChecker();
  if (diaryTimer) clearInterval(diaryTimer);
  if (bufferSaveTimer) clearInterval(bufferSaveTimer);
  saveConversationBuffer().catch(() => void 0);
  void bot.stop();
});

// Crash guards: ensure unhandled errors are logged before exit
process.once("uncaughtException", (err) => {
  saveConversationBuffer().catch(() => void 0);
  logger.fatal({ err }, "uncaught exception — exiting");
  process.exit(1);
});
process.once("unhandledRejection", (reason) => {
  saveConversationBuffer().catch(() => void 0);
  logger.fatal(
    { err: reason instanceof Error ? reason : new Error(String(reason)) },
    "unhandled rejection — exiting",
  );
  process.exit(1);
});
