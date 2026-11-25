import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import config from "../configs/env.js";
import { closeDatabase, initDatabase } from "./database.js";
import {
  configuredMemorySearch,
  indexMemoryBatch,
  normalizeVector,
  startMemoryEmbeddingIndex,
  type SemanticMemorySearch,
} from "./memory-embeddings.js";
import { deleteUserMemory, recallUserMemories, saveUserMemory } from "./user-memory.js";

async function fixture(run: (db: ReturnType<typeof initDatabase>) => Promise<void>) {
  const db = initDatabase(":memory:");
  for (const uid of ["1", "2"]) {
    db.prepare(
      "INSERT INTO users (firestore_id, uid, nickname, source_json) VALUES (?, ?, ?, '{}')",
    ).run(uid, uid, uid);
  }
  try {
    await run(db);
  } finally {
    closeDatabase();
  }
}

const signal = new AbortController().signal;
const embed: SemanticMemorySearch["embed"] = async (texts) =>
  texts.map((text) => (/美式|提神|过时喜好|隐私资料/u.test(text) ? [3, 4] : [-3, -4]));
const hybrid = { mode: "hybrid", modelKey: "test-v1", embed } satisfies SemanticMemorySearch;
const lookup = (query: string, search: SemanticMemorySearch = hybrid) =>
  recallUserMemories("1", { query }, Date.now(), search);

test("hybrid finds paraphrases while preserving short exact matches and subject/date scopes", async () => {
  await fixture(async (db) => {
    const coffee = await saveUserMemory(
      "1",
      {
        content: "无糖美式",
        tags: ["咖啡"],
        exactQuote: "not-indexed",
        reflection: "not-indexed",
      },
      ["not-indexed"],
    );
    const short = await saveUserMemory("1", { content: "今天喝红茶" });
    await saveUserMemory("2", { content: "隐私资料" });
    await saveUserMemory(
      "1",
      { content: "过时喜好", expiresAt: Date.now() - 1 },
      [],
      Date.now() - 1000,
    );
    let inputs: string[] = [];
    assert.equal(
      await indexMemoryBatch(
        db,
        {
          ...hybrid,
          embed: (texts, abort) => {
            inputs = texts;
            return embed(texts, abort);
          },
        },
        signal,
      ),
      3,
    );
    assert.ok(inputs.includes('无糖美式\n["咖啡"]'));
    assert.ok(inputs.every((text) => !text.includes("not-indexed")));
    assert.equal(await indexMemoryBatch(db, hybrid, signal), 0);
    assert.deepEqual(
      (await lookup("提神")).map((row) => row.id),
      [coffee.id],
    );
    assert.deepEqual(
      (await lookup("红茶")).map((row) => row.id),
      [short.id],
    );
    assert.deepEqual(await lookup("提神", { ...hybrid, mode: "shadow" }), []);
    assert.deepEqual(await lookup("提神", { ...hybrid, modelKey: "other-version" }), []);
    assert.deepEqual(
      await recallUserMemories("1", { query: "提神", until: 2 }, Date.now(), hybrid),
      [],
    );
    const unavailable = {
      ...hybrid,
      embed: async () => {
        throw new Error("offline");
      },
    };
    assert.deepEqual(
      (await lookup("红茶", unavailable)).map((row) => row.id),
      [short.id],
    );
    assert.deepEqual(
      (await lookup("红茶", { ...hybrid, embed: async () => [[1, 1, 1]] })).map((row) => row.id),
      [short.id],
    );
    assert.equal(
      (await recallUserMemories("1", { mode: "recent", limit: 1 }, Date.now(), unavailable)).length,
      1,
    );
  });
});

test("concurrent revision and forgetting cannot return or recreate a stale embedding", async () => {
  await fixture(async (db) => {
    const old = await saveUserMemory("1", { content: "无糖美式" });
    assert.equal(await indexMemoryBatch(db, hybrid, signal), 1);
    let revisedId = "";
    const output = await lookup("无糖美式", {
      ...hybrid,
      async embed() {
        const revised = await saveUserMemory("1", { content: "红茶", supersedesId: old.id });
        revisedId = revised.id;
        return [[3, 4]];
      },
    });
    assert.deepEqual(output, []);
    assert.equal(db.prepare("SELECT count(*) FROM user_memory_embeddings").pluck().get(), 0);
    assert.equal(
      await indexMemoryBatch(
        db,
        {
          ...hybrid,
          async embed() {
            assert.equal(await deleteUserMemory("1", revisedId), true);
            return [[-3, -4]];
          },
        },
        signal,
      ),
      0,
    );
    assert.equal(db.prepare("SELECT count(*) FROM user_memory_embeddings").pluck().get(), 0);
    const newMemory = await saveUserMemory("1", { content: "无糖美式" });
    assert.equal(await indexMemoryBatch(db, hybrid, signal), 1);
    assert.equal(await deleteUserMemory("1", newMemory.id), true);
    assert.equal(db.prepare("SELECT count(*) FROM user_memory_embeddings").pluck().get(), 0);
  });
});

test("adapter posts only input and model, rejects invalid results and does not follow redirects", async (t) => {
  const settings = {
    ...config,
    memorySearchMode: "hybrid" as const,
    memoryEmbeddingUrl: new URL("http://ollama/api/embed"),
  };
  const search = configuredMemorySearch(settings)!;
  const response = t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    assert.equal(url.href, "http://ollama/api/embed");
    assert.equal(init.redirect, "error");
    assert.equal(init.signal, signal);
    assert.deepEqual(JSON.parse(String(init.body)), {
      model: settings.memoryEmbeddingModel,
      input: ["红茶"],
      truncate: false,
    });
    return Response.json({ embeddings: [[3, 4]] });
  });
  assert.deepEqual(await search.embed(["红茶"], signal), [[3, 4]]);
  response.mock.mockImplementation(async () => new Response(null, { status: 503 }));
  await assert.rejects(search.embed(["红茶"], signal), /request failed/);
  response.mock.mockImplementation(async () => Response.json({ embeddings: [] }));
  await assert.rejects(search.embed(["红茶"], signal), /Unexpected/);
  for (const vector of [[], [0], [NaN], [Infinity]]) {
    assert.throws(() => normalizeVector(vector), /Invalid/);
  }
  assert.equal(configuredMemorySearch({ ...settings, memorySearchMode: "off" }), undefined);
});

test("shutdown aborts and waits for the background index batch", async (t) => {
  await fixture(async (db) => {
    await saveUserMemory("1", { content: "红茶" });
    const fetch = t.mock.method(globalThis, "fetch", async (_url: URL, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) =>
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }),
      );
    });
    const worker = startMemoryEmbeddingIndex(db, {
      ...config,
      memorySearchMode: "shadow",
      memoryEmbeddingUrl: new URL("http://ollama/api/embed"),
    });
    assert.equal(fetch.mock.callCount(), 1);
    await worker?.close();
    assert.equal(db.prepare("SELECT count(*) FROM user_memory_embeddings").pluck().get(), 0);
  });
});

test("the enabled background index persists a successful batch without a chat query", async (t) => {
  await fixture(async (db) => {
    const memory = await saveUserMemory("1", { content: "红茶" });
    const fetch = t.mock.method(globalThis, "fetch", async () =>
      Response.json({ embeddings: [[0, 1]] }),
    );
    const worker = startMemoryEmbeddingIndex(db, {
      ...config,
      memorySearchMode: "shadow",
      memoryEmbeddingUrl: new URL("http://ollama/api/embed"),
    });
    try {
      await setImmediate();
      assert.equal(fetch.mock.callCount(), 1);
      assert.equal(
        db.prepare("SELECT memory_id FROM user_memory_embeddings").pluck().get(),
        memory.id,
      );
    } finally {
      await worker?.close();
    }
  });
});
