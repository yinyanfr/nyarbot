import config from "../configs/env.js";
import { APICallError } from "ai";
import {
  appendCompactionRecord,
  appendRuntimeEvent,
  appendTurnRecord,
  loadRecentRuntimeEvents,
  loadRecentTurnRecords,
  loadRuntimeGroupState,
  writeRuntimeGroupState,
  type RuntimeEventRecord,
  type RuntimeMediaRef,
  type RuntimeReplyRef,
  type RuntimeTurnRecord,
} from "../services/firestore.js";
import { generateConversationCompaction } from "./ai.js";
import { logger } from "./logger.js";

type Timer = ReturnType<typeof setTimeout>;
const MESSAGE_CONTENT_SIGNATURE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface GroupRuntimeState {
  running: boolean;
  dirty: boolean;
  debounceTimer: Timer | null;
  maxDelayTimer: Timer | null;
  pendingSinceMs: number | null;
  quietUntilMs: number;
  lastProcessedMessageId: number | null;
  lastProcessedEventTs: number;
}

export interface IngestMessageInput {
  chatId: string;
  messageId?: number;
  updateId?: number;
  editDate?: number;
  kind: "user_message" | "edited_message" | "command";
  uid: string;
  name: string;
  username?: string;
  text: string;
  mediaRefs: RuntimeMediaRef[];
  urls: string[];
  replyTo?: RuntimeReplyRef;
  ts?: number;
  triggered: boolean;
}

export interface IngestDecision {
  accepted: boolean;
  ignoredReason?: string;
  allowAiTrigger: boolean;
  allowWebSearch: boolean;
  allowMediaTools: boolean;
  lateBindingStatus: string;
}

export interface RuntimeContext {
  summary: string;
  summaryCursorTs: number;
  recentEvents: RuntimeEventRecord[];
  recentEventsText: string;
}

interface UserRuntimeStats {
  recentMessageTs: number[];
  recentUrlTs: number[];
  recentMediaTs: number[];
  cooldownUntilMs: number;
  mediaDisabledUntilMs: number;
  recentTextByText: Map<string, number>;
}

interface ScheduledTurn {
  label: string;
  execute: () => Promise<void>;
}

function pruneOlderThan(values: number[], cutoff: number): number[] {
  return values.filter((value) => value >= cutoff);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function preview(text: string, maxLen = 180): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen - 3)}...` : oneLine;
}

function formatRuntimeEvent(event: RuntimeEventRecord): string {
  const date = new Date(event.ts).toISOString();
  const label = event.username ? `${event.name} (@${event.username})` : event.name;
  const ignored = event.ignoredReason ? ` ignored=${event.ignoredReason}` : "";
  const urls = event.urls.length ? ` urls=${event.urls.join(",")}` : "";
  const media = event.mediaRefs.length
    ? ` media=${event.mediaRefs.map((m) => m.type).join(",")}`
    : "";
  const reply = event.replyTo?.text ? ` reply_to="${preview(event.replyTo.text, 80)}"` : "";
  return `[${date}] ${event.kind}${ignored} ${label}(${event.uid})${reply}: ${preview(event.text)}${urls}${media}`;
}

function formatTurnRecord(turn: RuntimeTurnRecord): string {
  const date = new Date(turn.startedAt).toISOString();
  const tools = turn.toolCalls.map((toolCall) => toolCall.name).join(",");
  const messages = turn.messages.map((message) => preview(message, 80)).join(" / ");
  return `[${date}] ${turn.kind} ${turn.action} model=${turn.model} tier=${turn.tier ?? "n/a"} tools=${tools} messages=${messages}`;
}

function buildMessageContentSignature(input: IngestMessageInput): string {
  const media = input.mediaRefs
    .map((mediaRef) =>
      [mediaRef.source, mediaRef.type, mediaRef.fileId ?? "", mediaRef.thumbnailFileId ?? ""].join(
        ":",
      ),
    )
    .join("|");
  const urls = [...input.urls].sort().join("|");
  const replyTo = input.replyTo
    ? [input.replyTo.uid, input.replyTo.messageId ?? "", input.replyTo.text].join(":")
    : "";
  return JSON.stringify({
    text: input.text.trim(),
    media,
    urls,
    replyTo,
  });
}

class SingleGroupRuntime {
  readonly state: GroupRuntimeState = {
    running: false,
    dirty: false,
    debounceTimer: null,
    maxDelayTimer: null,
    pendingSinceMs: null,
    quietUntilMs: 0,
    lastProcessedMessageId: null,
    lastProcessedEventTs: 0,
  };

  private readonly seenMessageKeys = new Map<string, number>();
  private readonly messageContentSignatures = new Map<string, { signature: string; ts: number }>();
  private readonly userStats = new Map<string, UserRuntimeStats>();
  private readonly recentRealUserEvents: number[] = [];
  private pendingTurn: ScheduledTurn | null = null;
  private compacting = false;
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    try {
      const runtime = await loadRuntimeGroupState();
      this.state.lastProcessedMessageId = runtime.lastProcessedMessageId ?? null;
      this.state.lastProcessedEventTs = runtime.summaryCursorTs;
    } catch (err) {
      logger.warn({ err }, "group runtime init failed");
    }
  }

  getStatusSnapshot(): {
    running: boolean;
    dirty: boolean;
    debouncing: boolean;
    quietUntilMs: number;
    quietRemainingMs: number;
    pendingSinceMs: number | null;
  } {
    const now = Date.now();
    return {
      running: this.state.running,
      dirty: this.state.dirty,
      debouncing: this.state.debounceTimer !== null,
      quietUntilMs: this.state.quietUntilMs,
      quietRemainingMs: Math.max(0, this.state.quietUntilMs - now),
      pendingSinceMs: this.state.pendingSinceMs,
    };
  }

  async loadContext(): Promise<RuntimeContext> {
    await this.init();
    const runtime = await loadRuntimeGroupState();
    const recentEvents = await loadRecentRuntimeEvents({
      afterTs: runtime.summaryCursorTs,
      limit: config.runtimeMaxRecentEvents + config.runtimeRetainRecentEvents,
      newestFirst: true,
    });
    return {
      summary: runtime.summary,
      summaryCursorTs: runtime.summaryCursorTs,
      recentEvents,
      recentEventsText: recentEvents.map(formatRuntimeEvent).join("\n"),
    };
  }

  async ingestUserMessage(input: IngestMessageInput): Promise<IngestDecision> {
    await this.init();
    const now = input.ts ?? Date.now();
    const messageKey = `${input.chatId}:${input.messageId ?? "none"}:${input.editDate ?? "none"}`;
    const contentKey = input.messageId != null ? `${input.chatId}:${input.messageId}` : null;
    const oldSeenCutoff = now - 10 * 60 * 1000;
    for (const [key, ts] of this.seenMessageKeys) {
      if (ts < oldSeenCutoff) this.seenMessageKeys.delete(key);
    }
    const oldContentCutoff = now - MESSAGE_CONTENT_SIGNATURE_TTL_MS;
    for (const [key, entry] of this.messageContentSignatures) {
      if (entry.ts < oldContentCutoff) this.messageContentSignatures.delete(key);
    }

    let ignoredReason: string | undefined;
    if (input.messageId != null && this.seenMessageKeys.has(messageKey)) {
      ignoredReason = "duplicate_message";
    }
    const contentSignature = buildMessageContentSignature(input);
    if (!ignoredReason && input.kind === "edited_message" && contentKey) {
      const lastContent = this.messageContentSignatures.get(contentKey);
      if (lastContent?.signature === contentSignature) {
        ignoredReason = "non_content_edit";
      }
    }
    this.seenMessageKeys.set(messageKey, now);
    if (contentKey) {
      this.messageContentSignatures.set(contentKey, { signature: contentSignature, ts: now });
    }

    const stats = this.getUserStats(input.uid);
    stats.recentMessageTs = pruneOlderThan(
      [...stats.recentMessageTs, now],
      now - config.runtimeUserBurstWindowMs,
    );
    stats.recentUrlTs = pruneOlderThan(
      [...stats.recentUrlTs, ...input.urls.map(() => now)],
      now - config.runtimeUrlFloodWindowMs,
    );
    stats.recentMediaTs = pruneOlderThan(
      [...stats.recentMediaTs, ...input.mediaRefs.map(() => now)],
      now - config.runtimeMediaFloodWindowMs,
    );

    const normalizedText = input.text.trim();
    if (!ignoredReason && normalizedText) {
      const lastSameTextTs = stats.recentTextByText.get(normalizedText);
      if (lastSameTextTs && now - lastSameTextTs <= config.runtimeDuplicateTextWindowMs) {
        ignoredReason = "duplicate_text";
      }
      stats.recentTextByText.set(normalizedText, now);
      for (const [text, ts] of stats.recentTextByText) {
        if (now - ts > config.runtimeDuplicateTextWindowMs) stats.recentTextByText.delete(text);
      }
    }

    if (!ignoredReason && stats.recentMessageTs.length > config.runtimeUserBurstThreshold) {
      stats.cooldownUntilMs = now + config.runtimeUserCooldownMs;
      ignoredReason = "user_rate_limited";
    } else if (!ignoredReason && stats.cooldownUntilMs > now) {
      ignoredReason = "user_rate_limited";
    }

    const allowWebSearch = stats.recentUrlTs.length <= config.runtimeUrlFloodThreshold;
    if (stats.recentMediaTs.length > config.runtimeMediaFloodThreshold) {
      stats.mediaDisabledUntilMs = now + config.runtimeMediaFloodCooldownMs;
    }
    const allowMediaTools = stats.mediaDisabledUntilMs <= now;

    this.recentRealUserEvents.push(now);
    while (
      this.recentRealUserEvents.length > 0 &&
      this.recentRealUserEvents[0]! < now - config.runtimeQuietWindowMs
    ) {
      this.recentRealUserEvents.shift();
    }
    if (this.recentRealUserEvents.length >= config.runtimeHotChatThreshold) {
      this.state.quietUntilMs = Math.max(
        this.state.quietUntilMs,
        now + config.runtimeQuietDurationMs,
      );
    }

    const quiet = this.state.quietUntilMs > now;
    const allowAiTrigger =
      input.triggered &&
      !ignoredReason &&
      (!quiet || input.triggered) &&
      stats.cooldownUntilMs <= now;

    await appendRuntimeEvent({
      chatId: input.chatId,
      ...(input.messageId != null ? { messageId: input.messageId } : {}),
      ...(input.updateId != null ? { updateId: input.updateId } : {}),
      kind: input.kind,
      uid: input.uid,
      name: input.name,
      ...(input.username ? { username: input.username } : {}),
      text: input.text,
      mediaRefs: input.mediaRefs,
      urls: input.urls,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      ts: now,
      ...(ignoredReason ? { ignoredReason } : {}),
    });

    this.state.lastProcessedEventTs = now;
    if (input.messageId != null) {
      this.state.lastProcessedMessageId = input.messageId;
      await writeRuntimeGroupState({ lastProcessedMessageId: input.messageId });
    }

    const disabledReasons: string[] = [];
    if (quiet)
      disabledReasons.push(`quiet_mode_until=${new Date(this.state.quietUntilMs).toISOString()}`);
    if (!allowWebSearch) disabledReasons.push("url_flood_search_disabled");
    if (!allowMediaTools) disabledReasons.push("media_flood_describe_disabled");
    if (ignoredReason) disabledReasons.push(`ignored=${ignoredReason}`);

    return {
      accepted: !ignoredReason,
      ...(ignoredReason ? { ignoredReason } : {}),
      allowAiTrigger,
      allowWebSearch,
      allowMediaTools,
      lateBindingStatus: disabledReasons.join("; "),
    };
  }

  async recordBotMessages(params: {
    messages: string[];
    stickerFileId?: string | null;
    kind?: RuntimeEventRecord["kind"];
  }): Promise<void> {
    try {
      const now = Date.now();
      for (const message of params.messages) {
        await appendRuntimeEvent({
          chatId: config.tgGroupId,
          kind: params.kind ?? "bot_message",
          uid: "bot",
          name: config.botUsername,
          text: message,
          mediaRefs: [],
          urls: [],
          ts: now,
        });
      }
      if (params.messages.length === 0 && params.stickerFileId) {
        await appendRuntimeEvent({
          chatId: config.tgGroupId,
          kind: params.kind ?? "bot_message",
          uid: "bot",
          name: config.botUsername,
          text: `[贴纸: ${params.stickerFileId}]`,
          mediaRefs: [{ type: "sticker", fileId: params.stickerFileId }],
          urls: [],
          ts: now,
        });
      }
    } catch (err) {
      logger.warn({ err }, "runtime bot event persistence failed");
    }
  }

  async recordTurn(record: RuntimeTurnRecord): Promise<void> {
    try {
      await appendTurnRecord(record);
    } catch (err) {
      logger.warn({ err }, "runtime turn persistence failed");
      return;
    }
    await this.maybeCompact().catch((err: unknown) => {
      logger.warn({ err }, "runtime compaction trigger failed");
    });
  }

  schedulePassiveTurn(turn: ScheduledTurn): void {
    this.pendingTurn = turn;
    if (this.state.running) {
      this.state.dirty = true;
      return;
    }
    this.scheduleDebounce();
  }

  canRunProactive(): boolean {
    const now = Date.now();
    return (
      !this.state.running &&
      this.state.debounceTimer === null &&
      this.state.maxDelayTimer === null &&
      this.state.quietUntilMs <= now
    );
  }

  async runProactiveTurn(execute: () => Promise<void>): Promise<boolean> {
    if (!this.canRunProactive()) return false;
    this.state.running = true;
    try {
      await execute();
      return true;
    } finally {
      this.state.running = false;
      if (this.state.dirty && this.pendingTurn) {
        this.state.dirty = false;
        this.scheduleDebounce();
      }
    }
  }

  async maybeCompact(): Promise<void> {
    if (this.compacting) return;
    this.compacting = true;
    try {
      const runtime = await loadRuntimeGroupState();
      const recentEvents = await loadRecentRuntimeEvents({
        afterTs: runtime.summaryCursorTs,
        limit: config.runtimeMaxRecentEvents + config.runtimeRetainRecentEvents + 80,
      });
      const recentText = recentEvents.map(formatRuntimeEvent).join("\n");
      const shouldCompact =
        recentEvents.length > config.runtimeMaxRecentEvents ||
        estimateTokens(recentText) > config.runtimeMaxContextEstTokens;
      if (!shouldCompact || recentEvents.length <= config.runtimeRetainRecentEvents) return;

      const compactUntilIndex = Math.max(0, recentEvents.length - config.runtimeRetainRecentEvents);
      const eventsToCompact = recentEvents.slice(0, compactUntilIndex);
      const newCursorTs = eventsToCompact.at(-1)?.ts;
      if (!newCursorTs) return;

      const turns = await loadRecentTurnRecords({
        afterTs: runtime.summaryCursorTs,
        limit: 120,
      });
      const eventText = eventsToCompact.map(formatRuntimeEvent).join("\n");
      const turnText = turns
        .filter((turn) => turn.startedAt <= newCursorTs)
        .map(formatTurnRecord)
        .join("\n");

      let result: Awaited<ReturnType<typeof generateConversationCompaction>>;
      try {
        result = await generateConversationCompaction({
          previousSummary: runtime.summary,
          eventText,
          turnText,
        });
      } catch (err) {
        logger.warn(
          {
            oldCursorTs: runtime.summaryCursorTs,
            newCursorTs,
            compactedEvents: eventsToCompact.length,
            previousSummaryLength: runtime.summary.length,
            eventTextLength: eventText.length,
            turnTextLength: turnText.length,
            ...(APICallError.isInstance(err)
              ? {
                  statusCode: err.statusCode,
                  url: err.url,
                  responseBody: err.responseBody,
                  requestBodyValues: err.requestBodyValues,
                }
              : {}),
            err,
          },
          "runtime compaction failed",
        );
        throw err;
      }

      await appendCompactionRecord({
        oldCursorTs: runtime.summaryCursorTs,
        newCursorTs,
        summary: result.summary,
        inputTokens: result.inputTokens ?? 0,
        outputTokens: result.outputTokens ?? 0,
        createdAt: Date.now(),
      });
      await writeRuntimeGroupState({
        summary: result.summary,
        summaryCursorTs: newCursorTs,
        lastCompactedAt: Date.now(),
      });
      logger.info(
        {
          oldCursorTs: runtime.summaryCursorTs,
          newCursorTs,
          compactedEvents: eventsToCompact.length,
        },
        "runtime compaction completed",
      );
    } finally {
      this.compacting = false;
    }
  }

  private getUserStats(uid: string): UserRuntimeStats {
    let stats = this.userStats.get(uid);
    if (!stats) {
      stats = {
        recentMessageTs: [],
        recentUrlTs: [],
        recentMediaTs: [],
        cooldownUntilMs: 0,
        mediaDisabledUntilMs: 0,
        recentTextByText: new Map(),
      };
      this.userStats.set(uid, stats);
    }
    return stats;
  }

  private scheduleDebounce(): void {
    const now = Date.now();
    const isFirstSchedule = this.state.pendingSinceMs === null;
    if (this.state.pendingSinceMs === null) {
      this.state.pendingSinceMs = now;
      this.state.maxDelayTimer = setTimeout(() => this.runPendingTurn(), config.runtimeMaxDelayMs);
      this.state.maxDelayTimer.unref?.();
    }

    if (this.state.debounceTimer) clearTimeout(this.state.debounceTimer);
    const delay =
      this.state.quietUntilMs > now
        ? config.runtimeMaxDelayMs
        : isFirstSchedule
          ? config.runtimeInitialDelayMs
          : config.runtimeTypingExtendMs;
    this.state.debounceTimer = setTimeout(() => this.runPendingTurn(), delay);
    this.state.debounceTimer.unref?.();
  }

  private clearTimers(): void {
    if (this.state.debounceTimer) clearTimeout(this.state.debounceTimer);
    if (this.state.maxDelayTimer) clearTimeout(this.state.maxDelayTimer);
    this.state.debounceTimer = null;
    this.state.maxDelayTimer = null;
    this.state.pendingSinceMs = null;
  }

  private async runPendingTurn(): Promise<void> {
    if (this.state.running) {
      this.state.dirty = true;
      return;
    }
    const turn = this.pendingTurn;
    if (!turn) {
      this.clearTimers();
      return;
    }

    this.clearTimers();
    this.pendingTurn = null;
    this.state.running = true;
    try {
      logger.info({ label: turn.label }, "group runtime starting AI turn");
      await turn.execute();
    } catch (err) {
      logger.error({ err, label: turn.label }, "group runtime scheduled turn failed");
    } finally {
      this.state.running = false;
      if (this.state.dirty && this.pendingTurn) {
        this.state.dirty = false;
        this.scheduleDebounce();
      } else {
        this.state.dirty = false;
      }
    }
  }
}

export const groupRuntime = new SingleGroupRuntime();
