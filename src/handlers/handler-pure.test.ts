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
const { buildBufferLine, buildUserMessage, detectTrigger, getMessageSender } =
  await import("./message-builders.js");

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
      speakerUid: "42",
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

test("reply context identifies both speakers even for a bot reply or chat sender", () => {
  const reply = {
    message_id: 19,
    from: { id: 99, first_name: "Bot", username: "test_bot" },
    text: "先前的回答",
  } as never;
  const current = buildUserMessage({
    rawText: "你说的是这个吗",
    displayName: "同名",
    speakerUid: "42",
    mediaRefs: [],
    replyTo: reply,
    isRepliedToBot: true,
    urls: [],
  });
  assert.match(current, /<speaker uid="42" name="同名"/);
  assert.match(current, /<reply_to uid="99" name="Bot" username="test_bot" message_id="19">/);
  assert.match(current, /<quoted_text>先前的回答<\/quoted_text>/);

  const chatReply = {
    message_id: 20,
    from: { id: 1087968824, first_name: "GroupAnonymousBot" },
    sender_chat: { id: -100, title: "群管理员", type: "supergroup" },
    text: "群公告",
  } as never;
  assert.deepEqual(getMessageSender(chatReply), { uid: "chat:-100", name: "群管理员" });
  const line = buildBufferLine({
    rawText: "收到",
    mediaRefs: [],
    urls: [],
    replyToInfo: { ...getMessageSender(chatReply), text: "群公告", messageId: 20 },
  });
  assert.match(line, /回复 uid chat:-100 群管理员 message_id=20: "群公告"/);
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
