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

interface CompletionRow {
  schedule_date: string;
}

export class DatabaseBackupService {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(private readonly options: DatabaseBackupOptions) {}

  start(): void {
    this.stopped = false;
    void this.checkAndScheduleSafely();
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => void 0);
  }

  private latestCompletedDate(): string | undefined {
    const row = this.options.database
      .prepare(`SELECT schedule_date FROM database_backup_runs ORDER BY schedule_date DESC LIMIT 1`)
      .get() as CompletionRow | undefined;
    return row?.schedule_date;
  }

  private async checkAndSchedule(): Promise<void> {
    if (this.stopped) return;
    const nowMs = Date.now();
    const state = getBackupScheduleState(
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
    const next = getBackupScheduleState(
      Date.now(),
      this.options.schedule,
      this.options.timeZone,
      this.latestCompletedDate(),
    );
    const delay = failed
      ? FAILURE_RETRY_MS
      : Math.max(1_000, Math.min(TIMER_MAX_MS, next.nextRunMs - Date.now()));
    this.timer = setTimeout(() => void this.checkAndScheduleSafely(), delay);
    this.timer.unref?.();
  }

  private async checkAndScheduleSafely(): Promise<void> {
    try {
      await this.checkAndSchedule();
    } catch (err) {
      if (this.stopped) return;
      logger.error({ err }, "database backup scheduler failed");
      this.timer = setTimeout(() => void this.checkAndScheduleSafely(), FAILURE_RETRY_MS);
      this.timer.unref?.();
    }
  }

  private async run(scheduleDate: string): Promise<void> {
    await mkdir(this.options.archiveDirectory, { recursive: true, mode: 0o700 });
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}/, "");
    const archiveName = `nyarbot-${timestamp}.sqlite.gz.enc`;
    const archivePath = path.join(this.options.archiveDirectory, archiveName);
    const partialArchivePath = `${archivePath}.partial`;
    const snapshotPath = path.join(this.options.archiveDirectory, `.${archiveName}.sqlite.tmp`);
    try {
      await this.options.database.backup(snapshotPath);
      await chmod(snapshotPath, 0o600);
      await encryptSqliteBackup(snapshotPath, partialArchivePath, this.options.passphrase);
      await rename(partialArchivePath, archivePath);
      const archiveStat = await stat(archivePath);
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
        .run(scheduleDate, Date.now(), archiveName, archiveStat.size);
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
      await rm(snapshotPath, { force: true }).catch(() => void 0);
      await rm(partialArchivePath, { force: true }).catch(() => void 0);
      await this.pruneArchives().catch((err: unknown) => {
        logger.warn({ err }, "database backup archive pruning failed");
      });
    }
  }

  private async pruneArchives(): Promise<void> {
    const entries = await readdir(this.options.archiveDirectory, { withFileTypes: true });
    const archives = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && ARCHIVE_PATTERN.test(entry.name))
        .map(async (entry) => ({
          name: entry.name,
          mtimeMs: (await stat(path.join(this.options.archiveDirectory, entry.name))).mtimeMs,
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
      toDelete.map((name) => rm(path.join(this.options.archiveDirectory, name), { force: true })),
    );
  }
}
