import type { BotContext } from "./context.js";
import config from "../configs/env.js";
import { pushMessage, type HistoryEntryKind } from "../libs/conversation-buffer.js";
import { touchBotActivity } from "../libs/proactive.js";
import { logger } from "../libs/logger.js";
import { MAX_BUFFER_TEXT } from "./constants.js";
import { formatForTelegramHtml } from "../libs/format-telegram.js";
import { groupRuntime } from "../libs/group-runtime.js";

function isReplyTargetMissingError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("message to be replied not found");
}

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
  kind: HistoryEntryKind = "normal",
): Promise<void> {
  const push = () => {
    pushMessage(
      config.tgGroupId,
      "bot",
      config.botUsername,
      text.slice(0, MAX_BUFFER_TEXT),
      undefined,
      kind,
    );
    groupRuntime
      .recordBotMessages({ messages: [text], kind: "bot_message" })
      .catch((err: unknown) => {
        logger.warn({ err }, "replyAndTrack: runtime bot event persist failed");
      });
    touchBotActivity();
  };

  if (formatMarkdown) {
    const formatted = formatForTelegramHtml(text);
    try {
      const htmlOpts: Record<string, unknown> = { parse_mode: "HTML" };
      if (replyToMessageId !== undefined) {
        htmlOpts.reply_parameters = { message_id: replyToMessageId };
      }
      await ctx.reply(formatted, htmlOpts);
      push();
      return;
    } catch (err) {
      if (isReplyTargetMissingError(err) && replyToMessageId !== undefined) {
        logger.info(
          { replyToMessageId },
          "replyAndTrack: reply target missing, retrying without reply",
        );
        try {
          await ctx.reply(formatted, { parse_mode: "HTML" });
          push();
          return;
        } catch (retryErr) {
          logger.warn(
            { err: retryErr },
            "replyAndTrack: HTML send without reply failed, falling back to plain text",
          );
        }
      } else {
        logger.warn({ err }, "replyAndTrack: HTML reply failed, falling back to plain text");
      }
    }
  }

  try {
    const opts: Record<string, unknown> = {};
    if (replyToMessageId !== undefined) {
      opts.reply_parameters = { message_id: replyToMessageId };
    }
    await ctx.reply(text, opts);
  } catch (err) {
    if (isReplyTargetMissingError(err) && replyToMessageId !== undefined) {
      logger.info(
        { replyToMessageId },
        "replyAndTrack: plain-text reply target missing, retrying without reply",
      );
      try {
        await ctx.reply(text);
      } catch (retryErr) {
        logger.warn({ err: retryErr }, "replyAndTrack: plain-text send without reply failed");
        return;
      }
    } else {
      logger.warn({ err }, "replyAndTrack: reply failed");
      return;
    }
  }
  push();
}
