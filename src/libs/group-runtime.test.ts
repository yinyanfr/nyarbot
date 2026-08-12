import assert from "node:assert/strict";
import test from "node:test";
import type {
  RuntimeEventRecord,
  RuntimeGroupStateDoc,
  RuntimeTurnRecord,
} from "../services/persistence.js";
import {
  createGroupRuntime,
  type GroupRuntimeDependencies,
  type IngestMessageInput,
} from "./group-runtime.js";

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FakeTimer {
  id: number;
  due: number;
  callback: () => void;
  cancelled: boolean;
  unref(): void;
}

function createHarness(
  overrides: Partial<GroupRuntimeDependencies> = {},
  configOverrides: Partial<GroupRuntimeDependencies["config"]> = {},
) {
  let now = 1_000;
  let nextTimerId = 1;
  const timers: FakeTimer[] = [];
  const microtasks: (() => void)[] = [];
  const events: RuntimeEventRecord[] = [];
  const advanced: { event: RuntimeEventRecord; messageId: number }[] = [];
  const turns: RuntimeTurnRecord[] = [];
  const commits: Parameters<GroupRuntimeDependencies["commitRuntimeCompaction"]>[] = [];
  const logs: { level: string; data: object; message: string }[] = [];
  let runtimeState: RuntimeGroupStateDoc = {
    summary: "",
    summaryCursorTs: 0,
    updatedAt: 0,
  };
  let recentEvents: RuntimeEventRecord[] = [];
  let recentTurns: RuntimeTurnRecord[] = [];

  const config = {
    botUsername: "test_bot",
    tgGroupId: "-100",
    runtimeDuplicateTextWindowMs: 100,
    runtimeHotChatThreshold: 3,
    runtimeInitialDelayMs: 20,
    runtimeMaxContextEstTokens: 100,
    runtimeMaxDelayMs: 50,
    runtimeMaxRecentEvents: 4,
    runtimeMediaFloodCooldownMs: 200,
    runtimeMediaFloodThreshold: 2,
    runtimeMediaFloodWindowMs: 100,
    runtimeQuietDurationMs: 80,
    runtimeQuietWindowMs: 40,
    runtimeRetainRecentEvents: 2,
    runtimeTypingExtendMs: 15,
    runtimeUrlFloodThreshold: 2,
    runtimeUrlFloodWindowMs: 100,
    runtimeUserBurstThreshold: 3,
    runtimeUserBurstWindowMs: 100,
    runtimeUserCooldownMs: 60,
    ...configOverrides,
  } satisfies GroupRuntimeDependencies["config"];

  const dependencies: GroupRuntimeDependencies = {
    config,
    appendRuntimeEvent: async (event) => {
      events.push(event);
    },
    appendRuntimeEventAndAdvance: async (event, messageId) => {
      advanced.push({ event, messageId });
    },
    appendTurnRecord: async (turn) => {
      turns.push(turn);
    },
    commitRuntimeCompaction: async (...args) => {
      commits.push(args);
    },
    generateConversationCompaction: async () => ({
      summary: "compacted",
      inputTokens: 9,
      outputTokens: 3,
    }),
    loadRecentRuntimeEvents: async () => recentEvents,
    loadRecentTurnRecords: async () => recentTurns,
    loadRuntimeGroupState: async () => runtimeState,
    logger: {
      info: (data, message) => logs.push({ level: "info", data, message }),
      warn: (data, message) => logs.push({ level: "warn", data, message }),
      error: (data, message) => logs.push({ level: "error", data, message }),
    },
    now: () => now,
    setTimeout: (callback, delay) => {
      const timer: FakeTimer = {
        id: nextTimerId++,
        due: now + delay,
        callback,
        cancelled: false,
        unref: () => undefined,
      };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (timer) => {
      (timer as unknown as FakeTimer).cancelled = true;
    },
    queueMicrotask: (callback) => microtasks.push(callback),
    ...overrides,
  };

  return {
    runtime: createGroupRuntime(dependencies),
    config: dependencies.config,
    dependencies,
    events,
    advanced,
    turns,
    commits,
    logs,
    setNow(value: number) {
      now = value;
    },
    setRuntimeState(value: RuntimeGroupStateDoc) {
      runtimeState = value;
    },
    setRecentEvents(value: RuntimeEventRecord[]) {
      recentEvents = value;
    },
    setRecentTurns(value: RuntimeTurnRecord[]) {
      recentTurns = value;
    },
    async tick(milliseconds: number) {
      const target = now + milliseconds;
      while (true) {
        const timer = timers
          .filter((candidate) => !candidate.cancelled && candidate.due <= target)
          .sort((a, b) => a.due - b.due || a.id - b.id)[0];
        if (!timer) break;
        now = timer.due;
        timer.cancelled = true;
        timer.callback();
        await flush();
      }
      now = target;
      await flush();
    },
    async drainMicrotasks() {
      while (microtasks.length > 0) {
        microtasks.shift()!();
        await flush();
      }
    },
  };
}

function input(overrides: Partial<IngestMessageInput> = {}): IngestMessageInput {
  return {
    chatId: "-100",
    messageId: 1,
    kind: "user_message",
    uid: "u1",
    name: "Alice",
    text: "hello",
    mediaRefs: [],
    urls: [],
    triggered: true,
    ...overrides,
  };
}

function idlessInput(overrides: Partial<IngestMessageInput> = {}): IngestMessageInput {
  const value = input(overrides);
  delete value.messageId;
  return value;
}

function event(ts: number, text = `event-${ts}`): RuntimeEventRecord {
  return {
    chatId: "-100",
    messageId: ts,
    kind: "user_message",
    uid: "u1",
    name: "Alice",
    text,
    mediaRefs: [],
    urls: [],
    ts,
  };
}

const turnRecord: RuntimeTurnRecord = {
  kind: "passive",
  startedAt: 10,
  completedAt: 20,
  model: "fake",
  needsSearch: false,
  toolCalls: [],
  action: "send",
  messages: ["reply"],
};

test("init restores cursors once and tolerates a load failure", async () => {
  let loads = 0;
  const restored = createHarness({
    loadRuntimeGroupState: async () => {
      loads++;
      return { summary: "old", summaryCursorTs: 44, lastProcessedMessageId: 9, updatedAt: 0 };
    },
  });
  await restored.runtime.init();
  await restored.runtime.init();
  assert.equal(loads, 1);
  assert.equal(restored.runtime.state.lastProcessedMessageId, 9);
  assert.equal(restored.runtime.state.lastProcessedEventTs, 44);

  const failed = createHarness({
    loadRuntimeGroupState: async () => {
      throw new Error("offline");
    },
  });
  await failed.runtime.init();
  await failed.runtime.init();
  assert.equal(failed.logs.filter((log) => log.level === "warn").length, 1);
});

test("loadContext uses the restored cursor and formats persisted events", async () => {
  const harness = createHarness();
  harness.setRuntimeState({ summary: "known", summaryCursorTs: 5, updatedAt: 0 });
  harness.setRecentEvents([event(6)]);
  const context = await harness.runtime.loadContext();
  assert.equal(context.summary, "known");
  assert.equal(context.summaryCursorTs, 5);
  assert.deepEqual(context.recentEvents, [event(6)]);
  assert.match(context.recentEventsText, /Alice\(u1\): event-6/);
});

test("deduplicates deliveries and distinguishes content-changing edits", async () => {
  const harness = createHarness();
  assert.equal((await harness.runtime.ingestUserMessage(input({ ts: 1_000 }))).accepted, true);
  const duplicate = await harness.runtime.ingestUserMessage(input({ ts: 1_001 }));
  assert.equal(duplicate.ignoredReason, "duplicate_message");

  const unchangedEdit = await harness.runtime.ingestUserMessage(
    input({ kind: "edited_message", editDate: 2, urls: ["b", "a"], ts: 1_102 }),
  );
  assert.equal(unchangedEdit.accepted, true);
  const reorderedEdit = await harness.runtime.ingestUserMessage(
    input({ kind: "edited_message", editDate: 3, urls: ["a", "b"], ts: 1_203 }),
  );
  assert.equal(reorderedEdit.ignoredReason, "non_content_edit");
  const changedEdit = await harness.runtime.ingestUserMessage(
    input({ kind: "edited_message", editDate: 4, text: "changed", urls: ["a", "b"], ts: 1_304 }),
  );
  assert.equal(changedEdit.accepted, true);
  assert.equal(harness.advanced.length, 5);
  assert.equal(harness.advanced[1]!.event.ignoredReason, "duplicate_message");
});

test("content signatures include media and replies and expire after seven days", async () => {
  const harness = createHarness();
  const media = [{ source: "telegram", type: "photo", fileId: "one" }];
  const replyTo = { uid: "u2", name: "Bob", text: "quoted", messageId: 8 };
  await harness.runtime.ingestUserMessage(input({ mediaRefs: media, replyTo, ts: 1_000 }));
  const mediaEdit = await harness.runtime.ingestUserMessage(
    input({
      kind: "edited_message",
      editDate: 2,
      mediaRefs: [{ ...media[0]!, fileId: "two" }],
      replyTo,
      ts: 1_101,
    }),
  );
  assert.equal(mediaEdit.accepted, true);
  const replyEdit = await harness.runtime.ingestUserMessage(
    input({
      kind: "edited_message",
      editDate: 3,
      mediaRefs: media,
      replyTo: { ...replyTo, text: "new" },
      ts: 1_202,
    }),
  );
  assert.equal(replyEdit.accepted, true);
  const expired = await harness.runtime.ingestUserMessage(
    input({ kind: "edited_message", editDate: 4, mediaRefs: media, replyTo, ts: 604_801_003 }),
  );
  assert.equal(expired.accepted, true);
});

test("applies duplicate-text and burst cooldown gates per user", async () => {
  const harness = createHarness();
  await harness.runtime.ingestUserMessage(input({ messageId: 1, ts: 1_000 }));
  const repeated = await harness.runtime.ingestUserMessage(input({ messageId: 2, ts: 1_010 }));
  assert.equal(repeated.ignoredReason, "duplicate_text");
  await harness.runtime.ingestUserMessage(input({ messageId: 3, text: "two", ts: 1_020 }));
  await harness.runtime.ingestUserMessage(input({ messageId: 4, text: "three", ts: 1_030 }));
  const burst = await harness.runtime.ingestUserMessage(
    input({ messageId: 5, text: "four", ts: 1_040 }),
  );
  assert.equal(burst.ignoredReason, "user_rate_limited");
  const cooldown = await harness.runtime.ingestUserMessage(
    input({ messageId: 6, text: "five", ts: 1_101 }),
  );
  assert.equal(cooldown.ignoredReason, "user_rate_limited");
  const recovered = await harness.runtime.ingestUserMessage(
    input({ messageId: 7, text: "six", ts: 1_201 }),
  );
  assert.equal(recovered.accepted, true);
  const otherUser = await harness.runtime.ingestUserMessage(
    input({ messageId: 8, uid: "u2", text: "hello", ts: 1_041 }),
  );
  assert.equal(otherUser.accepted, true);
});

test("disables URL and media tools at flood thresholds and recovers after cooldown", async () => {
  const harness = createHarness();
  const first = await harness.runtime.ingestUserMessage(
    input({ messageId: 1, text: "one", urls: ["a", "b", "c"], ts: 1_000 }),
  );
  assert.equal(first.allowWebSearch, false);
  assert.match(first.lateBindingStatus, /url_flood_search_disabled/);
  const mediaFlood = await harness.runtime.ingestUserMessage(
    input({
      messageId: 2,
      text: "two",
      mediaRefs: [
        { type: "photo", fileId: "1" },
        { type: "photo", fileId: "2" },
        { type: "photo", fileId: "3" },
      ],
      ts: 1_001,
    }),
  );
  assert.equal(mediaFlood.allowMediaTools, false);
  assert.match(mediaFlood.lateBindingStatus, /media_flood_describe_disabled/);
  const recovered = await harness.runtime.ingestUserMessage(
    input({ messageId: 3, text: "three", ts: 1_202 }),
  );
  assert.equal(recovered.allowWebSearch, true);
  assert.equal(recovered.allowMediaTools, true);
});

test("hot chat enters quiet mode, keeps explicit triggers eligible, and blocks proactive", async () => {
  const harness = createHarness();
  for (let index = 0; index < 3; index++) {
    await harness.runtime.ingestUserMessage(
      input({ messageId: index + 1, uid: `u${index}`, text: `${index}`, ts: 1_000 + index }),
    );
  }
  assert.equal(harness.runtime.state.quietUntilMs, 1_082);
  assert.equal(harness.runtime.canRunProactive(), false);
  const triggered = await harness.runtime.ingestUserMessage(
    input({ messageId: 4, uid: "u4", text: "ping", ts: 1_003, triggered: true }),
  );
  assert.equal(triggered.allowAiTrigger, true);
  assert.match(triggered.lateBindingStatus, /quiet_mode_until=/);
  const passive = await harness.runtime.ingestUserMessage(
    input({ messageId: 5, uid: "u5", text: "passive", ts: 1_004, triggered: false }),
  );
  assert.equal(passive.allowAiTrigger, false);
  harness.setNow(1_200);
  assert.equal(harness.runtime.canRunProactive(), true);
});

test("persists message-id events atomically and id-less events directly", async () => {
  const harness = createHarness();
  await harness.runtime.ingestUserMessage(input({ messageId: 7, updateId: 70, ts: 1_000 }));
  await harness.runtime.ingestUserMessage(idlessInput({ updateId: 71, text: "idless", ts: 1_001 }));
  assert.equal(harness.advanced.length, 1);
  assert.equal(harness.advanced[0]!.messageId, 7);
  assert.equal(harness.events.length, 1);
  assert.equal(harness.runtime.state.lastProcessedMessageId, 7);
  assert.equal(harness.runtime.state.lastProcessedEventTs, 1_001);

  const failed = createHarness({
    appendRuntimeEventAndAdvance: async () => {
      throw new Error("write failed");
    },
  });
  await assert.rejects(failed.runtime.ingestUserMessage(input()), /write failed/);
  assert.equal(failed.runtime.canRunProactive(), true);
});

test("passive turns debounce to the latest turn, extend typing, and honor max delay", async () => {
  const harness = createHarness();
  const order: string[] = [];
  harness.runtime.schedulePassiveTurn({
    label: "one",
    execute: async () => void order.push("one"),
  });
  await harness.tick(10);
  harness.runtime.schedulePassiveTurn({
    label: "two",
    execute: async () => void order.push("two"),
  });
  await harness.tick(14);
  assert.equal(order.length, 0);
  await harness.tick(1);
  assert.deepEqual(order, ["two"]);
  assert.equal(harness.runtime.getStatusSnapshot().pendingSinceMs, null);

  harness.runtime.schedulePassiveTurn({
    label: "three",
    execute: async () => void order.push("three"),
  });
  for (let index = 0; index < 3; index++) {
    await harness.tick(10);
    harness.runtime.schedulePassiveTurn({
      label: `latest-${index}`,
      execute: async () => void order.push(`latest-${index}`),
    });
  }
  await harness.tick(20);
  assert.deepEqual(order, ["two", "latest-2"]);
});

test("a passive arrival during a running turn marks dirty and runs after a fresh debounce", async () => {
  const harness = createHarness();
  const gate = deferred();
  const order: string[] = [];
  harness.runtime.schedulePassiveTurn({
    label: "running",
    execute: async () => {
      order.push("running");
      await gate.promise;
    },
  });
  await harness.tick(20);
  harness.runtime.schedulePassiveTurn({
    label: "dirty",
    execute: async () => void order.push("dirty"),
  });
  assert.equal(harness.runtime.state.dirty, true);
  gate.resolve();
  await flush();
  assert.equal(harness.runtime.state.dirty, false);
  await harness.tick(19);
  assert.deepEqual(order, ["running"]);
  await harness.tick(1);
  assert.deepEqual(order, ["running", "dirty"]);
});

test("command turns run FIFO and wait behind passive work", async () => {
  const harness = createHarness();
  const order: string[] = [];
  harness.runtime.schedulePassiveTurn({
    label: "passive",
    execute: async () => void order.push("passive"),
  });
  for (const label of ["command-1", "command-2"]) {
    harness.runtime.scheduleCommandTurn({ label, execute: async () => void order.push(label) });
  }
  await harness.drainMicrotasks();
  assert.equal(order.length, 0);
  await harness.tick(20);
  await harness.drainMicrotasks();
  assert.deepEqual(order, ["passive", "command-1", "command-2"]);

  const direct = createHarness();
  direct.runtime.scheduleCommandTurn({ label: "now", execute: async () => void order.push("now") });
  assert.equal(direct.runtime.canRunProactive(), false);
  await direct.drainMicrotasks();
  assert.equal(order.at(-1), "now");
});

test("proactive locks and activity revisions cover ingestion and explicit activity", async () => {
  const harness = createHarness();
  assert.equal(harness.runtime.getActivityRevision(), 0);
  const release = harness.runtime.beginIncomingActivity();
  assert.equal(harness.runtime.getActivityRevision(), 1);
  assert.equal(harness.runtime.canRunProactive(), false);
  release();
  release();
  assert.equal(harness.runtime.canRunProactive(), true);

  const load = deferred<RuntimeGroupStateDoc>();
  const ingesting = createHarness({ loadRuntimeGroupState: () => load.promise });
  const ingestPromise = ingesting.runtime.ingestUserMessage(input());
  assert.equal(ingesting.runtime.getActivityRevision(), 1);
  assert.equal(ingesting.runtime.canRunProactive(), false);
  load.resolve({ summary: "", summaryCursorTs: 0, updatedAt: 0 });
  await ingestPromise;
  assert.equal(ingesting.runtime.canRunProactive(), true);

  const gate = deferred();
  const proactive = harness.runtime.runProactiveTurn(() => gate.promise);
  assert.equal(harness.runtime.state.running, true);
  assert.equal(await harness.runtime.runProactiveTurn(async () => undefined), false);
  gate.resolve();
  assert.equal(await proactive, true);
  assert.equal(harness.runtime.state.running, false);
});

test("records bot text or sticker events and treats persistence as best effort", async () => {
  const harness = createHarness();
  await harness.runtime.recordBotMessages({ messages: ["one", "two"] });
  await harness.runtime.recordBotMessages({ messages: [], stickerFileId: "sticker" });
  await harness.runtime.recordBotMessages({ messages: [], stickerFileId: null });
  assert.deepEqual(
    harness.events.map((item) => item.text),
    ["one", "two", "[贴纸: sticker]"],
  );
  assert.equal(harness.events[0]!.chatId, "-100");
  assert.equal(harness.events[0]!.name, "test_bot");
  assert.deepEqual(harness.events[2]!.mediaRefs, [{ type: "sticker", fileId: "sticker" }]);

  const failed = createHarness({
    appendRuntimeEvent: async () => {
      throw new Error("write failed");
    },
  });
  await failed.runtime.recordBotMessages({ messages: ["ignored"] });
  assert.match(failed.logs[0]!.message, /persistence failed/);
});

test("records turns, skips compaction below both thresholds, and survives write failure", async () => {
  let compactions = 0;
  const harness = createHarness({
    generateConversationCompaction: async () => {
      compactions++;
      return { summary: "unused" };
    },
  });
  harness.setRecentEvents([event(1), event(2)]);
  await harness.runtime.recordTurn(turnRecord);
  assert.deepEqual(harness.turns, [turnRecord]);
  assert.equal(compactions, 0);

  const failed = createHarness({
    appendTurnRecord: async () => {
      throw new Error("write failed");
    },
    generateConversationCompaction: async () => {
      throw new Error("must not run");
    },
  });
  await failed.runtime.recordTurn(turnRecord);
  assert.equal(failed.logs.length, 1);
  assert.match(failed.logs[0]!.message, /turn persistence failed/);
});

test("compacts by event count, retains the working tail, filters turns, and commits atomically", async () => {
  const harness = createHarness();
  harness.setNow(9_000);
  harness.setRuntimeState({ summary: "previous", summaryCursorTs: 5, updatedAt: 0 });
  harness.setRecentEvents([event(10), event(20), event(30), event(40), event(50)]);
  harness.setRecentTurns([
    { ...turnRecord, startedAt: 15 },
    { ...turnRecord, startedAt: 35 },
  ]);
  let request:
    | Parameters<GroupRuntimeDependencies["generateConversationCompaction"]>[0]
    | undefined;
  harness.dependencies.generateConversationCompaction = async (params) => {
    request = params;
    return { summary: "new", inputTokens: 7, outputTokens: 2 };
  };
  await harness.runtime.maybeCompact();
  assert.match(request!.eventText, /event-10/);
  assert.match(request!.eventText, /event-30/);
  assert.doesNotMatch(request!.eventText, /event-40/);
  assert.match(request!.turnText, /startedAt|reply|passive/);
  assert.equal(harness.commits.length, 1);
  assert.deepEqual(harness.commits[0], [
    {
      oldCursorTs: 5,
      newCursorTs: 30,
      summary: "new",
      inputTokens: 7,
      outputTokens: 2,
      createdAt: 9_000,
    },
    { summary: "new", summaryCursorTs: 30, lastCompactedAt: 9_000 },
  ]);
});

test("compacts by token estimate and does nothing when the retained tail is all events", async () => {
  let generated = 0;
  const harness = createHarness(
    {
      generateConversationCompaction: async () => {
        generated++;
        return { summary: "new" };
      },
    },
    { runtimeMaxRecentEvents: 100, runtimeMaxContextEstTokens: 5 },
  );
  harness.setRecentEvents([event(10, "x".repeat(30)), event(20), event(30)]);
  await harness.runtime.maybeCompact();
  assert.equal(generated, 1);

  const retained = createHarness(
    {},
    { runtimeMaxContextEstTokens: 1, runtimeRetainRecentEvents: 3 },
  );
  retained.setRecentEvents([event(10), event(20), event(30)]);
  await retained.runtime.maybeCompact();
  assert.equal(retained.commits.length, 0);
});

test("compaction is single-flight, retries after generation failure, and propagates commit failure", async () => {
  const generation = deferred<{ summary: string }>();
  let calls = 0;
  const harness = createHarness({
    generateConversationCompaction: async () => {
      calls++;
      return generation.promise;
    },
  });
  harness.setRecentEvents([event(10), event(20), event(30), event(40), event(50)]);
  const first = harness.runtime.maybeCompact();
  await flush();
  await harness.runtime.maybeCompact();
  assert.equal(calls, 1);
  generation.resolve({ summary: "new" });
  await first;
  await harness.runtime.maybeCompact();
  assert.equal(calls, 2);

  let attempts = 0;
  const generationFailure = createHarness({
    generateConversationCompaction: async () => {
      attempts++;
      throw new Error("AI failed");
    },
  });
  generationFailure.setRecentEvents([event(10), event(20), event(30), event(40), event(50)]);
  await assert.rejects(generationFailure.runtime.maybeCompact(), /AI failed/);
  await assert.rejects(generationFailure.runtime.maybeCompact(), /AI failed/);
  assert.equal(attempts, 2);
  assert.equal(generationFailure.commits.length, 0);

  const commitFailure = createHarness({
    commitRuntimeCompaction: async () => {
      throw new Error("transaction failed");
    },
  });
  commitFailure.setRecentEvents([event(10), event(20), event(30), event(40), event(50)]);
  await assert.rejects(commitFailure.runtime.maybeCompact(), /transaction failed/);
});
