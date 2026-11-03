import assert from "node:assert/strict";
import test from "node:test";
import { getBackupScheduleState, parseBackupSchedule } from "./database-backup-schedule.js";

test("parses only strict 24-hour HH:mm schedules", () => {
  assert.deepEqual(parseBackupSchedule("00:00"), { hour: 0, minute: 0 });
  assert.deepEqual(parseBackupSchedule("23:59"), { hour: 23, minute: 59 });
  for (const value of ["3:30", "24:00", "12:60", "12:00 ", "aa:bb"]) {
    assert.throws(() => parseBackupSchedule(value), /HH:mm/);
  }
});

test("reports missed, due, completed, and next runs", () => {
  const before = Date.parse("2026-08-12T03:00:00Z");
  const after = Date.parse("2026-08-12T04:00:00Z");
  assert.deepEqual(getBackupScheduleState(before, "03:30", "UTC"), {
    dueDate: "2026-08-11",
    nextRunMs: before,
  });
  assert.deepEqual(getBackupScheduleState(before, "03:30", "UTC", "2026-08-11"), {
    dueDate: null,
    nextRunMs: Date.parse("2026-08-12T03:30:00Z"),
  });
  assert.deepEqual(getBackupScheduleState(after, "03:30", "UTC", "2026-08-12"), {
    dueDate: null,
    nextRunMs: Date.parse("2026-08-13T03:30:00Z"),
  });
});

test("next run honors the changed offset after a DST boundary", () => {
  const now = Date.parse("2026-03-08T08:00:00Z");
  const state = getBackupScheduleState(now, "03:30", "America/New_York", "2026-03-08");
  assert.equal(state.nextRunMs, Date.parse("2026-03-09T07:30:00Z"));
});
