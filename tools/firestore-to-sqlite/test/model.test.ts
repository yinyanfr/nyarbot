import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs, parseServiceAccount } from "../src/cli.js";
import { canonicalJson, collectionHash, compareDocumentIds, jsonSafe } from "../src/model.js";
import { validateFormalDocument } from "../src/validate.js";

test("canonical JSON is key-order independent and hashes preserve document IDs", () => {
  assert.equal(canonicalJson({ z: 1, a: 2 }), canonicalJson({ a: 2, z: 1 }));
  assert.notEqual(
    collectionHash([{ id: "a", data: { value: 1 } }]),
    collectionHash([{ id: "b", data: { value: 1 } }]),
  );
});

test("document ID ordering is locale-independent", () => {
  assert.deepEqual(["a", "B", "b", "A"].sort(compareDocumentIds), ["A", "B", "a", "b"]);
});

test("JSON-safe conversion handles Firestore-like timestamps and bytes", () => {
  assert.deepEqual(
    jsonSafe({ ts: { toDate: () => new Date("2026-01-02T03:04:05Z") }, bytes: Buffer.from("ok") }),
    {
      bytes: { $bytes: "b2s=" },
      ts: { $timestamp: "2026-01-02T03:04:05.000Z" },
    },
  );
});

test("formal validation rejects malformed documents with source path", () => {
  assert.throws(
    () =>
      validateFormalDocument("users", {
        id: "42",
        data: { uid: "42", nickname: "n", memories: [1] },
      }),
    /users\/42: memories must be an array of strings/,
  );
});

test("CLI requires all explicit arguments and validates timezone", () => {
  const options = parseArgs([
    "--service-account",
    "a.json",
    "--wordcloud-db",
    "old.db",
    "--output",
    "new.db",
    "--timezone",
    "Asia/Shanghai",
  ]);
  assert.equal(options.timezone, "Asia/Shanghai");
  assert.throws(
    () =>
      parseArgs([
        "--service-account",
        "a",
        "--wordcloud-db",
        "b",
        "--output",
        "c",
        "--timezone",
        "Mars/Olympus",
      ]),
    /Invalid IANA timezone/,
  );
});

test("service account parser accepts the official downloaded JSON shape", () => {
  assert.deepEqual(
    parseServiceAccount({
      project_id: "project",
      client_email: "bot@example.com",
      private_key: "private-key",
    }),
    { projectId: "project", clientEmail: "bot@example.com", privateKey: "private-key" },
  );
});
