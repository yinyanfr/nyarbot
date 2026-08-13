import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

const requiredEnv = {
  BOT_USERNAME: "test_bot",
  BOT_API_KEY: "test-token",
  TG_ADMIN_UID: "1",
  TG_GROUP_ID: "-1",
  DEEPSEEK_API_KEY: "test",
  TAVILY_API_KEY: "test",
  CF_AIG_TOKEN: "test",
  CF_ACCOUNT_ID: "test",
  DATABASE_BACKUP_PASSPHRASE: "correct horse battery staple",
};
Object.assign(process.env, requiredEnv);

const { createTelegramImageDownloader, createTelegramVideoStickerDownloader } =
  await import("./telegram-image.js");
const signal = new AbortController().signal;
const videoIo = {
  mkdtemp: async () => "/tmp/nyarbot-sticker-test",
  readFile: async () => Buffer.from("mp4"),
  writeFile: async () => undefined,
  rm: async () => undefined,
  tmpdir: () => "/tmp",
} as const;

function successfulFfmpeg(
  inspect?: (args: readonly string[], options: { stdio?: unknown }) => void,
) {
  return ((_command: string, args: readonly string[], options: { stdio?: unknown }) => {
    inspect?.(args, options);
    const child = new EventEmitter() as never as ReturnType<
      typeof import("node:child_process").spawn
    >;
    const stderr = new EventEmitter();
    Object.assign(stderr, { resume: () => stderr });
    Object.assign(child, { stderr, kill: () => true });
    queueMicrotask(() => child.emit("close", 0));
    return child;
  }) as typeof import("node:child_process").spawn;
}

function downloader(response: Response | Error) {
  const urls: string[] = [];
  const download = createTelegramImageDownloader({
    botApiKey: "secret-token",
    timeout: (milliseconds) => {
      assert.equal(milliseconds, 15_000);
      return signal;
    },
    fetch: async (input, init) => {
      urls.push(String(input));
      assert.equal(init?.signal, signal);
      if (response instanceof Error) throw response;
      return response;
    },
  });
  return { download, urls };
}

test("downloads an image, detects its type, and constructs the Telegram URL", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2]);
  const fixture = downloader(new Response(png, { headers: { "content-type": "text/plain" } }));
  assert.equal(
    await fixture.download("photos/a.png"),
    `data:image/png;base64,${png.toString("base64")}`,
  );
  assert.deepEqual(fixture.urls, ["https://api.telegram.org/file/botsecret-token/photos/a.png"]);
});

test("accepts an image response content type when bytes have no known signature", async () => {
  const bytes = Buffer.from("image bytes");
  const { download } = downloader(
    new Response(bytes, { headers: { "content-type": "image/svg+xml; charset=utf-8" } }),
  );
  assert.equal(await download("a"), `data:image/svg+xml;base64,${bytes.toString("base64")}`);
});

test("detects every supported image signature without trusting response headers", async () => {
  const fixtures: [string, Buffer][] = [
    ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff])],
    ["image/gif", Buffer.from("GIF89a")],
    ["image/webp", Buffer.from("RIFFxxxxWEBP")],
    ["image/bmp", Buffer.from([0x42, 0x4d, 0, 0])],
    ["image/tiff", Buffer.from([0x49, 0x49, 0x2a, 0])],
    ["image/tiff", Buffer.from([0x4d, 0x4d, 0, 0x2a])],
    ["image/avif", Buffer.from("xxxxftypavif")],
    ["image/heic", Buffer.from("xxxxftypheic")],
  ];
  for (const [contentType, bytes] of fixtures) {
    const { download } = downloader(
      new Response(bytes, { headers: { "content-type": "application/octet-stream" } }),
    );
    assert.equal(await download("image"), `data:${contentType};base64,${bytes.toString("base64")}`);
  }
});

test("returns null for non-2xx, malformed non-image, oversized, timeout, and abort failures", async (t) => {
  await t.test("non-2xx", async () => {
    assert.equal(await downloader(new Response("no", { status: 503 })).download("a"), null);
  });
  await t.test("non-image", async () => {
    assert.equal(await downloader(new Response("no")).download("a"), null);
  });
  await t.test("oversized", async () => {
    assert.equal(
      await downloader(new Response(Buffer.alloc(10 * 1024 * 1024 + 1, 0xff))).download("a"),
      null,
    );
  });
  for (const name of ["TimeoutError", "AbortError"]) {
    await t.test(name, async () => {
      assert.equal(await downloader(new DOMException(name, name)).download("a"), null);
    });
  }
});

test("loops WebM video stickers into three-second MP4 for Gemini", async () => {
  const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1]);
  const writes: { path: string; data: Buffer }[] = [];
  const download = createTelegramVideoStickerDownloader({
    botApiKey: "secret-token",
    timeout: () => signal,
    fetch: async () => new Response(webm),
    ...videoIo,
    writeFile: async (filePath, data) => {
      writes.push({ path: filePath, data });
    },
    spawn: successfulFfmpeg((args, options) => {
      assert.deepEqual(args.slice(0, 8), [
        "-hide_banner",
        "-loglevel",
        "error",
        "-stream_loop",
        "-1",
        "-i",
        "/tmp/nyarbot-sticker-test/sticker.webm",
        "-t",
      ]);
      assert.equal(args[8], "3");
      assert.deepEqual(options.stdio, ["ignore", "ignore", "pipe"]);
    }),
  });
  assert.equal(
    await download("stickers/a.webm"),
    `data:video/mp4;base64,${Buffer.from("mp4").toString("base64")}`,
  );
  assert.deepEqual(writes, [{ path: "/tmp/nyarbot-sticker-test/sticker.webm", data: webm }]);
});

test("rejects non-WebM video sticker payloads", async () => {
  const download = createTelegramVideoStickerDownloader({
    botApiKey: "secret-token",
    timeout: () => signal,
    fetch: async () => new Response("not webm"),
    ...videoIo,
    spawn: successfulFfmpeg(),
  });
  assert.equal(await download("stickers/a.tgs"), null);
});

test("handles video sticker download failures", async () => {
  const download = createTelegramVideoStickerDownloader({
    botApiKey: "secret-token",
    timeout: () => signal,
    fetch: async () => Promise.reject(new Error("offline")),
    ...videoIo,
    spawn: successfulFfmpeg(),
  });
  assert.equal(await download("stickers/a.webm"), null);
});

test("rejects failed and oversized Telegram video sticker downloads", async () => {
  for (const response of [
    new Response("no", { status: 503 }),
    new Response(Buffer.alloc(5 * 1024 * 1024 + 1)),
  ]) {
    const download = createTelegramVideoStickerDownloader({
      botApiKey: "secret-token",
      timeout: () => signal,
      fetch: async () => response,
      ...videoIo,
      spawn: successfulFfmpeg(),
    });
    assert.equal(await download("stickers/a.webm"), null);
  }
});

test("rejects failed, empty, and oversized Gemini MP4 conversions", async () => {
  const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1]);
  for (const fixture of [
    { code: 1, output: Buffer.from("bad") },
    { code: 0, output: Buffer.alloc(0) },
    { code: 0, output: Buffer.alloc(7 * 1024 * 1024 + 1) },
  ]) {
    const download = createTelegramVideoStickerDownloader({
      botApiKey: "secret-token",
      timeout: () => signal,
      fetch: async () => new Response(webm),
      ...videoIo,
      readFile: async () => fixture.output,
      spawn: (() => {
        const child = new EventEmitter() as never as ReturnType<
          typeof import("node:child_process").spawn
        >;
        const stderr = new EventEmitter();
        Object.assign(stderr, { resume: () => stderr });
        Object.assign(child, { stderr, kill: () => true });
        queueMicrotask(() => child.emit("close", fixture.code));
        return child;
      }) as typeof import("node:child_process").spawn,
    });
    assert.equal(await download("stickers/a.webm"), null);
  }
});

test("handles ffmpeg process errors and ignores a later close event", async () => {
  const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1]);
  const download = createTelegramVideoStickerDownloader({
    botApiKey: "secret-token",
    timeout: () => signal,
    fetch: async () => new Response(webm),
    ...videoIo,
    spawn: (() => {
      const child = new EventEmitter() as never as ReturnType<
        typeof import("node:child_process").spawn
      >;
      const stderr = new EventEmitter();
      Object.assign(stderr, { resume: () => stderr });
      Object.assign(child, { stderr, kill: () => true });
      queueMicrotask(() => {
        child.emit("error", new Error("spawn failed"));
        child.emit("close", 1);
      });
      return child;
    }) as typeof import("node:child_process").spawn,
  });

  assert.equal(await download("stickers/a.webm"), null);
});
