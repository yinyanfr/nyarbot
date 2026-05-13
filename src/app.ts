import "dotenv/config";
import { Bot } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { setupHandlers } from "./handlers/index.js";
import config from "./configs/env.js";
import { initFirebase } from "./services/index.js";
import { startProactiveChecker, stopProactiveChecker } from "./libs/proactive.js";
import type { ProactiveCallbacks } from "./libs/proactive.js";
import { logger, initAdminNotify } from "./libs/logger.js";
import { cleanupExpiredImageCache } from "./services/firestore.js";
import { formatForTelegramHtml } from "./libs/format-telegram.js";
import { initStickerStore, stickerStoreReady } from "./libs/sticker-store.js";
import { checkAndGenerateDiary, initDiaryCallbacks } from "./libs/diary.js";
import { saveConversationBuffer, loadConversationBuffer } from "./libs/conversation-buffer.js";

let diaryTimer: ReturnType<typeof setInterval> | undefined;
let bufferSaveTimer: ReturnType<typeof setInterval> | undefined;

initFirebase();
initStickerStore();

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

  // Wait for sticker store to load from Firestore before accepting messages
  await stickerStoreReady();

  // Restore conversation context from last session
  await loadConversationBuffer();

  // Fire-and-forget cache cleanup; failures shouldn't block startup.
  cleanupExpiredImageCache().catch((err: unknown) => {
    logger.warn({ err }, "image cache cleanup failed");
  });

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
    sendText: async (text) => {
      const formatted = formatForTelegramHtml(text);
      try {
        await bot.api.sendMessage(config.tgGroupId, formatted, { parse_mode: "HTML" });
      } catch {
        await bot.api.sendMessage(config.tgGroupId, text);
      }
    },
  });

  // Midnight diary generation: check every 60s if the UTC+8 date has changed
  diaryTimer = setInterval(checkAndGenerateDiary, 60_000);
  diaryTimer.unref?.();

  // Periodic buffer save: flush to disk every 5 min for crash resilience
  bufferSaveTimer = setInterval(() => {
    saveConversationBuffer().catch(() => void 0);
  }, 300_000);
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
