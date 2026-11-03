import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { StoredGroupMessage } from "./local-wordcloud-store.js";

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
  APP_TIMEZONE: "Asia/Shanghai",
});

function message(overrides: Partial<StoredGroupMessage> = {}): StoredGroupMessage {
  return {
    chatId: "-100",
    messageId: 1,
    userId: "u1",
    displayName: "Alice",
    username: "alice",
    isBot: false,
    isForwarded: false,
    text: "hello",
    createdAt: Date.parse("2026-08-12T04:00:00Z"),
    ...overrides,
  };
}

test("wordcloud message CRUD filters by group and local date", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nyarbot-wordcloud-crud-test-"));
  const databaseModule = await import("./database.js");
  const store = await import("./local-wordcloud-store.js");
  try {
    databaseModule.initDatabase(path.join(directory, "wordcloud.sqlite"));
    await store.upsertGroupMessage(message());
    await store.upsertGroupMessage(message({ messageId: 1, text: "edited", editedAt: 20 }));
    await store.upsertGroupMessage(
      message({ messageId: 2, createdAt: Date.parse("2026-08-11T15:59:59Z") }),
    );
    await store.upsertGroupMessage(
      message({ messageId: 3, createdAt: Date.parse("2026-08-11T16:00:00Z") }),
    );
    await store.upsertGroupMessage(message({ chatId: "other", messageId: 4 }));
    const stored = await store.listStoredMessagesForDate("2026-08-12");
    assert.deepEqual(
      stored.map((item) => item.messageId),
      [3, 1],
    );
    assert.equal(stored[1]?.text, "edited");
    assert.equal(stored[1]?.editedAt, 20);
    assert.equal(await store.deleteStoredMessage("-100", 1), true);
    assert.equal(await store.deleteStoredMessage("-100", 1), false);
  } finally {
    databaseModule.closeDatabase();
    await rm(directory, { recursive: true, force: true });
  }
});

test("wordcloud ranking, retention, runs, and publication slots persist", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nyarbot-wordcloud-ranking-test-"));
  const databaseModule = await import("./database.js");
  const store = await import("./local-wordcloud-store.js");
  const now = Date.parse("2026-08-12T12:00:00Z");
  try {
    databaseModule.initDatabase(path.join(directory, "wordcloud.sqlite"));
    await store.upsertGroupMessage(message({ messageId: 1, userId: "b", displayName: "Bob" }));
    await store.upsertGroupMessage(message({ messageId: 2, userId: "a", displayName: "Alice" }));
    await store.upsertGroupMessage(
      message({ messageId: 3, userId: "b", displayName: "Bobby", username: "bobby" }),
    );
    await store.upsertGroupMessage(
      message({ messageId: 4, userId: "bot", displayName: "Bot", isBot: true }),
    );
    assert.deepEqual(await store.listTopActiveUsersForDate("2026-08-12", 2), [
      { userId: "b", displayName: "Bobby", username: "bobby", messageCount: 2 },
      { userId: "a", displayName: "Alice", username: "alice", messageCount: 1 },
    ]);
    await store.upsertGroupMessage(message({ messageId: 5, createdAt: now - 11 * 86_400_000 }));
    await store.upsertGroupMessage(message({ messageId: 6, createdAt: now - 10 * 86_400_000 }));
    assert.equal(await store.pruneStoredMessages(now), 1);

    assert.equal(await store.hasWordcloudRunForDate("2026-08-12"), false);
    await store.markWordcloudRunForDate("2026-08-12", 1);
    await store.markWordcloudRunForDate("2026-08-12", 2);
    assert.equal(await store.hasWordcloudRunForDate("2026-08-12"), true);
    assert.equal(await store.hasWordcloudPublication("2026-08-12", "same_day_noon"), false);
    await store.markWordcloudPublication("2026-08-12", "same_day_noon", 3);
    assert.equal(await store.hasWordcloudPublication("2026-08-12", "same_day_noon"), true);
    assert.equal(await store.hasWordcloudPublication("2026-08-12", "same_day_evening"), false);
    assert.equal(
      databaseModule.getDatabase().prepare("SELECT published_at FROM wordcloud_runs").pluck().get(),
      2,
    );
  } finally {
    databaseModule.closeDatabase();
    await rm(directory, { recursive: true, force: true });
  }
});

test("wordcloud rows preserve optional fields and latest non-empty identity", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nyarbot-wordcloud-null-test-"));
  const databaseModule = await import("./database.js");
  const store = await import("./local-wordcloud-store.js");
  try {
    databaseModule.initDatabase(path.join(directory, "wordcloud.sqlite"));
    const withoutOptionalFields = message();
    delete withoutOptionalFields.username;
    await store.upsertGroupMessage(withoutOptionalFields);
    const emptyIdentity = message({ messageId: 2, displayName: "" });
    delete emptyIdentity.username;
    await store.upsertGroupMessage(emptyIdentity);
    const stored = await store.listStoredMessagesForDate("2026-08-12");
    assert.deepEqual(stored[0], {
      chatId: "-100",
      messageId: 1,
      userId: "u1",
      displayName: "Alice",
      isBot: false,
      isForwarded: false,
      text: "hello",
      createdAt: Date.parse("2026-08-12T04:00:00Z"),
    });
    assert.deepEqual(await store.listTopActiveUsersForDate("2026-08-12"), [
      { userId: "u1", displayName: "Alice", messageCount: 2 },
    ]);
    store.closeLocalWordcloudStore();
  } finally {
    databaseModule.closeDatabase();
    await rm(directory, { recursive: true, force: true });
  }
});
