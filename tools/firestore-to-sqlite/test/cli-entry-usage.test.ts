import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

test("CLI prints argument errors without attempting migration", async () => {
  const cliUrl = new URL("../src/cli.ts", import.meta.url);
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  const originalWrite = process.stderr.write;
  let stderr = "";

  process.argv = [process.execPath, fileURLToPath(cliUrl)];
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;

  try {
    await import(pathToFileURL(fileURLToPath(cliUrl)).href);
    assert.equal(process.exitCode, 1);
    const printed = JSON.parse(stderr) as { status: string; error?: string };
    assert.equal(printed.status, "failed");
    assert.match(printed.error ?? "", /^Usage:/);
  } finally {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    process.stderr.write = originalWrite;
  }
});
