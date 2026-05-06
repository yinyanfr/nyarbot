import "dotenv/config";
import { Bot, type Context } from "grammy";
import { stream, type StreamFlavor } from "@grammyjs/stream";
import { autoRetry } from "@grammyjs/auto-retry";
import { setupHandlers } from "./handlers/index.js";
import config from "./configs/env.js";
import { initFirebase } from "./services/index.js";
import { startProactiveChecker, stopProactiveChecker } from "./libs/proactive.js";
import { logger } from "./libs/logger.js";

initFirebase();

type BotContext = StreamFlavor<Context>;

const bot = new Bot<BotContext>(config.botApiKey);

// Auto-retry: handles 429 rate limit errors so the bot doesn't crash
bot.api.config.use(autoRetry());

// Stream: adds ctx.replyWithStream for real-time LLM response streaming
bot.use(stream());

bot.start({
  onStart(botInfo) {
    logger.info(`nyarbot started as @${botInfo.username}`);

    // Pass cached botInfo so handlers don't call getMe() on every message
    setupHandlers(bot, botInfo);

    // Proactive conversation: bot joins when people are talking
    startProactiveChecker(async (text) => {
      await bot.api.sendMessage(config.tgGroupId, text);
    });
  },
});

// Graceful shutdown
process.once("SIGINT", () => {
  stopProactiveChecker();
  bot.stop();
});
process.once("SIGTERM", () => {
  stopProactiveChecker();
  bot.stop();
});
