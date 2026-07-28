import { probeGate, generateAiTurn, type RichMediaRef } from "./ai.js";
import {
  getHistory,
  pushMessage,
  formatHistoryAsContext,
  type HistoryEntry,
} from "./conversation-buffer.js";
import { logger } from "./logger.js";
import config from "../configs/env.js";
import { MAX_BUFFER_TEXT } from "../handlers/constants.js";
import { getStickerEmojiByFileId } from "./stickers.js";
import { groupRuntime } from "./group-runtime.js";

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
let stopped = true;
let running = false;
let consecutiveFailures = 0;
const MAX_FAILURES = config.proactiveMaxFailures;
let lastCheckAt: number | null = null;
let lastSuccessAt: number | null = null;
let lastFailureAt: number | null = null;
let lastError: string | null = null;

export interface ProactiveHealthSnapshot {
  readonly running: boolean;
  readonly scheduled: boolean;
  readonly stopped: boolean;
  readonly consecutiveFailures: number;
  readonly lastCheckAt: number | null;
  readonly lastSuccessAt: number | null;
  readonly lastFailureAt: number | null;
  readonly lastError: string | null;
}

// ---------------------------------------------------------------------------
// Callback interface for sending messages to Telegram
// ---------------------------------------------------------------------------

export interface ProactiveCallbacks {
  /** Send a text message to the group (formatting applied by caller). */
  sendText: (text: string) => Promise<boolean>;
  /** Send a sticker by its Telegram file_id. */
  sendSticker: (stickerFileId: string) => Promise<boolean>;
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
  /** Resolve a Telegram file_id to a data URL so proactive turns can inspect images. */
  resolveTelegramFileAsDataUrl: (fileId: string) => Promise<string | null>;
}

function collectRecentImageMediaRefs(recentHistory: HistoryEntry[]): RichMediaRef[] {
  const refs: RichMediaRef[] = [];
  const seen = new Set<string>();

  for (let i = recentHistory.length - 1; i >= 0; i--) {
    const entry = recentHistory[i];
    if (!entry || entry.uid === "bot" || entry.uid === "system") continue;
    for (const media of Array.isArray(entry.mediaRefs) ? entry.mediaRefs : []) {
      if (!media || typeof media !== "object") continue;
      if (media.type !== "image" || !media.fileId || seen.has(media.fileId)) continue;
      seen.add(media.fileId);
      refs.push({
        type: "image",
        source:
          media.source === "current" || media.source === "reply_to" ? media.source : "current",
        fileId: media.fileId,
        ...(media.thumbnailFileId ? { thumbnailFileId: media.thumbnailFileId } : {}),
      });
    }
    if (refs.length > 0) break;
  }

  return refs.slice(0, 2);
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

export function getProactiveHealthSnapshot(): Readonly<ProactiveHealthSnapshot> {
  return Object.freeze({
    running,
    scheduled: timer !== null && !stopped,
    stopped,
    consecutiveFailures,
    lastCheckAt,
    lastSuccessAt,
    lastFailureAt,
    lastError,
  });
}

function getNextCheckDelayMs(): number {
  if (consecutiveFailures === 0) return CHECK_INTERVAL_MS;

  const boundedFailureCount = Math.min(consecutiveFailures, Math.max(1, Math.floor(MAX_FAILURES)));
  return Math.min(CHECK_INTERVAL_MS * 2 ** (boundedFailureCount - 1), 2_147_483_647);
}

function scheduleNextCheck(callbacks: ProactiveCallbacks, delayMs: number): void {
  if (stopped) return;
  timer = setTimeout(() => {
    timer = null;
    void check(callbacks);
  }, delayMs);
  timer.unref?.();
}

async function check(callbacks: ProactiveCallbacks): Promise<void> {
  if (stopped) return;

  running = true;
  lastCheckAt = Date.now();
  let failed = false;

  try {
    const now = Date.now();
    const history = getHistory(config.tgGroupId);
    let latestBotIndex = -1;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i]?.uid === "bot") {
        latestBotIndex = i;
        break;
      }
    }
    const latestBotHistoryTime = latestBotIndex >= 0 ? history[latestBotIndex]!.timestamp : 0;
    const recentWindow = history.filter((entry) => entry.timestamp > now - WINDOW_MS);
    const referenceHistory =
      latestBotIndex >= 0 && latestBotHistoryTime <= now - WINDOW_MS
        ? [history[latestBotIndex]!, ...recentWindow]
        : recentWindow;
    const recentHistory = history
      .slice(latestBotIndex + 1)
      .filter((entry) => entry.timestamp > now - WINDOW_MS);

    // A bot output consumes everything before it; proactive turns only consider
    // new real-user messages that arrived afterwards.
    const recentCount = recentHistory.filter(
      (entry) => entry.uid !== "bot" && entry.uid !== "system",
    ).length;

    if (recentCount === 0) return;
    if (!groupRuntime.canRunProactive()) return;

    const cooldown = getCooldownMs(recentCount);
    const effectiveLastBotMessageTime = Math.max(lastBotMessageTime, latestBotHistoryTime);
    if (now - effectiveLastBotMessageTime < cooldown) return;

    const activityRevision = groupRuntime.getActivityRevision();
    const ran = await groupRuntime.runProactiveTurn(async () => {
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

      const shouldProceed = await probeGate({
        recentConversation: referenceHistory
          .map((entry) => {
            const label = entry.username
              ? `[${entry.name} (@${entry.username})]`
              : `[${entry.name}]`;
            return `${label}: ${entry.text}`;
          })
          .join("\n"),
        candidateConversation: recentHistory
          .map((entry) => {
            const label = entry.username
              ? `[${entry.name} (@${entry.username})]`
              : `[${entry.name}]`;
            return `${label}: ${entry.text}`;
          })
          .join("\n"),
        recentMembers,
      });

      if (!shouldProceed) {
        // Probe decided to stay silent — skip the full model run entirely.
        return;
      }

      if (groupRuntime.getActivityRevision() !== activityRevision) {
        logger.info({ phase: "after_probe" }, "proactive: conversation changed, skipping");
        return;
      }

      // Direct replies update this timestamp even when they bypass the runtime queue.
      const botActivitySnapshot = lastBotMessageTime;
      if (botActivitySnapshot > effectiveLastBotMessageTime) {
        logger.info({ phase: "after_probe" }, "proactive: bot activity changed, skipping");
        return;
      }

      // Signal "typing..." to the group while the full model runs
      // Use an interval to keep it alive during long DeepSeek thinking phases
      const typingTimer = setInterval(() => {
        callbacks.sendChatAction("typing").catch(() => void 0);
      }, 4500);
      await callbacks.sendChatAction("typing").catch(() => void 0);

      const formattedHistory = formatHistoryAsContext(referenceHistory);
      const formattedCandidates = formatHistoryAsContext(recentHistory);

      // Collect recent bot messages for human-likeness feedback
      const recentBotMessages = history
        .filter((entry) => entry.timestamp > now - WINDOW_MS && entry.uid === "bot")
        .map((e) => e.text)
        .slice(-5);

      // Use the current conversation context for the proactive response
      let result;
      try {
        const recentImageMediaRefs = collectRecentImageMediaRefs(recentHistory);
        result = await generateAiTurn({
          userContext: { uid: "proactive", nickname: "", memories: [] },
          userMessage:
            recentImageMediaRefs.length > 0
              ? `（主动性回复：只能回应下方候选消息，其他历史仅用于理解前因。候选中包含图片；若要围绕图片发言，必须先理解图片内容。）\n${formattedCandidates}`
              : `（主动性回复：只能回应下方候选消息，其他历史仅用于理解前因。）\n${formattedCandidates}`,
          recentConversation: formattedHistory,
          recentMembers,
          tier: "simple", // proactive messages should always be short
          needsSearch: false,
          systemHint: null,
          wasMentioned: false,
          wasRepliedTo: false,
          recentBotMessages,
          allowPersistentTools: false,
          ...(recentImageMediaRefs.length > 0 ? { mediaRefs: recentImageMediaRefs } : {}),
          resolveTelegramFileAsDataUrl: callbacks.resolveTelegramFileAsDataUrl,
          allowRichContentTools: recentImageMediaRefs.length > 0,
          ...(recentImageMediaRefs.length > 0 ? { allowMediaTools: true } : {}),
        });
      } finally {
        clearInterval(typingTimer);
      }

      if (result.action === "dismiss") {
        logger.info("proactive: full model chose to dismiss after probe activation");
        await groupRuntime.recordTurn({
          kind: "proactive",
          startedAt: Date.now() - (result.metrics?.latencyMs ?? 0),
          completedAt: Date.now(),
          model: result.metrics?.model ?? "unknown",
          tier: "simple",
          needsSearch: false,
          toolCalls: result.metrics?.toolCalls ?? [],
          action: "dismiss",
          messages: [],
          ...(result.metrics?.inputTokens != null
            ? { inputTokens: result.metrics.inputTokens }
            : {}),
          ...(result.metrics?.outputTokens != null
            ? { outputTokens: result.metrics.outputTokens }
            : {}),
          ...(result.metrics?.cachedInputTokens != null
            ? { cachedInputTokens: result.metrics.cachedInputTokens }
            : {}),
          ...(result.metrics?.latencyMs != null ? { latencyMs: result.metrics.latencyMs } : {}),
        });
        return;
      }

      const conversationChanged = () =>
        groupRuntime.getActivityRevision() !== activityRevision ||
        lastBotMessageTime !== botActivitySnapshot;
      if (conversationChanged()) {
        logger.info({ phase: "before_send" }, "proactive: conversation changed, dropping result");
        return;
      }

      logger.info(
        {
          candidateMessages: recentCount,
          candidateStartTs: recentHistory[0]?.timestamp ?? null,
          candidateEndTs: recentHistory.at(-1)?.timestamp ?? null,
        },
        "proactive: sending reply for new messages",
      );

      // Send all text messages from the result, formatted for Telegram HTML
      const sentMessages: string[] = [];
      let dispatchFailed = false;
      for (let i = 0; i < result.messages.length; i++) {
        if (i > 0 && conversationChanged()) {
          logger.info({ phase: "between_messages" }, "proactive: conversation changed, stopping");
          break;
        }
        const msg = result.messages[i]!;
        if (!(await callbacks.sendText(msg))) {
          dispatchFailed = true;
          break;
        }
        sentMessages.push(msg);
        pushMessage(config.tgGroupId, "bot", config.botUsername, msg.slice(0, MAX_BUFFER_TEXT));
        await groupRuntime.recordBotMessages({ messages: [msg] });

        // Stagger messages to mimic human typing rhythm, but not after the last one
        if (i < result.messages.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, MESSAGE_DELAY_MS));
        }
      }

      // Dispatch sticker — either after text messages, or sticker-only (no text)
      const stickerFileId =
        result.stickerFileId && !dispatchFailed && !conversationChanged()
          ? result.stickerFileId
          : null;
      let sentStickerFileId: string | null = null;
      if (stickerFileId) {
        if (await callbacks.sendSticker(stickerFileId)) {
          sentStickerFileId = stickerFileId;
          if (sentMessages.length === 0) {
            const emoji = getStickerEmojiByFileId(sentStickerFileId) ?? "🐱";
            pushMessage(
              config.tgGroupId,
              "bot",
              config.botUsername,
              `[贴纸 ${emoji}: ${sentStickerFileId}]`,
            );
            await groupRuntime.recordBotMessages({
              messages: [],
              stickerFileId: sentStickerFileId,
            });
          }
        } else {
          dispatchFailed = true;
        }
      }

      const sentOutput = sentMessages.length > 0 || sentStickerFileId !== null;
      const dispatchError = dispatchFailed || !sentOutput;

      await groupRuntime.recordTurn({
        kind: "proactive",
        startedAt: Date.now() - (result.metrics?.latencyMs ?? 0),
        completedAt: Date.now(),
        model: result.metrics?.model ?? "unknown",
        tier: "simple",
        needsSearch: false,
        toolCalls: result.metrics?.toolCalls ?? [],
        action: dispatchError ? "error" : "send",
        messages: sentMessages,
        stickerFileId: sentStickerFileId,
        ...(dispatchError ? { error: "telegram proactive dispatch failed" } : {}),
        ...(result.metrics?.inputTokens != null ? { inputTokens: result.metrics.inputTokens } : {}),
        ...(result.metrics?.outputTokens != null
          ? { outputTokens: result.metrics.outputTokens }
          : {}),
        ...(result.metrics?.cachedInputTokens != null
          ? { cachedInputTokens: result.metrics.cachedInputTokens }
          : {}),
        ...(result.metrics?.latencyMs != null ? { latencyMs: result.metrics.latencyMs } : {}),
      });

      if (!sentOutput) throw new Error("telegram proactive dispatch failed");
      lastBotMessageTime = Date.now();
    });
    if (!ran) return;
  } catch (err) {
    failed = true;
    consecutiveFailures++;
    lastFailureAt = Date.now();
    lastError = err instanceof Error ? err.message : String(err);
    logger.error(err, `proactive check failed (${consecutiveFailures} consecutive failures)`);
  } finally {
    running = false;
    if (!failed) {
      consecutiveFailures = 0;
      lastSuccessAt = Date.now();
      lastError = null;
    }
    // Schedule next check only after current one finishes (prevents overlap)
    scheduleNextCheck(callbacks, getNextCheckDelayMs());
  }
}

/**
 * Start the proactive conversation checker.
 * @param callbacks - object with methods to send messages, stickers, and chat
 *   actions to the group.
 */
export function startProactiveChecker(callbacks: ProactiveCallbacks): void {
  if (timer || running) return;
  stopped = false;
  scheduleNextCheck(callbacks, CHECK_INTERVAL_MS);
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
