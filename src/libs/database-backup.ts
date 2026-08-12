import { chmod, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { InputFile, type Api, type RawApi } from "grammy";
import type { SqliteDatabase } from "../services/database.js";
import { logger } from "./logger.js";
import { encryptSqliteBackup } from "./database-backup-crypto.js";
import { selectArchiveNamesToDelete } from "./database-backup-retention.js";
import { getBackupScheduleState } from "./database-backup-schedule.js";

const MAX_TELEGRAM_FILE_BYTES = 50 * 1024 * 1024;
const TIMER_MAX_MS = 2_147_000_000;
const FAILURE_RETRY_MS = 15 * 60 * 1000;
const ARCHIVE_PATTERN = /^nyarbot-\d{8}T\d{6}Z\.sqlite\.gz\.enc$/;

export interface DatabaseBackupOptions {
  database: SqliteDatabase;
  api: Api<RawApi>;
  adminUid: string;
  passphrase: string;
  archiveDirectory: string;
  schedule: string;
  timeZone: string;
}

export interface DatabaseBackupDependencies {
  now: () => number;
  date: () => Date;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  mkdir: typeof mkdir;
  chmod: typeof chmod;
  rename: typeof rename;
  rm: typeof rm;
  stat: typeof stat;
  readdir: typeof readdir;
  encrypt: typeof encryptSqliteBackup;
  scheduleState: typeof getBackupScheduleState;
}

const productionDependencies: DatabaseBackupDependencies = {
  now: Date.now,
  date: () => new Date(),
  setTimeout,
  clearTimeout,
  mkdir,
  chmod,
  rename,
  rm,
  stat,
  readdir,
  encrypt: encryptSqliteBackup,
  scheduleState: getBackupScheduleState,
};

interface CompletionRow {
  schedule_date: string;
}

export class DatabaseBackupService {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private checking: Promise<void> | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;
  private readonly dependencies: DatabaseBackupDependencies;

  constructor(
    private readonly options: DatabaseBackupOptions,
    dependencies: Partial<DatabaseBackupDependencies> = {},
  ) {
    this.dependencies = { ...productionDependencies, ...dependencies };
  }

  start(): void {
    this.stopped = false;
    this.launchCheck();
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) this.dependencies.clearTimeout(this.timer);
    this.timer = undefined;
    await this.checking?.catch(() => void 0);
    await this.running?.catch(() => void 0);
  }

  private launchCheck(): void {
    const checking = this.checkAndScheduleSafely();
    this.checking = checking;
    void checking.finally(() => {
      if (this.checking === checking) this.checking = undefined;
    });
  }

  private latestCompletedDate(): string | undefined {
    const row = this.options.database
      .prepare(`SELECT schedule_date FROM database_backup_runs ORDER BY schedule_date DESC LIMIT 1`)
      .get() as CompletionRow | undefined;
    return row?.schedule_date;
  }

  private async checkAndSchedule(): Promise<void> {
    if (this.stopped) return;
    const nowMs = this.dependencies.now();
    const state = this.dependencies.scheduleState(
      nowMs,
      this.options.schedule,
      this.options.timeZone,
      this.latestCompletedDate(),
    );
    let failed = false;
    if (state.dueDate) {
      this.running = this.run(state.dueDate);
      await this.running.catch(() => {
        failed = true;
      });
      this.running = undefined;
    }
    if (this.stopped) return;
    const next = this.dependencies.scheduleState(
      this.dependencies.now(),
      this.options.schedule,
      this.options.timeZone,
      this.latestCompletedDate(),
    );
    const delay = failed
      ? FAILURE_RETRY_MS
      : Math.max(1_000, Math.min(TIMER_MAX_MS, next.nextRunMs - this.dependencies.now()));
    this.timer = this.dependencies.setTimeout(() => this.launchCheck(), delay);
    this.timer.unref?.();
  }

  private async checkAndScheduleSafely(): Promise<void> {
    try {
      await this.checkAndSchedule();
    } catch (err) {
      if (this.stopped) return;
      logger.error({ err }, "database backup scheduler failed");
      this.timer = this.dependencies.setTimeout(() => this.launchCheck(), FAILURE_RETRY_MS);
      this.timer.unref?.();
    }
  }

  private async run(scheduleDate: string): Promise<void> {
    await this.dependencies.mkdir(this.options.archiveDirectory, { recursive: true, mode: 0o700 });
    const timestamp = this.dependencies
      .date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}/, "");
    const archiveName = `nyarbot-${timestamp}.sqlite.gz.enc`;
    const archivePath = path.join(this.options.archiveDirectory, archiveName);
    const partialArchivePath = `${archivePath}.partial`;
    const snapshotPath = path.join(this.options.archiveDirectory, `.${archiveName}.sqlite.tmp`);
    try {
      await this.options.database.backup(snapshotPath);
      await this.dependencies.chmod(snapshotPath, 0o600);
      await this.dependencies.encrypt(snapshotPath, partialArchivePath, this.options.passphrase);
      await this.dependencies.rename(partialArchivePath, archivePath);
      await this.dependencies.chmod(archivePath, 0o600);
      const archiveStat = await this.dependencies.stat(archivePath);
      if (archiveStat.size > MAX_TELEGRAM_FILE_BYTES) {
        throw new Error(
          `Encrypted database backup is ${archiveStat.size} bytes, exceeding Telegram's 50 MB limit`,
        );
      }
      await this.options.api.sendDocument(
        this.options.adminUid,
        new InputFile(archivePath, archiveName),
        { caption: `SQLite backup ${scheduleDate} (${this.options.timeZone})` },
      );
      this.options.database
        .prepare(
          `
            INSERT INTO database_backup_runs (schedule_date, completed_at, archive_name, archive_bytes)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(schedule_date) DO UPDATE SET
              completed_at = excluded.completed_at,
              archive_name = excluded.archive_name,
              archive_bytes = excluded.archive_bytes
          `,
        )
        .run(scheduleDate, this.dependencies.now(), archiveName, archiveStat.size);
      logger.info(
        { scheduleDate, archiveName, bytes: archiveStat.size },
        "database backup completed",
      );
    } catch (err) {
      logger.error({ err, scheduleDate }, "database backup failed");
      await this.options.api
        .sendMessage(
          this.options.adminUid,
          `SQLite backup failed for ${scheduleDate}: ${err instanceof Error ? err.message : String(err)}`.slice(
            0,
            4000,
          ),
        )
        .catch(() => void 0);
      throw err;
    } finally {
      await this.dependencies.rm(snapshotPath, { force: true }).catch(() => void 0);
      await this.dependencies.rm(partialArchivePath, { force: true }).catch(() => void 0);
      await this.pruneArchives().catch((err: unknown) => {
        logger.warn({ err }, "database backup archive pruning failed");
      });
    }
  }

  private async pruneArchives(): Promise<void> {
    const entries = await this.dependencies.readdir(this.options.archiveDirectory, {
      withFileTypes: true,
    });
    const archives = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && ARCHIVE_PATTERN.test(entry.name))
        .map(async (entry) => ({
          name: entry.name,
          mtimeMs: (
            await this.dependencies.stat(path.join(this.options.archiveDirectory, entry.name))
          ).mtimeMs,
        })),
    );
    const successfulRows = this.options.database
      .prepare(`SELECT archive_name FROM database_backup_runs ORDER BY completed_at DESC`)
      .all() as { archive_name: string }[];
    const toDelete = selectArchiveNamesToDelete(
      archives,
      successfulRows.map((row) => row.archive_name),
    );
    await Promise.all(
      toDelete.map((name) =>
        this.dependencies.rm(path.join(this.options.archiveDirectory, name), { force: true }),
      ),
    );
  }
}
