import config from "../configs/env.js";
import { logger } from "../libs/logger.js";
import type { SqliteDatabase } from "./database.js";

export interface SemanticMemorySearch {
  mode: "shadow" | "hybrid";
  modelKey: string;
  embed(inputs: string[], signal: AbortSignal): Promise<number[][]>;
}

export function configuredMemorySearch(settings = config): SemanticMemorySearch | undefined {
  const { memorySearchMode: mode, memoryEmbeddingUrl: url, memoryEmbeddingModel: model } = settings;
  if (mode === "off" || !url) return;
  return {
    mode,
    modelKey: JSON.stringify([model, settings.memoryEmbeddingRevision]),
    async embed(input, signal) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, input, truncate: false }),
        redirect: "error",
        signal,
      });
      if (!response.ok) throw new Error("Memory embedding request failed");
      const { embeddings } = (await response.json()) as { embeddings?: unknown };
      if (!Array.isArray(embeddings) || embeddings.length !== input.length) {
        throw new Error("Unexpected memory embedding batch");
      }
      return embeddings;
    },
  };
}

export function normalizeVector(vector: number[]): number[] {
  if (
    !Array.isArray(vector) ||
    vector.length < 1 ||
    vector.length > 4096 ||
    !vector.every(Number.isFinite)
  ) {
    throw new Error("Invalid memory embedding");
  }
  const norm = Math.hypot(...vector);
  if (!Number.isFinite(norm) || norm === 0) throw new Error("Invalid memory embedding norm");
  return vector.map((value) => value / norm);
}

// Vectors are normalized; a dot product is therefore cosine similarity.
export function memorySimilarity(vector: number[], stored: Buffer): number {
  if (stored.length !== vector.length * 4) return -1;
  return vector.reduce((sum, value, i) => sum + value * stored.readFloatLE(i * 4), 0);
}

export async function indexMemoryBatch(
  db: SqliteDatabase,
  search: SemanticMemorySearch,
  signal: AbortSignal,
): Promise<number> {
  const candidates = db
    .prepare(
      `
    SELECT m.id, m.content, m.tags_json
    FROM user_memory_records m
    LEFT JOIN user_memory_embeddings e ON e.memory_id = m.id AND e.model_key = ?
    WHERE e.memory_id IS NULL AND m.status = 'active'
      AND (m.expires_at IS NULL OR m.expires_at > ?)
    ORDER BY m.id LIMIT 8`,
    )
    .all(search.modelKey, Date.now()) as {
    id: string;
    content: string;
    tags_json: string;
  }[];
  if (!candidates.length) return 0;

  const vectors = await search.embed(
    candidates.map((row) => row.content + "\n" + row.tags_json),
    signal,
  );
  signal.throwIfAborted();
  if (vectors.length !== candidates.length) throw new Error("Invalid memory embedding batch size");
  const stored = vectors.map((vector) => {
    const normalized = normalizeVector(vector);
    const bytes = Buffer.alloc(normalized.length * 4);
    normalized.forEach((value, i) => bytes.writeFloatLE(value, i * 4));
    return bytes;
  });
  return db.transaction(() => {
    // Re-check after inference: a concurrent revision, prune, expiry or forget
    // must never be undone by a stale background response.
    const put = db.prepare(`
      INSERT INTO user_memory_embeddings (memory_id, model_key, vector)
      SELECT id, ?, ? FROM user_memory_records
      WHERE id = ? AND content = ? AND tags_json = ? AND status = 'active'
        AND (expires_at IS NULL OR expires_at > ?)
      ON CONFLICT(memory_id) DO UPDATE SET model_key = excluded.model_key, vector = excluded.vector`);
    return candidates.reduce(
      (count, row, index) =>
        count +
        put.run(search.modelKey, stored[index], row.id, row.content, row.tags_json, Date.now())
          .changes,
      0,
    );
  })();
}

export function startMemoryEmbeddingIndex(db: SqliteDatabase, settings = config) {
  const search = configuredMemorySearch(settings);
  if (!search) return;
  const shutdown = new AbortController();
  let pending: Promise<void> | undefined;
  const tick = () => {
    if (pending || shutdown.signal.aborted) return;
    const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(10_000)]);
    pending = indexMemoryBatch(db, search, signal)
      .then((indexed) => {
        if (indexed) logger.info({ indexed }, "memory embeddings indexed");
      })
      .catch(() => {
        if (!shutdown.signal.aborted) logger.warn("memory embedding batch failed");
      })
      .finally(() => {
        pending = undefined;
      });
  };
  const timer = setInterval(tick, 15_000);
  timer.unref();
  tick();
  return {
    async close() {
      clearInterval(timer);
      shutdown.abort();
      await pending;
    },
  };
}
