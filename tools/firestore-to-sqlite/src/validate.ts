import { isRecord, type FormalCollection, type SourceDocument } from "./model.js";

type RecordValue = Record<string, unknown>;

function fail(collection: string, docId: string, detail: string): never {
  throw new Error(`Malformed formal document ${collection}/${docId}: ${detail}`);
}

function record(value: unknown, collection: string, id: string): RecordValue {
  if (!isRecord(value)) fail(collection, id, "expected an object");
  return value;
}

function string(data: RecordValue, key: string, collection: string, id: string): string {
  if (typeof data[key] !== "string") fail(collection, id, `${key} must be a string`);
  return data[key];
}

function number(data: RecordValue, key: string, collection: string, id: string): number {
  const value = data[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(collection, id, `${key} must be a finite number`);
  }
  return value;
}

function optionalString(data: RecordValue, key: string, collection: string, id: string): void {
  if (data[key] !== undefined && typeof data[key] !== "string") {
    fail(collection, id, `${key} must be a string when present`);
  }
}

function optionalNullableString(
  data: RecordValue,
  key: string,
  collection: string,
  id: string,
): void {
  if (data[key] !== undefined && data[key] !== null && typeof data[key] !== "string") {
    fail(collection, id, `${key} must be a string or null when present`);
  }
}

function optionalNumber(data: RecordValue, key: string, collection: string, id: string): void {
  const value = data[key];
  if (
    value !== undefined &&
    value !== null &&
    (typeof value !== "number" || !Number.isFinite(value))
  ) {
    fail(collection, id, `${key} must be a finite number when present`);
  }
}

function stringArray(data: RecordValue, key: string, collection: string, id: string): string[] {
  const value = data[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    fail(collection, id, `${key} must be an array of strings`);
  }
  return value;
}

function optionalStringArray(data: RecordValue, key: string, collection: string, id: string): void {
  if (data[key] !== undefined) stringArray(data, key, collection, id);
}

function oneOf(
  data: RecordValue,
  key: string,
  values: readonly unknown[],
  collection: string,
  id: string,
): void {
  if (!values.includes(data[key])) fail(collection, id, `${key} has an unsupported value`);
}

function validateUsers(doc: SourceDocument): void {
  const data = record(doc.data, "users", doc.id);
  string(data, "uid", "users", doc.id);
  string(data, "nickname", "users", doc.id);
  stringArray(data, "memories", "users", doc.id);
  optionalString(data, "timeZone", "users", doc.id);
  optionalNumber(data, "nightyTimestamp", "users", doc.id);
  optionalNumber(data, "lastMorningGreet", "users", doc.id);
}

function validateDiary(doc: SourceDocument): void {
  const data = record(doc.data, "diary", doc.id);
  const date = data.date === undefined ? doc.id : string(data, "date", "diary", doc.id);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail("diary", doc.id, "date must be YYYY-MM-DD");
  if (data.entries !== undefined) {
    if (!Array.isArray(data.entries)) fail("diary", doc.id, "entries must be an array");
    for (const [index, entryValue] of data.entries.entries()) {
      const entry = record(entryValue, "diary", doc.id);
      number(entry, "ts", "diary", `${doc.id}.entries[${index}]`);
      string(entry, "content", "diary", `${doc.id}.entries[${index}]`);
    }
  }
  optionalString(data, "diary", "diary", doc.id);
  optionalNumber(data, "generatedAt", "diary", doc.id);
  if (data.generationRecords !== undefined) {
    if (!Array.isArray(data.generationRecords))
      fail("diary", doc.id, "generationRecords must be an array");
    for (const [index, item] of data.generationRecords.entries()) {
      const suffix = `${doc.id}.generationRecords[${index}]`;
      const generation = record(item, "diary", suffix);
      for (const key of [
        "date",
        "generatedAt",
        "modelProvider",
        "modelName",
        "promptVersion",
        "styleReferenceVersion",
      ] as const) {
        string(generation, key, "diary", suffix);
      }
      stringArray(generation, "observationIds", "diary", suffix);
      oneOf(generation, "status", ["success", "failed"], "diary", suffix);
      optionalNumber(generation, "inputTokens", "diary", suffix);
      optionalNumber(generation, "outputTokens", "diary", suffix);
      optionalString(generation, "error", "diary", suffix);
    }
  }
}

function validateObservation(doc: SourceDocument): void {
  const data = record(doc.data, "diaryObservations", doc.id);
  oneOf(data, "schemaVersion", [2], "diaryObservations", doc.id);
  for (const key of ["id", "recordedAt", "localDate", "event"] as const) {
    string(data, key, "diaryObservations", doc.id);
  }
  for (const key of [
    "occurredAt",
    "subjectUid",
    "subjectName",
    "subjectUsername",
    "exactQuote",
    "immediateReaction",
    "interpretation",
    "unsaidThought",
    "unresolvedQuestion",
    "supersedesId",
  ] as const) {
    optionalString(data, key, "diaryObservations", doc.id);
  }
  oneOf(data, "confidence", ["fact", "inference", "uncertain"], "diaryObservations", doc.id);
  oneOf(data, "salience", [1, 2, 3, 4, 5], "diaryObservations", doc.id);
  oneOf(data, "status", ["active", "superseded", "retracted"], "diaryObservations", doc.id);
  optionalStringArray(data, "tags", "diaryObservations", doc.id);
  optionalStringArray(data, "sourceRefs", "diaryObservations", doc.id);
}

function validateRuntime(doc: SourceDocument): void {
  if (doc.id !== "group") fail("runtime", doc.id, "only runtime/group is formal");
  const data = record(doc.data, "runtime", doc.id);
  string(data, "summary", "runtime", doc.id);
  number(data, "summaryCursorTs", "runtime", doc.id);
  number(data, "updatedAt", "runtime", doc.id);
  optionalNumber(data, "lastProcessedMessageId", "runtime", doc.id);
  optionalNumber(data, "lastCompactedAt", "runtime", doc.id);
}

function validateEvent(doc: SourceDocument): void {
  const data = record(doc.data, "events", doc.id);
  for (const key of ["chatId", "uid", "name", "text"] as const) string(data, key, "events", doc.id);
  oneOf(
    data,
    "kind",
    ["user_message", "edited_message", "bot_message", "command", "system"],
    "events",
    doc.id,
  );
  number(data, "ts", "events", doc.id);
  optionalNumber(data, "messageId", "events", doc.id);
  optionalNumber(data, "updateId", "events", doc.id);
  optionalString(data, "username", "events", doc.id);
  optionalString(data, "ignoredReason", "events", doc.id);
  stringArray(data, "urls", "events", doc.id);
  if (!Array.isArray(data.mediaRefs) || !data.mediaRefs.every(isRecord))
    fail("events", doc.id, "mediaRefs must be an array of objects");
  if (data.replyTo !== undefined && !isRecord(data.replyTo))
    fail("events", doc.id, "replyTo must be an object");
}

function validateTurn(doc: SourceDocument): void {
  const data = record(doc.data, "turns", doc.id);
  oneOf(data, "kind", ["passive", "proactive", "retry", "subagent", "compaction"], "turns", doc.id);
  number(data, "startedAt", "turns", doc.id);
  number(data, "completedAt", "turns", doc.id);
  string(data, "model", "turns", doc.id);
  oneOf(data, "needsSearch", [true, false], "turns", doc.id);
  oneOf(data, "action", ["send", "dismiss", "error"], "turns", doc.id);
  stringArray(data, "messages", "turns", doc.id);
  if (!Array.isArray(data.toolCalls) || !data.toolCalls.every(isRecord))
    fail("turns", doc.id, "toolCalls must be an array of objects");
  if (data.tier !== undefined) oneOf(data, "tier", ["simple", "complex", "tech"], "turns", doc.id);
  optionalNullableString(data, "stickerFileId", "turns", doc.id);
  optionalString(data, "error", "turns", doc.id);
  for (const key of ["inputTokens", "outputTokens", "cachedInputTokens", "latencyMs"] as const)
    optionalNumber(data, key, "turns", doc.id);
}

function validateCompaction(doc: SourceDocument): void {
  const data = record(doc.data, "compactions", doc.id);
  for (const key of [
    "oldCursorTs",
    "newCursorTs",
    "inputTokens",
    "outputTokens",
    "createdAt",
  ] as const)
    number(data, key, "compactions", doc.id);
  string(data, "summary", "compactions", doc.id);
}

const validators: Record<FormalCollection, (document: SourceDocument) => void> = {
  users: validateUsers,
  diary: validateDiary,
  diaryObservations: validateObservation,
  runtime: validateRuntime,
  events: validateEvent,
  turns: validateTurn,
  compactions: validateCompaction,
};

export function validateFormalDocument(
  collection: FormalCollection,
  document: SourceDocument,
): void {
  validators[collection](document);
}
