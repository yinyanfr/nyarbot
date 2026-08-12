import { createHash } from "node:crypto";
import type { FormalCollection, SourceDocument } from "./model.js";
import { canonicalJson, collectionHash } from "./model.js";
import { FORMAL_TABLES, type SqliteDatabase, type WordcloudCounts } from "./sqlite.js";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: unknown;
}

function sqliteCollectionHash(db: SqliteDatabase, table: string): string {
  const rows = db
    .prepare(`SELECT firestore_id, source_json FROM ${table} ORDER BY firestore_id`)
    .all() as { firestore_id: string; source_json: string }[];
  const hash = createHash("sha256");
  for (const row of rows) {
    hash.update(row.firestore_id);
    hash.update("\0");
    hash.update(row.source_json);
    hash.update("\n");
  }
  return hash.digest("hex");
}

export function runChecks(
  db: SqliteDatabase,
  source: Map<FormalCollection, SourceDocument[]>,
  wordcloud: WordcloudCounts,
): CheckResult[] {
  const checks: CheckResult[] = [];
  for (const [collection, documents] of source) {
    const table = FORMAL_TABLES[collection];
    const outputCount = Number(
      (db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count,
    );
    checks.push({
      name: `count:${collection}`,
      ok: outputCount === documents.length,
      detail: { source: documents.length, output: outputCount },
    });
    const sourceHash = collectionHash(documents);
    const outputHash = sqliteCollectionHash(db, table);
    checks.push({
      name: `hash:${collection}`,
      ok: sourceHash === outputHash,
      detail: { algorithm: "sha256", source: sourceHash, output: outputHash },
    });
  }
  for (const [table, expected] of Object.entries(wordcloud)) {
    const actual = Number(
      (db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count,
    );
    checks.push({
      name: `count:wordcloud:${table}`,
      ok: actual === expected,
      detail: { source: expected, output: actual },
    });
  }
  const integrity = db.pragma("integrity_check") as { integrity_check: string }[];
  checks.push({
    name: "sqlite:integrity",
    ok: integrity.length === 1 && integrity[0]?.integrity_check === "ok",
    detail: integrity,
  });
  const userVersion = Number(db.pragma("user_version", { simple: true }));
  checks.push({
    name: "sqlite:user_version",
    ok: userVersion === 1,
    detail: { expected: 1, actual: userVersion },
  });
  const foreignKeys = db.pragma("foreign_key_check") as unknown[];
  checks.push({ name: "sqlite:foreign_keys", ok: foreignKeys.length === 0, detail: foreignKeys });
  const semanticQueries: [string, string][] = [
    [
      "semantic:users",
      "SELECT count(*) AS count FROM users WHERE uid = '' OR nickname IS NULL OR NOT json_valid(source_json)",
    ],
    [
      "semantic:diary_dates",
      "SELECT count(*) AS count FROM diary WHERE date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' OR NOT json_valid(source_json)",
    ],
    [
      "semantic:observation_ids",
      "SELECT count(*) AS count FROM diary_observations WHERE observation_id = '' OR event = '' OR NOT json_valid(source_json)",
    ],
    [
      "semantic:event_timestamps",
      "SELECT count(*) AS count FROM runtime_events WHERE ts < 0 OR NOT json_valid(source_json)",
    ],
    [
      "semantic:turn_duration",
      "SELECT count(*) AS count FROM runtime_turns WHERE completed_at < started_at OR NOT json_valid(source_json)",
    ],
    [
      "semantic:compaction_cursor",
      "SELECT count(*) AS count FROM runtime_compactions WHERE new_cursor_ts < old_cursor_ts OR NOT json_valid(source_json)",
    ],
    [
      "semantic:wordcloud_booleans",
      "SELECT count(*) AS count FROM group_messages WHERE is_bot NOT IN (0, 1) OR is_forwarded NOT IN (0, 1)",
    ],
  ];
  for (const [name, query] of semanticQueries) {
    const invalid = Number((db.prepare(query).get() as { count: number }).count);
    checks.push({ name, ok: invalid === 0, detail: { invalidRows: invalid } });
  }
  const metadata = canonicalJson({
    checkedAt: new Date().toISOString(),
    checks: checks.map(({ name, ok }) => ({ name, ok })),
  });
  db.prepare("INSERT INTO schema_metadata VALUES (?, ?)").run("migration_checks", metadata);
  return checks;
}
