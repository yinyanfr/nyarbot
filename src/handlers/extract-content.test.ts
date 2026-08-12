import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "grammy/types";
import { extractContent } from "./extract-content.js";

function message(fields: Record<string, unknown>): Message {
  return fields as unknown as Message;
}

test("extracts and deduplicates entity, text-link, bare, caption, state, and reply URLs", async () => {
  const msg = message({
    text: "https://one.example and linked",
    entities: [
      { type: "url", offset: 0, length: 19 },
      { type: "text_link", offset: 24, length: 6, url: "https://linked.example" },
    ],
    reply_to_message: message({
      caption: "https://two.example/path). reply https://reply.example！",
    }),
  });
  const result = await extractContent({} as never, msg, {
    rawText: "duplicate https://one.example plus https://state.example】",
    entities: [],
  });
  assert.deepEqual(result.urls, [
    "https://one.example",
    "https://linked.example",
    "https://two.example/path",
    "https://reply.example",
    "https://state.example",
  ]);
});

test("collects current and replied media with preferred thumbnails and metadata", async () => {
  const msg = message({
    photo: [{ file_id: "small" }, { file_id: "large" }],
    sticker: { file_id: "sticker", emoji: "🐱", thumbnail: { file_id: "sticker-thumb" } },
    video: {
      file_id: "video",
      cover: [{ file_id: "cover-small" }, { file_id: "cover-large" }],
      thumbnail: { file_id: "video-thumb" },
    },
    animation: { file_id: "animation", thumbnail: { file_id: "animation-thumb" } },
    video_note: { file_id: "note", thumbnail: { file_id: "note-thumb" } },
    document: { file_id: "doc", file_name: "file.pdf", thumbnail: { file_id: "doc-thumb" } },
    audio: { file_id: "audio", file_name: "fallback.mp3", thumbnail: { file_id: "audio-thumb" } },
    reply_to_message: message({
      photo: [{ file_id: "reply-photo" }],
      audio: { file_id: "reply-audio", title: "Song" },
    }),
  });
  const result = await extractContent({} as never, msg, { rawText: "", entities: [] });
  assert.equal(result.stickerEmoji, "🐱");
  assert.deepEqual(result.mediaRefs, [
    { type: "image", source: "current", fileId: "large" },
    {
      type: "sticker",
      source: "current",
      fileId: "sticker",
      thumbnailFileId: "sticker-thumb",
      emoji: "🐱",
    },
    { type: "video", source: "current", fileId: "video", thumbnailFileId: "cover-large" },
    {
      type: "animation",
      source: "current",
      fileId: "animation",
      thumbnailFileId: "animation-thumb",
    },
    { type: "video_note", source: "current", fileId: "note", thumbnailFileId: "note-thumb" },
    {
      type: "document",
      source: "current",
      fileId: "doc",
      filename: "file.pdf",
      thumbnailFileId: "doc-thumb",
    },
    {
      type: "audio",
      source: "current",
      fileId: "audio",
      title: "fallback.mp3",
      thumbnailFileId: "audio-thumb",
    },
    { type: "image", source: "reply_to", fileId: "reply-photo" },
    { type: "audio", source: "reply_to", fileId: "reply-audio", title: "Song" },
  ]);
});

test("handles messages without content and does not inherit replied sticker emoji", async () => {
  const result = await extractContent(
    {} as never,
    message({ reply_to_message: message({ sticker: { file_id: "reply-sticker", emoji: "😺" } }) }),
    { rawText: "", entities: [] },
  );
  assert.deepEqual(result.urls, []);
  assert.equal(result.stickerEmoji, "");
  assert.deepEqual(result.mediaRefs, [
    { type: "sticker", source: "reply_to", fileId: "reply-sticker", emoji: "😺" },
  ]);
});
