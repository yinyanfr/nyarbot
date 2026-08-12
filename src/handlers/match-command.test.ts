import assert from "node:assert/strict";
import test from "node:test";
import { matchCommand } from "./match-command.js";

test("matches an exact bare or addressed Telegram command entity", () => {
  assert.equal(
    matchCommand([{ type: "bot_command", offset: 0, length: 6 }], "/start", "/start", "cat_bot"),
    true,
  );
  assert.equal(
    matchCommand(
      [{ type: "bot_command", offset: 4, length: 14 }],
      "hey /start@cat_bot now",
      "/start",
      "cat_bot",
    ),
    true,
  );
});

test("rejects wrong entity types, usernames, casing, and partial commands", () => {
  assert.equal(
    matchCommand([{ type: "bold", offset: 0, length: 6 }], "/start", "/start", "cat_bot"),
    false,
  );
  assert.equal(
    matchCommand(
      [{ type: "bot_command", offset: 0, length: 12 }],
      "/start@other",
      "/start",
      "cat_bot",
    ),
    false,
  );
  assert.equal(
    matchCommand([{ type: "bot_command", offset: 0, length: 6 }], "/Start", "/start", "cat_bot"),
    false,
  );
  assert.equal(
    matchCommand([{ type: "bot_command", offset: 0, length: 3 }], "/start", "/start", "cat_bot"),
    false,
  );
  assert.equal(matchCommand([], "/start", "/start", "cat_bot"), false);
});
