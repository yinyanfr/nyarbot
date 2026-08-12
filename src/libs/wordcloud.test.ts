import assert from "node:assert/strict";
import test from "node:test";
import type { WordcloudDependencies } from "./wordcloud.js";

Object.assign(process.env, {
  BOT_USERNAME: "test_bot",
  BOT_API_KEY: "test",
  TG_ADMIN_UID: "1",
  TG_GROUP_ID: "-1",
  DEEPSEEK_API_KEY: "test",
  TAVILY_API_KEY: "test",
  CF_AIG_TOKEN: "test",
  CF_ACCOUNT_ID: "test",
  DATABASE_BACKUP_PASSPHRASE: "correct horse battery staple",
});

const wordcloud = await import("./wordcloud.js");

function wcFixture(overrides: Partial<WordcloudDependencies> = {}) {
  const writes: string[] = [];
  const marks: string[] = [];
  const dependencies: Partial<WordcloudDependencies> = {
    listStoredMessagesForDate: async () => [
      {
        chatId: "-1",
        messageId: 1,
        userId: "u",
        displayName: "Alice",
        isBot: false,
        isForwarded: false,
        text: "测试 词云",
        createdAt: 1,
      },
    ],
    listTopActiveUsersForDate: async () => [{ userId: "u", displayName: "Alice", messageCount: 3 }],
    buildWordFrequencies: () => [{ text: "测试", sizeWeight: 2 }],
    renderWordcloudImage: () => Buffer.from("png"),
    buildCaption: ({ date }) => `caption ${date}`,
    readWordcloudArtifact: async () => null,
    writeWordcloudArtifact: async (date, preview) => {
      writes.push(date);
      return { date, fileName: `${date}.png`, imagePath: date, ...preview };
    },
    hasWordcloudRunForDate: async () => false,
    hasWordcloudPublication: async () => false,
    markWordcloudRunForDate: async (date) => {
      marks.push(`run:${date}`);
    },
    markWordcloudPublication: async (date, slot) => {
      marks.push(`${date}:${slot}`);
    },
    pruneStoredMessages: async () => 2,
    todayDateStr: () => "2026-08-12",
    yesterdayDateStr: () => "2026-08-11",
    now: () => ({ hour: () => 13, minute: () => 0 }) as ReturnType<WordcloudDependencies["now"]>,
    sleep: async () => undefined,
    makeInputFile: (_data, fileName) => ({ fileName }) as never,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    } as unknown as WordcloudDependencies["logger"],
    ...overrides,
  };
  return { service: wordcloud.createWordcloudService(dependencies), writes, marks };
}

test("token normalization and ranking reject noise and favor meaningful phrases", () => {
  for (const token of ["", "https://x.test", "@alice", "123", "!!!", "的", "死", "a"]) {
    assert.equal(wordcloud.normalizeToken(token), null);
  }
  assert.equal(wordcloud.normalizeToken("  TypeScript  "), "typescript");
  assert.equal(wordcloud.normalizeToken("词云"), "词云");
  assert.ok(
    wordcloud.getTokenRankingWeight("词云测试", 2) > wordcloud.getTokenRankingWeight("猫", 2),
  );
  assert.equal(wordcloud.getTokenRankingWeight("中", 2), 0);
  assert.equal(wordcloud.normalizeToken("超长中文词语超过八个字符"), null);
  assert.equal(wordcloud.normalizeToken("x".repeat(25)), null);
  assert.equal(wordcloud.getTokenRankingWeight("猫", 8), 8 * 0.4 * 1.15);
  assert.equal(wordcloud.getTokenRankingWeight("中", 5), 5 * 0.22 * 1.05);
  assert.equal(wordcloud.getTokenRankingWeight("词云", 2), 2 * 1.12);
  assert.equal(wordcloud.getTokenRankingWeight("词云图", 2), 2 * 1.2);
  assert.equal(wordcloud.getTokenSizeWeight("猫", 2), 2 * 0.58);
});

test("vertical layout selects only low-weight short CJK candidates after priority words", () => {
  const words = Array.from({ length: 30 }, (_, index) => ({
    text: index >= 18 ? `猫咪` : `horizontal-${index}`,
    sizeWeight: 30 - index,
  }));
  const selected = wordcloud.buildVerticalLayoutIndexSet(words);
  assert.ok(selected.size > 0);
  assert.ok([...selected].every((index) => index >= 18));
  assert.deepEqual(
    wordcloud.buildVerticalLayoutIndexSet([{ text: "猫咪", sizeWeight: 1 }]),
    new Set(),
  );
});

test("frequency ranking deduplicates each message and limits low-value words", () => {
  const ranked = wordcloud.buildWordFrequencies(["词云 词云 测试", "词云 测试", "typescript"]);
  assert.ok(ranked.some((word) => word.text.includes("词云")));
  assert.ok(ranked.every((word) => word.sizeWeight > 0));
});

test("layout is bounded and non-colliding, with a small real canvas PNG integration", () => {
  const words = Array.from({ length: 30 }, (_, index) => ({
    text: `词云${index}`,
    sizeWeight: 30 - index,
  }));
  const placements = wordcloud.buildPlacements(words);
  assert.ok(placements.length > 10);
  for (const placement of placements) {
    assert.ok(placement.x >= 22 && placement.y >= 22);
    assert.ok(placement.x + placement.width <= 1002);
    assert.ok(placement.y + placement.height <= 1002);
  }
  const png = wordcloud.renderWordcloudImage(words.slice(0, 8));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});

test("caption handles relative dates, aligned rankings, and empty activity", () => {
  const caption = wordcloud.buildCaption({
    date: "2026-08-12",
    messageCount: 12,
    topUsers: [
      { userId: "1", displayName: "猫", messageCount: 12 },
      { userId: "2", displayName: "Alice", messageCount: 3 },
    ],
  });
  assert.match(caption, /今天的热门话题/);
  assert.match(caption, /🥇/);
  assert.match(
    wordcloud.buildCaption({ date: "bad", messageCount: 0, topUsers: [] }),
    /没有可统计/,
  );
  assert.match(
    wordcloud.buildCaption({ date: "2026-08-11", messageCount: 3, topUsers: [] }),
    /昨天的热门话题 🐾/u,
  );
  assert.match(
    wordcloud.buildCaption({
      date: "2026-08-10",
      messageCount: 6,
      topUsers: Array.from({ length: 6 }, (_, index) => ({
        userId: String(index),
        displayName: `User ${index}`,
        messageCount: 6 - index,
      })),
    }),
    /6\. User 5/u,
  );
});

test("preview excludes forwarded text, preserves total count, and reuses artifacts", async () => {
  let rendered: unknown;
  const existing = {
    date: "d",
    fileName: "d.png",
    imagePath: "d",
    image: Buffer.from("old"),
    caption: "old",
    messageCount: 1,
    wordCount: 1,
  };
  const f = wcFixture({
    listStoredMessagesForDate: async () => [
      {
        chatId: "-1",
        messageId: 1,
        userId: "u",
        displayName: "A",
        isBot: false,
        isForwarded: true,
        text: "forward",
        createdAt: 1,
      },
      {
        chatId: "-1",
        messageId: 2,
        userId: "u",
        displayName: "A",
        isBot: false,
        isForwarded: false,
        text: "real",
        createdAt: 2,
      },
    ],
    buildWordFrequencies: (texts) => {
      rendered = texts;
      return [{ text: "real", sizeWeight: 1 }];
    },
    readWordcloudArtifact: async () => existing,
  });
  const preview = await f.service.generateWordcloudPreviewForDate("d");
  assert.deepEqual(rendered, ["real"]);
  assert.equal(preview?.messageCount, 2);
  assert.equal(await f.service.ensureWordcloudArtifactForDate("d"), existing);
  assert.deepEqual(f.writes, []);
});

test("publication marks only after send, empty rollups prune, and same-day artifacts are slotted", async () => {
  const sent: string[] = [];
  const f = wcFixture();
  f.service.initWordcloudCallbacks({
    sendPhoto: async (_photo, caption) => {
      sent.push(caption);
    },
  });
  await f.service.publishWordcloudForDate({
    date: "2026-08-12",
    slot: "same_day_noon",
    markPublished: async () => {
      f.marks.push("published");
    },
  });
  assert.deepEqual(sent, ["caption 2026-08-12"]);
  assert.deepEqual(f.writes, ["2026-08-12-same_day_noon"]);
  assert.deepEqual(f.marks, ["published"]);

  const empty = wcFixture({ listStoredMessagesForDate: async () => [] });
  await empty.service.publishWordcloudForDate({
    date: "d",
    slot: "daily_rollup_yesterday",
    markPublished: async () => {
      empty.marks.push("empty");
    },
  });
  assert.deepEqual(empty.marks, ["empty"]);

  let prunes = 0;
  const emptySameDay = wcFixture({
    listStoredMessagesForDate: async () => [],
    pruneStoredMessages: async () => ++prunes,
  });
  await emptySameDay.service.publishWordcloudForDate({
    date: "d",
    slot: "same_day_evening",
    markPublished: async () => {
      emptySameDay.marks.push("same-day-empty");
    },
  });
  assert.deepEqual(emptySameDay.marks, ["same-day-empty"]);
  assert.equal(prunes, 0);

  const noCallbacks = wcFixture();
  await noCallbacks.service.publishWordcloudForDate({
    date: "d",
    slot: "same_day_evening",
    markPublished: async () => {
      noCallbacks.marks.push("unexpected");
    },
  });
  assert.deepEqual(noCallbacks.marks, []);
});

test("retry uses fake timers and scheduler deduplicates publication in flight", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let attempts = 0;
  const sleeps: number[] = [];
  const f = wcFixture({
    readWordcloudArtifact: async () => {
      attempts++;
      if (attempts < 3) throw new Error("disk");
      return null;
    },
    sleep: (ms) =>
      new Promise((resolve) => {
        sleeps.push(ms);
        setTimeout(resolve, ms);
      }),
  });
  const pending = f.service.ensureWordcloudArtifactForDateWithRetry("d");
  while (sleeps.length < 1) await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(1200);
  while (sleeps.length < 2) await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(1200);
  await pending;
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [1200, 1200]);

  let checks = 0;
  let release: ((value: boolean) => void) | undefined;
  const gate = new Promise<boolean>((resolve) => (release = resolve));
  const scheduled = wcFixture({
    hasWordcloudPublication: async () => {
      checks++;
      return gate;
    },
  });
  scheduled.service.checkAndGenerateWordcloud();
  scheduled.service.checkAndGenerateWordcloud();
  assert.equal(checks, 1);
  release!(true);
  await Promise.resolve();
});

test("preview empty branches and exhausted retries do not create artifacts", async () => {
  const blank = wcFixture({
    listStoredMessagesForDate: async () => [
      {
        chatId: "-1",
        messageId: 1,
        userId: "u",
        displayName: "A",
        isBot: false,
        isForwarded: false,
        text: "   ",
        createdAt: 1,
      },
    ],
  });
  assert.equal(await blank.service.generateWordcloudPreviewForDate("d"), null);

  const noWords = wcFixture({ buildWordFrequencies: () => [] });
  assert.equal(await noWords.service.ensureWordcloudArtifactForDate("d"), null);
  assert.deepEqual(noWords.writes, []);

  let attempts = 0;
  const failed = wcFixture({
    readWordcloudArtifact: async () => {
      attempts++;
      throw new Error("disk unavailable");
    },
  });
  await assert.rejects(
    failed.service.ensureWordcloudArtifactForDateWithRetry("d"),
    /disk unavailable/,
  );
  assert.equal(attempts, 3);
});

test("scheduler catches startup and rollover failures and skips published days", async () => {
  const errors: string[] = [];
  let today = "2026-08-12";
  const f = wcFixture({
    todayDateStr: () => today,
    now: () => ({ hour: () => 1, minute: () => 0 }) as ReturnType<WordcloudDependencies["now"]>,
    hasWordcloudRunForDate: async () => {
      throw new Error("database unavailable");
    },
    hasWordcloudPublication: async () => true,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: (_data: unknown, message: string) => errors.push(message),
    } as unknown as WordcloudDependencies["logger"],
  });
  f.service.checkAndGenerateWordcloud();
  await new Promise((resolve) => setImmediate(resolve));
  today = "2026-08-13";
  f.service.checkAndGenerateWordcloud();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(errors.some((message) => message.includes("startup catch-up failed")));
  assert.ok(errors.some((message) => message.includes("checkAndGenerateWordcloud failed")));
});
