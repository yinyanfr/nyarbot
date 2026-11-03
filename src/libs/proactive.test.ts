import assert from "node:assert/strict";
import test from "node:test";
import type { HistoryEntry } from "./conversation-buffer.js";
import type { ProactiveCallbacks, ProactiveDependencies } from "./proactive.js";

Object.assign(process.env, {
  BOT_USERNAME: "test_bot",
  BOT_API_KEY: "test-token",
  TG_ADMIN_UID: "1",
  TG_GROUP_ID: "-1",
  DEEPSEEK_API_KEY: "test",
  TAVILY_API_KEY: "test",
  CF_AIG_TOKEN: "test",
  CF_ACCOUNT_ID: "test",
  DATABASE_BACKUP_PASSPHRASE: "correct horse battery staple",
});

const { createProactiveChecker } = await import("./proactive.js");

const clock = Date.parse("2026-08-12T12:00:00Z");

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    uid: "u1",
    name: "Alice",
    text: "new message",
    timestamp: clock - 1_000,
    ...overrides,
  };
}

function fixture(options: {
  history?: HistoryEntry[];
  probe?: (input: unknown) => Promise<boolean>;
  turn?: (input?: unknown) => Promise<unknown>;
  canRun?: boolean;
  runLock?: boolean;
  config?: Partial<ProactiveDependencies["config"]>;
}) {
  let revision = 1;
  const probes: unknown[] = [];
  const turns: unknown[] = [];
  const pushed: string[] = [];
  const delays: number[] = [];
  const runtime = {
    canRunProactive: () => options.canRun ?? true,
    getActivityRevision: () => revision,
    runProactiveTurn: async (task: () => Promise<void>) => {
      if (options.runLock === false) return false;
      await task();
      return true;
    },
    recordBotMessages: async () => undefined,
    recordTurn: async (turn: unknown) => {
      turns.push(turn);
    },
  };
  const dependencies: Partial<ProactiveDependencies> = {
    config: {
      ...awaitConfig(),
      proactiveCheckIntervalMs: 1_000,
      proactiveWindowMs: 60_000,
      proactiveMessageDelayMs: 200,
      proactiveCooldownLowMs: 0,
      proactiveCooldownMediumMs: 0,
      proactiveCooldownHighMs: 0,
      proactiveMaxFailures: 3,
      ...options.config,
    },
    now: () => clock,
    getHistory: () => options.history ?? [entry()],
    containsTwitterStatusUrl: (text: string) => text.includes("x.com/"),
    probeGate: async (input) => {
      probes.push(input);
      return options.probe ? options.probe(input) : true;
    },
    generateAiTurn: (async (input) =>
      options.turn
        ? options.turn(input)
        : {
            action: "send",
            messages: ["reply"],
            stickerFileId: null,
          }) as ProactiveDependencies["generateAiTurn"],
    pushMessage: (_groupId, _uid, _name, text) => {
      pushed.push(text);
    },
    formatHistoryAsContext: (history) => history.map((item) => item.text).join("|"),
    getStickerEmojiByFileId: () => "😺",
    groupRuntime: runtime as unknown as ProactiveDependencies["groupRuntime"],
    logger: quietLogger() as unknown as ProactiveDependencies["logger"],
    setTimeout: ((callback: () => void, delay: number) => {
      delays.push(delay);
      return setTimeout(callback, delay);
    }) as typeof setTimeout,
  };
  return {
    checker: createProactiveChecker(dependencies),
    probes,
    turns,
    pushed,
    delays,
    changeRevision: () => revision++,
  };
}

function awaitConfig() {
  return {
    tgGroupId: "-1",
    botUsername: "test_bot",
  } as ProactiveDependencies["config"];
}

function quietLogger() {
  return { info: () => undefined, warn: () => undefined, error: () => undefined };
}

function callbacks(overrides: Partial<ProactiveCallbacks> = {}): ProactiveCallbacks {
  return {
    sendText: async () => true,
    sendSticker: async () => true,
    sendChatAction: async () => undefined,
    resolveTelegramFileAsDataUrl: async () => null,
    ...overrides,
  };
}

test("filters stale, consumed, status-url, bot, and system messages from candidates", async () => {
  const f = fixture({
    history: [
      entry({ uid: "bot", text: "old bot context", timestamp: clock - 70_000 }),
      entry({ text: "stale", timestamp: clock - 65_000 }),
      entry({ text: "x.com/user/status/1" }),
      entry({ uid: "system", text: "system" }),
      entry({ uid: "u2", name: "Bob", username: "bob", text: "candidate" }),
    ],
  });
  f.checker.startProactiveChecker(callbacks());
  await f.checker.checkNow(callbacks());
  assert.equal(f.probes.length, 1);
  assert.deepEqual((f.probes[0] as { recentMembers: unknown[] }).recentMembers, [
    { uid: "u2", name: "Bob", username: "bob" },
  ]);
  assert.match(
    (f.probes[0] as { candidateConversation: string }).candidateConversation,
    /candidate/,
  );
  assert.doesNotMatch(
    (f.probes[0] as { candidateConversation: string }).candidateConversation,
    /stale|x\.com/,
  );
  f.checker.stopProactiveChecker();
});

test("probe rejection and runtime locks avoid model work", async () => {
  for (const options of [{ probe: async () => false }, { canRun: false }, { runLock: false }]) {
    let modelCalls = 0;
    const f = fixture({
      ...options,
      turn: async () => {
        modelCalls++;
        return { action: "send", messages: ["no"], stickerFileId: null };
      },
    });
    f.checker.startProactiveChecker(callbacks());
    await f.checker.checkNow(callbacks());
    assert.equal(modelCalls, 0);
    f.checker.stopProactiveChecker();
  }
});

test("drops stale activity after probe and before send", async () => {
  let releaseProbe: ((value: boolean) => void) | undefined;
  const probe = new Promise<boolean>((resolve) => (releaseProbe = resolve));
  const f = fixture({ probe: async () => probe });
  f.checker.startProactiveChecker(callbacks());
  const pending = f.checker.checkNow(callbacks());
  f.changeRevision();
  releaseProbe!(true);
  await pending;
  assert.equal(f.turns.length, 0);
  assert.equal(f.pushed.length, 0);
  f.checker.stopProactiveChecker();
});

test("sends text and sticker-only results and records dispatch failures", async () => {
  const sent: string[] = [];
  const text = fixture({
    turn: async () => ({ action: "send", messages: ["one"], stickerFileId: "sticker" }),
  });
  text.checker.startProactiveChecker(
    callbacks({ sendText: async (value) => (sent.push(value), true) }),
  );
  await text.checker.checkNow(callbacks({ sendText: async (value) => (sent.push(value), true) }));
  assert.deepEqual(sent, ["one"]);
  assert.equal((text.turns.at(-1) as { action: string }).action, "send");
  text.checker.stopProactiveChecker();

  const sticker = fixture({
    turn: async () => ({ action: "send", messages: [], stickerFileId: "cat" }),
  });
  sticker.checker.startProactiveChecker(callbacks());
  await sticker.checker.checkNow(callbacks());
  assert.deepEqual(sticker.pushed, ["[贴纸 😺: cat]"]);
  sticker.checker.stopProactiveChecker();

  const failed = fixture({});
  failed.checker.startProactiveChecker(callbacks());
  await failed.checker.checkNow(callbacks({ sendText: async () => false }));
  assert.equal(failed.checker.getProactiveHealthSnapshot().consecutiveFailures, 1);
  assert.equal((failed.turns.at(-1) as { action: string }).action, "error");
  failed.checker.stopProactiveChecker();
});

test("fake timers cover message staggering, exponential backoff, and stop/start locks", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture({
    turn: async () => ({ action: "send", messages: ["one", "two"], stickerFileId: null }),
  });
  const cb = callbacks();
  f.checker.startProactiveChecker(cb);
  f.checker.startProactiveChecker(cb);
  assert.deepEqual(f.delays, [1_000]);
  const pending = f.checker.checkNow(cb);
  while (!f.delays.includes(200)) await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(200);
  await pending;
  assert.ok(f.delays.includes(200));
  f.checker.stopProactiveChecker();
  assert.equal(f.checker.getProactiveHealthSnapshot().scheduled, false);

  const failing = fixture({
    probe: async () => {
      throw new Error("probe down");
    },
  });
  failing.checker.startProactiveChecker(cb);
  await failing.checker.checkNow(cb);
  await failing.checker.checkNow(cb);
  assert.deepEqual(failing.delays.slice(-2), [1_000, 2_000]);
  failing.checker.stopProactiveChecker();
});

test("passes deduplicated recent image context and records a model dismissal", async () => {
  let turnInput: unknown;
  const f = fixture({
    history: [
      entry({
        text: "photo",
        mediaRefs: [
          { type: "image", source: "reply_to", fileId: "photo", thumbnailFileId: "thumb" },
          { type: "image", source: "invalid" as "current", fileId: "photo" },
          { type: "video", source: "current", fileId: "video" },
        ],
      }),
    ],
    turn: async (input) => {
      turnInput = input;
      return {
        action: "dismiss",
        messages: [],
        stickerFileId: null,
        metrics: { model: "test", latencyMs: 5, inputTokens: 2, outputTokens: 1 },
      };
    },
  });
  f.checker.startProactiveChecker(callbacks());
  await f.checker.checkNow(callbacks());
  assert.deepEqual((turnInput as { mediaRefs: unknown[] }).mediaRefs, [
    { type: "image", source: "reply_to", fileId: "photo", thumbnailFileId: "thumb" },
  ]);
  assert.equal((turnInput as { allowMediaTools: boolean }).allowMediaTools, true);
  assert.equal((f.turns.at(-1) as { action: string }).action, "dismiss");
  f.checker.stopProactiveChecker();
});

test("cooldown suppresses proactive output after recent bot activity", async () => {
  const recentBot = fixture({
    history: [entry({ uid: "bot", timestamp: clock - 100 }), entry()],
    config: { proactiveCooldownLowMs: 10_000 },
  });
  recentBot.checker.startProactiveChecker(callbacks());
  recentBot.checker.touchBotActivity();
  await recentBot.checker.checkNow(callbacks());
  assert.equal(recentBot.turns.length, 0);
  recentBot.checker.stopProactiveChecker();
});

test("drops a completed model result when conversation changes during generation", async () => {
  let release: (() => void) | undefined;
  const model = new Promise<void>((resolve) => (release = resolve));
  const f = fixture({
    turn: async () => {
      await model;
      return { action: "send", messages: ["stale"], stickerFileId: null };
    },
  });
  f.checker.startProactiveChecker(callbacks());
  const pending = f.checker.checkNow(callbacks());
  await new Promise((resolve) => setImmediate(resolve));
  f.changeRevision();
  release!();
  await pending;
  assert.deepEqual(f.pushed, []);
  f.checker.stopProactiveChecker();
});

test("stops a multi-message dispatch when activity changes between sends", async () => {
  const f = fixture({
    turn: async () => ({ action: "send", messages: ["one", "two"], stickerFileId: null }),
  });
  const sent: string[] = [];
  f.checker.startProactiveChecker(callbacks());
  await f.checker.checkNow(
    callbacks({
      sendText: async (text) => {
        sent.push(text);
        f.changeRevision();
        return true;
      },
    }),
  );
  assert.deepEqual(sent, ["one"]);
  assert.equal((f.turns.at(-1) as { action: string }).action, "send");
  f.checker.stopProactiveChecker();
});

test("scheduled checks run and rejected typing actions remain best-effort", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let probes = 0;
  let typingAttempts = 0;
  let releaseTurn: (() => void) | undefined;
  const turnGate = new Promise<void>((resolve) => (releaseTurn = resolve));
  const f = fixture({
    probe: async () => {
      probes++;
      return true;
    },
    turn: async () => {
      await turnGate;
      return { action: "dismiss", messages: [], stickerFileId: null };
    },
  });
  const cb = callbacks({
    sendChatAction: async () => {
      typingAttempts++;
      throw new Error("Telegram offline");
    },
  });
  f.checker.startProactiveChecker(cb);
  t.mock.timers.tick(1_000);
  while (probes === 0 || typingAttempts === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  t.mock.timers.tick(4_500);
  releaseTurn!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(typingAttempts >= 2);
  assert.equal((f.turns.at(-1) as { action: string }).action, "dismiss");
  f.checker.stopProactiveChecker();
});
