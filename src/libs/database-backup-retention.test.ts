import assert from "node:assert/strict";
import test from "node:test";
import { selectArchiveNamesToDelete } from "./database-backup-retention.js";

test("retains seven recorded successes and only the newest failed archive", () => {
  const successful = Array.from({ length: 9 }, (_, index) => `success-${index}`);
  const archives = [
    ...successful.map((name, index) => ({ name, mtimeMs: index })),
    { name: "failed-old", mtimeMs: 10 },
    { name: "failed-new", mtimeMs: 20 },
  ];
  assert.deepEqual(selectArchiveNamesToDelete(archives, successful).sort(), [
    "failed-old",
    "success-7",
    "success-8",
  ]);
});

test("retains the newest unrecorded archive regardless of input order", () => {
  assert.deepEqual(
    selectArchiveNamesToDelete(
      [
        { name: "middle", mtimeMs: 2 },
        { name: "new", mtimeMs: 3 },
        { name: "old", mtimeMs: 1 },
      ],
      [],
    ).sort(),
    ["middle", "old"],
  );
  assert.deepEqual(selectArchiveNamesToDelete([], []), []);
});
