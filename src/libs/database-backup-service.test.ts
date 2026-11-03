import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Api, RawApi } from "grammy";
import type { SqliteDatabase } from "../services/database.js";
import type { DatabaseBackupDependencies } from "./database-backup.js";

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
};
Object.assign(process.env, requiredEnv);

const { DatabaseBackupService } = await import("./database-backup.js");

interface RunRow {
  schedule_date: string;
  completed_at: number;
  archive_name: string;
  archive_bytes: number;
}

function fakeDatabase(directory: string, rows: RunRow[], backupError?: Error): SqliteDatabase {
  return {
    backup: async (destination: string) => {
      if (backupError) throw backupError;
      await writeFile(destination, "sqlite snapshot");
      return {} as never;
    },
    prepare: (sql: string) => ({
      get: () =>
        sql.includes("schedule_date")
          ? rows.toSorted((a, b) => b.schedule_date.localeCompare(a.schedule_date))[0]
          : undefined,
      all: () =>
        rows
          .toSorted((a, b) => b.completed_at - a.completed_at)
          .map((row) => ({
            archive_name: row.archive_name,
          })),
      run: (
        scheduleDate: string,
        completedAt: number,
        archiveName: string,
        archiveBytes: number,
      ) => {
        rows.push({
          schedule_date: scheduleDate,
          completed_at: completedAt,
          archive_name: archiveName,
          archive_bytes: archiveBytes,
        });
      },
    }),
    name: directory,
  } as unknown as SqliteDatabase;
}

function fakeApi(documents: string[], messages: string[], documentError?: Error): Api<RawApi> {
  return {
    sendDocument: async (_uid: string | number, file: { fileData: string }) => {
      if (documentError) throw documentError;
      documents.push(String(file.fileData));
      return {} as never;
    },
    sendMessage: async (_uid: string | number, message: string) => {
      messages.push(message);
      return {} as never;
    },
  } as unknown as Api<RawApi>;
}

async function createFixture(options?: {
  backupError?: Error;
  documentError?: Error;
  encryptedBytes?: number;
  scheduleError?: Error;
  pruneError?: Error;
}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nyarbot-service-test-"));
  const rows: RunRow[] = [];
  const documents: string[] = [];
  const messages: string[] = [];
  const delays: number[] = [];
  let timerCallback: (() => void) | undefined;
  const dependencies: Partial<DatabaseBackupDependencies> = {
    now: () => 123_456,
    date: () => new Date("2026-08-12T01:02:03.000Z"),
    scheduleState: (_now, _schedule, _zone, completed) => {
      if (options?.scheduleError) throw options.scheduleError;
      return {
        dueDate: completed ? null : "2026-08-12",
        nextRunMs: 999_999,
      };
    },
    encrypt: async (_source, destination) => {
      await writeFile(destination, Buffer.alloc(16, 1));
    },
    stat: async (target, statOptions) => {
      const result = await stat(target, statOptions as never);
      if (options?.encryptedBytes && String(target).endsWith(".enc")) {
        Object.defineProperty(result, "size", { value: options.encryptedBytes });
      }
      return result as never;
    },
    setTimeout: ((callback: () => void, delay: number) => {
      timerCallback = callback;
      delays.push(delay);
      return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeout: (() => {
      timerCallback = undefined;
    }) as typeof clearTimeout,
    ...(options?.pruneError
      ? {
          readdir: async () => {
            throw options.pruneError;
          },
        }
      : {}),
  };
  const service = new DatabaseBackupService(
    {
      database: fakeDatabase(directory, rows, options?.backupError),
      api: fakeApi(documents, messages, options?.documentError),
      adminUid: "1",
      passphrase: "passphrase",
      archiveDirectory: directory,
      schedule: "03:30",
      timeZone: "Asia/Shanghai",
    },
    dependencies,
  );
  return { directory, rows, documents, messages, delays, service, timer: () => timerCallback };
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not reached");
}

test("runs the complete backup lifecycle and records/schedules success", async () => {
  const fixture = await createFixture();
  try {
    fixture.service.start();
    await fixture.service.close();
    assert.equal(fixture.documents.length, 1);
    assert.equal(fixture.rows.length, 1);
    assert.equal(fixture.rows[0]?.schedule_date, "2026-08-12");
    assert.equal(fixture.rows[0]?.archive_bytes, 16);
    assert.equal(
      (await stat(path.join(fixture.directory, fixture.rows[0]!.archive_name))).mode & 0o777,
      0o600,
    );
    assert.deepEqual(
      (await readdir(fixture.directory)).filter(
        (name) => name.endsWith(".tmp") || name.endsWith(".partial"),
      ),
      [],
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("reports failure, cleans temporary files, and schedules a 15-minute retry", async () => {
  const fixture = await createFixture({ documentError: new Error("Telegram offline") });
  try {
    fixture.service.start();
    await waitFor(() => fixture.delays.length === 1);
    assert.match(fixture.messages[0]!, /Telegram offline/);
    assert.deepEqual(fixture.delays, [15 * 60 * 1000]);
    assert.equal(fixture.rows.length, 0);
    assert.deepEqual(
      (await readdir(fixture.directory)).filter(
        (name) => name.endsWith(".tmp") || name.endsWith(".partial"),
      ),
      [],
    );
    await fixture.service.close();
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("rejects archives above Telegram size limit without sending document", async () => {
  const fixture = await createFixture({ encryptedBytes: 50 * 1024 * 1024 + 1 });
  try {
    fixture.service.start();
    await waitFor(() => fixture.delays.length === 1);
    assert.equal(fixture.documents.length, 0);
    assert.match(fixture.messages[0]!, /exceeding Telegram's 50 MB limit/);
    assert.deepEqual(fixture.delays, [15 * 60 * 1000]);
    await fixture.service.close();
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("close cancels a scheduled timer and prevents subsequent work", async () => {
  const fixture = await createFixture();
  try {
    fixture.rows.push({
      schedule_date: "2026-08-12",
      completed_at: 1,
      archive_name: "old",
      archive_bytes: 1,
    });
    fixture.service.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(fixture.timer());
    await fixture.service.close();
    assert.equal(fixture.timer(), undefined);
    assert.equal(fixture.documents.length, 0);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("scheduler setup failures are contained and retried", async () => {
  const fixture = await createFixture({ scheduleError: new Error("bad schedule") });
  try {
    fixture.service.start();
    await waitFor(() => fixture.delays.length === 1);
    assert.deepEqual(fixture.delays, [15 * 60 * 1000]);
    assert.equal(fixture.documents.length, 0);
    await fixture.service.close();
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("a pruning failure does not undo a completed backup", async () => {
  const fixture = await createFixture({ pruneError: new Error("archive directory unavailable") });
  try {
    fixture.service.start();
    await waitFor(() => fixture.rows.length === 1);
    assert.equal(fixture.documents.length, 1);
    assert.deepEqual(fixture.messages, []);
    await fixture.service.close();
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("the scheduled timer callback performs the next check", async () => {
  const fixture = await createFixture();
  try {
    fixture.rows.push({
      schedule_date: "2026-08-12",
      completed_at: 1,
      archive_name: "old",
      archive_bytes: 1,
    });
    fixture.service.start();
    await waitFor(() => fixture.delays.length === 1);
    const scheduled = fixture.timer();
    assert.ok(scheduled);
    scheduled();
    await waitFor(() => fixture.delays.length === 2);
    assert.equal(fixture.documents.length, 0);
    await fixture.service.close();
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
