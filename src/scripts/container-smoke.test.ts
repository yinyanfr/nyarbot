import assert from "node:assert/strict";
import test from "node:test";
import { runContainerSmoke } from "./container-smoke.js";

test("container smoke exports a reusable check without import-time execution", () => {
  const result = runContainerSmoke();
  assert.equal(result.sqlite, true);
  assert.match(result.platform, /\//);
  assert.ok(result.nodejieba.includes("南京市"));
  assert.ok(result.nodejieba.includes("长江大桥"));
  assert.ok(result.canvasPngBytes >= 200);
});
