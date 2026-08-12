import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

test("CLI prints and persists a failed report for invalid service account JSON", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "nyarbot-cli-entry-test-"));
  const serviceAccount = path.join(directory, "service-account.json");
  const wordcloudDb = path.join(directory, "legacy.sqlite");
  const output = path.join(directory, "output.sqlite");
  const reportPath = `${output}.migration-report.json`;
  const cliUrl = new URL("../src/cli.ts", import.meta.url);
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  const originalWrite = process.stderr.write;
  let stderr = "";

  writeFileSync(serviceAccount, "not-json");
  writeFileSync(wordcloudDb, "");
  process.argv = [
    process.execPath,
    fileURLToPath(cliUrl),
    "--service-account",
    serviceAccount,
    "--wordcloud-db",
    wordcloudDb,
    "--output",
    output,
    "--timezone",
    "Asia/Shanghai",
  ];
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;

  try {
    await import(pathToFileURL(fileURLToPath(cliUrl)).href);
    assert.equal(process.exitCode, 1);
    const printed = JSON.parse(stderr) as { status: string; error?: string };
    const persisted = JSON.parse(readFileSync(reportPath, "utf8")) as {
      status: string;
      error?: string;
    };
    assert.equal(printed.status, "failed");
    assert.match(printed.error ?? "", /JSON/);
    assert.deepEqual(printed, persisted);
  } finally {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    process.stderr.write = originalWrite;
    rmSync(directory, { recursive: true, force: true });
  }
});
