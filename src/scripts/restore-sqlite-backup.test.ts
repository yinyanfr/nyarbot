import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { encryptSqliteBackup } from "../libs/database-backup-crypto.js";

const passphrase = "correct horse battery staple";

test("restore argument parsing and verification reject invalid inputs", async () => {
  const restore = await import("./restore-sqlite-backup.js");
  assert.deepEqual(
    restore.parseArgs([
      "backup.sqlite.gz.enc",
      "out.sqlite",
      "--force",
      "--require-table",
      "custom",
    ]),
    {
      archivePath: "backup.sqlite.gz.enc",
      outputPath: "out.sqlite",
      force: true,
      requiredTables: ["custom"],
    },
  );
  assert.equal(restore.parseArgs(["backup.sqlite.gz.enc"]).outputPath, "backup.sqlite");
  assert.throws(() => restore.parseArgs([]), /Usage/);
  assert.throws(() => restore.parseArgs(["archive", "--unknown"]), /Usage/);
  assert.throws(() => restore.parseArgs(["archive", "--require-table"]), /Usage/);
  assert.throws(() => restore.parseArgs(["archive", "out", "extra"]), /Usage/);
  assert.throws(() => restore.parseArgs(["archive", "archive"]), /Usage/);
});

test("database verification rejects incompatible and empty schemas", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nyarbot-verify-test-"));
  const restore = await import("./restore-sqlite-backup.js");
  try {
    const incompatiblePath = path.join(directory, "incompatible.sqlite");
    const incompatible = new Database(incompatiblePath);
    incompatible.exec("CREATE TABLE sample (id INTEGER PRIMARY KEY) STRICT");
    incompatible.pragma("user_version = 999");
    incompatible.close();
    assert.throws(() => restore.verifyDatabase(incompatiblePath), /schema version 999/);

    const emptyPath = path.join(directory, "empty.sqlite");
    const empty = new Database(emptyPath);
    const { SCHEMA_VERSION } = await import("../services/schema-version.js");
    empty.pragma(`user_version = ${SCHEMA_VERSION}`);
    empty.close();
    assert.throws(() => restore.verifyDatabase(emptyPath), /no application tables/);
    await assert.rejects(
      restore.runRestore(
        { archivePath: emptyPath, outputPath: emptyPath, force: true, requiredTables: [] },
        passphrase,
      ),
      /must be different/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("argument defaults and output collision checks handle edge paths", async () => {
  const restore = await import("./restore-sqlite-backup.js");
  assert.deepEqual(restore.parseArgs(["archive.sqlite.gz.enc", "out.sqlite"]), {
    archivePath: "archive.sqlite.gz.enc",
    outputPath: "out.sqlite",
    force: false,
    requiredTables: [],
  });
  await assert.rejects(
    restore.runRestore(
      { archivePath: "./same", outputPath: path.resolve("same"), force: true, requiredTables: [] },
      passphrase,
    ),
    /must be different/,
  );
});

test("main validates command-line usage", async () => {
  const restore = await import("./restore-sqlite-backup.js");
  await assert.rejects(restore.main([]), /Usage/);
});

test("restore replaces output only after decrypting and verifying a real database", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nyarbot-restore-test-"));
  const sourcePath = path.join(directory, "source.sqlite");
  const archivePath = path.join(directory, "backup.sqlite.gz.enc");
  const outputPath = path.join(directory, "output.sqlite");
  Object.assign(process.env, {
    BOT_USERNAME: "test_bot",
    BOT_API_KEY: "test-token",
    TG_ADMIN_UID: "1",
    TG_GROUP_ID: "-100",
    DEEPSEEK_API_KEY: "test",
    TAVILY_API_KEY: "test",
    CF_AIG_TOKEN: "test",
    CF_ACCOUNT_ID: "test",
    DATABASE_BACKUP_PASSPHRASE: passphrase,
  });
  const databaseModule = await import("../services/database.js");
  const restore = await import("./restore-sqlite-backup.js");
  try {
    const database = databaseModule.initDatabase(sourcePath);
    database
      .prepare("INSERT INTO users (firestore_id, uid, nickname, source_json) VALUES (?, ?, ?, ?)")
      .run("u1", "u1", "Alice", "{}");
    databaseModule.closeDatabase();
    await encryptSqliteBackup(sourcePath, archivePath, passphrase, { cost: 1_024 });
    await writeFile(outputPath, "old output");
    await assert.rejects(
      restore.runRestore({ archivePath, outputPath, force: false, requiredTables: [] }, passphrase),
      /Refusing to overwrite/,
    );
    assert.equal(await readFile(outputPath, "utf8"), "old output");
    const tables = await restore.runRestore(
      { archivePath, outputPath, force: true, requiredTables: ["users"] },
      passphrase,
    );
    assert.ok(tables.includes("runtime_compactions"));
    const restored = new Database(outputPath, { readonly: true });
    assert.equal(restored.prepare("SELECT nickname FROM users").pluck().get(), "Alice");
    restored.close();
  } finally {
    databaseModule.closeDatabase();
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed restore preserves an existing output and removes staging files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nyarbot-restore-failure-test-"));
  const invalidPath = path.join(directory, "invalid.sqlite");
  const archivePath = path.join(directory, "invalid.sqlite.gz.enc");
  const outputPath = path.join(directory, "protected.sqlite");
  const restore = await import("./restore-sqlite-backup.js");
  try {
    const invalid = new Database(invalidPath);
    invalid.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY) STRICT");
    invalid.pragma("user_version = 1");
    invalid.close();
    await encryptSqliteBackup(invalidPath, archivePath, passphrase, { cost: 1_024 });
    await writeFile(outputPath, "keep me");
    await assert.rejects(
      restore.runRestore({ archivePath, outputPath, force: true, requiredTables: [] }, passphrase),
      /Required table is missing/,
    );
    assert.equal(await readFile(outputPath, "utf8"), "keep me");
    assert.equal(
      (await readdir(directory)).some((name) => name.includes(".restore-")),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
