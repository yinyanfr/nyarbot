import type { BotContext } from "./context.js";
import config from "../configs/env.js";
import { pushMessage } from "../libs/conversation-buffer.js";
import { touchBotActivity } from "../libs/proactive.js";
import { logger } from "../libs/logger.js";
import { MAX_BUFFER_TEXT } from "./constants.js";
import { formatForTelegramHtml } from "../libs/format-telegram.js";

/**
 * Reply to the current message, push the reply into the group buffer so that
 * later AI calls and the proactive checker have full context, and reset the
 * proactive cooldown. Centralizing these three steps prevents the common bug
 * of forgetting one of them in an early-return branch.
 *
 * When `formatMarkdown` is true, the text is converted from Markdown to
 * Telegram HTML and sent with parse_mode "HTML". If Telegram rejects the
 * formatted version (e.g. malformed tags), it falls back to plain text.
 */
export async function replyAndTrack(
  ctx: BotContext,
  text: string,
  replyToMessageId?: number,
  formatMarkdown = false,
): Promise<void> {
  const push = () => {
    pushMessage(config.tgGroupId, "bot", config.botUsername, text.slice(0, MAX_BUFFER_TEXT));
    touchBotActivity();
  };

  if (formatMarkdown) {
    const formatted = formatForTelegramHtml(text);
    const opts: Record<string, unknown> = { parse_mode: "HTML" };
    if (replyToMessageId !== undefined) {
      opts.reply_parameters = { message_id: replyToMessageId };
    }
    try {
      await ctx.reply(formatted, opts);
      push();
      return;
    } catch (err) {
      logger.warn({ err }, "replyAndTrack: HTML reply failed, falling back to plain text");
    }
  }

  try {
    const opts: Record<string, unknown> = {};
    if (replyToMessageId !== undefined) {
      opts.reply_parameters = { message_id: replyToMessageId };
    }
    await ctx.reply(text, opts);
  } catch (err) {
    logger.warn({ err }, "replyAndTrack: reply failed");
    return;
  }
  push();
}
