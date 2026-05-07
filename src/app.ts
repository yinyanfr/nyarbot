import "dotenv/config";
import { Bot } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { setupHandlers } from "./handlers/index.js";
import config from "./configs/env.js";
import { initFirebase } from "./services/index.js";
import { startProactiveChecker, stopProactiveChecker } from "./libs/proactive.js";
import type { ProactiveCallbacks } from "./libs/proactive.js";
import { logger } from "./libs/logger.js";
import { cleanupExpiredImageCache } from "./services/firestore.js";
import { formatForTelegramHtml } from "./libs/format-telegram.js";
import { MIAOHAHA_STICKERS } from "./libs/stickers.js";

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

  setupHandlers(bot, botInfo);

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
    sendSticker: async (stickerEmoji: string) => {
      const fileId = MIAOHAHA_STICKERS[stickerEmoji];
      if (fileId) {
        try {
          await bot.api.sendSticker(config.tgGroupId, fileId);
        } catch (err) {
          logger.warn({ err, stickerEmoji }, "proactive: sticker dispatch failed");
        }
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
  void bot.stop();
});
process.once("SIGTERM", () => {
  stopProactiveChecker();
  void bot.stop();
});
