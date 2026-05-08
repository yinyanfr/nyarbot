import pino from "pino";
import type { Api, RawApi } from "grammy";
import config from "../configs/env.js";

const isDev = process.env.NODE_ENV !== "production";

// ---------------------------------------------------------------------------
// Admin DM stream — forwards error/warn logs to the admin via Telegram
// ---------------------------------------------------------------------------

const MIN_DM_INTERVAL_MS = 5_000; // rate-limit: max 1 DM per 5 seconds

class AdminDmStream {
  private botApi: Api<RawApi> | null = null;
  private lastDmTime = 0;
  private pending: string[] = [];

  /** Call after bot.init() to activate admin DM forwarding. */
  setBot(api: Api<RawApi>): void {
    this.botApi = api;
    // Flush any messages buffered before the bot was ready
    for (const msg of this.pending) {
      this.send(msg).catch(() => void 0);
    }
    this.pending = [];
  }

  /** Pino stream write handler. */
  write(chunk: string): boolean {
    let level: number;
    try {
      level = JSON.parse(chunk).level;
    } catch {
      return true;
    }

    if (level < 40) return true; // only warn (40) and error (50)

    const msg = this.formatChunk(chunk);
    if (!msg) return true;

    if (!this.botApi) {
      if (this.pending.length < 10) this.pending.push(msg);
      return true;
    }

    this.send(msg).catch(() => void 0);
    return true;
  }

  private formatChunk(chunk: string): string | null {
    try {
      const obj = JSON.parse(chunk);
      const levelName = obj.level >= 50 ? "🔴" : "🟡";
      const msg = obj.msg ?? "";
      const errPart = obj.err
        ? `\n${obj.err.message ?? ""}${obj.err.stack ? "\n" + obj.err.stack.split("\n").slice(0, 3).join("\n") : ""}`
        : "";
      const extra = Object.entries(obj)
        .filter(
          ([k]) =>
            k !== "level" &&
            k !== "time" &&
            k !== "pid" &&
            k !== "hostname" &&
            k !== "msg" &&
            k !== "name" &&
            k !== "err",
        )
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" ");
      const full = extra
        ? `${levelName} ${msg} ${extra}${errPart}`
        : `${levelName} ${msg}${errPart}`;
      return full.slice(0, 4000);
    } catch {
      return null;
    }
  }

  private async send(text: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastDmTime < MIN_DM_INTERVAL_MS) return;
    this.lastDmTime = now;

    try {
      await this.botApi!.sendMessage(config.tgAdminUid, text);
    } catch {
      // Silently ignore — admin DM is best-effort
    }
  }
}

const adminDmStream = new AdminDmStream();

// ---------------------------------------------------------------------------
// Logger setup
// ---------------------------------------------------------------------------

const baseOptions: pino.LoggerOptions = {
  name: "nyarbot",
  level: process.env.LOG_LEVEL ?? "info",
};

const adminStream: pino.StreamEntry = {
  stream: adminDmStream as unknown as NodeJS.WritableStream,
  level: "warn",
};

export const logger: pino.Logger = isDev
  ? pino({ ...baseOptions, transport: { target: "pino-pretty", options: { colorize: true } } })
  : pino(baseOptions, pino.multistream([{ stream: process.stdout }, adminStream]));

// In dev mode, pino-pretty uses worker transport which doesn't support multistream.
// We add admin DM forwarding via a child logger approach instead.
if (isDev) {
  const origError = logger.error.bind(logger);
  const origWarn = logger.warn.bind(logger);

  const forwardToAdmin = (
    level: number,
    mergingObjectOrMsg: unknown,
    msgOrInterpolation: unknown,
  ) => {
    try {
      const obj =
        typeof mergingObjectOrMsg === "object" && mergingObjectOrMsg !== null
          ? { ...(mergingObjectOrMsg as Record<string, unknown>) }
          : {};
      const msg =
        typeof mergingObjectOrMsg === "string"
          ? mergingObjectOrMsg
          : typeof msgOrInterpolation === "string"
            ? msgOrInterpolation
            : (obj.msg ?? "");
      adminDmStream.write(JSON.stringify({ ...obj, level, msg }));
    } catch {
      // best-effort
    }
  };

  logger.error = ((...args: unknown[]) => {
    forwardToAdmin(50, args[0], args[1]);
    return origError(
      args[0] as Parameters<typeof origError>[0],
      args[1] as Parameters<typeof origError>[1],
    );
  }) as typeof logger.error;

  logger.warn = ((...args: unknown[]) => {
    forwardToAdmin(40, args[0], args[1]);
    return origWarn(
      args[0] as Parameters<typeof origWarn>[0],
      args[1] as Parameters<typeof origWarn>[1],
    );
  }) as typeof logger.warn;
}

/** Call after bot.init() to start forwarding warn/error logs to admin DM. */
export function initAdminNotify(api: Api<RawApi>): void {
  adminDmStream.setBot(api);
}
