import { probeGate, generateAiTurn } from "./ai.js";
import { getHistory, pushMessage, formatHistoryAsContext } from "./conversation-buffer.js";
import { logger } from "./logger.js";
import config from "../configs/env.js";
import { MAX_BUFFER_TEXT } from "../handlers/constants.js";
import { getStickerEmojiByFileId } from "./stickers.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CHECK_INTERVAL_MS = config.proactiveCheckIntervalMs; // check interval
const WINDOW_MS = config.proactiveWindowMs; // lookback window

// Delay between consecutive bot messages (ms) — mimics human typing rhythm.
const MESSAGE_DELAY_MS = config.proactiveMessageDelayMs;

// Cooldown between bot messages, based on group activity
function getCooldownMs(activityCount: number): number {
  if (activityCount >= 7) return config.proactiveCooldownHighMs; // high activity
  if (activityCount >= 3) return config.proactiveCooldownMediumMs; // medium activity
  return config.proactiveCooldownLowMs; // low activity
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let lastBotMessageTime = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;
let consecutiveFailures = 0;
const MAX_FAILURES = config.proactiveMaxFailures;

// ---------------------------------------------------------------------------
// Callback interface for sending messages to Telegram
// ---------------------------------------------------------------------------

export interface ProactiveCallbacks {
  /** Send a text message to the group (formatting applied by caller). */
  sendText: (text: string) => Promise<void>;
  /** Send a sticker by its Telegram file_id. */
  sendSticker: (stickerFileId: string) => Promise<void>;
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
    const memberMap = new Map<string, { name: string; username?: string }>();
    for (const entry of recentHistory) {
      if (entry.uid !== "bot" && entry.uid !== "system" && !memberMap.has(entry.uid)) {
        memberMap.set(entry.uid, {
          name: entry.name,
          ...(entry.username ? { username: entry.username } : {}),
        });
      }
    }
    const recentMembers = Array.from(memberMap.entries()).map(([uid, info]) => ({
      uid,
      name: info.name,
      ...(info.username ? { username: info.username } : {}),
    }));
    const allowedUids = new Set(memberMap.keys());

    const shouldProceed = await probeGate({
      recentConversation: recentHistory
        .map((entry) => {
          const label = entry.username ? `[${entry.name} (@${entry.username})]` : `[${entry.name}]`;
          return `${label}: ${entry.text}`;
        })
        .join("\n"),
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

    // Lock the cooldown slot *before* calling generateAiTurn
    // This prevents a race condition where users chat during the proactive generation
    // window and end up triggering a double bot response.
    touchBotActivity();

    // Signal "typing..." to the group while the full model runs
    // Use an interval to keep it alive during long DeepSeek thinking phases
    const typingTimer = setInterval(() => {
      callbacks.sendChatAction("typing").catch(() => void 0);
    }, 4500);
    await callbacks.sendChatAction("typing").catch(() => void 0);

    const formattedHistory = formatHistoryAsContext(recentHistory);

    // Collect recent bot messages for human-likeness feedback
    const recentBotMessages = recentHistory
      .filter((e) => e.uid === "bot")
      .map((e) => e.text)
      .slice(-5);

    // Use the current conversation context for the proactive response
    let result;
    try {
      result = await generateAiTurn({
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
    } finally {
      clearInterval(typingTimer);
    }

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
    if (result.stickerFileId) {
      await callbacks.sendSticker(result.stickerFileId);
      if (result.messages.length === 0) {
        const emoji = getStickerEmojiByFileId(result.stickerFileId) ?? "🐱";
        pushMessage(
          config.tgGroupId,
          "bot",
          config.botUsername,
          `[贴纸 ${emoji}: ${result.stickerFileId}]`,
        );
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
