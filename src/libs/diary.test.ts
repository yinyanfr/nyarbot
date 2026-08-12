import assert from "node:assert/strict";
import test from "node:test";
import type { DiaryDependencies } from "./diary.js";
import type { DiaryObservationV2 } from "../global.d.js";

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

const { createDiaryService } = await import("./diary.js");

const observation: DiaryObservationV2 = {
  schemaVersion: 2,
  id: "o1",
  recordedAt: "2026-08-11T10:00:00+08:00",
  localDate: "2026-08-11",
  event: "Alice discussed testing",
  confidence: "fact",
  salience: 5,
  status: "active",
};

function diaryFixture(overrides: Partial<DiaryDependencies> = {}) {
  const records: unknown[] = [];
  const generated: unknown[] = [];
  const dependencies: Partial<DiaryDependencies> = {
    config: {
      githubRepo: "owner/repo",
      tgDiaryChannelId: "-2",
      appTimezone: "Asia/Shanghai",
    } as DiaryDependencies["config"],
    now: () =>
      ({
        hour: () => 1,
        minute: () => 0,
        subtract: (days: number) => ({ format: () => `2026-08-0${9 + days}` }),
      }) as ReturnType<DiaryDependencies["now"]>,
    yesterdayDateStr: () => "2026-08-11",
    listActiveDiaryObservationsByDate: async () => [observation],
    getDiaryEntries: async () => [],
    loadRuntimeEventsForLocalDate: async () => [],
    getGeneratedDiary: async () => null,
    writeGeneratedDiary: async (...args) => {
      generated.push(args);
    },
    appendDiaryGenerationRecord: async (record) => {
      records.push(record);
    },
    generateText: (async (input: Parameters<DiaryDependencies["generateText"]>[0]) =>
      "messages" in input
        ? { text: "2026-08-11 猫娘日记\n正文", usage: { inputTokens: 10, outputTokens: 20 } }
        : { text: "导读" }) as DiaryDependencies["generateText"],
    ensureWordcloudArtifactForDateWithRetry: async () => null,
    pushDiaryToGithub: async () => null,
    waitForGithubPagesPublish: async () => ({ ready: true, state: "ready", detail: "ok" }),
    makeInputFile: (_data, fileName) => ({ fileName }) as never,
    getPersonaLabel: () => "persona",
    formatTimestamp: () => "12:34",
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    } as unknown as DiaryDependencies["logger"],
    ...overrides,
  };
  return { service: createDiaryService(dependencies), records, generated };
}

test("material precedence is observations, legacy entries, then bounded runtime events", async () => {
  let legacyCalls = 0;
  let runtimeCalls = 0;
  const observations = diaryFixture({
    getDiaryEntries: async () => (legacyCalls++, []),
    loadRuntimeEventsForLocalDate: async () => (runtimeCalls++, []),
  });
  assert.ok(await observations.service.generateDiaryForDate("2026-08-11"));
  assert.equal(legacyCalls, 0);
  assert.equal(runtimeCalls, 0);

  let request = "";
  const legacy = diaryFixture({
    listActiveDiaryObservationsByDate: async () => [],
    getDiaryEntries: async () => [{ ts: 1, content: "legacy material" }],
    loadRuntimeEventsForLocalDate: async () => (runtimeCalls++, []),
    generateText: (async (input: unknown) => {
      request = JSON.stringify(input);
      return { text: "diary" };
    }) as DiaryDependencies["generateText"],
  });
  await legacy.service.generateDiaryForDate("2026-08-11");
  assert.match(request, /legacy material/);

  const runtime = diaryFixture({
    listActiveDiaryObservationsByDate: async () => [],
    getDiaryEntries: async () => [],
    loadRuntimeEventsForLocalDate: async () => [
      {
        id: 1,
        groupId: "-1",
        chatId: "-1",
        updateId: 1,
        messageId: 1,
        uid: "u",
        name: "Alice",
        text: "runtime",
        ts: 1,
        kind: "user_message",
        mediaRefs: [],
        urls: [],
      },
      {
        id: 2,
        groupId: "-1",
        chatId: "-1",
        updateId: 2,
        messageId: 2,
        uid: "system",
        name: "system",
        text: "hidden",
        ts: 2,
        kind: "system",
        mediaRefs: [],
        urls: [],
      },
    ],
    generateText: (async (input: unknown) => {
      request = JSON.stringify(input);
      return { text: "diary" };
    }) as DiaryDependencies["generateText"],
  });
  await runtime.service.generateDiaryForDate("2026-08-11");
  assert.match(request, /runtime/);
  assert.doesNotMatch(request, /hidden/);
});

test("records successful, empty, and thrown generation attempts", async () => {
  const success = diaryFixture();
  await success.service.generateDiaryForDate("2026-08-11");
  assert.deepEqual(
    success.records.map((r) => (r as { status: string }).status),
    ["success"],
  );
  assert.equal((success.records[0] as { inputTokens: number }).inputTokens, 10);

  for (const generateText of [
    async () => ({ text: " " }),
    async () => {
      throw new Error("model down");
    },
  ]) {
    const failed = diaryFixture({
      generateText: generateText as unknown as DiaryDependencies["generateText"],
    });
    assert.equal(await failed.service.generateDiaryForDate("2026-08-11"), null);
    assert.equal((failed.records[0] as { status: string }).status, "failed");
  }
});

test("time gate, catch-up order, no-material completion, and check lock are deterministic", async () => {
  let hour = 0;
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  const checked: string[] = [];
  const f = diaryFixture({
    now: () =>
      ({
        hour: () => hour,
        minute: () => 1,
        subtract: (days: number) => ({ format: () => `day-${days}` }),
      }) as ReturnType<DiaryDependencies["now"]>,
    getGeneratedDiary: async (date) => {
      checked.push(date);
      if (date === "day-3") await blocked;
      return date === "day-3" ? "existing" : null;
    },
    listActiveDiaryObservationsByDate: async () => [],
    getDiaryEntries: async () => [],
    loadRuntimeEventsForLocalDate: async () => [],
  });
  await f.service.checkAndGenerateDiary();
  assert.deepEqual(checked, []);
  hour = 1;
  const first = f.service.checkAndGenerateDiary();
  await Promise.resolve();
  const second = f.service.checkAndGenerateDiary();
  release!();
  await Promise.all([first, second]);
  assert.deepEqual(checked, ["day-3", "day-2"]);
});

test("channel, GitHub, wordcloud failure, caption fallback, and notification are isolated", async () => {
  const channelText: string[] = [];
  const photos: unknown[] = [];
  const notices: string[] = [];
  const pushes: unknown[] = [];
  const f = diaryFixture({
    ensureWordcloudArtifactForDateWithRetry: async () => ({
      date: "2026-08-11",
      fileName: "wc.png",
      imagePath: "x",
      image: Buffer.from("png"),
      caption: "wc",
      messageCount: 1,
      wordCount: 1,
    }),
    pushDiaryToGithub: async (...args) => {
      pushes.push(args);
      return {
        owner: "owner",
        repo: "repo",
        path: "source/post.md",
        commitSha: "sha",
        previousSha: "old",
        branch: "main",
      };
    },
  });
  f.service.initDiaryCallbacks({
    sendText: async (text) => {
      notices.push(text);
    },
    sendChannelText: async (text) => {
      channelText.push(text);
    },
    sendChannelPhoto: async (photo, caption) => {
      photos.push([photo, caption]);
    },
  });
  await f.service.checkAndGenerateDiary();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(photos.length, 1);
  assert.equal(pushes.length, 1);
  assert.match(notices[0]!, /导读/);

  const failure = diaryFixture({
    ensureWordcloudArtifactForDateWithRetry: async () => {
      throw new Error("canvas");
    },
  });
  failure.service.initDiaryCallbacks({
    sendText: async () => undefined,
    sendChannelText: async (text) => {
      channelText.push(text);
    },
    sendChannelPhoto: async () => undefined,
  });
  await failure.service.checkAndGenerateDiary();
  assert.ok(channelText.length > 0);
});

test("long diaries send photo then text and report pages still publishing", async () => {
  const channelText: string[] = [];
  const notices: string[] = [];
  const captions: (string | undefined)[] = [];
  const f = diaryFixture({
    generateText: (async (input: Parameters<DiaryDependencies["generateText"]>[0]) =>
      "messages" in input
        ? { text: "长".repeat(1_025) }
        : { text: "导读" }) as DiaryDependencies["generateText"],
    ensureWordcloudArtifactForDateWithRetry: async () => ({
      date: "2026-08-11",
      fileName: "wc.png",
      imagePath: "x",
      image: Buffer.from("png"),
      caption: "wc",
      messageCount: 1,
      wordCount: 1,
    }),
    pushDiaryToGithub: async () => ({
      owner: "owner",
      repo: "repo",
      path: "source/post.md",
      commitSha: "sha",
      previousSha: null,
      branch: "main",
    }),
    waitForGithubPagesPublish: async () => ({ ready: false, state: "pending", detail: "building" }),
  });
  f.service.initDiaryCallbacks({
    sendText: async (text) => {
      notices.push(text);
    },
    sendChannelText: async (text) => {
      channelText.push(text);
    },
    sendChannelPhoto: async (_photo, caption) => {
      captions.push(caption);
    },
  });
  await f.service.checkAndGenerateDiary();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(captions, [undefined]);
  assert.equal(channelText[0]?.length, 1_025);
  assert.match(notices[0]!, /页面还在发布中/);
});

test("photo failure falls back to channel text and malformed repo omits diary URL", async () => {
  const channelText: string[] = [];
  const notices: string[] = [];
  const f = diaryFixture({
    config: {
      githubRepo: "invalid",
      tgDiaryChannelId: "-2",
      appTimezone: "Asia/Shanghai",
    } as DiaryDependencies["config"],
    ensureWordcloudArtifactForDateWithRetry: async () => ({
      date: "2026-08-11",
      fileName: "wc.png",
      imagePath: "x",
      image: Buffer.from("png"),
      caption: "wc",
      messageCount: 1,
      wordCount: 1,
    }),
  });
  f.service.initDiaryCallbacks({
    sendText: async (text) => {
      notices.push(text);
    },
    sendChannelText: async (text) => {
      channelText.push(text);
    },
    sendChannelPhoto: async () => {
      throw new Error("photo rejected");
    },
  });
  await f.service.checkAndGenerateDiary();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(channelText.length, 1);
  assert.match(notices[0]!, /日记已经整理好了/);
  assert.doesNotMatch(notices[0]!, /github\.io/);
});

test("secondary persistence, publishing, and notification failures are contained", async () => {
  const warnings: string[] = [];
  const f = diaryFixture({
    generateText: (async (input: Parameters<DiaryDependencies["generateText"]>[0]) => {
      if ("messages" in input) throw new Error("model down");
      return { text: "notice" };
    }) as DiaryDependencies["generateText"],
    appendDiaryGenerationRecord: async () => {
      throw new Error("record unavailable");
    },
    logger: {
      info: () => undefined,
      warn: (_data: unknown, message: string) => warnings.push(message),
      error: () => undefined,
    } as unknown as DiaryDependencies["logger"],
  });
  assert.equal(await f.service.generateDiaryForDate("2026-08-11"), null);
  assert.ok(warnings.some((message) => message.includes("failure record")));

  const publication = diaryFixture({
    pushDiaryToGithub: async () => {
      throw new Error("GitHub unavailable");
    },
    logger: {
      info: () => undefined,
      warn: (_data: unknown, message: string) => warnings.push(message),
      error: () => undefined,
    } as unknown as DiaryDependencies["logger"],
  });
  publication.service.initDiaryCallbacks({
    sendText: async () => {
      throw new Error("group unavailable");
    },
    sendChannelText: async () => undefined,
    sendChannelPhoto: async () => undefined,
  });
  await publication.service.checkAndGenerateDiary();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(warnings.some((message) => message.includes("GitHub push")));
  assert.ok(warnings.some((message) => message.includes("notification send")));
});
