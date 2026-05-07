import "dotenv/config";
import { Bot, type Context } from "grammy";
import { stream, type StreamFlavor } from "@grammyjs/stream";
import { autoRetry } from "@grammyjs/auto-retry";
import { setupHandlers } from "./handlers/index.js";
import config from "./configs/env.js";
import { initFirebase } from "./services/index.js";
import { startProactiveChecker, stopProactiveChecker } from "./libs/proactive.js";
import { logger } from "./libs/logger.js";
import { cleanupExpiredImageCache } from "./services/firestore.js";

initFirebase();

type BotContext = StreamFlavor<Context>;

const bot = new Bot<BotContext>(config.botApiKey);

// Auto-retry: handles 429 rate limit errors so the bot doesn't crash
bot.api.config.use(autoRetry());

// Stream: adds ctx.replyWithStream for real-time LLM response streaming
bot.use(stream());

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

  startProactiveChecker(async (text) => {
    await bot.api.sendMessage(config.tgGroupId, text);
  });

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
