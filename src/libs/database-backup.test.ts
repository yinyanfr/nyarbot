import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { decryptSqliteBackup, encryptSqliteBackup } from "./database-backup-crypto.js";
import { getBackupScheduleState, parseBackupSchedule } from "./database-backup-schedule.js";
import { selectArchiveNamesToDelete } from "./database-backup-retention.js";

test("encrypted backup roundtrip and authentication", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nyarbot-backup-test-"));
  const source = path.join(directory, "source.sqlite");
  const archive = path.join(directory, "backup.enc");
  const restored = path.join(directory, "restored.sqlite");
  const payload = Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(64 * 1024, 0x5a)]);
  try {
    await writeFile(source, payload);
    await encryptSqliteBackup(source, archive, "correct horse battery staple", { cost: 1_024 });
    await decryptSqliteBackup(archive, restored, "correct horse battery staple");
    assert.deepEqual(await readFile(restored), payload);
    await assert.rejects(
      decryptSqliteBackup(archive, path.join(directory, "wrong.sqlite"), "wrong passphrase"),
    );
    const corrupted = path.join(directory, "corrupted.enc");
    const bytes = await readFile(archive);
    const corruptAt = bytes.length - 20;
    bytes[corruptAt] = bytes[corruptAt]! ^ 0xff;
    await writeFile(corrupted, bytes);
    const protectedOutput = path.join(directory, "protected.sqlite");
    await writeFile(protectedOutput, "keep me");
    await assert.rejects(
      decryptSqliteBackup(corrupted, protectedOutput, "correct horse battery staple"),
    );
    assert.equal(await readFile(protectedOutput, "utf8"), "keep me");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("schedule reports a startup missed run and the next zoned run", () => {
  const before = Date.parse("2026-08-11T19:29:00Z");
  const after = Date.parse("2026-08-11T19:31:00Z");
  assert.equal(getBackupScheduleState(before, "03:30", "Asia/Shanghai").dueDate, "2026-08-11");
  assert.equal(
    getBackupScheduleState(before, "03:30", "Asia/Shanghai", "2026-08-11").nextRunMs,
    Date.parse("2026-08-11T19:30:00Z"),
  );
  assert.equal(getBackupScheduleState(after, "03:30", "Asia/Shanghai").dueDate, "2026-08-12");
  assert.equal(
    getBackupScheduleState(after, "03:30", "Asia/Shanghai", "2026-08-12").nextRunMs,
    Date.parse("2026-08-12T19:30:00Z"),
  );
  assert.throws(() => parseBackupSchedule("3:30"));
});

test("archive retention keeps seven successful backups and the latest failed attempt", () => {
  const successful = Array.from({ length: 8 }, (_, index) => `success-${8 - index}`);
  const archives = [
    ...successful.map((name, index) => ({ name, mtimeMs: 100 - index })),
    { name: "failed-new", mtimeMs: 200 },
    { name: "failed-old", mtimeMs: 50 },
  ];
  assert.deepEqual(selectArchiveNamesToDelete(archives, successful).sort(), [
    "failed-old",
    "success-1",
  ]);
});
