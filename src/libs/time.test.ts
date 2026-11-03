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
  APP_TIMEZONE: "Asia/Shanghai",
});

const time = await import("./time.js");

test("validates IANA zones and rejects malformed calendar dates", () => {
  assert.equal(time.isValidTimezone("America/New_York"), true);
  assert.equal(time.isValidTimezone("Not/A_Zone"), false);
  assert.equal(time.dateRangeForTimezone("2026-02-30", "UTC"), null);
  assert.equal(time.dateRangeForTimezone("2026-02-01", "Not/A_Zone"), null);
  assert.equal(time.dateRangeForTimezone("02/01/2026", "UTC"), null);
});

test("date ranges follow DST-short and DST-long local days", () => {
  const spring = time.dateRangeForTimezone("2026-03-08", "America/New_York");
  const fall = time.dateRangeForTimezone("2026-11-01", "America/New_York");
  assert.ok(spring);
  assert.ok(fall);
  assert.equal(spring.endMs - spring.startMs, 23 * 60 * 60 * 1000);
  assert.equal(fall.endMs - fall.startMs, 25 * 60 * 60 * 1000);
  assert.equal(time.dateStrForTimezone(spring.startMs, "America/New_York"), "2026-03-08");
});

test("parses absolute timestamps and timezone-local wall times", () => {
  assert.equal(
    time.parseTimestampInputForTimezone("2026-01-02T03:04:00+02:00", "Asia/Shanghai"),
    Date.parse("2026-01-02T01:04:00Z"),
  );
  assert.equal(
    time.parseTimestampInputForTimezone("2026-01-02 09:04", "Asia/Shanghai"),
    Date.parse("2026-01-02T01:04:00Z"),
  );
  assert.equal(time.parseTimestampInputForTimezone("   ", "UTC"), null);
  assert.equal(time.parseTimestampInputForTimezone("not a date", "UTC"), null);
  assert.equal(
    time.formatTimestampInputForTimezone("2026-01-02T01:04:00Z", "Asia/Shanghai"),
    "2026-01-02 09:04",
  );
});

test("user prompt time rejects absent and invalid zones", () => {
  assert.equal(time.formatUserPromptTime(), null);
  assert.equal(time.formatUserPromptTime("Not/A_Zone"), null);
  assert.match(time.formatUserPromptTime("UTC") ?? "", /\(UTC, UTC\+00:00\)$/);
});
