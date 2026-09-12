import assert from "node:assert/strict";
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

const { createTelegramImageDownloader } = await import("./telegram-image.js");
const signal = new AbortController().signal;

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

test("accepts a supported image response content type when bytes have no known signature", async () => {
  const bytes = Buffer.from("image bytes");
  const { download } = downloader(
    new Response(bytes, { headers: { "content-type": "image/webp; charset=utf-8" } }),
  );
  assert.equal(await download("a"), `data:image/webp;base64,${bytes.toString("base64")}`);
});

test("detects every DeepSeek-supported image signature without trusting response headers", async () => {
  const fixtures: [string, Buffer][] = [
    ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff])],
    ["image/gif", Buffer.from("GIF89a")],
    ["image/webp", Buffer.from("RIFFxxxxWEBP")],
  ];
  for (const [contentType, bytes] of fixtures) {
    const { download } = downloader(
      new Response(bytes, { headers: { "content-type": "application/octet-stream" } }),
    );
    assert.equal(await download("image"), `data:${contentType};base64,${bytes.toString("base64")}`);
  }
});

test("rejects image types that DeepSeek vision does not support", async () => {
  for (const [contentType, bytes] of [
    ["image/svg+xml", Buffer.from("<svg/>")],
    ["image/bmp", Buffer.from([0x42, 0x4d, 0, 0])],
    ["image/tiff", Buffer.from([0x49, 0x49, 0x2a, 0])],
    ["image/avif", Buffer.from("xxxxftypavif")],
    ["image/heic", Buffer.from("xxxxftypheic")],
  ] as const) {
    const { download } = downloader(
      new Response(bytes, { headers: { "content-type": contentType } }),
    );
    assert.equal(await download("image"), null);
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
