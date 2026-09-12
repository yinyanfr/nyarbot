import assert from "node:assert/strict";
import test from "node:test";

const requiredEnv = {
  BOT_USERNAME: "test_bot",
  BOT_API_KEY: "test-token",
  TG_ADMIN_UID: "1",
  TG_GROUP_ID: "-1",
  DEEPSEEK_API_KEY: "test",
  TAVILY_API_KEY: "test",
  CF_AIG_TOKEN: "test",
  CF_ACCOUNT_ID: "test",
  DATABASE_BACKUP_PASSPHRASE: "correct horse battery staple",
  LOG_LEVEL: "silent",
};
Object.assign(process.env, requiredEnv);

const {
  createApplication,
  createProductionApplication,
  productionApplicationDependencies,
  productionMainDependencies,
  runMain,
} = await import("./app.js");
const testConfig = (await import("./configs/env.js")).default;
type ApplicationDependencies = import("./app.js").ApplicationDependencies;
type MainDependencies = import("./app.js").MainDependencies;
type ProductionApplicationDependencies = import("./app.js").ProductionApplicationDependencies;
type ProactiveCallbacks = import("./libs/proactive.js").ProactiveCallbacks;
type DiaryCallbacks = import("./libs/diary.js").DiaryCallbacks;
type WordcloudCallbacks = import("./libs/wordcloud.js").WordcloudCallbacks;

function createDependencies(overrides: Partial<ApplicationDependencies> = {}): {
  dependencies: ApplicationDependencies;
  calls: string[];
} {
  const calls: string[] = [];
  const bot = {
    botInfo: { id: 1, username: "bot" },
    use() {
      return undefined;
    },
    async init() {
      calls.push("bot.init");
    },
    async start() {
      calls.push("bot.start");
    },
    async stop() {
      calls.push("bot.stop");
    },
  };
  return {
    calls,
    dependencies: {
      bot: bot as never,
      initDatabase: () => calls.push("db.init"),
      prepareServices: async () => void calls.push("services.prepare"),
      setupHandlers: () => calls.push("handlers"),
      loadConversationBuffer: async () => void calls.push("buffer.load"),
      startBackgroundServices: async () => void calls.push("background.start"),
      stopBackgroundServices: async () => void calls.push("background.stop"),
      closeBackgroundServices: async () => void calls.push("background.close"),
      closeVideoReader: async () => void calls.push("video.close"),
      saveConversationBuffer: async () => void calls.push("buffer.save"),
      closeDatabase: () => void calls.push("db.close"),
      logStarting: () => calls.push("log.starting"),
      logPolling: () => calls.push("log.polling"),
      ...overrides,
    },
  };
}

test("application starts and shuts resources down in order", async () => {
  const calls: string[] = [];
  let middleware: ((ctx: never, next: () => Promise<void>) => Promise<void>) | undefined;
  const bot = {
    botInfo: { id: 1, username: "bot" },
    use(fn: typeof middleware) {
      middleware = fn;
    },
    async init() {
      calls.push("bot.init");
    },
    async start(options: { onStart(info: { username: string }): void }) {
      calls.push("bot.start");
      options.onStart(this.botInfo);
    },
    async stop() {
      calls.push("bot.stop");
    },
  };
  const app = createApplication({
    bot: bot as never,
    initDatabase: () => calls.push("db.init"),
    prepareServices: async () => void calls.push("services.prepare"),
    setupHandlers: () => calls.push("handlers"),
    loadConversationBuffer: async () => void calls.push("buffer.load"),
    startBackgroundServices: async () => void calls.push("background.start"),
    stopBackgroundServices: async () => void calls.push("background.stop"),
    closeBackgroundServices: async () => void calls.push("background.close"),
    closeVideoReader: async () => void calls.push("video.close"),
    saveConversationBuffer: async () => void calls.push("buffer.save"),
    closeDatabase: () => void calls.push("db.close"),
    logStarting: () => calls.push("log.starting"),
    logPolling: () => calls.push("log.polling"),
  });
  await app.start();
  assert.deepEqual(calls, [
    "db.init",
    "bot.init",
    "log.starting",
    "services.prepare",
    "handlers",
    "buffer.load",
    "background.start",
    "bot.start",
    "log.polling",
  ]);
  assert.ok(middleware);
  let release!: () => void;
  const inFlight = middleware(
    {} as never,
    () => new Promise<void>((resolve) => (release = resolve)),
  );
  await Promise.resolve();
  const shutdown = app.shutdown();
  await Promise.resolve();
  assert.deepEqual(calls.slice(-2), ["background.stop", "bot.stop"]);
  release();
  await inFlight;
  await shutdown;
  assert.deepEqual(calls.slice(-6), [
    "background.stop",
    "bot.stop",
    "background.close",
    "video.close",
    "buffer.save",
    "db.close",
  ]);
  await app.shutdown();
  assert.equal(calls.filter((call) => call === "db.close").length, 1);
});

test("application start is idempotent", async () => {
  const { dependencies, calls } = createDependencies();
  const app = createApplication(dependencies);
  await app.start();
  await app.start();
  assert.equal(calls.filter((call) => call === "bot.start").length, 1);
});

test("application startup stops at the failing boundary", async () => {
  const failure = new Error("offline");
  const { dependencies, calls } = createDependencies({
    loadConversationBuffer: async () => {
      calls.push("buffer.load");
      throw failure;
    },
  });
  const app = createApplication(dependencies);
  await assert.rejects(app.start(), failure);
  assert.deepEqual(calls.slice(-2), ["handlers", "buffer.load"]);
  assert.ok(!calls.includes("background.start"));
  assert.ok(!calls.includes("bot.start"));
});

test("shutdown ignores a buffer save failure and closes the database", async () => {
  const { dependencies, calls } = createDependencies({
    saveConversationBuffer: async () => {
      calls.push("buffer.save");
      throw new Error("disk full");
    },
  });
  await createApplication(dependencies).shutdown();
  assert.deepEqual(calls, [
    "background.stop",
    "bot.stop",
    "background.close",
    "video.close",
    "buffer.save",
    "db.close",
  ]);
});

function createProductionDependencies(): {
  dependencies: ProductionApplicationDependencies;
  calls: string[];
  timers: (() => void)[];
  sentMessages: { chatId: string; text: string; options?: unknown }[];
  callbacks: {
    proactive?: ProactiveCallbacks;
    diary?: DiaryCallbacks;
    wordcloud?: WordcloudCallbacks;
  };
  api: {
    sendMessage(chatId: string, text: string, options?: unknown): Promise<unknown>;
    sendSticker(chatId: string, sticker: string): Promise<unknown>;
    sendChatAction(chatId: string, action: string): Promise<unknown>;
    getFile(fileId: string): Promise<{ file_path?: string }>;
    sendPhoto(chatId: string, photo: unknown, options?: unknown): Promise<unknown>;
  };
} {
  const calls: string[] = [];
  const timers: (() => void)[] = [];
  const sentMessages: { chatId: string; text: string; options?: unknown }[] = [];
  const callbacks: {
    proactive?: ProactiveCallbacks;
    diary?: DiaryCallbacks;
    wordcloud?: WordcloudCallbacks;
  } = {};
  const api = {
    async sendMessage(chatId: string, text: string, options?: unknown) {
      sentMessages.push({ chatId, text, ...(options === undefined ? {} : { options }) });
      return {};
    },
    async sendSticker(chatId: string, sticker: string) {
      calls.push(`sticker:${chatId}:${sticker}`);
      return {};
    },
    async sendChatAction(chatId: string, action: string) {
      calls.push(`action:${chatId}:${action}`);
      return {};
    },
    async getFile(fileId: string) {
      return fileId === "missing" ? {} : { file_path: `/files/${fileId}` };
    },
    async sendPhoto(chatId: string, _photo: unknown, options?: unknown) {
      calls.push(`photo:${chatId}:${JSON.stringify(options)}`);
      return {};
    },
  };
  const bot = {
    api,
    botInfo: { id: 1, username: "wired_bot" },
    use() {
      return undefined;
    },
    async init() {
      calls.push("bot.init");
    },
    async start(options: { onStart(info: { username: string }): void }) {
      calls.push("bot.start");
      options.onStart(this.botInfo);
    },
    async stop() {
      calls.push("bot.stop");
    },
  };
  const timer = {
    unref: () => void calls.push("timer.unref"),
  } as unknown as ReturnType<typeof setInterval>;
  return {
    calls,
    timers,
    sentMessages,
    callbacks,
    api,
    dependencies: {
      config: {
        ...testConfig,
        tgDiaryChannelId: "-2",
      },
      createBot: () => bot as never,
      configureBot: () => void calls.push("bot.configure"),
      initDatabase: () => ({ database: true }) as never,
      setupHandlers: (_bot, info) => calls.push(`handlers:${info.username}`),
      loadConversationBuffer: async () => void calls.push("buffer.load"),
      closeVideoReader: async () => void calls.push("video.close"),
      saveConversationBuffer: async () => void calls.push("buffer.save"),
      closeDatabase: () => void calls.push("db.close"),
      initAdminNotify: () => void calls.push("admin.notify"),
      createDatabaseBackup: () => ({
        start: () => void calls.push("backup.start"),
        close: async () => void calls.push("backup.close"),
      }),
      startProactiveChecker: (value) => {
        callbacks.proactive = value;
      },
      stopProactiveChecker: () => void calls.push("proactive.stop"),
      initDiaryCallbacks: (value) => {
        callbacks.diary = value;
      },
      stopDiaryService: async () => void calls.push("diary.stop"),
      initWordcloudCallbacks: (value) => {
        callbacks.wordcloud = value;
      },
      checkAndGenerateDiary: async () => void calls.push("diary.check"),
      checkAndGenerateWordcloud: () => void calls.push("wordcloud.check"),
      formatForTelegramHtml: (text) => `<b>${text}</b>`,
      downloadTelegramFileAsDataUrl: async (path) => `data:${path}`,
      pushMessage: (...args) => void calls.push(`push:${String(args[3])}`),
      recordBotMessages: async (messages) => void calls.push(`record:${messages.join(",")}`),
      touchBotActivity: () => void calls.push("activity"),
      setInterval: (callback) => {
        timers.push(callback);
        return timer;
      },
      clearInterval: () => void calls.push("timer.clear"),
      logInfo: (details, message) => calls.push(`info:${message ?? String(details)}`),
      logWarn: (_details, message) => calls.push(`warn:${message}`),
      logError: (_details, message) => calls.push(`error:${message}`),
    },
  };
}

test("production wiring starts services, dispatches callbacks, timers, and cleanup offline", async () => {
  const fixture = createProductionDependencies();
  const app = createProductionApplication(fixture.dependencies);
  await app.start();

  assert.ok(fixture.callbacks.proactive);
  assert.ok(fixture.callbacks.diary);
  assert.ok(fixture.callbacks.wordcloud);
  assert.equal(await fixture.callbacks.proactive.sendText("hello"), true);
  assert.equal(await fixture.callbacks.proactive.sendSticker("sticker-id"), true);
  await fixture.callbacks.proactive.sendChatAction("typing");
  assert.equal(await fixture.callbacks.proactive.resolveTelegramFileAsDataUrl("missing"), null);
  assert.equal(
    await fixture.callbacks.proactive.resolveTelegramFileAsDataUrl("photo"),
    "data:/files/photo",
  );
  await fixture.callbacks.diary.sendText("diary", "normal", {
    inlineKeyboardText: "read",
    inlineKeyboardUrl: "https://example.test",
  });
  await fixture.callbacks.diary.sendChannelText("channel");
  await fixture.callbacks.diary.sendChannelPhoto({} as never, "caption");
  await fixture.callbacks.wordcloud.sendPhoto({} as never, "cloud");
  fixture.timers.forEach((callback) => callback());
  await Promise.resolve();
  await app.shutdown();

  assert.equal(fixture.timers.length, 3);
  assert.equal(fixture.calls.filter((call) => call === "timer.unref").length, 3);
  assert.equal(fixture.calls.filter((call) => call === "timer.clear").length, 3);
  assert.ok(fixture.calls.includes("backup.start"));
  assert.ok(fixture.calls.includes("backup.close"));
  assert.ok(fixture.calls.includes("diary.stop"));
  assert.ok(fixture.calls.includes("record:diary"));
  assert.ok(fixture.calls.includes("record:cloud"));
  assert.ok(fixture.calls.includes("activity"));
  assert.ok(fixture.sentMessages.some((message) => message.text === "<b>hello</b>"));
});

test("production callback wiring handles Telegram and persistence failures offline", async () => {
  const fixture = createProductionDependencies();
  let messageFailures = 0;
  fixture.api.sendMessage = async (chatId, text, options) => {
    fixture.sentMessages.push({ chatId, text, ...(options === undefined ? {} : { options }) });
    if (messageFailures-- > 0) throw new Error("send failed");
    return {};
  };
  fixture.api.sendSticker = async () => Promise.reject(new Error("sticker failed"));
  fixture.api.sendChatAction = async () => Promise.reject(new Error("action failed"));
  fixture.api.getFile = async () => Promise.reject(new Error("file failed"));
  fixture.api.sendPhoto = async () => Promise.reject(new Error("photo failed"));
  fixture.dependencies.recordBotMessages = async () => Promise.reject(new Error("persist failed"));
  const app = createProductionApplication(fixture.dependencies);
  await app.start();

  messageFailures = 1;
  assert.equal(await fixture.callbacks.proactive!.sendText("fallback"), true);
  messageFailures = 2;
  assert.equal(await fixture.callbacks.proactive!.sendText("fail"), false);
  assert.equal(await fixture.callbacks.proactive!.sendSticker("bad"), false);
  await fixture.callbacks.proactive!.sendChatAction("typing");
  assert.equal(await fixture.callbacks.proactive!.resolveTelegramFileAsDataUrl("bad"), null);
  messageFailures = 1;
  await fixture.callbacks.diary!.sendText("fallback diary");
  messageFailures = 1;
  await fixture.callbacks.diary!.sendChannelText("fallback channel");
  messageFailures = 2;
  await assert.rejects(fixture.callbacks.diary!.sendChannelText("failed channel"), /send failed/);
  await assert.rejects(fixture.callbacks.diary!.sendChannelPhoto({} as never), /photo failed/);
  await assert.rejects(
    fixture.callbacks.wordcloud!.sendPhoto({} as never, "cloud"),
    /photo failed/,
  );
  await new Promise((resolve) => setImmediate(resolve));
  await app.shutdown();

  assert.ok(fixture.calls.includes("warn:proactive: text dispatch failed"));
  assert.ok(fixture.calls.includes("warn:proactive: sticker dispatch failed"));
  assert.ok(fixture.calls.includes("warn:proactive: resolveTelegramFileAsDataUrl failed"));
  assert.ok(fixture.calls.includes("warn:diary: runtime bot event persist failed"));
  assert.ok(fixture.calls.includes("error:diary: channel plain-text publish failed"));
  assert.ok(fixture.calls.includes("error:diary: channel photo publish failed"));
  assert.ok(fixture.calls.includes("error:wordcloud: group photo publish failed"));
});

test("production diary callbacks skip channel delivery when no channel is configured", async () => {
  const fixture = createProductionDependencies();
  fixture.dependencies.config = {
    ...fixture.dependencies.config,
    tgDiaryChannelId: "",
  };
  const app = createProductionApplication(fixture.dependencies);
  await app.start();
  await fixture.callbacks.diary!.sendChannelText("ignored");
  await fixture.callbacks.diary!.sendChannelPhoto({} as never, "ignored");
  await app.shutdown();
  assert.ok(!fixture.sentMessages.some((message) => message.text.includes("ignored")));
  assert.ok(!fixture.calls.some((call) => call.startsWith("photo:")));
});

test("production default application adapters are offline-safe", async () => {
  const bot = productionApplicationDependencies.createBot("test-token");
  assert.doesNotThrow(() => productionApplicationDependencies.configureBot(bot));
  assert.doesNotThrow(() => productionApplicationDependencies.initAdminNotify(bot));

  const backup = productionApplicationDependencies.createDatabaseBackup({} as never, bot);
  await backup.close();
  await productionApplicationDependencies.recordBotMessages([]);

  const timer = productionApplicationDependencies.setInterval(() => undefined, 60_000);
  productionApplicationDependencies.clearInterval(timer);
  assert.doesNotThrow(() => productionApplicationDependencies.logInfo("info"));
  assert.doesNotThrow(() => productionApplicationDependencies.logInfo({}, "info details"));
  assert.doesNotThrow(() => productionApplicationDependencies.logWarn({}, "warning"));
  assert.doesNotThrow(() => productionApplicationDependencies.logError({}, "error"));
});

test("production default main adapters register and log without starting infrastructure", () => {
  const listener = () => undefined;
  productionMainDependencies.once("SIGINT", listener);
  process.removeListener("SIGINT", listener);

  const application = productionMainDependencies.createApplication();
  assert.equal(typeof application.start, "function");
  assert.equal(typeof application.shutdown, "function");
  assert.doesNotThrow(() => productionMainDependencies.logError(new Error("startup")));
  assert.doesNotThrow(() =>
    productionMainDependencies.logFatal(new Error("fatal"), "fatal message"),
  );
});

function createMainDependencies(start: () => Promise<void> = () => Promise.resolve()): {
  dependencies: MainDependencies;
  listeners: Map<string, (value?: unknown) => void>;
  calls: string[];
  fatalErrors: { error: Error; message: string }[];
} {
  const calls: string[] = [];
  const listeners = new Map<string, (value?: unknown) => void>();
  const fatalErrors: { error: Error; message: string }[] = [];
  return {
    calls,
    listeners,
    fatalErrors,
    dependencies: {
      createApplication: () => ({
        start,
        shutdown: async () => void calls.push("shutdown"),
      }),
      once: (event, listener) => void listeners.set(event, listener),
      exit: (code) => void calls.push(`exit:${code}`),
      closeDatabase: () => void calls.push("db.close"),
      closeVideoReader: async () => void calls.push("video.close"),
      saveConversationBuffer: async () => void calls.push("buffer.save"),
      logError: (error) => calls.push(`startup.error:${String(error)}`),
      logFatal: (error, message) => void fatalErrors.push({ error, message }),
    },
  };
}

test("runMain registers lifecycle handlers and signals trigger shutdown", async () => {
  const { dependencies, listeners, calls } = createMainDependencies();
  runMain(dependencies);
  assert.deepEqual(
    [...listeners.keys()],
    ["SIGINT", "SIGTERM", "uncaughtException", "unhandledRejection"],
  );
  listeners.get("SIGTERM")!();
  await Promise.resolve();
  assert.deepEqual(calls, ["shutdown"]);
});

test("runMain reports startup failures and exits", async () => {
  const failure = new Error("bad token");
  const { dependencies, calls } = createMainDependencies(async () => Promise.reject(failure));
  runMain(dependencies);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [`startup.error:${String(failure)}`, "exit:1"]);
});

test("runMain crash guards perform best-effort cleanup, log, and exit", async () => {
  const { dependencies, listeners, calls, fatalErrors } = createMainDependencies();
  dependencies.saveConversationBuffer = async () => {
    calls.push("buffer.save");
    throw new Error("ignored");
  };
  runMain(dependencies);

  const uncaught = new Error("boom");
  listeners.get("uncaughtException")!(uncaught);
  listeners.get("unhandledRejection")!("rejected");
  await Promise.resolve();

  assert.deepEqual(calls, [
    "db.close",
    "video.close",
    "buffer.save",
    "exit:1",
    "db.close",
    "video.close",
    "buffer.save",
    "exit:1",
  ]);
  assert.equal(fatalErrors[0]?.error, uncaught);
  assert.equal(fatalErrors[0]?.message, "uncaught exception — exiting");
  assert.equal(fatalErrors[1]?.error.message, "rejected");
  assert.equal(fatalErrors[1]?.message, "unhandled rejection — exiting");
});
