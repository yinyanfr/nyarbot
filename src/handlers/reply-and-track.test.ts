import assert from "node:assert/strict";
import test from "node:test";
import type { BotContext } from "./context.js";
import type { ReplyAndTrackDependencies } from "./reply-and-track.js";

const requiredEnv = {
  BOT_USERNAME: "test_bot",
  BOT_API_KEY: "test-token",
  TG_ADMIN_UID: "1",
  TG_GROUP_ID: "-1",
  DEEPSEEK_API_KEY: "test",
  TAVILY_API_KEY: "test",
  CF_AIG_TOKEN: "test",
  CF_ACCOUNT_ID: "test",
  DATABASE_BACKUP_PASSPHRASE: "correct horse battery staple",
};
Object.assign(process.env, requiredEnv);

const { createReplyAndTrack } = await import("./reply-and-track.js");

function fixture(
  reply: (...args: unknown[]) => Promise<unknown>,
  recordBotMessages?: (input: unknown) => Promise<void>,
) {
  const pushed: unknown[][] = [];
  const recorded: unknown[] = [];
  let touched = 0;
  const dependencies = {
    pushMessage: (...args: unknown[]) => pushed.push(args),
    recordBotMessages: async (input: unknown) => {
      recorded.push(input);
      await recordBotMessages?.(input);
    },
    touchBotActivity: () => {
      touched++;
    },
    formatForTelegramHtml: (text: string) => `<b>${text}</b>`,
  } as unknown as ReplyAndTrackDependencies;
  return {
    run: createReplyAndTrack(dependencies),
    ctx: { reply } as unknown as BotContext,
    pushed,
    recorded,
    touched: () => touched,
  };
}

test("sends HTML with reply target and tracks exactly once", async () => {
  const calls: unknown[][] = [];
  const setup = fixture(async (...args) => {
    calls.push(args);
  });
  await setup.run(setup.ctx, "**hello**", 7, true, "command_help");
  assert.deepEqual(calls, [
    ["<b>**hello**</b>", { parse_mode: "HTML", reply_parameters: { message_id: 7 } }],
  ]);
  assert.equal(setup.pushed.length, 1);
  assert.equal(setup.recorded.length, 1);
  assert.equal(setup.touched(), 1);
  assert.equal(setup.pushed[0]?.[5], "command_help");
});

test("falls back from rejected HTML to plain text", async () => {
  const calls: unknown[][] = [];
  const setup = fixture(async (...args) => {
    calls.push(args);
    if (calls.length === 1) throw new Error("can't parse entities");
  });
  await setup.run(setup.ctx, "hello", 7, true);
  assert.deepEqual(calls, [
    ["<b>hello</b>", { parse_mode: "HTML", reply_parameters: { message_id: 7 } }],
    ["hello", { reply_parameters: { message_id: 7 } }],
  ]);
  assert.equal(setup.pushed.length, 1);
});

test("retries missing HTML reply target without target", async () => {
  const calls: unknown[][] = [];
  const setup = fixture(async (...args) => {
    calls.push(args);
    if (calls.length === 1) throw new Error("Bad Request: message to be replied not found");
  });
  await setup.run(setup.ctx, "hello", 9, true);
  assert.deepEqual(calls[1], ["<b>hello</b>", { parse_mode: "HTML" }]);
  assert.equal(setup.pushed.length, 1);
});

test("retries missing plain target and does not track an undelivered reply", async (t) => {
  await t.test("retry succeeds", async () => {
    const calls: unknown[][] = [];
    const setup = fixture(async (...args) => {
      calls.push(args);
      if (calls.length === 1) throw new Error("message to be replied not found");
    });
    await setup.run(setup.ctx, "hello", 9);
    assert.deepEqual(calls, [["hello", { reply_parameters: { message_id: 9 } }], ["hello"]]);
    assert.equal(setup.touched(), 1);
  });
  await t.test("retry fails", async () => {
    const setup = fixture(async () => {
      throw new Error("message to be replied not found");
    });
    await setup.run(setup.ctx, "hello", 9);
    assert.equal(setup.pushed.length, 0);
    assert.equal(setup.touched(), 0);
  });
});

test("plain reply without target uses empty options", async () => {
  const calls: unknown[][] = [];
  const setup = fixture(async (...args) => calls.push(args));
  await setup.run(setup.ctx, "hello");
  assert.deepEqual(calls, [["hello", {}]]);
});

test("waits for runtime persistence and contains persistence failures", async (t) => {
  await t.test("waits", async () => {
    let release: (() => void) | undefined;
    const persisted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const setup = fixture(
      async () => undefined,
      async () => persisted,
    );
    let completed = false;
    const pending = setup.run(setup.ctx, "hello").then(() => {
      completed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(completed, false);
    assert.equal(setup.pushed.length, 1);
    release?.();
    await pending;
    assert.equal(completed, true);
  });

  await t.test("contains failure", async () => {
    const setup = fixture(
      async () => undefined,
      async () => {
        throw new Error("database unavailable");
      },
    );
    await setup.run(setup.ctx, "hello");
    assert.equal(setup.pushed.length, 1);
    assert.equal(setup.touched(), 1);
  });
});
