import assert from "node:assert/strict";
import test from "node:test";
import type { FormalCollection, SourceDocument } from "../src/model.js";
import { validateFormalDocument } from "../src/validate.js";

const valid: Record<FormalCollection, SourceDocument> = {
  users: {
    id: "user-doc",
    data: {
      uid: "42",
      nickname: "Yan",
      memories: ["cats"],
      timeZone: "UTC",
      nightyTimestamp: null,
      lastMorningGreet: 1,
    },
  },
  diary: {
    id: "2026-01-01",
    data: {
      entries: [{ ts: 1, content: "entry" }],
      diary: "generated",
      generatedAt: 2,
      generationRecords: [
        {
          date: "2026-01-01",
          generatedAt: "now",
          modelProvider: "google",
          modelName: "model",
          promptVersion: "1",
          styleReferenceVersion: "1",
          observationIds: ["o1"],
          status: "failed",
          inputTokens: null,
          outputTokens: 2,
          error: "failure",
        },
      ],
    },
  },
  diaryObservations: {
    id: "observation-doc",
    data: {
      schemaVersion: 2,
      id: "o1",
      recordedAt: "now",
      localDate: "2026-01-01",
      event: "event",
      occurredAt: "then",
      subjectUid: "42",
      subjectName: "Yan",
      subjectUsername: "yan",
      exactQuote: "quote",
      immediateReaction: "reaction",
      interpretation: "interpretation",
      unsaidThought: "thought",
      unresolvedQuestion: "question",
      supersedesId: "old",
      confidence: "fact",
      salience: 5,
      status: "active",
      tags: ["tag"],
      sourceRefs: ["event:1"],
    },
  },
  runtime: {
    id: "group",
    data: {
      summary: "summary",
      summaryCursorTs: 1,
      updatedAt: 2,
      lastProcessedMessageId: null,
      lastCompactedAt: 3,
    },
  },
  events: {
    id: "event-doc",
    data: {
      chatId: "-1",
      uid: "42",
      name: "Yan",
      text: "hello",
      kind: "user_message",
      ts: 1,
      messageId: null,
      updateId: 2,
      username: "yan",
      ignoredReason: "none",
      urls: ["https://example.com"],
      mediaRefs: [{}],
      replyTo: {},
    },
  },
  turns: {
    id: "turn-doc",
    data: {
      kind: "passive",
      startedAt: 1,
      completedAt: 2,
      model: "model",
      needsSearch: false,
      action: "send",
      messages: ["hello"],
      toolCalls: [{}],
      tier: "tech",
      stickerFileId: null,
      error: "none",
      inputTokens: 1,
      outputTokens: null,
      cachedInputTokens: 2,
      latencyMs: 3,
    },
  },
  compactions: {
    id: "compaction-doc",
    data: {
      oldCursorTs: 1,
      newCursorTs: 2,
      inputTokens: 3,
      outputTokens: 4,
      createdAt: 5,
      summary: "summary",
    },
  },
};

test("validation accepts complete documents for every formal collection", () => {
  for (const [collection, document] of Object.entries(valid) as [
    FormalCollection,
    SourceDocument,
  ][]) {
    assert.doesNotThrow(() => validateFormalDocument(collection, document), collection);
  }
  assert.doesNotThrow(() =>
    validateFormalDocument("diary", { id: "ignored", data: { date: "2026-12-31" } }),
  );
});

const malformed: [FormalCollection, SourceDocument, RegExp][] = [
  ["users", { id: "u", data: null }, /expected an object/],
  ["users", { id: "u", data: { uid: 1, nickname: "n", memories: [] } }, /uid must be/],
  ["users", { id: "u", data: { uid: "u", nickname: 1, memories: [] } }, /nickname must be/],
  ["users", { id: "u", data: { uid: "u", nickname: "n", memories: [1] } }, /memories must/],
  ["users", { id: "u", data: { uid: "u", nickname: "n", memories: [], timeZone: 1 } }, /timeZone/],
  [
    "users",
    { id: "u", data: { uid: "u", nickname: "n", memories: [], nightyTimestamp: NaN } },
    /nightyTimestamp/,
  ],
  ["diary", { id: "bad", data: {} }, /date must be YYYY-MM-DD/],
  ["diary", { id: "2026-01-01", data: { entries: {} } }, /entries must be an array/],
  ["diary", { id: "2026-01-01", data: { entries: [{ ts: "x", content: "x" }] } }, /ts must/],
  ["diary", { id: "2026-01-01", data: { generationRecords: {} } }, /generationRecords must/],
  ["diary", { id: "2026-01-01", data: { generationRecords: [{}] } }, /date must be/],
  [
    "diary",
    {
      id: "2026-01-01",
      data: {
        generationRecords: [
          {
            date: "d",
            generatedAt: "g",
            modelProvider: "p",
            modelName: "m",
            promptVersion: "v",
            styleReferenceVersion: "s",
            observationIds: [],
            status: "bad",
          },
        ],
      },
    },
    /status has an unsupported value/,
  ],
  ["diaryObservations", { id: "o", data: { schemaVersion: 1 } }, /schemaVersion/],
  [
    "diaryObservations",
    {
      id: "o",
      data: {
        schemaVersion: 2,
        id: "o",
        recordedAt: "r",
        localDate: "d",
        event: "e",
        confidence: "fact",
        salience: 3,
        status: "active",
        tags: [1],
      },
    },
    /tags must/,
  ],
  ["runtime", { id: "other", data: {} }, /only runtime\/group/],
  [
    "runtime",
    { id: "group", data: { summary: "s", summaryCursorTs: Infinity, updatedAt: 1 } },
    /summaryCursorTs/,
  ],
  [
    "events",
    {
      id: "e",
      data: {
        chatId: "c",
        uid: "u",
        name: "n",
        text: "t",
        kind: "bad",
        ts: 1,
        urls: [],
        mediaRefs: [],
      },
    },
    /kind has/,
  ],
  [
    "events",
    {
      id: "e",
      data: {
        chatId: "c",
        uid: "u",
        name: "n",
        text: "t",
        kind: "system",
        ts: 1,
        urls: [],
        mediaRefs: [1],
      },
    },
    /mediaRefs/,
  ],
  [
    "events",
    {
      id: "e",
      data: {
        chatId: "c",
        uid: "u",
        name: "n",
        text: "t",
        kind: "system",
        ts: 1,
        urls: [],
        mediaRefs: [],
        replyTo: [],
      },
    },
    /replyTo/,
  ],
  ["turns", { id: "t", data: { kind: "bad" } }, /kind has/],
  [
    "turns",
    {
      id: "t",
      data: {
        kind: "passive",
        startedAt: 1,
        completedAt: 2,
        model: "m",
        needsSearch: "no",
        action: "send",
        messages: [],
        toolCalls: [],
      },
    },
    /needsSearch/,
  ],
  [
    "turns",
    {
      id: "t",
      data: {
        kind: "passive",
        startedAt: 1,
        completedAt: 2,
        model: "m",
        needsSearch: true,
        action: "send",
        messages: [],
        toolCalls: [1],
      },
    },
    /toolCalls/,
  ],
  [
    "turns",
    {
      id: "t",
      data: {
        kind: "passive",
        startedAt: 1,
        completedAt: 2,
        model: "m",
        needsSearch: true,
        action: "send",
        messages: [],
        toolCalls: [],
        stickerFileId: 1,
      },
    },
    /stickerFileId/,
  ],
  [
    "compactions",
    {
      id: "c",
      data: {
        oldCursorTs: 1,
        newCursorTs: 2,
        inputTokens: 3,
        outputTokens: 4,
        createdAt: 5,
        summary: 6,
      },
    },
    /summary must/,
  ],
];

test("validation rejects malformed fields across every formal collection", () => {
  for (const [collection, document, expected] of malformed) {
    assert.throws(
      () => validateFormalDocument(collection, document),
      (error: unknown) =>
        error instanceof Error &&
        expected.test(error.message) &&
        error.message.includes(`${collection}/${document.id}`),
      `${collection}/${document.id} ${expected}`,
    );
  }
});
