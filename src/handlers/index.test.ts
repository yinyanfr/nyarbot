import assert from "node:assert/strict";
import test from "node:test";
import { Bot } from "grammy";
import type { User } from "../global.d.js";
import type { AiTurnDependencies, HandlerDependencies, StatusDependencies } from "./index.js";

const requiredEnv = {
  BOT_USERNAME: "test_bot",
  BOT_API_KEY: "test-token",
  TG_ADMIN_UID: "1",
  TG_GROUP_ID: "-100",
  DEEPSEEK_API_KEY: "test",
  TAVILY_API_KEY: "test",
  CF_AIG_TOKEN: "test",
  CF_ACCOUNT_ID: "test",
  DATABASE_BACKUP_PASSPHRASE: "correct horse battery staple",
};
Object.assign(process.env, requiredEnv);
const { attachRecentMediaRefs, createBuildStatusText, createHandleAiTurn, setupHandlers } =
  await import("./index.js");

interface FixtureOptions {
  duplicate?: boolean;
  allowAiTrigger?: boolean;
  accepted?: boolean;
  ignoredReason?: string;
  user?: User;
  runtimeContext?:
    | {
        summary: string;
        summaryCursorTs: number;
        recentEvents: never[];
        recentEventsText: string;
      }
    | Error;
  overrides?: Partial<HandlerDependencies>;
}

function fixture(options: FixtureOptions = {}) {
  const bot = new Bot("test-token", {
    botInfo: {
      id: 99,
      is_bot: true,
      first_name: "Bot",
      username: "test_bot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
      can_manage_bots: false,
      has_topics_enabled: false,
      allows_users_to_create_topics: false,
    },
  });
  const replies: unknown[][] = [];
  const ingested: unknown[] = [];
  const scheduled: { label: string; execute(): Promise<void> }[] = [];
  const dispatched: unknown[] = [];
  const pushed: unknown[][] = [];
  const generated: { kind: string; args: unknown[] }[] = [];
  const morningGreeted: unknown[][] = [];
  const apiCalls: { method: string; payload: Record<string, unknown> }[] = [];
  let activities = 0;
  let releases = 0;
  const user: User = options.user ?? { uid: "2", nickname: "Alice", memories: [] };
  const dependencies = {
    isDuplicateUpdate: () => options.duplicate ?? false,
    getOrCreateUser: async () => user,
    extractContent: async () => ({ urls: [], mediaRefs: [], stickerEmoji: "" }),
    replyAndTrack: async (...args: unknown[]) => void replies.push(args),
    getHistory: () => [],
    formatHistoryAsContext: () => "buffer context",
    pushMessage: (...args: unknown[]) => void pushed.push(args),
    generateLoveResponse: async (...args: unknown[]) => {
      generated.push({ kind: "love", args });
      return "love response";
    },
    generateMorningGreeting: async (...args: unknown[]) => {
      generated.push({ kind: "morning", args });
      return "morning response";
    },
    generateShockResponse: async (...args: unknown[]) => {
      generated.push({ kind: "shock", args });
      return "shock response";
    },
    generateStrokeResponse: async (...args: unknown[]) => {
      generated.push({ kind: "stroke", args });
      return "stroke response";
    },
    setMorningGreeted: async (...args: unknown[]) => void morningGreeted.push(args),
    setNightyTimestamp: async () => undefined,
    buildStatusText: async () => "status response",
    generateDiaryForDate: async () => "diary response",
    generateWordcloudPreviewForDateWithRetry: async () => null,
    listDiaryObservationsByDate: async () => [],
    retractDiaryObservation: async () => ({ action: "retracted" }),
    updateDiaryObservation: async () => ({ action: "updated" }),
    getDiaryObservation: async () => null,
    resetRuntimeConversationSummary: async () => undefined,
    upsertGroupMessage: async () => undefined,
    deleteStoredMessage: async () => false,
    recentMedia: {
      loadRecentRuntimeEvents: async () => [],
      getHistory: () => [],
    },
    runtime: {
      beginIncomingActivity: () => {
        activities++;
        return () => releases++;
      },
      ingestUserMessage: async (input: unknown) => {
        ingested.push(input);
        return {
          accepted: options.accepted ?? true,
          allowAiTrigger: options.allowAiTrigger ?? true,
          allowWebSearch: true,
          allowMediaTools: true,
          ...(options.ignoredReason ? { ignoredReason: options.ignoredReason } : {}),
        };
      },
      loadContext: async () => {
        if (options.runtimeContext instanceof Error) throw options.runtimeContext;
        return (
          options.runtimeContext ?? {
            summary: "group summary",
            summaryCursorTs: 1,
            recentEvents: [],
            recentEventsText: "runtime reaction context",
          }
        );
      },
      schedulePassiveTurn: (turn: { label: string; execute(): Promise<void> }) =>
        scheduled.push(turn),
      scheduleCommandTurn: (turn: { label: string; execute(): Promise<void> }) =>
        scheduled.push(turn),
    },
    handleAiTurn: async (params: unknown) => void dispatched.push(params),
    ...options.overrides,
  } as unknown as HandlerDependencies;
  setupHandlers(bot, { id: 99, username: "test_bot" }, dependencies);
  bot.api.config.use(async (_prev, method, payload) => {
    apiCalls.push({ method, payload: payload as Record<string, unknown> });
    return {
      ok: true,
      result: {
        message_id: apiCalls.length + 100,
        date: 1,
        chat: { id: Number((payload as { chat_id?: number }).chat_id ?? 1), type: "private" },
      },
    } as never;
  });
  return {
    bot,
    replies,
    ingested,
    scheduled,
    dispatched,
    pushed,
    generated,
    morningGreeted,
    apiCalls,
    activities: () => activities,
    releases: () => releases,
  };
}

function update(params: {
  updateId?: number;
  chatId?: number;
  chatType?: "group" | "private";
  fromId?: number;
  text?: string;
  entities?: { type: "mention" | "bot_command"; offset: number; length: number }[];
  replyToBot?: boolean;
}) {
  return {
    update_id: params.updateId ?? 1,
    message: {
      message_id: 10,
      date: 1,
      chat: {
        id: params.chatId ?? -100,
        type: params.chatType ?? "group",
        title: "group",
      },
      from: { id: params.fromId ?? 2, is_bot: false, first_name: "Alice" },
      text: params.text ?? "hello",
      ...(params.entities ? { entities: params.entities } : {}),
      ...(params.replyToBot
        ? {
            reply_to_message: {
              message_id: 9,
              date: 1,
              chat: { id: params.chatId ?? -100, type: "group", title: "group" },
              from: { id: 99, is_bot: true, first_name: "Bot", username: "test_bot" },
              text: "previous bot reply",
            },
          }
        : {}),
    },
  } as never;
}

function editedUpdate(params: {
  updateId?: number;
  text: string;
  entities?: { type: "mention" | "bot_command"; offset: number; length: number }[];
  fromId?: number;
}) {
  const base = update({
    text: params.text,
    ...(params.updateId !== undefined ? { updateId: params.updateId } : {}),
    ...(params.entities ? { entities: params.entities } : {}),
    ...(params.fromId !== undefined ? { fromId: params.fromId } : {}),
  }) as unknown as { update_id: number; message: Record<string, unknown> };
  return {
    update_id: base.update_id,
    edited_message: { ...base.message, edit_date: 2 },
  } as never;
}

test("Telegram handler filters other groups and private non-admins", async () => {
  const setup = fixture();
  await setup.bot.handleUpdate(update({ chatId: -200 }));
  await setup.bot.handleUpdate(update({ updateId: 2, chatId: 2, chatType: "private" }));
  assert.equal(setup.ingested.length, 0);
  assert.equal(setup.replies.length, 0);
  assert.equal(setup.activities(), 0);
});

test("Telegram handler deduplicates before user/runtime work", async () => {
  const setup = fixture({ duplicate: true });
  await setup.bot.handleUpdate(update({}));
  assert.equal(setup.ingested.length, 0);
  assert.equal(setup.activities(), 1);
  assert.equal(setup.releases(), 1);
});

test("Telegram handler rejects unauthorized admin commands after ingestion", async () => {
  const setup = fixture();
  await setup.bot.handleUpdate(
    update({ text: "/status", entities: [{ type: "bot_command", offset: 0, length: 7 }] }),
  );
  assert.equal(setup.ingested.length, 1);
  assert.equal(setup.replies.length, 1);
  assert.match(String(setup.replies[0]?.[1]), /主人/);
  assert.equal(setup.scheduled.length, 0);
});

test("Telegram handler tracks passive messages but dispatches only triggers", async () => {
  const passive = fixture();
  await passive.bot.handleUpdate(update({ text: "hello" }));
  assert.equal(passive.ingested.length, 1);
  assert.equal(passive.scheduled.length, 0);

  const triggered = fixture();
  await triggered.bot.handleUpdate(
    update({
      text: "@test_bot hello",
      entities: [{ type: "mention", offset: 0, length: 9 }],
    }),
  );
  assert.equal(triggered.scheduled.length, 1);
  await triggered.scheduled[0]!.execute();
  assert.equal(triggered.dispatched.length, 1);
});

test("Telegram handler honors runtime AI rejection", async () => {
  const setup = fixture({ allowAiTrigger: false });
  await setup.bot.handleUpdate(
    update({
      text: "@test_bot hello",
      entities: [{ type: "mention", offset: 0, length: 9 }],
    }),
  );
  assert.equal(setup.ingested.length, 1);
  assert.equal(setup.scheduled.length, 0);
});

test("public commands reply and short-circuit AI dispatch", async (t) => {
  await t.test("help", async () => {
    const setup = fixture();
    await setup.bot.handleUpdate(
      update({ text: "/help", entities: [{ type: "bot_command", offset: 0, length: 5 }] }),
    );
    assert.match(String(setup.replies[0]?.[1]), /\/roll/);
    assert.equal(setup.replies[0]?.[4], "command_help");
    assert.equal(setup.scheduled.length, 0);
  });

  await t.test("love, shock, and stroke", async () => {
    const setup = fixture();
    await setup.bot.handleUpdate(
      update({ text: "/love", entities: [{ type: "bot_command", offset: 0, length: 5 }] }),
    );
    await setup.bot.handleUpdate(
      update({
        updateId: 2,
        text: "/shock 20 hello",
        entities: [{ type: "bot_command", offset: 0, length: 6 }],
      }),
    );
    await setup.bot.handleUpdate(
      update({
        updateId: 3,
        text: "/stroke gently",
        entities: [{ type: "bot_command", offset: 0, length: 7 }],
      }),
    );
    assert.deepEqual(
      setup.scheduled.map((turn) => turn.label),
      ["shock:10", "stroke:10"],
    );
    await setup.scheduled[0]!.execute();
    await setup.scheduled[1]!.execute();
    assert.deepEqual(
      setup.generated.map((item) => item.kind),
      ["love", "shock", "stroke"],
    );
    assert.deepEqual(setup.generated[1]?.args[1], {
      intensity: 20,
      extraText: "hello",
      recentConversation: "runtime reaction context",
      recentMembers: [{ uid: "2", name: "Alice" }],
      conversationSummary: "group summary",
    });
    assert.deepEqual(setup.generated[2]?.args[1], {
      extraText: "gently",
      recentConversation: "runtime reaction context",
      recentMembers: [{ uid: "2", name: "Alice" }],
      conversationSummary: "group summary",
    });
  });
});

test("roll command sends deterministic result shape and schedules a forced follow-up", async () => {
  const setup = fixture();
  await setup.bot.handleUpdate(
    update({ text: "/roll 2d6", entities: [{ type: "bot_command", offset: 0, length: 5 }] }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(String(setup.replies[0]?.[1]), /^掷出了 2d6：/);
  assert.equal(setup.scheduled.length, 1);
  assert.equal(setup.scheduled[0]?.label, "roll:10");
  await setup.scheduled[0]!.execute();
  const dispatch = setup.dispatched[0] as Record<string, unknown>;
  assert.equal(dispatch.forceReply, true);
  assert.deepEqual(dispatch.sourceRefs, ["tg:-100:roll:10"]);
  assert.match(String(dispatch.systemHint), /command_roll/);
  assert.equal(setup.activities(), 2);
  assert.equal(setup.releases(), 2);
});

test("invalid roll reports parser failure but still schedules contextual follow-up", async () => {
  const setup = fixture();
  await setup.bot.handleUpdate(
    update({ text: "/roll nope", entities: [{ type: "bot_command", offset: 0, length: 5 }] }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(String(setup.replies[0]?.[1]), /格式/);
  await setup.scheduled[0]!.execute();
  assert.match(
    String((setup.dispatched[0] as Record<string, unknown>).systemHint),
    /command_roll_invalid/,
  );
});

test("trigger dispatch carries reply trigger, memory hint, and runtime controls", async () => {
  const setup = fixture();
  await setup.bot.handleUpdate(update({ text: "叫我小明", replyToBot: true }));
  assert.equal(setup.scheduled.length, 1);
  await setup.scheduled[0]!.execute();
  const dispatch = setup.dispatched[0] as Record<string, unknown>;
  assert.equal(dispatch.isMentioned, false);
  assert.equal(dispatch.isRepliedToBot, true);
  assert.deepEqual(dispatch.memoryCandidateHints, ["当前轮可能出现了称呼/昵称信息"]);
  assert.equal(dispatch.allowWebSearch, true);
  assert.equal(dispatch.allowMediaTools, true);
});

test("morning greeting merges into triggered AI turn and stands alone otherwise", async (t) => {
  const sleepingUser: User = {
    uid: "2",
    nickname: "Alice",
    memories: [],
    nightyTimestamp: Date.now() - 9 * 60 * 60 * 1000,
  };
  await t.test("triggered", async () => {
    const setup = fixture({ user: sleepingUser });
    await setup.bot.handleUpdate(update({ text: "早", replyToBot: true }));
    assert.equal(setup.morningGreeted.length, 1);
    assert.equal(setup.generated.length, 0);
    await setup.scheduled[0]!.execute();
    assert.match(
      String((setup.dispatched[0] as Record<string, unknown>).systemHint),
      /user_just_woke_up/,
    );
  });
  await t.test("passive", async () => {
    const setup = fixture({ user: sleepingUser });
    await setup.bot.handleUpdate(update({ text: "早" }));
    assert.deepEqual(
      setup.generated.map((item) => item.kind),
      ["morning"],
    );
    assert.equal(setup.replies[0]?.[1], "morning response");
    assert.equal(setup.scheduled.length, 0);
  });
});

test("edited messages ignore passive corrections and dispatch accepted mentions", async () => {
  const passive = fixture();
  await passive.bot.handleUpdate(editedUpdate({ text: "corrected text" }));
  assert.equal(passive.ingested.length, 0);
  assert.equal(passive.scheduled.length, 0);

  const triggered = fixture();
  await triggered.bot.handleUpdate(
    editedUpdate({
      text: "@test_bot 我更喜欢茶",
      entities: [{ type: "mention", offset: 0, length: 9 }],
    }),
  );
  assert.equal(triggered.ingested.length, 1);
  assert.equal(triggered.scheduled[0]?.label, "edited:10");
  await triggered.scheduled[0]!.execute();
  const dispatch = triggered.dispatched[0] as Record<string, unknown>;
  assert.deepEqual(dispatch.sourceRefs, ["tg:-100:edited:10:2"]);
  assert.deepEqual(dispatch.memoryCandidateHints, ["当前轮可能出现了偏好/习惯/常用工具信息"]);
});

test("edited message obeys runtime rejection and non-content dedup", async () => {
  const rejected = fixture({ allowAiTrigger: false });
  await rejected.bot.handleUpdate(
    editedUpdate({
      text: "@test_bot corrected",
      entities: [{ type: "mention", offset: 0, length: 9 }],
    }),
  );
  assert.equal(rejected.scheduled.length, 0);

  const duplicateContent = fixture({ ignoredReason: "non_content_edit" });
  await duplicateContent.bot.handleUpdate(
    editedUpdate({
      text: "@test_bot same",
      entities: [{ type: "mention", offset: 0, length: 9 }],
    }),
  );
  assert.equal(duplicateContent.pushed.length, 0);
  assert.equal(duplicateContent.scheduled.length, 0);
});

test("edited commands dispatch stroke, shock, love, and contain wordcloud storage failures", async () => {
  const setup = fixture({
    overrides: {
      deleteStoredMessage: async () => {
        throw new Error("delete failed");
      },
      upsertGroupMessage: async () => {
        throw new Error("upsert failed");
      },
    },
  });
  await setup.bot.handleUpdate(
    editedUpdate({
      updateId: 1,
      text: "/stroke 4",
      entities: [{ type: "bot_command", offset: 0, length: 7 }],
    }),
  );
  assert.equal(setup.ingested.length, 1);
  assert.equal(setup.scheduled[0]?.label, "stroke:10");
  await setup.scheduled[0]!.execute();
  await setup.bot.handleUpdate(
    editedUpdate({
      updateId: 2,
      text: "@test_bot 我爱你",
      entities: [{ type: "mention", offset: 0, length: 9 }],
    }),
  );
  await setup.bot.handleUpdate(
    editedUpdate({
      updateId: 3,
      text: "@test_bot /shock 8",
      entities: [
        { type: "mention", offset: 0, length: 9 },
        { type: "bot_command", offset: 10, length: 6 },
      ],
    }),
  );
  assert.equal(setup.ingested.length, 3);
  assert.equal(setup.scheduled[1]?.label, "shock:10");
  await setup.scheduled[1]!.execute();
  assert.deepEqual(
    setup.generated.map((item) => item.kind),
    ["stroke", "love", "shock"],
  );
  assert.equal((setup.ingested[0] as { triggered?: boolean }).triggered, true);
});

test("reaction context falls back to the conversation buffer when runtime loading fails", async () => {
  const setup = fixture({ runtimeContext: new Error("database unavailable") });
  await setup.bot.handleUpdate(
    update({ text: "/shock", entities: [{ type: "bot_command", offset: 0, length: 6 }] }),
  );
  await setup.scheduled[0]!.execute();
  assert.equal(
    (setup.generated[0]?.args[1] as { recentConversation?: string }).recentConversation,
    "buffer context",
  );
});

test("group wordcloud persistence stores forwarded messages and contains storage rejection", async () => {
  const stored: unknown[] = [];
  const success = fixture({
    overrides: {
      upsertGroupMessage: async (message) => void stored.push(message),
    },
  });
  const forwarded = update({ text: "forwarded text" }) as unknown as {
    message: Record<string, unknown>;
  };
  forwarded.message.forward_origin = { type: "hidden_user", sender_user_name: "Hidden" };
  await success.bot.handleUpdate(forwarded as never);
  assert.equal((stored[0] as Record<string, unknown>).isForwarded, true);

  const failure = fixture({
    overrides: {
      upsertGroupMessage: async () => {
        throw new Error("storage unavailable");
      },
    },
  });
  await failure.bot.handleUpdate(update({ text: "normal text" }));
  assert.equal(failure.ingested.length, 1);
});

test("roll follow-up contains asynchronous user resolution failure and releases activity", async () => {
  const setup = fixture({
    overrides: {
      getOrCreateUser: async () => {
        throw new Error("user lookup failed");
      },
    },
  });
  await setup.bot.handleUpdate(
    update({ text: "/roll", entities: [{ type: "bot_command", offset: 0, length: 5 }] }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(setup.scheduled.length, 0);
  assert.equal(setup.releases(), 2);
});

const privateCommand = (text: string, updateId = 1) =>
  update({
    updateId,
    chatId: 1,
    chatType: "private",
    fromId: 1,
    text,
    entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }],
  });

test("private admin status, diary, and diary regeneration cover success, empty, and failure", async (t) => {
  await t.test("status", async () => {
    const setup = fixture();
    await setup.bot.handleUpdate(privateCommand("/status"));
    assert.equal(setup.apiCalls[0]?.method, "sendMessage");
    assert.equal(setup.apiCalls[0]?.payload.text, "status response");
  });

  for (const [name, value, expected] of [
    ["diary success", "diary text", "diary text"],
    ["diary empty", null, "今天还没有日记记录喵~"],
  ] as const) {
    await t.test(name, async () => {
      const setup = fixture({
        overrides: { generateDiaryForDate: async () => value },
      });
      await setup.bot.handleUpdate(privateCommand("/diary"));
      assert.equal(setup.apiCalls.at(-1)?.payload.text, expected);
    });
  }

  await t.test("diary failure", async () => {
    const setup = fixture({
      overrides: {
        generateDiaryForDate: async () => {
          throw new Error("offline failure");
        },
      },
    });
    await setup.bot.handleUpdate(privateCommand("/diary"));
    assert.equal(setup.apiCalls.at(-1)?.payload.text, "生成日记时出错了喵...");
  });

  await t.test("regen success and failure", async () => {
    let calls = 0;
    const setup = fixture({
      overrides: {
        generateDiaryForDate: async () => {
          calls++;
          if (calls === 1) return null;
          throw new Error("regen failed");
        },
      },
    });
    await setup.bot.handleUpdate(privateCommand("/diaryregen 2026-08-10"));
    await setup.bot.handleUpdate(privateCommand("/diaryregen 2026-08-11", 2));
    assert.equal(setup.apiCalls[1]?.payload.text, "生成失败或返回空内容");
    assert.equal(setup.apiCalls.at(-1)?.payload.text, "重生日记失败了喵...");
  });
});

test("private wordcloud covers image, caption fallback, empty, and generation failure", async (t) => {
  await t.test("image success", async () => {
    const setup = fixture({
      overrides: {
        generateWordcloudPreviewForDateWithRetry: async () => ({
          image: Buffer.from("offline image"),
          caption: "caption",
          messageCount: 10,
          wordCount: 20,
        }),
      },
    });
    await setup.bot.handleUpdate(privateCommand("/wordcloud 2026-08-10"));
    assert.equal(setup.apiCalls.at(-1)?.method, "sendPhoto");
    assert.equal(setup.apiCalls.at(-1)?.payload.caption, "caption");
  });

  await t.test("photo failure falls back to caption", async () => {
    const setup = fixture({
      overrides: {
        generateWordcloudPreviewForDateWithRetry: async () => ({
          image: Buffer.from("offline image"),
          caption: "fallback caption",
          messageCount: 10,
          wordCount: 20,
        }),
      },
    });
    const fallbackCalls: { method: string; payload: Record<string, unknown> }[] = [];
    setup.bot.api.config.use(async (_prev, method, payload) => {
      fallbackCalls.push({ method, payload: payload as Record<string, unknown> });
      if (method === "sendPhoto") throw new Error("photo failed");
      return { ok: true, result: true } as never;
    });
    await setup.bot.handleUpdate(privateCommand("/wordcloud"));
    assert.equal(fallbackCalls.at(-1)?.payload.text, "fallback caption");
  });

  await t.test("empty and failure", async () => {
    let calls = 0;
    const setup = fixture({
      overrides: {
        generateWordcloudPreviewForDateWithRetry: async () => {
          calls++;
          if (calls === 1) return null;
          throw new Error("wordcloud failed");
        },
      },
    });
    await setup.bot.handleUpdate(privateCommand("/wordcloud 2026-08-10"));
    await setup.bot.handleUpdate(privateCommand("/wordcloud 2026-08-11", 2));
    assert.equal(setup.apiCalls[1]?.payload.text, "这一天没有足够的聊天记录可生成词云喵。");
    assert.equal(setup.apiCalls.at(-1)?.payload.text, "生成词云失败了喵...");
  });
});

test("private diary observation commands validate input and cover service outcomes", async () => {
  const observation = {
    schemaVersion: 2 as const,
    id: "obs-1",
    recordedAt: "2026-08-10T00:00:00Z",
    localDate: "2026-08-10",
    event: "Alice shipped a feature",
    confidence: "fact" as const,
    salience: 4 as const,
    status: "active" as const,
    sourceRefs: ["tg:1"],
  };
  const setup = fixture({
    overrides: {
      listDiaryObservationsByDate: async () => [observation],
      retractDiaryObservation: async () => ({ action: "retracted" }),
      updateDiaryObservation: async () => ({ action: "updated", observation }),
      getDiaryObservation: async (id) => (id === "obs-1" ? observation : null),
    },
  });
  const commands = [
    "/diaryobs 2026-08-10",
    "/diaryretract",
    "/diaryretract obs-1 duplicate",
    "/diaryedit obs-1 []",
    '/diaryedit obs-1 {"event":"fixed"}',
    "/diaryshow",
    "/diaryshow missing",
    "/diaryshow obs-1",
  ];
  for (const [index, command] of commands.entries()) {
    await setup.bot.handleUpdate(privateCommand(command, index + 1));
  }
  const replies = setup.apiCalls.map((call) => String(call.payload.text ?? ""));
  assert.ok(replies.some((text) => text.includes("observations (1)")));
  assert.ok(replies.some((text) => text.includes("用法: /diaryretract")));
  assert.ok(replies.some((text) => text === "已撤销 obs-1"));
  assert.ok(replies.some((text) => text === "patch 必须是 JSON 对象"));
  assert.ok(replies.some((text) => text.startsWith("已修正 obs-1")));
  assert.ok(replies.some((text) => text === "没找到这条 observation"));
  assert.ok(replies.some((text) => text.includes('"id": "obs-1"')));
});

test("private observation commands report rejected results and service exceptions", async () => {
  let failures = false;
  const setup = fixture({
    overrides: {
      listDiaryObservationsByDate: async () => {
        if (failures) throw new Error("list failed");
        return [];
      },
      retractDiaryObservation: async () => {
        if (failures) throw new Error("retract failed");
        return { action: "ignored", reason: "already retracted" } as never;
      },
      updateDiaryObservation: async () => {
        if (failures) throw new Error("update failed");
        return { action: "ignored", reason: "invalid patch" } as never;
      },
      getDiaryObservation: async () => {
        throw new Error("show failed");
      },
    },
  });
  const firstPass = [
    "/diaryobs 2026-08-10",
    "/diaryretract obs-1",
    '/diaryedit obs-1 {"event":"fixed"}',
  ];
  for (const [index, command] of firstPass.entries()) {
    await setup.bot.handleUpdate(privateCommand(command, index + 1));
  }
  failures = true;
  const failurePass = [
    "/diaryobs 2026-08-10",
    "/diaryretract obs-1",
    '/diaryedit obs-1 {"event":"fixed"}',
    "/diaryshow obs-1",
  ];
  for (const [index, command] of failurePass.entries()) {
    await setup.bot.handleUpdate(privateCommand(command, index + 10));
  }
  const replies = setup.apiCalls.map((call) => String(call.payload.text ?? ""));
  assert.ok(replies.includes("2026-08-10 没有 observation"));
  assert.ok(replies.includes("撤销失败: already retracted"));
  assert.ok(replies.includes("修正失败: invalid patch"));
  assert.ok(replies.includes("查看 observation 失败了喵..."));
  assert.ok(replies.includes("撤销 observation 失败了喵..."));
  assert.ok(replies.includes("修正 observation 失败了喵..."));
  assert.ok(replies.includes("查看 observation 详情失败了喵..."));
});

test("private and group admin status/reset execute and contain service/reply failures", async () => {
  let resets = 0;
  const setup = fixture({
    overrides: {
      resetRuntimeConversationSummary: async () => {
        resets++;
        throw new Error("reset failed");
      },
    },
  });
  await setup.bot.handleUpdate(privateCommand("/reset"));
  await setup.bot.handleUpdate(
    update({
      updateId: 2,
      fromId: 1,
      text: "/status",
      entities: [{ type: "bot_command", offset: 0, length: 7 }],
    }),
  );
  await setup.bot.handleUpdate(
    update({
      updateId: 3,
      fromId: 1,
      text: "/reset",
      entities: [{ type: "bot_command", offset: 0, length: 6 }],
    }),
  );
  assert.equal(resets, 2);
  assert.ok(setup.replies.some((reply) => reply[1] === "status response"));
  assert.ok(setup.replies.some((reply) => reply[4] === "command_reset"));

  const replyFailure = fixture();
  replyFailure.bot.api.config.use(async () => {
    throw new Error("Telegram unavailable");
  });
  await replyFailure.bot.handleUpdate(privateCommand("/status"));
  await replyFailure.bot.handleUpdate(privateCommand("/reset", 2));
});

test("private command delivery guards contain Telegram outages across validation and failure replies", async () => {
  const setup = fixture({
    overrides: {
      generateDiaryForDate: async () => {
        throw new Error("diary failed");
      },
      generateWordcloudPreviewForDateWithRetry: async () => {
        throw new Error("wordcloud failed");
      },
      listDiaryObservationsByDate: async () => {
        throw new Error("list failed");
      },
      retractDiaryObservation: async () => {
        throw new Error("retract failed");
      },
      updateDiaryObservation: async () => {
        throw new Error("update failed");
      },
      getDiaryObservation: async () => {
        throw new Error("show failed");
      },
    },
  });
  setup.bot.api.config.use(async () => {
    throw new Error("Telegram unavailable");
  });
  const commands = [
    "/diary",
    "/wordcloud",
    "/diaryobs",
    "/diaryretract",
    "/diaryretract obs-1",
    "/diaryedit",
    "/diaryedit obs-1 nope",
    '/diaryedit obs-1 {"event":"fixed"}',
    "/diaryshow",
    "/diaryshow obs-1",
    "/diaryregen",
  ];
  for (const [index, command] of commands.entries()) {
    await setup.bot.handleUpdate(privateCommand(command, index + 1));
  }
  assert.equal(setup.apiCalls.length, 0);
});

test("nighty replies immediately and contains persistence rejection", async () => {
  const setup = fixture({
    overrides: {
      setNightyTimestamp: async () => {
        throw new Error("database unavailable");
      },
    },
  });
  await setup.bot.handleUpdate(
    update({ text: "/nighty", entities: [{ type: "bot_command", offset: 0, length: 7 }] }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(String(setup.replies[0]?.[1]), /晚安安 Alice/);
  assert.equal(setup.replies[0]?.[4], "command_nighty");
});

test("morning generation failure is contained without dispatch", async () => {
  const setup = fixture({
    user: {
      uid: "2",
      nickname: "Alice",
      memories: [],
      nightyTimestamp: Date.now() - 9 * 60 * 60 * 1000,
    },
    overrides: {
      generateMorningGreeting: async () => {
        throw new Error("morning model failed");
      },
    },
  });
  await setup.bot.handleUpdate(update({ text: "早" }));
  assert.equal(setup.replies.length, 0);
  assert.equal(setup.scheduled.length, 0);
});

test("recent media recovery prefers persisted runtime refs and falls back to legacy buffer markers", async (t) => {
  await t.test("runtime refs", async () => {
    const refs = await attachRecentMediaRefs(
      { groupId: "-100", rawText: "这张图是什么", mediaRefs: [] },
      {
        loadRecentRuntimeEvents: async () =>
          [
            {
              uid: "2",
              mediaRefs: [
                { type: "unknown", source: "current" },
                { type: "image", source: "current", fileId: "runtime-image" },
              ],
            },
          ] as never,
        getHistory: () => [],
      },
    );
    assert.deepEqual(refs, [{ type: "image", source: "reply_to", fileId: "runtime-image" }]);
  });

  await t.test("runtime failure and legacy buffer", async () => {
    const refs = await attachRecentMediaRefs(
      { groupId: "-100", rawText: "帮我看图", mediaRefs: [] },
      {
        loadRecentRuntimeEvents: async () => {
          throw new Error("runtime unavailable");
        },
        getHistory: () =>
          [
            {
              uid: "2",
              name: "Alice",
              text: "[视频 file_id=video-1 thumb=thumb-1] [文件 file_id=doc-1 thumb= document.pdf]",
              timestamp: Date.now(),
            },
          ] as never,
      },
    );
    assert.deepEqual(refs, [
      { type: "video", source: "reply_to", fileId: "video-1", thumbnailFileId: "thumb-1" },
      { type: "document", source: "reply_to", fileId: "doc-1", filename: "document.pdf" },
    ]);
  });

  await t.test("current media bypasses recovery", async () => {
    let loaded = false;
    const current = [{ type: "sticker", source: "current", fileId: "sticker" }] as const;
    const refs = await attachRecentMediaRefs(
      { groupId: "-100", rawText: "这是什么", mediaRefs: [...current] },
      {
        loadRecentRuntimeEvents: async () => {
          loaded = true;
          return [];
        },
        getHistory: () => [],
      },
    );
    assert.deepEqual(refs, current);
    assert.equal(loaded, false);
  });

  await t.test("typed buffer refs and all legacy media markers", async () => {
    const typed = await attachRecentMediaRefs(
      { groupId: "-100", rawText: "上一张图", mediaRefs: [] },
      {
        loadRecentRuntimeEvents: async () => [],
        getHistory: () =>
          [
            { uid: "bot", name: "Bot", text: "ignored" },
            {
              uid: "2",
              name: "Alice",
              text: "typed",
              mediaRefs: [
                { type: "unknown", source: "current" },
                {
                  type: "audio",
                  source: "current",
                  fileId: "audio",
                  thumbnailFileId: "cover",
                  title: "song",
                },
              ],
            },
          ] as never,
      },
    );
    assert.deepEqual(typed, [
      {
        type: "audio",
        source: "reply_to",
        fileId: "audio",
        thumbnailFileId: "cover",
        title: "song",
      },
    ]);

    const legacy = await attachRecentMediaRefs(
      { groupId: "-100", rawText: "图里是什么", mediaRefs: [] },
      {
        loadRecentRuntimeEvents: async () => [],
        getHistory: () =>
          [
            {
              uid: "2",
              name: "Alice",
              text: "[图片 file_id=image] [GIF file_id=gif thumb=gif-thumb] [视频消息 file_id=note thumb=note-thumb] [音频 file_id=audio thumb=cover song title]",
            },
          ] as never,
      },
    );
    assert.deepEqual(
      legacy.map((ref) => ref.type),
      ["image", "animation", "video_note", "audio"],
    );
  });

  await t.test("irrelevant follow-up returns immediately", async () => {
    let loaded = false;
    const refs = await attachRecentMediaRefs(
      { groupId: "-100", rawText: "hello", mediaRefs: [] },
      {
        loadRecentRuntimeEvents: async () => {
          loaded = true;
          return [];
        },
        getHistory: () => [],
      },
    );
    assert.deepEqual(refs, []);
    assert.equal(loaded, false);
  });
});

test("status text reports healthy snapshots and degraded dependency fallbacks", async (t) => {
  const memoryUsage = () =>
    ({
      rss: 64 * 1024 * 1024,
      heapTotal: 0,
      heapUsed: 0,
      external: 0,
      arrayBuffers: 0,
    }) as NodeJS.MemoryUsage;
  const base = {
    getHistory: () => [{ uid: "2" }, { uid: "bot" }] as never,
    countUsersWithMemories: async () => 7,
    getRuntimeStatus: () => ({
      running: true,
      dirty: false,
      debouncing: true,
      quietUntilMs: 0,
      quietRemainingMs: 1500,
      pendingSinceMs: null,
    }),
    loadRuntimeContext: async () => ({
      summary: "summary",
      summaryCursorTs: 123,
      recentEvents: [{}, {}],
      recentEventsText: "events",
    }),
    getProactiveHealthSnapshot: () => ({
      running: false,
      scheduled: true,
      stopped: false,
      consecutiveFailures: 1,
      lastCheckAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: "line one\nline two",
    }),
    uptime: () => 3720,
    memoryUsage,
  } as unknown as StatusDependencies;

  await t.test("healthy", async () => {
    const text = await createBuildStatusText(base)();
    assert.match(text, /运行时间: 1h2m/);
    assert.match(text, /缓冲区消息数: 2/);
    assert.match(text, /Quiet 剩余: 2s/);
    assert.match(text, /Summary cursor: 123/);
    assert.match(text, /记忆用户数: 7/);
    assert.match(text, /Proactive error: line one line two/);
  });

  await t.test("degraded", async () => {
    const text = await createBuildStatusText({
      ...base,
      countUsersWithMemories: async () => {
        throw new Error("count failed");
      },
      loadRuntimeContext: async () => {
        throw new Error("context failed");
      },
    })();
    assert.match(text, /Summary cursor: 0/);
    assert.match(text, /Recent events: \?/);
    assert.match(text, /记忆用户数: \?/);
  });

  await t.test("short uptime and populated health timestamps", async () => {
    const text = await createBuildStatusText({
      ...base,
      uptime: () => 59,
      getProactiveHealthSnapshot: () => ({
        running: false,
        scheduled: false,
        stopped: true,
        consecutiveFailures: 0,
        lastCheckAt: 1,
        lastSuccessAt: 2,
        lastFailureAt: 3,
        lastError: null,
      }),
    })();
    assert.match(text, /运行时间: 0m/);
    assert.doesNotMatch(text, /last=never/);
    assert.match(text, /Proactive error: none/);
  });
});

function aiTurnFixture(results: unknown[], apiFailures: Record<string, number[]> = {}) {
  const generated: unknown[] = [];
  const turns: Record<string, unknown>[] = [];
  const recordedMessages: unknown[] = [];
  const pushed: unknown[][] = [];
  const replies: unknown[][] = [];
  const apiCalls: { method: string; args: unknown[] }[] = [];
  const callCounts = new Map<string, number>();
  const callApi = async (method: string, ...args: unknown[]) => {
    apiCalls.push({ method, args });
    const count = (callCounts.get(method) ?? 0) + 1;
    callCounts.set(method, count);
    if (apiFailures[method]?.includes(count)) {
      throw new Error(
        apiFailures.missingReply?.includes(count)
          ? "message to be replied not found"
          : `${method} failed`,
      );
    }
    if (method === "getFile") return { file_path: "files/image.jpg" };
    return true;
  };
  const ctx = {
    chatId: -100,
    me: { id: 99 },
    msg: { text: "@test_bot hello" },
    api: {
      sendChatAction: (...args: unknown[]) => callApi("sendChatAction", ...args),
      sendMessage: (...args: unknown[]) => callApi("sendMessage", ...args),
      sendSticker: (...args: unknown[]) => callApi("sendSticker", ...args),
      getFile: (...args: unknown[]) => callApi("getFile", ...args),
    },
  };
  const dependencies = {
    classifyMessage: async () => ({ tier: "simple", needsSearch: false }),
    generateAiTurn: async (input: unknown) => {
      generated.push(input);
      const result = results.shift();
      if (result instanceof Error) throw result;
      return result;
    },
    rescueSendMessagesFromDraft: async () => null,
    getHistory: () => [],
    formatHistoryAsContext: () => "buffer context",
    pushMessage: (...args: unknown[]) => void pushed.push(args),
    touchBotActivity: () => undefined,
    getStickerEmojiByFileId: () => "🐱",
    getStickerFileId: (emoji: string) => `sticker:${emoji}`,
    pickRandomStickerEmoji: () => "🐱",
    downloadTelegramFileAsDataUrl: async (path: string) => `data:${path}`,
    formatForTelegramHtml: (text: string) => `<b>${text}</b>`,
    replyAndTrack: async (...args: unknown[]) => void replies.push(args),
    runtime: {
      loadContext: async () => ({
        summary: "summary",
        summaryCursorTs: 1,
        recentEvents: [],
        recentEventsText: "runtime context",
      }),
      recordBotMessages: async (input: unknown) => void recordedMessages.push(input),
      recordTurn: async (input: Record<string, unknown>) => void turns.push(input),
    },
    delay: async () => undefined,
  } as unknown as AiTurnDependencies;
  const run = (overrides: Record<string, unknown> = {}) =>
    createHandleAiTurn(dependencies)({
      ctx: ctx as never,
      replyToMessageId: 10,
      user: { uid: "2", nickname: "Alice", memories: [] },
      userMessage: "hello",
      systemHint: null,
      isMentioned: true,
      isRepliedToBot: false,
      mediaRefs: [],
      urls: [],
      ...overrides,
    });
  return { run, dependencies, ctx, generated, turns, recordedMessages, pushed, replies, apiCalls };
}

test("AI turn sends multi-message and sticker output and records delivered output", async () => {
  const setup = aiTurnFixture([
    {
      action: "send",
      messages: ["one", "two"],
      stickerFileId: "cat-sticker",
      metrics: { model: "offline", latencyMs: 5, toolCalls: [{ name: "send_message" }] },
    },
  ]);
  await setup.run({ memoryCandidateHints: ["hint"], allowWebSearch: false });
  assert.deepEqual(
    setup.apiCalls.filter((call) => call.method === "sendMessage").map((call) => call.args[1]),
    ["<b>one</b>", "<b>two</b>"],
  );
  assert.equal(setup.apiCalls.filter((call) => call.method === "sendSticker").length, 1);
  assert.deepEqual(setup.recordedMessages, [
    { messages: ["one"] },
    { messages: ["two"] },
    { messages: [], stickerFileId: "cat-sticker" },
  ]);
  assert.equal(setup.turns[0]?.action, "send");
  assert.deepEqual(setup.turns[0]?.messages, ["one", "two"]);
});

test("AI turn invokes configured delay between messages", async () => {
  const setup = aiTurnFixture([{ action: "send", messages: ["one", "two"], stickerFileId: null }]);
  const delays: number[] = [];
  setup.dependencies.delay = async (ms) => void delays.push(ms);
  await setup.run();
  assert.equal(delays.length, 1);
  assert.ok(delays[0]! >= 0);
});

test("AI turn retries a triggered dismiss with mandatory hint then sends", async () => {
  const setup = aiTurnFixture([
    { action: "dismiss", rawText: "draft" },
    { action: "send", messages: ["retry reply"], stickerFileId: null },
  ]);
  await setup.run({ systemHint: "base hint" });
  assert.equal(setup.generated.length, 2);
  assert.equal((setup.generated[0] as Record<string, unknown>).isRetryTurn, false);
  assert.equal((setup.generated[1] as Record<string, unknown>).isRetryTurn, true);
  assert.match(
    String((setup.generated[1] as Record<string, unknown>).systemHint),
    /mandatory_reply_hint/,
  );
  assert.equal(setup.turns[0]?.action, "send");
});

test("AI turn dismiss fallbacks cover configured text, rescued draft, sticker, and silence", async (t) => {
  await t.test("configured text", async () => {
    const setup = aiTurnFixture([{ action: "dismiss" }, { action: "dismiss" }]);
    await setup.run({ dismissFallbackMessages: ["fallback"] });
    assert.equal(
      setup.apiCalls.find((call) => call.method === "sendMessage")?.args[1],
      "<b>fallback</b>",
    );
    assert.equal(setup.turns[0]?.action, "send");
  });

  await t.test("rescued draft", async () => {
    const setup = aiTurnFixture([
      { action: "dismiss", rawText: "draft" },
      { action: "dismiss", rawText: "draft", metrics: { model: "m", latencyMs: 1, toolCalls: [] } },
    ]);
    setup.dependencies.rescueSendMessagesFromDraft = async () =>
      ({
        messages: ["rescued"],
        toolCalls: [{ name: "send_message" }],
      }) as never;
    await setup.run();
    assert.equal(
      setup.apiCalls.find((call) => call.method === "sendMessage")?.args[1],
      "<b>rescued</b>",
    );
    assert.deepEqual(setup.turns[0]?.toolCalls, [{ name: "send_message" }]);
  });

  await t.test("sticker-only fallback", async () => {
    const setup = aiTurnFixture([{ action: "dismiss" }, { action: "dismiss" }]);
    await setup.run();
    assert.equal(
      setup.apiCalls.find((call) => call.method === "sendSticker")?.args[1],
      "sticker:🐱",
    );
  });

  await t.test("twitter failure remains silent", async () => {
    const setup = aiTurnFixture([{ action: "dismiss", dismissReason: "twitter_fetch_failed" }]);
    await setup.run();
    assert.equal(
      setup.apiCalls.some((call) => call.method === "sendMessage"),
      false,
    );
    assert.equal(setup.turns[0]?.action, "dismiss");
  });
});

test("AI turn handles Telegram fallback failures, file resolution, and generation exceptions", async (t) => {
  await t.test("HTML failure falls back to plain and resolves Telegram file", async () => {
    const setup = aiTurnFixture([{ action: "send", messages: ["plain"], stickerFileId: null }], {
      sendMessage: [1],
    });
    await setup.run({ mediaRefs: [{ type: "image", source: "current", fileId: "image" }] });
    const resolver = (setup.generated[0] as Record<string, unknown>)
      .resolveTelegramFileAsDataUrl as (id: string) => Promise<string | null>;
    assert.equal(await resolver("image"), "data:files/image.jpg");
    assert.equal(setup.apiCalls.filter((call) => call.method === "sendMessage").length, 2);
    assert.equal(setup.turns[0]?.action, "send");
  });

  await t.test("undelivered output records error", async () => {
    const setup = aiTurnFixture([{ action: "send", messages: ["lost"], stickerFileId: null }], {
      sendMessage: [1, 2],
    });
    await setup.run();
    assert.equal(setup.turns[0]?.action, "error");
    assert.equal(setup.turns[0]?.error, "telegram dispatch failed");
  });

  await t.test("generation exception replies and records error", async () => {
    const setup = aiTurnFixture([new Error("model unavailable")]);
    await setup.run();
    assert.equal(setup.replies[0]?.[1], "呜喵...出了点问题喵...");
    assert.equal(setup.turns[0]?.action, "error");
    assert.equal(setup.turns[0]?.error, "model unavailable");
  });

  await t.test("missing reply target retries formatted without reply", async () => {
    const setup = aiTurnFixture([{ action: "send", messages: ["reply"], stickerFileId: null }], {
      sendMessage: [1],
      missingReply: [1],
    });
    await setup.run();
    assert.deepEqual(setup.apiCalls.filter((call) => call.method === "sendMessage")[1]?.args[2], {
      parse_mode: "HTML",
    });
    assert.equal(setup.turns[0]?.action, "send");
  });

  await t.test(
    "missing formatted target and malformed HTML fall back to plain without reply",
    async () => {
      const setup = aiTurnFixture([{ action: "send", messages: ["reply"], stickerFileId: null }], {
        sendMessage: [1, 2],
        missingReply: [1],
      });
      await setup.run();
      assert.deepEqual(setup.apiCalls.filter((call) => call.method === "sendMessage")[2]?.args, [
        -100,
        "reply",
        {},
      ]);
      assert.equal(setup.turns[0]?.action, "send");
    },
  );

  await t.test("plain missing reply target retries plain without target", async () => {
    const setup = aiTurnFixture([{ action: "send", messages: ["reply"], stickerFileId: null }], {
      sendMessage: [1, 2],
      missingReply: [2],
    });
    await setup.run();
    assert.deepEqual(setup.apiCalls.filter((call) => call.method === "sendMessage")[2]?.args, [
      -100,
      "reply",
      {},
    ]);
  });

  await t.test(
    "sticker-only missing target retries and total failure records dispatch error",
    async () => {
      const retried = aiTurnFixture([{ action: "send", messages: [], stickerFileId: "sticker" }], {
        sendSticker: [1],
        missingReply: [1],
      });
      await retried.run();
      assert.equal(retried.apiCalls.filter((call) => call.method === "sendSticker").length, 2);
      assert.equal(retried.turns[0]?.action, "send");

      const failed = aiTurnFixture([{ action: "send", messages: [], stickerFileId: "sticker" }], {
        sendSticker: [1],
      });
      await failed.run();
      assert.equal(failed.turns[0]?.action, "error");
    },
  );

  await t.test("post-text sticker failure preserves delivered text", async () => {
    const setup = aiTurnFixture(
      [{ action: "send", messages: ["text"], stickerFileId: "sticker" }],
      { sendSticker: [1] },
    );
    await setup.run();
    assert.equal(setup.turns[0]?.action, "send");
    assert.equal(setup.turns[0]?.stickerFileId, null);
  });
});

test("AI turn context and routing fallbacks include members, classifier, metrics, and resolver errors", async () => {
  const setup = aiTurnFixture([
    {
      action: "dismiss",
      metrics: {
        model: "offline",
        latencyMs: 4,
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: 3,
        toolCalls: [{ name: "dismiss" }],
      },
    },
  ]);
  setup.dependencies.getHistory = () =>
    [
      { uid: "2", name: "Alice", username: "alice", text: "hello" },
      { uid: "3", name: "Bob", text: "hi" },
      { uid: "bot", name: "Bot", text: "first" },
      { uid: "bot", name: "Bot", text: "second" },
    ] as never;
  setup.dependencies.runtime.loadContext = async () => {
    throw new Error("context unavailable");
  };
  setup.dependencies.classifyMessage = async () => ({ tier: "tech", needsSearch: true });
  setup.ctx.msg = {
    text: "x".repeat(60),
    reply_to_message: {
      from: { id: 3, first_name: "Bob", username: "bob" },
    },
  } as never;
  await setup.run({ isMentioned: false, forceReply: false, senderUsername: "alice" });
  const generated = setup.generated[0] as Record<string, unknown>;
  assert.equal(generated.tier, "tech");
  assert.equal(generated.recentConversation, "buffer context");
  assert.deepEqual(generated.recentBotMessages, ["first", "second"]);
  assert.deepEqual(generated.recentMembers, [
    { uid: "2", name: "Alice", username: "alice" },
    { uid: "3", name: "Bob" },
  ]);
  assert.equal(setup.turns[0]?.inputTokens, 10);
  assert.equal(setup.turns[0]?.cachedInputTokens, 3);

  const resolver = generated.resolveTelegramFileAsDataUrl as (
    fileId: string,
  ) => Promise<string | null>;
  setup.ctx.api.getFile = async () => ({}) as never;
  assert.equal(await resolver("missing-path"), null);
  setup.ctx.api.getFile = async () => {
    throw new Error("getFile failed");
  };
  assert.equal(await resolver("failed"), null);
});

test("AI turn appends a replied user absent from history", async () => {
  const setup = aiTurnFixture([{ action: "dismiss", dismissReason: "twitter_fetch_failed" }]);
  setup.ctx.msg = {
    text: "@test_bot hello",
    reply_to_message: {
      from: { id: 3, first_name: "Bob", username: "bob" },
    },
  } as never;
  await setup.run();
  assert.deepEqual((setup.generated[0] as Record<string, unknown>).recentMembers, [
    { uid: "2", name: "Alice" },
    { uid: "3", name: "Bob", username: "bob" },
  ]);
});

test("AI turn validates missing chat context and records non-Error generation failures", async () => {
  const missingChat = aiTurnFixture([]);
  missingChat.ctx.chatId = undefined as never;
  await assert.rejects(missingChat.run(), /no chat in context/);

  const nonError = aiTurnFixture(["model failed"]);
  nonError.dependencies.generateAiTurn = async () => {
    throw "string failure";
  };
  await nonError.run();
  assert.equal(nonError.turns[0]?.error, "string failure");
});
