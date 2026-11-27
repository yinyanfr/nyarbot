import "dotenv/config";
import { pathToFileURL } from "node:url";
import { Bot, GrammyError, InlineKeyboard, InputFile } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { setupHandlers } from "./handlers/index.js";
import config from "./configs/env.js";
import { closeDatabase, initDatabase } from "./services/database.js";
import { startMemoryEmbeddingIndex } from "./services/memory-embeddings.js";
import { startProactiveChecker, stopProactiveChecker, touchBotActivity } from "./libs/proactive.js";
import type { ProactiveCallbacks } from "./libs/proactive.js";
import { logger, initAdminNotify } from "./libs/logger.js";
import { formatForTelegramHtml, telegramMessageParts } from "./libs/format-telegram.js";
import { checkAndGenerateDiary, initDiaryCallbacks, stopDiaryService } from "./libs/diary.js";
import type { DiaryCallbacks } from "./libs/diary.js";
import {
  checkAndGenerateWordcloud,
  initWordcloudCallbacks,
  stopWordcloudService,
} from "./libs/wordcloud.js";
import type { WordcloudCallbacks } from "./libs/wordcloud.js";
import { saveConversationBuffer, loadConversationBuffer } from "./libs/conversation-buffer.js";
import { pushMessage, type HistoryEntryKind } from "./libs/conversation-buffer.js";
import { groupRuntime } from "./libs/group-runtime.js";
import { downloadTelegramFileAsDataUrl } from "./libs/telegram-image.js";
import { closeVideoReader } from "./libs/video.js";
import { DatabaseBackupService } from "./libs/database-backup.js";
import { telegramSignal } from "./libs/abort.js";

type BotContext = import("./handlers/context.js").BotContext;

interface ApplicationBot {
  init(): Promise<void>;
  readonly botInfo: { id: number; username: string };
  use(middleware: (ctx: BotContext, next: () => Promise<void>) => Promise<void>): unknown;
  start(options: { onStart(info: { username: string }): void }): Promise<void>;
  stop(): Promise<void>;
}

export interface ApplicationDependencies {
  bot: ApplicationBot;
  initDatabase(): unknown;
  prepareServices(database: unknown): void | Promise<void>;
  setupHandlers(botInfo: { id: number; username: string }): void;
  loadConversationBuffer(): Promise<void>;
  startBackgroundServices(database: unknown): void | Promise<void>;
  stopBackgroundServices(): void | Promise<void>;
  closeBackgroundServices(): void | Promise<void>;
  closeVideoReader(): Promise<void>;
  saveConversationBuffer(): Promise<void>;
  closeDatabase(): void;
  logStarting(username: string): void;
  logPolling(username: string): void;
}

export function createApplication(dependencies: ApplicationDependencies): {
  start(): Promise<void>;
  shutdown(): Promise<void>;
} {
  let activeMiddleware = 0;
  let resolveMiddlewareDrain: (() => void) | undefined;
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;
  let started = false;

  dependencies.bot.use(async (_ctx, next) => {
    activeMiddleware += 1;
    try {
      await next();
    } finally {
      activeMiddleware -= 1;
      if (activeMiddleware === 0) resolveMiddlewareDrain?.();
    }
  });

  return {
    async start(): Promise<void> {
      if (started) return;
      started = true;
      const database = dependencies.initDatabase();
      await dependencies.bot.init();
      if (shuttingDown) return;
      const botInfo = dependencies.bot.botInfo;
      dependencies.logStarting(botInfo.username);
      await dependencies.prepareServices(database);
      if (shuttingDown) return;
      dependencies.setupHandlers(botInfo);
      await dependencies.loadConversationBuffer();
      if (shuttingDown) return;
      await dependencies.startBackgroundServices(database);
      if (shuttingDown) return;
      await dependencies.bot.start({
        onStart(info) {
          dependencies.logPolling(info.username);
        },
      });
    },
    shutdown(): Promise<void> {
      if (shutdownPromise) return shutdownPromise;
      shuttingDown = true;
      shutdownPromise = (async () => {
        const stopping = await Promise.allSettled([
          dependencies.stopBackgroundServices(),
          dependencies.bot.stop(),
        ]);
        if (activeMiddleware > 0) {
          await new Promise<void>((resolve) => {
            resolveMiddlewareDrain = resolve;
          });
          resolveMiddlewareDrain = undefined;
        }
        const closing = await Promise.allSettled([
          dependencies.closeBackgroundServices(),
          dependencies.closeVideoReader(),
        ]);
        await dependencies.saveConversationBuffer().catch(() => void 0);
        dependencies.closeDatabase();
        const failure = [...stopping, ...closing].find((result) => result.status === "rejected");
        if (failure) throw failure.reason;
      })();
      return shutdownPromise;
    },
  };
}

type TimerHandle = ReturnType<typeof setInterval>;

interface BackgroundCloser {
  start(): void;
  close(): Promise<void>;
}

export interface ProductionApplicationDependencies {
  config: typeof config;
  createBot(apiKey: string, apiRoot?: string): Bot<BotContext>;
  configureBot(bot: Bot<BotContext>): void;
  initDatabase: typeof initDatabase;
  setupHandlers(bot: Bot<BotContext>, botInfo: { id: number; username: string }): void;
  loadConversationBuffer: typeof loadConversationBuffer;
  closeVideoReader: typeof closeVideoReader;
  saveConversationBuffer: typeof saveConversationBuffer;
  closeDatabase: typeof closeDatabase;
  initAdminNotify(bot: Bot<BotContext>): void;
  createDatabaseBackup(
    database: ReturnType<typeof initDatabase>,
    bot: Bot<BotContext>,
  ): BackgroundCloser;
  startProactiveChecker(callbacks: ProactiveCallbacks): void;
  stopProactiveChecker(): void;
  stopGroupRuntime(): Promise<void>;
  initDiaryCallbacks(callbacks: DiaryCallbacks): void;
  stopDiaryService(): Promise<void>;
  initWordcloudCallbacks(callbacks: WordcloudCallbacks): void;
  stopWordcloudService(): Promise<void>;
  checkAndGenerateDiary(): Promise<unknown>;
  checkAndGenerateWordcloud(): void;
  formatForTelegramHtml(text: string): string;
  downloadTelegramFileAsDataUrl(filePath: string, signal?: AbortSignal): Promise<string | null>;
  pushMessage: typeof pushMessage;
  recordBotMessages(messages: string[]): Promise<unknown>;
  touchBotActivity(): void;
  setInterval(callback: () => void, delay: number): TimerHandle;
  clearInterval(timer: TimerHandle): void;
  logInfo(details: unknown, message?: string): void;
  logWarn(details: unknown, message: string): void;
  logError(details: unknown, message: string): void;
}

export const productionApplicationDependencies: ProductionApplicationDependencies = {
  config,
  createBot: (apiKey, apiRoot = config.telegramApiRoot) =>
    new Bot<BotContext>(apiKey, { client: { apiRoot } }),
  configureBot: (bot) => {
    bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 10 }));
    bot.catch(({ error, ctx }) => {
      logger.error(
        {
          updateId: ctx.update.update_id,
          errorType: error instanceof Error ? error.name : typeof error,
        },
        "Telegram update handling failed",
      );
    });
  },
  initDatabase,
  setupHandlers,
  loadConversationBuffer,
  closeVideoReader,
  saveConversationBuffer,
  closeDatabase,
  initAdminNotify: (bot) => initAdminNotify(bot.api),
  createDatabaseBackup: (database, bot) =>
    new DatabaseBackupService({
      database,
      api: bot.api,
      adminUid: config.tgAdminUid,
      passphrase: config.databaseBackupPassphrase,
      archiveDirectory: config.databaseBackupPath,
      schedule: config.databaseBackupSchedule,
      timeZone: config.appTimezone,
    }),
  startProactiveChecker,
  stopProactiveChecker,
  stopGroupRuntime: () => groupRuntime.close(),
  initDiaryCallbacks,
  stopDiaryService,
  initWordcloudCallbacks,
  stopWordcloudService,
  checkAndGenerateDiary,
  checkAndGenerateWordcloud,
  formatForTelegramHtml,
  downloadTelegramFileAsDataUrl,
  pushMessage,
  recordBotMessages: (messages) => groupRuntime.recordBotMessages({ messages }),
  touchBotActivity,
  setInterval,
  clearInterval,
  logInfo: (details, message) =>
    message ? logger.info(details, message) : logger.info(details as string),
  logWarn: (details, message) => logger.warn(details, message),
  logError: (details, message) => logger.error(details, message),
};

export function createProductionApplication(
  dependencies: ProductionApplicationDependencies = productionApplicationDependencies,
): ReturnType<typeof createApplication> {
  const runtimeConfig = dependencies.config;
  const bot = dependencies.createBot(runtimeConfig.botApiKey, runtimeConfig.telegramApiRoot);
  dependencies.configureBot(bot);
  let diaryTimer: TimerHandle | undefined;
  let wordcloudTimer: TimerHandle | undefined;
  let bufferSaveTimer: TimerHandle | undefined;
  let databaseBackup: BackgroundCloser | undefined;
  let memoryEmbeddingIndex: Pick<BackgroundCloser, "close"> | undefined;
  let bufferSave: Promise<void> | undefined;

  async function sendFormatted(
    chatId: string,
    text: string,
    signal?: AbortSignal,
    keyboard?: InlineKeyboard,
  ): Promise<void> {
    const parts = telegramMessageParts(text, dependencies.formatForTelegramHtml(text));
    for (const [index, part] of parts.entries()) {
      signal?.throwIfAborted();
      const options = keyboard && index === parts.length - 1 ? { reply_markup: keyboard } : {};
      if (part.html !== undefined) {
        try {
          await bot.api.sendMessage(
            chatId,
            part.html,
            { ...options, parse_mode: "HTML" },
            telegramSignal(signal),
          );
          continue;
        } catch (err) {
          signal?.throwIfAborted();
          // Network failures can occur after delivery; only retry invalid HTML as plain text.
          if (
            !(err instanceof GrammyError) ||
            err.error_code !== 400 ||
            !err.description.includes("parse entities")
          )
            throw err;
        }
      }
      await bot.api.sendMessage(chatId, part.text, options, telegramSignal(signal));
    }
  }

  return createApplication({
    bot,
    initDatabase: dependencies.initDatabase,
    setupHandlers: (botInfo) => dependencies.setupHandlers(bot, botInfo),
    loadConversationBuffer: dependencies.loadConversationBuffer,
    closeVideoReader: dependencies.closeVideoReader,
    saveConversationBuffer: dependencies.saveConversationBuffer,
    closeDatabase: dependencies.closeDatabase,
    logStarting: (username) => dependencies.logInfo(`nyarbot starting as @${username}`),
    logPolling: (username) => dependencies.logInfo(`nyarbot polling as @${username}`),
    prepareServices(databaseValue) {
      const database = databaseValue as ReturnType<typeof initDatabase>;
      dependencies.initAdminNotify(bot);
      databaseBackup = dependencies.createDatabaseBackup(database, bot);
      databaseBackup.start();
      memoryEmbeddingIndex = startMemoryEmbeddingIndex(database, runtimeConfig);
    },
    startBackgroundServices() {
      const proactiveCallbacks: ProactiveCallbacks = {
        sendText: async (text, signal) => {
          try {
            await sendFormatted(runtimeConfig.tgGroupId, text, signal);
            return true;
          } catch (err) {
            if (!signal?.aborted) dependencies.logWarn({ err }, "proactive: text dispatch failed");
            return false;
          }
        },
        sendSticker: async (stickerFileId, signal) => {
          try {
            await bot.api.sendSticker(
              runtimeConfig.tgGroupId,
              stickerFileId,
              undefined,
              telegramSignal(signal),
            );
            return true;
          } catch (err) {
            dependencies.logWarn({ err, stickerFileId }, "proactive: sticker dispatch failed");
            return false;
          }
        },
        sendChatAction: async (action, signal) => {
          try {
            await bot.api.sendChatAction(
              runtimeConfig.tgGroupId,
              action,
              undefined,
              telegramSignal(signal),
            );
          } catch {
            // Best-effort; typing indicators are non-critical
          }
        },
        resolveTelegramFileAsDataUrl: async (fileId, signal) => {
          try {
            const file = await bot.api.getFile(fileId, telegramSignal(signal));
            if (!file.file_path) return null;
            return await dependencies.downloadTelegramFileAsDataUrl(file.file_path, signal);
          } catch (err) {
            dependencies.logWarn({ err, fileId }, "proactive: resolveTelegramFileAsDataUrl failed");
            return null;
          }
        },
      };

      dependencies.startProactiveChecker(proactiveCallbacks);

      dependencies.initDiaryCallbacks({
        sendText: async (text, kind: HistoryEntryKind = "normal", options, abortSignal) => {
          const reply_markup =
            options?.inlineKeyboardText && options.inlineKeyboardUrl
              ? new InlineKeyboard().url(options.inlineKeyboardText, options.inlineKeyboardUrl)
              : undefined;
          await sendFormatted(runtimeConfig.tgGroupId, text, abortSignal, reply_markup);
          dependencies.pushMessage(
            runtimeConfig.tgGroupId,
            "bot",
            runtimeConfig.botUsername,
            text,
            undefined,
            kind,
          );
          await dependencies.recordBotMessages([text]).catch((err: unknown) => {
            dependencies.logWarn({ err }, "diary: runtime bot event persist failed");
          });
          dependencies.touchBotActivity();
        },
        sendChannelText: async (text, abortSignal, date) => {
          if (!runtimeConfig.tgDiaryChannelId) return;
          try {
            abortSignal?.throwIfAborted();
            if (telegramMessageParts(text, dependencies.formatForTelegramHtml(text)).length > 1) {
              await bot.api.sendDocument(
                runtimeConfig.tgDiaryChannelId,
                new InputFile(Buffer.from(text, "utf-8"), date ? `${date}-diary.txt` : "diary.txt"),
                { caption: date ? `${date} 猫娘日记` : "猫娘日记" },
                telegramSignal(abortSignal),
              );
            } else {
              await sendFormatted(runtimeConfig.tgDiaryChannelId, text, abortSignal);
            }
            dependencies.logInfo(
              { chatId: runtimeConfig.tgDiaryChannelId },
              "diary: channel text publish succeeded",
            );
          } catch (err) {
            dependencies.logError(
              { err, chatId: runtimeConfig.tgDiaryChannelId },
              "diary: channel text publish failed",
            );
            throw err;
          }
        },
        sendChannelPhoto: async (photo, caption, abortSignal) => {
          if (!runtimeConfig.tgDiaryChannelId) return;
          const options = caption ? { caption } : {};
          try {
            abortSignal?.throwIfAborted();
            await bot.api.sendPhoto(
              runtimeConfig.tgDiaryChannelId,
              photo,
              options,
              telegramSignal(abortSignal),
            );
            dependencies.logInfo(
              { chatId: runtimeConfig.tgDiaryChannelId },
              "diary: channel photo publish succeeded",
            );
          } catch (err) {
            dependencies.logError(
              { err, chatId: runtimeConfig.tgDiaryChannelId },
              "diary: channel photo publish failed",
            );
            throw err;
          }
        },
      });

      dependencies.initWordcloudCallbacks({
        sendPhoto: async (photo, caption, signal) => {
          try {
            await bot.api.sendPhoto(
              runtimeConfig.tgGroupId,
              photo,
              { caption },
              telegramSignal(signal),
            );
          } catch (err) {
            dependencies.logError({ err }, "wordcloud: group photo publish failed");
            throw err;
          }
          dependencies.pushMessage(
            runtimeConfig.tgGroupId,
            "bot",
            runtimeConfig.botUsername,
            caption,
          );
          await dependencies.recordBotMessages([caption]).catch((err: unknown) => {
            dependencies.logWarn({ err }, "wordcloud: runtime bot event persist failed");
          });
          dependencies.touchBotActivity();
        },
      });

      // Midnight diary generation: check interval configurable by env
      void dependencies.checkAndGenerateDiary();
      diaryTimer = dependencies.setInterval(
        () => void dependencies.checkAndGenerateDiary(),
        runtimeConfig.diaryCheckIntervalMs,
      );
      diaryTimer.unref?.();

      wordcloudTimer = dependencies.setInterval(
        dependencies.checkAndGenerateWordcloud,
        runtimeConfig.wordcloudCheckIntervalMs,
      );
      wordcloudTimer.unref?.();

      // Periodic buffer save: interval configurable by env
      bufferSaveTimer = dependencies.setInterval(() => {
        if (bufferSave) return;
        bufferSave = dependencies
          .saveConversationBuffer()
          .catch(() => void 0)
          .finally(() => {
            bufferSave = undefined;
          });
      }, runtimeConfig.bufferSaveIntervalMs);
      bufferSaveTimer.unref?.();
    },
    async stopBackgroundServices() {
      dependencies.stopProactiveChecker();
      if (diaryTimer) dependencies.clearInterval(diaryTimer);
      if (wordcloudTimer) dependencies.clearInterval(wordcloudTimer);
      if (bufferSaveTimer) dependencies.clearInterval(bufferSaveTimer);
      await Promise.all([
        dependencies.stopGroupRuntime(),
        dependencies.stopDiaryService(),
        dependencies.stopWordcloudService(),
        bufferSave,
      ]);
    },
    async closeBackgroundServices() {
      await Promise.all([databaseBackup?.close(), memoryEmbeddingIndex?.close()]);
    },
  });
}

type MainEvent = "SIGINT" | "SIGTERM" | "uncaughtException" | "unhandledRejection";

export interface MainDependencies {
  createApplication(): ReturnType<typeof createApplication>;
  once(event: MainEvent, listener: (value?: unknown) => void): void;
  exit(code: number): void;
  closeDatabase(): void;
  closeVideoReader(): Promise<void>;
  saveConversationBuffer(): Promise<void>;
  logError(error: unknown): void;
  logFatal(error: Error, message: string): void;
}

export const productionMainDependencies: MainDependencies = {
  createApplication: createProductionApplication,
  once: (event, listener) => process.once(event, listener),
  exit: (code) => process.exit(code),
  closeDatabase,
  closeVideoReader,
  saveConversationBuffer,
  logError: (err) => logger.error({ err }, "fatal startup error"),
  logFatal: (err, message) => logger.fatal({ err }, message),
};

export function runMain(dependencies: MainDependencies = productionMainDependencies): void {
  const application = dependencies.createApplication();
  application.start().catch((err: unknown) => {
    dependencies.logError(err);
    dependencies.exit(1);
  });
  const shutdown = () => {
    void application.shutdown().catch((err: unknown) => {
      dependencies.logError(err);
      dependencies.exit(1);
    });
  };
  dependencies.once("SIGINT", shutdown);
  dependencies.once("SIGTERM", shutdown);
  dependencies.once("uncaughtException", (value) => {
    const err = value instanceof Error ? value : new Error(String(value));
    dependencies.closeDatabase();
    void dependencies.closeVideoReader();
    dependencies.saveConversationBuffer().catch(() => void 0);
    dependencies.logFatal(err, "uncaught exception — exiting");
    dependencies.exit(1);
  });
  dependencies.once("unhandledRejection", (reason) => {
    dependencies.closeDatabase();
    void dependencies.closeVideoReader();
    dependencies.saveConversationBuffer().catch(() => void 0);
    dependencies.logFatal(
      reason instanceof Error ? reason : new Error(String(reason)),
      "unhandled rejection — exiting",
    );
    dependencies.exit(1);
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) runMain();
