import assert from "node:assert/strict";
import test from "node:test";
import type { Api, RawApi } from "grammy";

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

const { AdminDmHandler, initAdminNotify, logger } = await import("./logger.js");

test("queues at most ten warnings and flushes them after bot initialization", async () => {
  let now = 1_000;
  const sent: string[] = [];
  const handler = new AdminDmHandler({ adminUid: "42", minIntervalMs: 0, now: () => now++ });
  handler.write("not json");
  handler.write(JSON.stringify({ level: 30, msg: "ignore" }));
  for (let index = 0; index < 12; index++) {
    handler.write(JSON.stringify({ level: 40, msg: `warning-${index}`, extra: index }));
  }
  handler.setBot({
    sendMessage: async (uid: string | number, text: string) => {
      assert.equal(uid, "42");
      sent.push(text);
      return {} as never;
    },
  } as unknown as Api<RawApi>);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 10);
  assert.match(sent[0]!, /warning-0 extra=0/);
});

test("rate-limits delivery and formats error details", async () => {
  let now = 10_000;
  const sent: string[] = [];
  const handler = new AdminDmHandler({ adminUid: "42", minIntervalMs: 5_000, now: () => now });
  handler.setBot({
    sendMessage: async (_uid: string | number, text: string) => {
      sent.push(text);
      return {} as never;
    },
  } as unknown as Api<RawApi>);
  handler.write(
    JSON.stringify({ level: 50, msg: "boom", err: { message: "bad", stack: "a\nb\nc\nd" } }),
  );
  handler.write(JSON.stringify({ level: 40, msg: "dropped" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /boom\nbad\na\nb\nc/);
  now += 5_000;
  handler.write(JSON.stringify({ level: 40, msg: "allowed" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 2);
});

test("swallows Telegram delivery errors", async () => {
  const handler = new AdminDmHandler({ adminUid: "42", minIntervalMs: 0 });
  handler.setBot({
    sendMessage: () => Promise.reject(new Error("offline")),
  } as unknown as Api<RawApi>);
  assert.doesNotThrow(() => handler.write(JSON.stringify({ level: 50, msg: "boom" })));
  await new Promise((resolve) => setImmediate(resolve));
});

test("formats warning payload variants and truncates Telegram messages", async () => {
  const sent: string[] = [];
  const handler = new AdminDmHandler({ adminUid: "42", minIntervalMs: 0, now: () => 1 });
  handler.setBot({
    sendMessage: async (_uid: string | number, text: string) => {
      sent.push(text);
      return {} as never;
    },
  } as unknown as Api<RawApi>);
  handler.write(
    JSON.stringify({
      level: 40,
      msg: "x".repeat(4_100),
      object: { nested: true },
      err: { message: "plain error" },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent[0]?.length, 4_000);
  assert.match(sent[0]!, /^🟡/u);
});

test("the shared logger forwards warnings after admin notification is initialized", async () => {
  const sent: string[] = [];
  initAdminNotify({
    sendMessage: async (_uid: string | number, text: string) => {
      sent.push(text);
      return {} as never;
    },
  } as unknown as Api<RawApi>);
  logger.warn({ component: "test" }, "forwarded warning");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(sent[0]!, /forwarded warning component=test/);
});
