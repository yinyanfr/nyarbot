import assert from "node:assert/strict";
import test from "node:test";
import { isDuplicateUpdate } from "./update-dedup.js";

test("detects repeats and evicts the oldest update after the bounded window", () => {
  const base = 10_000_000;
  assert.equal(isDuplicateUpdate(base), false);
  assert.equal(isDuplicateUpdate(base), true);
  for (let id = base + 1; id <= base + 1024; id++) {
    assert.equal(isDuplicateUpdate(id), false);
  }
  assert.equal(isDuplicateUpdate(base), false);
  assert.equal(isDuplicateUpdate(base + 1024), true);
});
