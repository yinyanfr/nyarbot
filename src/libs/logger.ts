import pino from "pino";
import { createRequire } from "node:module";
import type { Api, RawApi } from "grammy";
import config from "../configs/env.js";

const isDev = process.env.NODE_ENV !== "production";

// ---------------------------------------------------------------------------
// Admin DM stream — forwards warn/error logs to the admin via Telegram
// ---------------------------------------------------------------------------

const MIN_DM_INTERVAL_MS = 5_000;

class AdminDmHandler {
  private botApi: Api<RawApi> | null = null;
  private lastDmTime = 0;
  private pending: string[] = [];

  setBot(api: Api<RawApi>): void {
    this.botApi = api;
    for (const msg of this.pending) {
      this.send(msg).catch(() => void 0);
    }
    this.pending = [];
  }

  /** pino-compatible write handler — called once per log line. */
  write(chunk: string): void {
    let level: number;
    try {
      level = JSON.parse(chunk).level;
    } catch {
      return;
    }
    if (level < 40) return; // only warn (40) and error (50)

    const msg = this.formatChunk(chunk);
    if (!msg) return;

    if (!this.botApi) {
      if (this.pending.length < 10) this.pending.push(msg);
      return;
    }

    this.send(msg).catch(() => void 0);
  }

  private formatChunk(chunk: string): string | null {
    try {
      const obj = JSON.parse(chunk);
      const levelName = obj.level >= 50 ? "\uD83D\uDD34" : "\uD83D\uDFE1";
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
      // Admin DM is best-effort
    }
  }
}

const adminDm = new AdminDmHandler();

/**
 * Return a writable stream-compatible object for pino's multistream.
 * Pino v10 calls `stream.write(chunk)` and expects no return value.
 */
function adminDmStream(): { write(msg: string): void } {
  return { write: (msg: string) => adminDm.write(msg) };
}

// ---------------------------------------------------------------------------
// Logger factory
// ---------------------------------------------------------------------------

function createLogger(): pino.Logger {
  const baseOptions: pino.LoggerOptions = {
    name: "nyarbot",
    level: process.env.LOG_LEVEL ?? "info",
  };

  // In dev mode, try to load pino-pretty as a direct transform stream (main
  // thread, no worker). Falls back to plain JSON stdout if pino-pretty isn't
  // available.
  const primaryStream = isDev ? getPrettyStream() : undefined;

  return pino(
    baseOptions,
    pino.multistream([
      { stream: primaryStream ?? process.stdout },
      { level: "warn", stream: adminDmStream() },
    ]),
  );
}

/**
 * Conditionally load pino-pretty (dev only). Returns a Transform stream that
 * pretty-prints JSON logs, or undefined if pino-pretty isn't installed.
 */
function getPrettyStream(): NodeJS.WritableStream | undefined {
  try {
    const req = createRequire(import.meta.url);
    const prettyFactory = req("pino-pretty") as
      | { default?: (opts?: object) => NodeJS.WritableStream }
      | ((opts?: object) => NodeJS.WritableStream);
    const factory = typeof prettyFactory === "function" ? prettyFactory : prettyFactory.default;
    if (typeof factory !== "function") return undefined;
    return factory({ colorize: true });
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const logger = createLogger();

/** Call after bot.init() to start forwarding warn/error logs to admin DM. */
export function initAdminNotify(api: Api<RawApi>): void {
  adminDm.setBot(api);
}
