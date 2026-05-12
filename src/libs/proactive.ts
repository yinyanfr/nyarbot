import { probeGate, generateAiTurn } from "./ai.js";
import { getHistory, pushMessage, formatHistoryAsContext } from "./conversation-buffer.js";
import { logger } from "./logger.js";
import config from "../configs/env.js";
import { MAX_BUFFER_TEXT } from "../handlers/constants.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CHECK_INTERVAL_MS = 15_000; // check every 15 seconds
const WINDOW_MS = 3 * 60 * 1000; // look at last 3 minutes of messages

// Delay between consecutive bot messages (ms) — mimics human typing rhythm.
const MESSAGE_DELAY_MS = 400;

// Cooldown between bot messages, based on group activity
function getCooldownMs(activityCount: number): number {
  if (activityCount >= 7) return 90_000; // high: up to every 1.5 min
  if (activityCount >= 3) return 180_000; // medium: every 3 min
  return 360_000; // low: every 6 min
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let lastBotMessageTime = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;
let consecutiveFailures = 0;
const MAX_FAILURES = 5;

// ---------------------------------------------------------------------------
// Callback interface for sending messages to Telegram
// ---------------------------------------------------------------------------

export interface ProactiveCallbacks {
  /** Send a text message to the group (formatting applied by caller). */
  sendText: (text: string) => Promise<void>;
  /** Send a sticker by its emoji key (looked up in MIAOHAHA_STICKERS by caller). */
  sendSticker: (stickerEmoji: string) => Promise<void>;
  /** Send a chat action indicator (e.g. "typing"). */
  sendChatAction: (
    action:
      | "typing"
      | "upload_photo"
      | "record_video"
      | "upload_video"
      | "record_voice"
      | "upload_voice"
      | "upload_document"
      | "choose_sticker"
      | "find_location"
      | "record_video_note"
      | "upload_video_note",
  ) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Call this whenever the bot sends a message (triggered or proactive)
 * to reset the cooldown clock.
 */
export function touchBotActivity(): void {
  lastBotMessageTime = Date.now();
}

async function check(callbacks: ProactiveCallbacks): Promise<void> {
  if (stopped) return;

  try {
    const now = Date.now();
    const history = getHistory(config.tgGroupId);

    // Count recent messages from real users (excluding the bot itself and
    // synthetic "system" entries such as URL content summaries).
    const recentCount = history.filter(
      (e) => e.timestamp > now - WINDOW_MS && e.uid !== "bot" && e.uid !== "system",
    ).length;

    if (recentCount === 0) return;

    const cooldown = getCooldownMs(recentCount);
    if (now - lastBotMessageTime < cooldown) return;

    const recentHistory = history.filter((e) => e.timestamp > now - WINDOW_MS);

    // Collect recent members for the probe gate context
    const memberMap = new Map<string, string>();
    for (const entry of recentHistory) {
      if (entry.uid !== "bot" && entry.uid !== "system" && !memberMap.has(entry.uid)) {
        memberMap.set(entry.uid, entry.name);
      }
    }
    const recentMembers = Array.from(memberMap.entries()).map(([uid, name]) => ({ uid, name }));
    const allowedUids = new Set(memberMap.keys());

    const shouldProceed = await probeGate({
      recentConversation: recentHistory.map((entry) => `[${entry.name}]: ${entry.text}`).join("\n"),
      recentMembers,
    });

    if (!shouldProceed) {
      // Probe decided to stay silent — skip the full model run entirely.
      return;
    }

    // Re-check cooldown: a passive handler may have replied while probeGate was running.
    const elapsed = Date.now() - lastBotMessageTime;
    if (elapsed < cooldown) {
      logger.info(`proactive: passive reply ${elapsed}ms ago, skipping (cooldown ${cooldown}ms)`);
      return;
    }

    // Signal "typing..." to the group while the full model runs
    await callbacks.sendChatAction("typing");

    const formattedHistory = formatHistoryAsContext(recentHistory);

    // Collect recent bot messages for human-likeness feedback
    const recentBotMessages = recentHistory
      .filter((e) => e.uid === "bot")
      .map((e) => e.text)
      .slice(-5);

    // Use the current conversation context for the proactive response
    const result = await generateAiTurn({
      userContext: { uid: "proactive", nickname: "", memories: [] },
      userMessage: "（主动性回复：浏览群聊记录，决定是否有值得回复的内容）",
      recentConversation: formattedHistory,
      recentMembers,
      allowedUids,
      tier: "simple", // proactive messages should always be short
      needsSearch: false,
      systemHint: null,
      wasMentioned: false,
      wasRepliedTo: false,
      recentBotMessages,
    });

    if (result.action === "dismiss") {
      logger.info("proactive: full model chose to dismiss after probe activation");
      return;
    }

    // Send all text messages from the result, formatted for Telegram HTML
    for (let i = 0; i < result.messages.length; i++) {
      const msg = result.messages[i]!;
      await callbacks.sendText(msg);
      pushMessage(config.tgGroupId, "bot", config.botUsername, msg.slice(0, MAX_BUFFER_TEXT));

      // Stagger messages to mimic human typing rhythm, but not after the last one
      if (i < result.messages.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, MESSAGE_DELAY_MS));
      }
    }

    // Dispatch sticker — either after text messages, or sticker-only (no text)
    if (result.stickerEmoji) {
      await callbacks.sendSticker(result.stickerEmoji);
      if (result.messages.length === 0) {
        pushMessage(config.tgGroupId, "bot", config.botUsername, `[贴纸: ${result.stickerEmoji}]`);
      }
    }

    lastBotMessageTime = Date.now();
    consecutiveFailures = 0;
  } catch (err) {
    consecutiveFailures++;
    logger.error(err, `proactive check failed (${consecutiveFailures}/${MAX_FAILURES})`);
    if (consecutiveFailures >= MAX_FAILURES) {
      logger.warn("stopping proactive checker after max consecutive failures");
      stopProactiveChecker();
      return; // don't reschedule
    }
  } finally {
    // Schedule next check only after current one finishes (prevents overlap)
    if (!stopped) {
      timer = setTimeout(() => check(callbacks), CHECK_INTERVAL_MS);
      timer.unref?.();
    }
  }
}

/**
 * Start the proactive conversation checker.
 * @param callbacks - object with methods to send messages, stickers, and chat
 *   actions to the group.
 */
export function startProactiveChecker(callbacks: ProactiveCallbacks): void {
  if (timer) return;
  stopped = false;
  timer = setTimeout(() => check(callbacks), CHECK_INTERVAL_MS);
  timer.unref?.();
}

/**
 * Stop the proactive checker.
 */
export function stopProactiveChecker(): void {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
