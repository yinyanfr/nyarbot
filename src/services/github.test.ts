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

const { createGithubService } = await import("./github.js");

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("pushes diary and image atomically through the Git Data API", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const responses = [
    json({ object: { sha: "head" } }),
    json({ tree: { sha: "base-tree" } }),
    json({ sha: "image-blob" }),
    json({ sha: "markdown-blob" }),
    json({ sha: "new-tree" }),
    json({ sha: "new-commit" }),
    json({ object: { sha: "new-commit" } }),
  ];
  const service = createGithubService({
    token: "token",
    repo: "owner/repo",
    apiBase: "https://github.test",
    fetch: async (input, init) => {
      requests.push({ url: String(input), ...(init ? { init } : {}) });
      return responses.shift()!;
    },
  });
  const result = await service.pushDiaryToGithub("2026-08-12", "hello", {
    imageAsset: { path: "source/images/cloud.png", content: Buffer.from("png") },
  });
  assert.deepEqual(result, {
    owner: "owner",
    repo: "repo",
    path: "source/_posts/2026-08-12-diary.md",
    commitSha: "new-commit",
  });
  assert.equal(requests.length, 7);
  assert.equal(requests[6]!.init?.method, "PATCH");
  const tree = JSON.parse(String(requests[4]!.init?.body)) as { tree: { path: string }[] };
  assert.deepEqual(
    tree.tree.map((entry) => entry.path),
    ["source/images/cloud.png", "source/_posts/2026-08-12-diary.md"],
  );
  const markdownBlob = JSON.parse(String(requests[3]!.init?.body)) as { content: string };
  assert.match(
    Buffer.from(markdownBlob.content, "base64").toString(),
    /index_img: \/images\/cloud.png/,
  );
});

test("handles disabled, invalid, HTTP error, malformed Git Data responses", async (t) => {
  await t.test("disabled", async () => {
    assert.equal(
      await createGithubService({ token: "", repo: "" }).pushDiaryToGithub("d", "c"),
      null,
    );
  });
  await t.test("invalid repository", async () => {
    assert.equal(
      await createGithubService({ token: "t", repo: "invalid" }).pushDiaryToGithub("d", "c"),
      null,
    );
  });
  await t.test("HTTP error", async () => {
    const service = createGithubService({
      token: "t",
      repo: "o/r",
      fetch: async () => new Response("denied", { status: 403 }),
    });
    await assert.rejects(service.pushDiaryToGithub("d", "c"), /403 denied/);
  });
  await t.test("missing tree SHA", async () => {
    let call = 0;
    const service = createGithubService({
      token: "t",
      repo: "o/r",
      fetch: async () => (call++ === 0 ? json({ object: { sha: "head" } }) : json({})),
    });
    await assert.rejects(service.pushDiaryToGithub("d", "c"), /missing tree sha/);
  });
  await t.test("missing branch head", async () => {
    const service = createGithubService({
      token: "t",
      repo: "o/r",
      fetch: async () => new Response(null, { status: 404 }),
    });
    await assert.rejects(service.pushDiaryToGithub("d", "c"), /branch main head not found/);
  });
  for (const [name, responseIndex, expected] of [
    ["blob", 2, /blob create succeeded but sha was missing/],
    ["tree", 3, /tree create succeeded but sha was missing/],
    ["commit", 4, /commit create succeeded but sha was missing/],
  ] as const) {
    await t.test(`missing ${name} SHA`, async () => {
      let call = 0;
      const valid = [
        { object: { sha: "head" } },
        { tree: { sha: "base-tree" } },
        { sha: "blob" },
        { sha: "tree" },
        { sha: "commit" },
        {},
      ];
      const service = createGithubService({
        token: "t",
        repo: "o/r",
        fetch: async () => json(call++ === responseIndex ? {} : valid[call - 1]),
      });
      await assert.rejects(service.pushDiaryToGithub("d", "content"), expected);
    });
  }
});

test("polls Pages until deployment succeeds", async () => {
  let now = 0;
  let calls = 0;
  const service = createGithubService({
    token: "t",
    pagesPollIntervalMs: 10,
    pagesPollTimeoutMs: 100,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    fetch: async () => json({ status: calls++ === 0 ? "pending" : "succeed" }),
  });
  assert.deepEqual(
    await service.waitForGithubPagesPublish({ owner: "o", repo: "r", path: "p", commitSha: "c" }),
    { ready: true, state: "ready", detail: "succeed" },
  );
  assert.equal(calls, 2);
});

test("uses Pages fallback statuses and reports failures and timeout", async (t) => {
  const push = { owner: "o", repo: "r", path: "p", commitSha: "target" };
  await t.test("failed latest build", async () => {
    const responses = [
      new Response(null, { status: 404 }),
      json({ status: "built" }),
      json({ status: "errored", commit: "target", error: { message: "build failed" } }),
    ];
    const service = createGithubService({ token: "t", fetch: async () => responses.shift()! });
    assert.deepEqual(await service.waitForGithubPagesPublish(push), {
      ready: false,
      state: "failed",
      detail: "build failed",
    });
  });
  await t.test("timeout", async () => {
    let now = 0;
    const service = createGithubService({
      token: "t",
      pagesPollIntervalMs: 10,
      pagesPollTimeoutMs: 10,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      fetch: async () => json({ status: "pending" }),
    });
    assert.deepEqual(await service.waitForGithubPagesPublish(push), {
      ready: false,
      state: "pending",
      detail: "pages_publish_timeout",
    });
  });
  await t.test("deployment failure", async () => {
    const service = createGithubService({
      token: "t",
      fetch: async () => json({ status: "deployment_cancelled" }),
    });
    assert.deepEqual(await service.waitForGithubPagesPublish(push), {
      ready: false,
      state: "failed",
      detail: "deployment_cancelled",
    });
  });
  await t.test("errored Pages site", async () => {
    const responses = [new Response(null, { status: 404 }), json({ status: "errored" })];
    const service = createGithubService({ token: "t", fetch: async () => responses.shift()! });
    assert.deepEqual(await service.waitForGithubPagesPublish(push), {
      ready: false,
      state: "failed",
      detail: "pages_site_errored",
    });
  });
  await t.test("successful legacy build", async () => {
    const responses = [
      new Response(null, { status: 404 }),
      json({ status: "built" }),
      json({ status: "built", commit: "target" }),
    ];
    const service = createGithubService({ token: "t", fetch: async () => responses.shift()! });
    assert.deepEqual(await service.waitForGithubPagesPublish(push), {
      ready: true,
      state: "ready",
      detail: "built",
    });
  });
  assert.deepEqual(await createGithubService({ token: "" }).waitForGithubPagesPublish(push), {
    ready: false,
    state: "skipped",
    detail: "github_token_missing",
  });
});
