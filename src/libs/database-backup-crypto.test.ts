import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { decryptSqliteBackup, encryptSqliteBackup } from "./database-backup-crypto.js";

const passphrase = "correct horse battery staple";
const fastKdf = { cost: 1_024 };

test("round-trips compressed bytes, refuses archive overwrite, and controls restore overwrite", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nyarbot-crypto-test-"));
  const source = path.join(directory, "source.sqlite");
  const archive = path.join(directory, "backup.enc");
  const restored = path.join(directory, "restored.sqlite");
  const payload = Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(32_768, 0x5a)]);
  try {
    await writeFile(source, payload);
    await encryptSqliteBackup(source, archive, passphrase, fastKdf);
    await assert.rejects(encryptSqliteBackup(source, archive, passphrase, fastKdf), {
      code: "EEXIST",
    });
    await writeFile(restored, "keep");
    await assert.rejects(decryptSqliteBackup(archive, restored, passphrase), { code: "EEXIST" });
    assert.equal(await readFile(restored, "utf8"), "keep");
    await decryptSqliteBackup(archive, restored, passphrase, { overwrite: true });
    assert.deepEqual(await readFile(restored), payload);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects wrong keys, corrupted ciphertext, truncated files, invalid magic and unsafe KDF headers", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nyarbot-crypto-corrupt-test-"));
  const source = path.join(directory, "source.sqlite");
  const archive = path.join(directory, "backup.enc");
  try {
    await writeFile(source, "SQLite format 3\0payload");
    await encryptSqliteBackup(source, archive, passphrase, fastKdf);
    await assert.rejects(
      decryptSqliteBackup(archive, path.join(directory, "wrong.sqlite"), "wrong passphrase"),
    );

    const original = await readFile(archive);
    const corrupted = Buffer.from(original);
    corrupted[corrupted.length - 17] = corrupted[corrupted.length - 17]! ^ 0xff;
    const corruptPath = path.join(directory, "corrupt.enc");
    await writeFile(corruptPath, corrupted);
    await assert.rejects(
      decryptSqliteBackup(corruptPath, path.join(directory, "corrupt.sqlite"), passphrase),
    );

    const shortPath = path.join(directory, "short.enc");
    await writeFile(shortPath, original.subarray(0, 10));
    await assert.rejects(
      decryptSqliteBackup(shortPath, path.join(directory, "short.sqlite"), passphrase),
      /Truncated backup header/,
    );

    const badMagic = Buffer.from(original);
    badMagic[0] = 0;
    const badMagicPath = path.join(directory, "magic.enc");
    await writeFile(badMagicPath, badMagic);
    await assert.rejects(
      decryptSqliteBackup(badMagicPath, path.join(directory, "magic.sqlite"), passphrase),
      /Not a nyarbot/,
    );

    const unsafe = Buffer.from(original);
    unsafe.writeUInt32BE(65_536, 9);
    const unsafePath = path.join(directory, "unsafe.enc");
    await writeFile(unsafePath, unsafe);
    await assert.rejects(
      decryptSqliteBackup(unsafePath, path.join(directory, "unsafe.sqlite"), passphrase),
      /unsafe or invalid scrypt/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects unsupported versions, every unsafe KDF field, and a missing authentication tag", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nyarbot-crypto-header-test-"));
  const source = path.join(directory, "source.sqlite");
  const archive = path.join(directory, "backup.enc");
  try {
    await writeFile(source, "SQLite format 3\0payload");
    await encryptSqliteBackup(source, archive, passphrase, fastKdf);
    const original = await readFile(archive);
    const mutations: [string, (bytes: Buffer) => void, RegExp][] = [
      ["version", (bytes) => bytes.writeUInt8(2, 8), /Unsupported backup format version/],
      ["non-power cost", (bytes) => bytes.writeUInt32BE(3, 9), /unsafe or invalid scrypt/],
      ["zero block size", (bytes) => bytes.writeUInt32BE(0, 13), /unsafe or invalid scrypt/],
      ["large block size", (bytes) => bytes.writeUInt32BE(9, 13), /unsafe or invalid scrypt/],
      ["zero parallelization", (bytes) => bytes.writeUInt32BE(0, 17), /unsafe or invalid scrypt/],
      ["large parallelization", (bytes) => bytes.writeUInt32BE(2, 17), /unsafe or invalid scrypt/],
    ];
    for (const [name, mutate, expected] of mutations) {
      const bytes = Buffer.from(original);
      mutate(bytes);
      const mutatedPath = path.join(directory, `${name}.enc`);
      await writeFile(mutatedPath, bytes);
      await assert.rejects(
        decryptSqliteBackup(mutatedPath, path.join(directory, `${name}.sqlite`), passphrase),
        expected,
      );
    }

    const noTagPath = path.join(directory, "no-tag.enc");
    await writeFile(noTagPath, original.subarray(0, 49));
    await assert.rejects(
      decryptSqliteBackup(noTagPath, path.join(directory, "no-tag.sqlite"), passphrase),
      /Truncated backup authentication tag/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("removes a reserved archive when source streaming fails", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nyarbot-crypto-cleanup-test-"));
  const archive = path.join(directory, "backup.enc");
  try {
    await assert.rejects(
      encryptSqliteBackup(path.join(directory, "missing.sqlite"), archive, passphrase, fastKdf),
      { code: "ENOENT" },
    );
    await assert.rejects(readFile(archive), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
