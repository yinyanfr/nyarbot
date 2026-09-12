import { randomUUID } from "node:crypto";
import { access, rename, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { decryptSqliteBackup } from "../libs/database-backup-crypto.js";
import { SCHEMA_VERSION } from "../services/schema-version.js";

const REQUIRED_TABLES = [
  "users",
  "user_memories",
  "diary",
  "diary_entries",
  "diary_generation_records",
  "diary_observations",
  "runtime_group",
  "runtime_events",
  "runtime_turns",
  "runtime_compactions",
  "group_messages",
  "wordcloud_runs",
  "wordcloud_publications",
  "database_backup_runs",
];

function usage(): never {
  throw new Error(
    "Usage: npm run backup:restore -- <archive.sqlite.gz.enc> [output.sqlite] [--force] " +
      "[--require-table <name>]\nPassphrase is read from DATABASE_BACKUP_PASSPHRASE.",
  );
}

export interface RestoreArgs {
  archivePath: string;
  outputPath: string;
  force: boolean;
  requiredTables: string[];
}

export function parseArgs(args: string[]): RestoreArgs {
  const positional: string[] = [];
  const requiredTables: string[] = [];
  let force = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--force") force = true;
    else if (arg === "--require-table") {
      const table = args[index + 1];
      if (!table) usage();
      requiredTables.push(table);
      index += 1;
    } else if (arg.startsWith("--")) usage();
    else positional.push(arg);
  }
  const archivePath = positional[0];
  if (!archivePath || positional.length > 2) usage();
  const outputPath = positional[1] ?? archivePath.replace(/\.sqlite\.gz\.enc$/, ".sqlite");
  if (outputPath === archivePath) usage();
  return { archivePath, outputPath, force, requiredTables };
}

export function verifyDatabase(databasePath: string, requiredTables: string[] = []): string[] {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const integrity = database.pragma("integrity_check") as { integrity_check: string }[];
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      throw new Error(`SQLite integrity check failed: ${JSON.stringify(integrity)}`);
    }
    const foreignKeys = database.pragma("foreign_key_check") as unknown[];
    if (foreignKeys.length > 0)
      throw new Error(`SQLite foreign key check found ${foreignKeys.length} errors`);
    const schemaVersion = database.pragma("user_version", { simple: true }) as number;
    if (schemaVersion < 1 || schemaVersion > SCHEMA_VERSION) {
      throw new Error(
        `Restored SQLite schema version ${schemaVersion} is incompatible with supported version ${SCHEMA_VERSION}`,
      );
    }
    const tableRows = database
      .prepare(
        `SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as { name: string; sql: string | null }[];
    if (tableRows.some((row) => !row.sql)) {
      throw new Error("Restored SQLite database contains an invalid table definition");
    }
    const tables = tableRows.map((row) => row.name);
    if (tables.length === 0) throw new Error("Restored SQLite database has no application tables");
    const versionTables =
      schemaVersion >= 2 ? [...REQUIRED_TABLES, "diary_notification_deliveries"] : REQUIRED_TABLES;
    for (const table of [...versionTables, ...requiredTables]) {
      if (!tables.includes(table))
        throw new Error(`Required table is missing from restored schema: ${table}`);
    }
    return tables;
  } finally {
    database.close();
  }
}

export async function runRestore(args: RestoreArgs, passphrase: string): Promise<string[]> {
  if (path.resolve(args.archivePath) === path.resolve(args.outputPath)) {
    throw new Error("Archive and output paths must be different");
  }
  if (!args.force) {
    try {
      await access(args.outputPath);
      throw new Error(`Refusing to overwrite existing output: ${args.outputPath}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  const resolvedOutput = path.resolve(args.outputPath);
  const stagingPath = path.join(
    path.dirname(resolvedOutput),
    `.${path.basename(resolvedOutput)}.restore-${randomUUID()}.tmp`,
  );
  try {
    await decryptSqliteBackup(args.archivePath, stagingPath, passphrase);
    const tables = verifyDatabase(stagingPath, args.requiredTables);
    await rename(stagingPath, resolvedOutput);
    return tables;
  } catch (err) {
    await rm(stagingPath, { force: true });
    throw err;
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  await import("dotenv/config");
  const parsed = parseArgs(args);
  const passphrase = process.env.DATABASE_BACKUP_PASSPHRASE;
  if (!passphrase) throw new Error("DATABASE_BACKUP_PASSPHRASE is required");
  const tables = await runRestore(parsed, passphrase);
  process.stdout.write(
    `Restored and verified ${path.resolve(parsed.outputPath)}\nTables: ${tables.join(", ")}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
