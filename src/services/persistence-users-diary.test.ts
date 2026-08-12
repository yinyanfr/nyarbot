import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DiaryGenerationRecord } from "../global.d.js";

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

test("user profile and memory operations persist normalized, capped state", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nyarbot-users-test-"));
  const databaseModule = await import("./database.js");
  const persistence = await import("./persistence.js");
  try {
    databaseModule.initDatabase(path.join(directory, "users.sqlite"));
    assert.deepEqual(await persistence.getOrCreateUser("42", "Alice"), {
      uid: "42",
      nickname: "Alice",
      memories: [],
    });
    await persistence.updateUserNickname("42", "  Ally  ");
    await persistence.updateUserTimeZone("42", "Europe/Paris");
    await persistence.setNightyTimestamp("42", 100);
    await persistence.setMorningGreeted("42", 200);
    for (let index = 0; index < 32; index += 1) {
      await persistence.updateUserMemory("42", `memory ${index}`);
    }
    assert.deepEqual(
      await persistence.updateUserMemory("42", "memory 31"),
      Array.from({ length: 30 }, (_, index) => `memory ${index + 2}`),
    );
    assert.equal(await persistence.countUsersWithMemories(), 1);
    assert.equal(await persistence.removeUserMemory("42", "memory 2"), true);
    await persistence.overwriteUserMemories("42", ["compressed"], ["memory 3", "memory 4"]);
    assert.deepEqual(await persistence.getOrCreateUser("42"), {
      uid: "42",
      nickname: "Ally",
      memories: ["compressed", ...Array.from({ length: 27 }, (_, index) => `memory ${index + 5}`)],
      timeZone: "Europe/Paris",
      nightyTimestamp: 100,
      lastMorningGreet: 200,
    });
    await assert.rejects(persistence.updateUserNickname("missing", "Nobody"), /User not found/);
  } finally {
    databaseModule.closeDatabase();
    await rm(directory, { recursive: true, force: true });
  }
});

test("user mutations handle empty input, missing users, and absent memories", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nyarbot-user-edges-test-"));
  const databaseModule = await import("./database.js");
  const persistence = await import("./persistence.js");
  try {
    databaseModule.initDatabase(path.join(directory, "users.sqlite"));
    await persistence.getOrCreateUser("edge-user", "Alice");
    await persistence.updateUserNickname("edge-user", " \u0000 ");
    assert.equal((await persistence.getOrCreateUser("edge-user")).nickname, "Alice");
    assert.deepEqual(await persistence.updateUserMemory("edge-user", " \u0000 "), []);
    assert.equal(await persistence.removeUserMemory("edge-user", " \u0000 "), false);
    assert.equal(await persistence.removeUserMemory("edge-user", "not present"), false);
    assert.equal(await persistence.removeUserMemory("missing", "memory"), false);
    await persistence.overwriteUserMemories("missing", ["replacement"], ["old"]);
    await assert.rejects(persistence.updateUserMemory("missing", "memory"), /User not found/);
    await assert.rejects(persistence.updateUserTimeZone("missing", "UTC"), /User not found/);
    await assert.rejects(persistence.setNightyTimestamp("missing", 1), /User not found/);
    await assert.rejects(persistence.setMorningGreeted("missing", 1), /User not found/);
  } finally {
    databaseModule.closeDatabase();
    await rm(directory, { recursive: true, force: true });
  }
});

test("diary observations support dedupe, revision, retraction, and generation records", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nyarbot-diary-test-"));
  const databaseModule = await import("./database.js");
  const persistence = await import("./persistence.js");
  const date = "2026-08-12";
  try {
    databaseModule.initDatabase(path.join(directory, "diary.sqlite"));
    const created = await persistence.createDiaryObservation({
      observation: {
        occurredAt: "2026-08-12 12:00:00",
        subjectUid: "42",
        event: "Alice shared tea",
        confidence: "fact",
        salience: 3,
        tags: ["tea"],
      },
      sourceRefs: ["message:1"],
    });
    assert.equal(created.action, "created");
    assert.ok(created.observation);
    const merged = await persistence.createDiaryObservation({
      observation: {
        occurredAt: "2026-08-12 12:00:00",
        subjectUid: "42",
        event: "Alice shared tea",
        confidence: "fact",
        salience: 4,
        tags: ["drink"],
      },
      sourceRefs: ["message:1"],
    });
    assert.equal(merged.action, "merged");
    assert.deepEqual(merged.observation?.tags, ["tea", "drink"]);
    assert.equal((await persistence.listActiveDiaryObservationsByDate(date)).length, 1);

    const updated = await persistence.updateDiaryObservation(created.observation.id, {
      event: "Alice shared oolong tea",
      confidence: "inference",
    });
    assert.equal(updated.action, "updated");
    assert.ok(updated.observation);
    assert.equal(
      (await persistence.getDiaryObservation(created.observation.id))?.status,
      "superseded",
    );
    assert.equal((await persistence.listDiaryObservationsByDate(date)).length, 2);
    assert.equal(
      (await persistence.retractDiaryObservation(updated.observation.id, "duplicate")).action,
      "retracted",
    );
    assert.equal((await persistence.listActiveDiaryObservationsByDate(date)).length, 0);

    const record: DiaryGenerationRecord = {
      date,
      generatedAt: "2026-08-13T00:02:00.000Z",
      modelProvider: "test",
      modelName: "model",
      promptVersion: "v1",
      styleReferenceVersion: "v1",
      observationIds: [updated.observation.id],
      inputTokens: 10,
      outputTokens: 5,
      status: "success",
    };
    await persistence.appendDiaryGenerationRecord(record);
    await persistence.appendDiaryGenerationRecord(record);
    await persistence.writeGeneratedDiary(date, " diary text ");
    assert.equal(await persistence.getGeneratedDiary(date), " diary text ");
    assert.equal(
      databaseModule
        .getDatabase()
        .prepare("SELECT COUNT(*) FROM diary_generation_records")
        .pluck()
        .get(),
      1,
    );
  } finally {
    databaseModule.closeDatabase();
    await rm(directory, { recursive: true, force: true });
  }
});

test("diary persistence ignores invalid observations and malformed stored JSON", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nyarbot-diary-edges-test-"));
  const databaseModule = await import("./database.js");
  const persistence = await import("./persistence.js");
  try {
    const database = databaseModule.initDatabase(path.join(directory, "diary.sqlite"));
    assert.deepEqual(await persistence.createDiaryObservation({ observation: {} }), {
      action: "ignored",
      reason: "observation payload invalid",
    });
    assert.deepEqual(await persistence.updateDiaryObservation("missing", { event: "new" }), {
      action: "ignored",
      reason: "not_found",
    });
    assert.deepEqual(await persistence.retractDiaryObservation("missing"), {
      action: "ignored",
      reason: "not_found",
    });

    const created = await persistence.createDiaryObservation({
      observation: { event: "A valid event", confidence: "fact", salience: 2 },
    });
    assert.ok(created.observation);
    await persistence.retractDiaryObservation(created.observation.id, " \u0000 ");
    assert.equal(
      (await persistence.retractDiaryObservation(created.observation.id)).reason,
      "already_retracted",
    );

    database
      .prepare(
        `INSERT INTO diary_observations (
          firestore_id, observation_id, schema_version, recorded_at, local_date, event,
          confidence, salience, status, source_json
        ) VALUES (?, ?, 2, ?, ?, ?, 'fact', 1, 'active', ?)`,
      )
      .run("broken", "broken", new Date().toISOString(), "2020-01-01", "broken", "not-json");
    assert.equal(await persistence.getDiaryObservation("broken"), null);
    assert.deepEqual(await persistence.listDiaryObservationsByDate("2020-01-01"), []);

    await persistence.writeDiaryEntry(" \u0000 ");
    await persistence.writeDiaryEntry("kept note");
    const today = (await import("../libs/time.js")).todayDateStr();
    assert.equal((await persistence.getDiaryEntries(today))[0]?.content, "kept note");
    await persistence.writeGeneratedDiary("blank", "   ");
    assert.equal(await persistence.getGeneratedDiary("blank"), null);
    assert.equal(await persistence.getGeneratedDiary("missing"), null);
  } finally {
    databaseModule.closeDatabase();
    await rm(directory, { recursive: true, force: true });
  }
});
