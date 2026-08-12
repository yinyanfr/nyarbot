import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
  runMigration,
  type FirestoreLike,
  type MigrationDependencies,
  type MigrationOptions,
} from "../src/cli.js";

function createLegacy(pathname: string): void {
  const db = new Database(pathname);
  db.exec(`
    CREATE TABLE group_messages (chat_id TEXT, message_id INTEGER, user_id TEXT, display_name TEXT, username TEXT, is_bot INTEGER, text TEXT, created_at INTEGER, edited_at INTEGER, PRIMARY KEY(chat_id, message_id));
    CREATE TABLE wordcloud_runs (date TEXT PRIMARY KEY, published_at INTEGER);
    CREATE TABLE wordcloud_publications (date TEXT, slot TEXT, published_at INTEGER, PRIMARY KEY(date, slot));
  `);
  db.close();
}

function fixture(): { directory: string; options: MigrationOptions } {
  const directory = mkdtempSync(path.join(os.tmpdir(), "nyarbot-cli-test-"));
  const serviceAccount = path.join(directory, "service-account.json");
  const wordcloudDb = path.join(directory, "legacy.sqlite");
  writeFileSync(
    serviceAccount,
    JSON.stringify({
      project_id: "fake-project",
      client_email: "fake@example.com",
      private_key: "fake-key",
    }),
  );
  createLegacy(wordcloudDb);
  return {
    directory,
    options: {
      serviceAccount,
      wordcloudDb,
      output: path.join(directory, "nested", "output.sqlite"),
      timezone: "Asia/Shanghai",
    },
  };
}

function fakeFirestore(collections: Record<string, Record<string, unknown>>): FirestoreLike {
  return {
    async listCollections() {
      return Object.keys(collections).map((id) => ({ id }));
    },
    collection(name) {
      const values = collections[name] ?? {};
      const documents = Object.entries(values).map(([id, value]) => ({
        id,
        exists: true,
        data: () => value,
      }));
      return {
        async get() {
          return { docs: documents };
        },
        doc(id) {
          const value = values[id];
          return {
            async get() {
              return { id, exists: value !== undefined, data: () => value };
            },
          };
        },
      };
    },
  };
}

function dependencies(
  firestore: FirestoreLike,
  overrides: Partial<MigrationDependencies> = {},
): Partial<MigrationDependencies> & { closed: { value: boolean } } {
  const closed = { value: false };
  return {
    randomUUID: () => "fixed-id",
    now: () => new Date("2026-01-02T03:04:05.000Z"),
    async connectFirestore(credentials) {
      assert.equal(credentials.projectId, "fake-project");
      return {
        firestore,
        async close() {
          closed.value = true;
        },
      };
    },
    ...overrides,
    closed,
  };
}

test("runMigration succeeds with fake Firestore, archives unknown collections, and excludes backups", async () => {
  const { directory, options } = fixture();
  const deps = dependencies(
    fakeFirestore({
      users: { user: { uid: "42", nickname: "Yan", memories: [] } },
      diary: {},
      diaryObservations: {},
      runtime: {
        group: { summary: "summary", summaryCursorTs: 1, updatedAt: 2 },
        ignored: { summary: "not fetched" },
      },
      events: {},
      turns: {},
      compactions: {},
      mystery: { "doc / one": { nested: true } },
      users_backup: { secret: { ignored: true } },
    }),
  );
  try {
    const report = await runMigration(options, deps);
    assert.equal(report.status, "success", report.error);
    assert.equal(report.projectId, "fake-project");
    assert.equal(report.formalCollections.users?.sourceCount, 1);
    assert.equal(report.formalCollections.runtime?.sourceCount, 1);
    assert.equal(report.formalCollections.diary?.sourceCount, 0);
    assert.equal(
      report.checks.every((check) => check.ok),
      true,
    );
    assert.deepEqual(report.ignoredBackupCollections, ["users_backup"]);
    assert.equal(report.unknownCollections.mystery?.count, 1);
    assert.equal(deps.closed.value, true);
    assert.equal(existsSync(options.output), true);
    assert.equal(existsSync(report.report), true);
    const archive = JSON.parse(
      readFileSync(report.unknownCollections.mystery!.archive, "utf8"),
    ) as {
      collection: string;
      documents: unknown[];
    };
    assert.equal(archive.collection, "mystery");
    assert.equal(archive.documents.length, 1);
    const db = new Database(options.output, { readonly: true });
    assert.equal(
      (
        db.prepare("SELECT value FROM schema_metadata WHERE key = 'migration_timezone'").get() as {
          value: string;
        }
      ).value,
      "Asia/Shanghai",
    );
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runMigration rejects output, report, archive, and missing input collisions before Firebase", async () => {
  for (const collision of ["output", "report", "archive", "service", "wordcloud"] as const) {
    const { directory, options } = fixture();
    let connected = false;
    const deps = dependencies(fakeFirestore({}), {
      async connectFirestore() {
        connected = true;
        throw new Error("must not connect");
      },
    });
    try {
      mkdirSync(path.dirname(options.output), { recursive: true });
      if (collision === "output") writeFileSync(options.output, "", { flag: "wx" });
      if (collision === "report")
        writeFileSync(`${options.output}.migration-report.json`, "", { flag: "wx" });
      if (collision === "archive") {
        const archive = `${options.output}.unknown-collections`;
        writeFileSync(archive, "", { flag: "wx" });
      }
      if (collision === "service") rmSync(options.serviceAccount);
      if (collision === "wordcloud") rmSync(options.wordcloudDb);
      await assert.rejects(() => runMigration(options, deps), /already exists|not found/);
      assert.equal(connected, false, collision);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("runMigration returns failed report for malformed credentials and Firestore documents", async () => {
  for (const scenario of ["credentials", "document"] as const) {
    const { directory, options } = fixture();
    if (scenario === "credentials") writeFileSync(options.serviceAccount, "not-json");
    const deps = dependencies(
      fakeFirestore(
        scenario === "document"
          ? { users: { bad: { uid: "42", nickname: "Yan", memories: [1] } } }
          : {},
      ),
    );
    try {
      const report = await runMigration(options, deps);
      assert.equal(report.status, "failed");
      assert.match(report.error ?? "", scenario === "credentials" ? /JSON/ : /Malformed formal/);
      assert.equal(existsSync(options.output), false);
      assert.equal(existsSync(report.report), true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("runMigration rolls back published output when report publication fails", async () => {
  const { directory, options } = fixture();
  const reportPath = `${options.output}.migration-report.json`;
  const deps = dependencies(fakeFirestore({}), {
    writeFileSync(pathname, data, optionsArg) {
      if (pathname === reportPath) throw new Error("report write failed");
      return writeFileSync(pathname, data, optionsArg);
    },
  });
  try {
    await assert.rejects(() => runMigration(options, deps), /report write failed/);
    assert.equal(existsSync(options.output), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runMigration records output cleanup failure after report publication fails", async () => {
  const { directory, options } = fixture();
  const reportPath = `${options.output}.migration-report.json`;
  let reportWrites = 0;
  const deps = dependencies(fakeFirestore({}), {
    writeFileSync(pathname, data, optionsArg) {
      if (pathname === reportPath && reportWrites++ === 0) throw new Error("report write failed");
      return writeFileSync(pathname, data, optionsArg);
    },
    rmSync(pathname, optionsArg) {
      if (pathname === options.output) throw new Error("output cleanup failed");
      return rmSync(pathname, optionsArg);
    },
  });
  try {
    const report = await runMigration(options, deps);
    assert.equal(report.status, "failed");
    assert.match(report.error ?? "", /report write failed/);
    assert.match(report.error ?? "", /Cleanup failed: output cleanup failed/);
    assert.equal(existsSync(options.output), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runMigration records archive cleanup failure after output publication fails", async () => {
  const { directory, options } = fixture();
  const archiveDirectory = `${options.output}.unknown-collections`;
  const deps = dependencies(fakeFirestore({ mystery: { doc: { value: 1 } } }), {
    renameSync() {
      throw new Error("publish failed");
    },
    rmSync(pathname, optionsArg) {
      if (pathname === archiveDirectory) throw new Error("archive cleanup failed");
      return rmSync(pathname, optionsArg);
    },
  });
  try {
    const report = await runMigration(options, deps);
    assert.equal(report.status, "failed");
    assert.match(report.error ?? "", /publish failed/);
    assert.match(report.error ?? "", /Cleanup failed: archive cleanup failed/);
    assert.equal(existsSync(archiveDirectory), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runMigration records failed checks and cleanup failures without masking the cause", async () => {
  const { directory, options } = fixture();
  const originalRm = rmSync;
  const deps = dependencies(fakeFirestore({ unknown: { doc: { value: 1 } } }), {
    runChecks() {
      return [{ name: "forced", ok: false, detail: {} }];
    },
    rmSync(pathname, optionsArg) {
      if (
        String(pathname).includes("staging") ||
        String(pathname).includes("unknown-collections")
      ) {
        throw new Error(`cannot remove ${pathname}`);
      }
      return originalRm(pathname, optionsArg);
    },
  });
  try {
    const report = await runMigration(options, deps);
    assert.equal(report.status, "failed");
    assert.match(report.error ?? "", /migration checks failed/);
    assert.match(report.error ?? "", /Cleanup failed: cannot remove/);
  } finally {
    originalRm(directory, { recursive: true, force: true });
  }
});

test("runMigration reports Firebase close failures through normal rollback", async () => {
  const { directory, options } = fixture();
  const deps = dependencies(fakeFirestore({ runtime: {} }), {
    async connectFirestore() {
      return {
        firestore: fakeFirestore({ runtime: {} }),
        async close() {
          throw new Error("firebase close failed");
        },
      };
    },
  });
  try {
    const report = await runMigration(options, deps);
    assert.equal(report.status, "failed");
    assert.match(report.error ?? "", /firebase close failed/);
    const persisted = JSON.parse(
      readFileSync(`${options.output}.migration-report.json`, "utf8"),
    ) as typeof report;
    assert.deepEqual(persisted, report);
    assert.equal(existsSync(options.output), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
