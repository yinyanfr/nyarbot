import { shouldSpeak } from "./ai.js";
import { getHistory, formatHistoryAsContext, pushMessage } from "./conversation-buffer.js";
import { logger } from "./logger.js";
import config from "../configs/env.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CHECK_INTERVAL_MS = 15_000; // check every 15 seconds
const WINDOW_MS = 3 * 60 * 1000; // look at last 3 minutes of messages

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
// Public API
// ---------------------------------------------------------------------------

/**
 * Call this whenever the bot sends a message (triggered or proactive)
 * to reset the cooldown clock.
 */
export function touchBotActivity(): void {
  lastBotMessageTime = Date.now();
}

async function check(sendMessage: (text: string) => Promise<void>): Promise<void> {
  if (stopped) return;

  try {
    const now = Date.now();
    const history = getHistory(config.tgGroupId);

    // Count recent non-bot messages in the window
    const recentCount = history.filter(
      (e) => e.timestamp > now - WINDOW_MS && e.uid !== "bot",
    ).length;

    if (recentCount === 0) return;

    const cooldown = getCooldownMs(recentCount);
    if (now - lastBotMessageTime < cooldown) return;

    const recentHistory = history.filter((e) => e.timestamp > now - WINDOW_MS);
    const formattedHistory = formatHistoryAsContext(recentHistory);
    const reply = await shouldSpeak(formattedHistory);

    if (!reply) return;

    await sendMessage(reply);
    pushMessage(config.tgGroupId, "bot", config.botUsername, reply);
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
      timer = setTimeout(() => check(sendMessage), CHECK_INTERVAL_MS);
      timer.unref?.();
    }
  }
}

/**
 * Start the proactive conversation checker.
 * @param sendMessage - callback to send a message to the group
 */
export function startProactiveChecker(sendMessage: (text: string) => Promise<void>): void {
  if (timer) return;
  stopped = false;
  timer = setTimeout(() => check(sendMessage), CHECK_INTERVAL_MS);
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
