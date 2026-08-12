import assert from "node:assert/strict";
import test from "node:test";

Object.assign(process.env, {
  BOT_USERNAME: "test_bot",
  BOT_API_KEY: "test-token",
  TG_ADMIN_UID: "1",
  TG_GROUP_ID: "-1",
  DEEPSEEK_API_KEY: "test",
  TAVILY_API_KEY: "test",
  CF_AIG_TOKEN: "test",
  CF_ACCOUNT_ID: "test",
  DATABASE_BACKUP_PASSPHRASE: "correct horse battery staple",
});

const { getDismissRetryCount } = await import("./ai-dispatch.js");
const { decideLocalAiRoute } = await import("./ai-routing.js");
const { formatRollResult, parseRollCommand, parseShockCommand, parseStrokeCommand, rollDice } =
  await import("./command-parsers.js");
const { buildBufferLine, buildUserMessage, detectTrigger } = await import("./message-builders.js");

const command = (length: number) => [{ type: "bot_command", offset: 0, length }];

test("local route matrix covers casual, technical, detailed, media, video, search, and fallback", () => {
  const route = (rawText: string, extras: Record<string, unknown> = {}) =>
    decideLocalAiRoute({
      rawText,
      isMentioned: true,
      isRepliedToBot: false,
      urls: [],
      mediaRefs: [],
      ...extras,
    } as never);
  assert.equal(route("早")?.reason, "short_casual_triggered_chat");
  assert.equal(route("TypeScript 报错")?.tier, "tech");
  assert.equal(route("请详细解释")?.tier, "complex");
  assert.equal(
    route("看看", { mediaRefs: [{ type: "image", source: "current" }] })?.reason,
    "current_non_sticker_media_present",
  );
  assert.equal(
    route("", { urls: ["https://www.youtube.com/watch?v=dQw4w9WgXcQ"] })?.reason,
    "video_url_present",
  );
  assert.equal(route("今天的天气", { isMentioned: false })?.needsSearch, true);
  assert.equal(
    route(
      "这是一段足够长但没有任何特殊信号而且也没有触发本地规则的普通文字内容并且会继续超过四十八个字符的限制",
    ),
    null,
  );
});

test("command parser matrix handles addressing, values, text, defaults, and bounds", () => {
  assert.deepEqual(parseShockCommand(command(6), "/shock 20 hello", "bot"), {
    intensity: 20,
    extraText: "hello",
  });
  assert.deepEqual(parseStrokeCommand(command(7), "/stroke gently", "bot"), {
    extraText: "gently",
  });
  assert.equal(parseShockCommand(command(5), "/other", "bot"), null);
  assert.deepEqual(parseRollCommand(command(5), "/roll", "bot"), {
    kind: "ok",
    count: 1,
    sides: 20,
    notation: "1d20",
  });
  assert.equal(parseRollCommand(command(5), "/roll 0d6", "bot")?.kind, "error");
  assert.equal(parseRollCommand(command(5), "/roll 2d1", "bot")?.kind, "error");
  assert.equal(parseRollCommand(command(5), "/roll nope", "bot")?.kind, "error");
  assert.deepEqual(
    rollDice({ count: 2, sides: 6 }, () => 0.5),
    { results: [4, 4], total: 8 },
  );
  assert.equal(
    formatRollResult({ notation: "2d6", results: [4, 4], total: 8 }),
    "掷出了 2d6：4 + 4 = 8",
  );
});

test("message builders escape context, prioritize links, and detect triggers", () => {
  const trigger = detectTrigger({
    rawText: "hi @RealBot",
    entities: [{ type: "mention", offset: 3, length: 8 }],
    replyTo: undefined,
    botUsername: "realbot",
    configuredBotUsername: "configured",
    botId: 9,
  });
  assert.deepEqual(trigger, { isMentioned: true, isRepliedToBot: false });
  assert.match(
    buildUserMessage({
      rawText: "<hello>",
      displayName: "A&B",
      mediaRefs: [{ type: "image", source: "current", fileId: "p" }],
      replyTo: undefined,
      isRepliedToBot: false,
      isMentioned: true,
      urls: ["https://example.com?a=1&b=2"],
    }),
    /&lt;hello&gt;/,
  );
  const line = buildBufferLine({
    rawText: "text",
    mediaRefs: [{ type: "sticker", source: "current", emoji: "cat" }],
    urls: ["https://example.com", "https://x.com/a/status/1"],
  });
  assert.ok(line.indexOf("x.com") < line.indexOf("example.com"));
  assert.match(line, /贴纸: cat/);
});

test("dismiss retry matrix retries only triggered simple and complex turns", () => {
  assert.equal(getDismissRetryCount({ action: "dismiss", tier: "simple", triggered: true }), 1);
  assert.equal(getDismissRetryCount({ action: "dismiss", tier: "complex", triggered: true }), 1);
  assert.equal(getDismissRetryCount({ action: "dismiss", tier: "tech", triggered: true }), 0);
  assert.equal(getDismissRetryCount({ action: "dismiss", tier: "simple", triggered: false }), 0);
  assert.equal(
    getDismissRetryCount({
      action: "dismiss",
      tier: "simple",
      triggered: true,
      dismissReason: "twitter_fetch_failed",
    }),
    0,
  );
  assert.equal(getDismissRetryCount({ action: "send", tier: "simple", triggered: true }), 0);
});
