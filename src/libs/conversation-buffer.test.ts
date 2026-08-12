import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { HistoryEntry } from "./conversation-buffer.js";

Object.assign(process.env, {
  BOT_USERNAME: "test_bot",
  BOT_API_KEY: "test-token",
  TG_ADMIN_UID: "1",
  TG_GROUP_ID: "-100",
  DEEPSEEK_API_KEY: "test",
  TAVILY_API_KEY: "test",
  CF_AIG_TOKEN: "test",
  CF_ACCOUNT_ID: "test",
  DATABASE_BACKUP_PASSPHRASE: "correct horse battery staple",
  LOG_LEVEL: "silent",
});

test("conversation buffers cap and format prompt-safe history", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nyarbot-buffer-test-"));
  const module = await import("./conversation-buffer.js");
  const buffer = module.createConversationBuffer(path.join(directory, "buffer.json"));
  try {
    for (let index = 0; index < 32; index += 1) {
      buffer.pushMessage(
        "group",
        `u${index}`,
        index === 31 ? '<Alice & "Bob">' : "Alice",
        "x".repeat(510),
      );
    }
    const history = buffer.getHistory("group");
    assert.equal(history.length, 30);
    assert.equal(history[0]?.uid, "u2");
    assert.equal(history[29]?.text.length, 500);
    const context = module.formatHistoryAsContext([history[29]!]);
    assert.match(context, /name="&lt;Alice &amp; &quot;Bob&quot;&gt;"/);
    assert.ok(!context.includes("x".repeat(501)));
    buffer.clearHistory("group");
    assert.deepEqual(buffer.getHistory("group"), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("conversation buffers save, load, discard stale data, and tolerate corruption", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nyarbot-buffer-io-test-"));
  const savePath = path.join(directory, "nested", "buffer.json");
  const module = await import("./conversation-buffer.js");
  try {
    const writer = module.createConversationBuffer(savePath);
    writer.pushMessage("group", "u1", "Alice", "hello", "alice", "command_help", [
      { type: "photo" },
    ]);
    await writer.saveConversationBuffer();
    assert.match(await readFile(savePath, "utf8"), /command_help/);

    const diskEntries = JSON.parse(await readFile(savePath, "utf8")) as [string, HistoryEntry[]][];
    diskEntries.push([
      "stale",
      [{ uid: "u2", name: "Old", text: "old", timestamp: Date.now() - 3 * 60 * 60 * 1000 }],
    ]);
    diskEntries.push([
      "invalid",
      [{ uid: 3, name: "Bad", text: "bad", timestamp: Date.now() } as unknown as HistoryEntry],
    ]);
    await writeFile(savePath, JSON.stringify(diskEntries));
    const reader = module.createConversationBuffer(savePath);
    await reader.loadConversationBuffer();
    assert.equal(reader.getHistory("group").length, 1);
    assert.deepEqual(reader.getHistory("stale"), []);
    assert.deepEqual(reader.getHistory("invalid"), []);

    await writeFile(savePath, "not json");
    const corrupted = module.createConversationBuffer(savePath);
    corrupted.pushMessage("existing", "u3", "Kept", "memory");
    await corrupted.loadConversationBuffer();
    assert.equal(corrupted.getHistory("existing").length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
