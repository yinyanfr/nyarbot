import assert from "node:assert/strict";
import test from "node:test";
import {
  getStickerDescriptions,
  getStickerEmojiByFileId,
  getStickerEmojis,
  getStickerFileId,
  getStickerFileIdByDescription,
  getStickerList,
  pickRandomStickerEmoji,
  stickerCount,
} from "./stickers.js";

test("sticker indexes agree in both directions", () => {
  const emojis = getStickerEmojis();
  assert.equal(stickerCount(), emojis.length);
  assert.deepEqual(getStickerList(), emojis);
  assert.equal(Object.keys(getStickerDescriptions()).length, emojis.length);
  for (const emoji of emojis) {
    const fileId = getStickerFileId(emoji);
    assert.ok(fileId);
    assert.equal(getStickerEmojiByFileId(fileId), emoji);
    assert.equal(getStickerFileIdByDescription(`适合用 ${emoji} 回应`), fileId);
  }
});

test("unknown lookups return null and random picks stay in the catalog", () => {
  assert.equal(getStickerFileId("🛸"), null);
  assert.equal(getStickerEmojiByFileId("missing"), null);
  assert.equal(getStickerFileIdByDescription("no matching emoji"), null);
  assert.ok(getStickerList().includes(pickRandomStickerEmoji()));
});
