import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { parseArgs, parseServiceAccount } from "../src/cli.js";
import {
  assertValidTimezone,
  canonicalJson,
  collectionHash,
  compareDocumentIds,
  isRecord,
  jsonSafe,
} from "../src/model.js";

test("JSON-safe conversion handles supported scalar and Firestore-like values", () => {
  class DocumentReference {
    path = "users/42";
  }
  assert.deepEqual(
    jsonSafe({
      bigint: 12n,
      bytes: Buffer.from("ok"),
      date: new Date("2026-01-02T03:04:05Z"),
      geopoint: { latitude: 1.5, longitude: -2 },
      infinity: Infinity,
      nan: NaN,
      reference: new DocumentReference(),
      timestamp: { toDate: () => new Date("2026-01-02T03:04:05Z") },
      typedBytes: new Uint8Array([1, 2]),
      undefined,
      unsupported: Symbol("x"),
    }),
    {
      bigint: { $bigint: "12" },
      bytes: { $bytes: "b2s=" },
      date: { $date: "2026-01-02T03:04:05.000Z" },
      geopoint: { $geopoint: { latitude: 1.5, longitude: -2 } },
      infinity: { $number: "Infinity" },
      nan: { $number: "NaN" },
      reference: { $reference: "users/42" },
      timestamp: { $timestamp: "2026-01-02T03:04:05.000Z" },
      typedBytes: { $bytes: "AQI=" },
      undefined: { $undefined: true },
      unsupported: { $unsupported: "Symbol(x)" },
    },
  );
  assert.equal(jsonSafe(null), null);
  assert.equal(jsonSafe(true), true);
  assert.deepEqual(jsonSafe([1, "x"]), [1, "x"]);
});

test("JSON-safe conversion rejects cycles and invalid timestamps but permits shared values", () => {
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), /cyclic value cannot be archived/);
  assert.throws(() => jsonSafe({ toDate: () => "not a date" }), /invalid timestamp/);
  const shared = { value: 1 };
  assert.equal(canonicalJson({ a: shared, b: shared }), '{"a":{"value":1},"b":{"value":1}}');
});

test("canonical JSON and collection hashes are deterministic and include IDs", () => {
  assert.equal(canonicalJson({ z: 1, a: 2 }), canonicalJson({ a: 2, z: 1 }));
  const documents = [
    { id: "b", data: { value: 2 } },
    { id: "a", data: { value: 1 } },
  ];
  assert.equal(collectionHash(documents), collectionHash([...documents].reverse()));
  assert.notEqual(
    collectionHash(documents),
    collectionHash([{ id: "x", data: documents[0]!.data }]),
  );
  assert.deepEqual(["a", "B", "b", "A"].sort(compareDocumentIds), ["A", "B", "a", "b"]);
  assert.equal(compareDocumentIds("a", "a"), 0);
});

test("record and timezone guards accept valid inputs and reject invalid ones", () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord(null), false);
  assert.doesNotThrow(() => assertValidTimezone("Asia/Shanghai"));
  assert.throws(() => assertValidTimezone("Mars/Olympus"), /Invalid IANA timezone/);
});

test("CLI parser resolves every required option", () => {
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
  assert.equal(options.serviceAccount, path.resolve("a.json"));
  assert.equal(options.wordcloudDb, path.resolve("old.db"));
  assert.equal(options.output, path.resolve("new.db"));
  assert.equal(options.timezone, "Asia/Shanghai");
});

test("CLI parser rejects missing values, duplicates, unknown options, and bad timezones", () => {
  assert.throws(() => parseArgs([]), /Usage:/);
  assert.throws(() => parseArgs(["service-account", "x"]), /Usage:/);
  assert.throws(() => parseArgs(["--service-account"]), /Usage:/);
  assert.throws(
    () => parseArgs(["--service-account", "x", "--service-account", "y"]),
    /Duplicate argument/,
  );
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
        "UTC",
        "--extra",
        "x",
      ]),
    /Unknown argument/,
  );
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

test("service account parser accepts snake and camel case and rejects malformed files", () => {
  const expected = {
    projectId: "project",
    clientEmail: "bot@example.com",
    privateKey: "private-key",
  };
  assert.deepEqual(
    parseServiceAccount({
      project_id: "project",
      client_email: "bot@example.com",
      private_key: "private-key",
    }),
    expected,
  );
  assert.deepEqual(parseServiceAccount(expected), expected);
  assert.throws(() => parseServiceAccount(null), /must be an object/);
  assert.throws(() => parseServiceAccount({ project_id: "project" }), /is missing/);
  assert.throws(() => parseServiceAccount({ ...expected, privateKey: "" }), /is missing/);
});
