import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { cert, deleteApp, initializeApp, type ServiceAccount } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { runChecks, type CheckResult } from "./checks.js";
import {
  assertValidTimezone,
  canonicalJson,
  FORMAL_COLLECTIONS,
  type FormalCollection,
  type SourceDocument,
} from "./model.js";
import {
  createDatabase,
  importWordcloud,
  insertFormalCollection,
  type WordcloudCounts,
} from "./sqlite.js";
import { validateFormalDocument } from "./validate.js";

export interface MigrationOptions {
  serviceAccount: string;
  wordcloudDb: string;
  output: string;
  timezone: string;
}

export interface MigrationReport {
  version: 1;
  status: "success" | "failed";
  startedAt: string;
  completedAt: string;
  projectId?: string;
  timezone: string;
  output: string;
  report: string;
  archiveDirectory: string;
  formalCollections: Record<string, { sourceCount: number; outputCount?: number; sha256?: string }>;
  wordcloud: Partial<WordcloudCounts>;
  unknownCollections: Record<string, { count: number; archive: string }>;
  ignoredBackupCollections: string[];
  checks: CheckResult[];
  error?: string;
}

interface ServiceAccountFile {
  project_id?: unknown;
  client_email?: unknown;
  private_key?: unknown;
  projectId?: unknown;
  clientEmail?: unknown;
  privateKey?: unknown;
}

interface ParsedServiceAccount extends ServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

export function parseServiceAccount(value: unknown): ParsedServiceAccount {
  if (!value || typeof value !== "object")
    throw new Error("Service account JSON must be an object");
  const raw = value as ServiceAccountFile;
  const projectId = raw.projectId ?? raw.project_id;
  const clientEmail = raw.clientEmail ?? raw.client_email;
  const privateKey = raw.privateKey ?? raw.private_key;
  if (
    typeof projectId !== "string" ||
    !projectId ||
    typeof clientEmail !== "string" ||
    !clientEmail ||
    typeof privateKey !== "string" ||
    !privateKey
  ) {
    throw new Error("Service account JSON is missing project_id, client_email, or private_key");
  }
  return { projectId, clientEmail, privateKey };
}

function usage(): never {
  throw new Error(
    "Usage: npm run migrate -- --service-account <json> --wordcloud-db <sqlite> --output <sqlite> --timezone <IANA timezone>",
  );
}

export function parseArgs(args: string[]): MigrationOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) usage();
    if (values.has(key)) throw new Error(`Duplicate argument: ${key}`);
    values.set(key, value);
  }
  const allowed = new Set(["--service-account", "--wordcloud-db", "--output", "--timezone"]);
  for (const key of values.keys())
    if (!allowed.has(key)) throw new Error(`Unknown argument: ${key}`);
  const required = (key: string): string => values.get(key) ?? usage();
  const timezone = required("--timezone");
  assertValidTimezone(timezone);
  return {
    serviceAccount: path.resolve(required("--service-account")),
    wordcloudDb: path.resolve(required("--wordcloud-db")),
    output: path.resolve(required("--output")),
    timezone,
  };
}

interface FirestoreDocument {
  id: string;
  exists: boolean;
  data(): unknown;
}

export interface FirestoreLike {
  listCollections(): Promise<{ id: string }[]>;
  collection(name: string): {
    get(): Promise<{ docs: FirestoreDocument[] }>;
    doc(id: string): { get(): Promise<FirestoreDocument> };
  };
}

interface FirebaseConnection {
  firestore: FirestoreLike;
  close(): Promise<void>;
}

export interface MigrationDependencies {
  connectFirestore(credentials: ParsedServiceAccount): Promise<FirebaseConnection>;
  randomUUID(): string;
  now(): Date;
  existsSync(path: string): boolean;
  mkdirSync: typeof mkdirSync;
  readFileSync: typeof readFileSync;
  renameSync: typeof renameSync;
  rmSync: typeof rmSync;
  writeFileSync: typeof writeFileSync;
  createDatabase: typeof createDatabase;
  importWordcloud: typeof importWordcloud;
  insertFormalCollection: typeof insertFormalCollection;
  runChecks: typeof runChecks;
}

const defaultDependencies: MigrationDependencies = {
  async connectFirestore(credentials) {
    const app = initializeApp(
      { credential: cert(credentials), projectId: credentials.projectId },
      `firestore-to-sqlite-${randomUUID()}`,
    );
    return {
      firestore: getFirestore(app) as FirestoreLike,
      close: () => deleteApp(app),
    };
  },
  randomUUID,
  now: () => new Date(),
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  createDatabase,
  importWordcloud,
  insertFormalCollection,
  runChecks,
};

async function readCollection(db: FirestoreLike, name: string): Promise<SourceDocument[]> {
  const snapshot = await db.collection(name).get();
  return snapshot.docs.map((document) => ({ id: document.id, data: document.data() }));
}

function reportPaths(output: string): { report: string; archiveDirectory: string } {
  return {
    report: `${output}.migration-report.json`,
    archiveDirectory: `${output}.unknown-collections`,
  };
}

export async function runMigration(
  options: MigrationOptions,
  overrides: Partial<MigrationDependencies> = {},
): Promise<MigrationReport> {
  const deps = { ...defaultDependencies, ...overrides };
  const startedAt = deps.now().toISOString();
  const paths = reportPaths(options.output);
  if (deps.existsSync(options.output))
    throw new Error(`Output already exists; refusing to overwrite: ${options.output}`);
  if (deps.existsSync(paths.report) || deps.existsSync(paths.archiveDirectory))
    throw new Error("Report or archive destination already exists; refusing to overwrite");
  if (!deps.existsSync(options.serviceAccount))
    throw new Error(`Service account file not found: ${options.serviceAccount}`);
  if (!deps.existsSync(options.wordcloudDb))
    throw new Error(`Legacy wordcloud database not found: ${options.wordcloudDb}`);
  deps.mkdirSync(path.dirname(options.output), { recursive: true });
  const stage = `${options.output}.staging-${deps.randomUUID()}`;
  const formal = new Map<FormalCollection, SourceDocument[]>();
  const report: MigrationReport = {
    version: 1,
    status: "failed",
    startedAt,
    completedAt: startedAt,
    timezone: options.timezone,
    output: options.output,
    report: paths.report,
    archiveDirectory: paths.archiveDirectory,
    formalCollections: {},
    wordcloud: {},
    unknownCollections: {},
    ignoredBackupCollections: [],
    checks: [],
  };
  let connection: FirebaseConnection | undefined;
  let sqlite: ReturnType<typeof createDatabase> | undefined;
  let outputPublished = false;
  try {
    const credentials = parseServiceAccount(
      JSON.parse(deps.readFileSync(options.serviceAccount, "utf8")),
    );
    report.projectId = credentials.projectId;
    connection = await deps.connectFirestore(credentials);
    const firestore = connection.firestore;
    const collections = await firestore.listCollections();
    const names = collections.map((collection) => collection.id).sort();
    const nameSet = new Set(names);
    for (const collection of FORMAL_COLLECTIONS) {
      let documents: SourceDocument[] = [];
      if (nameSet.has(collection)) {
        if (collection === "runtime") {
          const document = await firestore.collection("runtime").doc("group").get();
          if (document.exists) documents = [{ id: document.id, data: document.data() }];
        } else {
          documents = await readCollection(firestore, collection);
        }
      }
      for (const document of documents) validateFormalDocument(collection, document);
      formal.set(collection, documents);
      report.formalCollections[collection] = { sourceCount: documents.length };
    }
    const unknownNames = names.filter(
      (name) => !FORMAL_COLLECTIONS.includes(name as FormalCollection) && !name.endsWith("_backup"),
    );
    report.ignoredBackupCollections = names.filter((name) => name.endsWith("_backup"));
    const unknownDocuments = new Map<string, SourceDocument[]>();
    for (const name of unknownNames)
      unknownDocuments.set(name, await readCollection(firestore, name));

    sqlite = deps.createDatabase(stage);
    sqlite.prepare("INSERT INTO schema_metadata VALUES (?, ?)").run("schema_version", "1");
    sqlite
      .prepare("INSERT INTO schema_metadata VALUES (?, ?)")
      .run("migration_timezone", options.timezone);
    sqlite
      .prepare("INSERT INTO schema_metadata VALUES (?, ?)")
      .run("firestore_project_id", credentials.projectId);
    for (const [collection, documents] of formal)
      deps.insertFormalCollection(sqlite, collection, documents);
    const wordcloud = deps.importWordcloud(sqlite, options.wordcloudDb);
    report.wordcloud = wordcloud;
    report.checks = deps.runChecks(sqlite, formal, wordcloud);
    if (report.checks.some((check) => !check.ok))
      throw new Error("One or more migration checks failed");
    sqlite.close();
    sqlite = undefined;

    if (unknownDocuments.size > 0) deps.mkdirSync(paths.archiveDirectory);
    for (const [name, documents] of unknownDocuments) {
      const archive = path.join(paths.archiveDirectory, `${encodeURIComponent(name)}.json`);
      deps.writeFileSync(archive, `${canonicalJson({ collection: name, documents })}\n`, {
        flag: "wx",
      });
      report.unknownCollections[name] = { count: documents.length, archive };
    }
    for (const check of report.checks) {
      const match = /^(count|hash):(.+)$/.exec(check.name);
      const collection = match?.[2];
      if (!collection || !(collection in report.formalCollections)) continue;
      const entry = report.formalCollections[collection]!;
      const detail = check.detail as Record<string, unknown>;
      if (match[1] === "count") entry.outputCount = Number(detail.output);
      else entry.sha256 = String(detail.output);
    }
    await connection.close();
    connection = undefined;
    deps.renameSync(stage, options.output);
    outputPublished = true;
    report.status = "success";
    report.completedAt = deps.now().toISOString();
    deps.writeFileSync(paths.report, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    report.status = "failed";
    const errors = [error instanceof Error ? error.message : String(error)];
    const cleanup = (action: () => void): void => {
      try {
        action();
      } catch (cleanupError) {
        errors.push(
          `Cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }
    };
    if (sqlite) cleanup(() => sqlite?.close());
    cleanup(() => deps.rmSync(stage, { force: true }));
    if (outputPublished) cleanup(() => deps.rmSync(options.output, { force: true }));
    if (deps.existsSync(paths.archiveDirectory))
      cleanup(() => deps.rmSync(paths.archiveDirectory, { recursive: true, force: true }));
    report.completedAt = deps.now().toISOString();
    report.error = errors.join("; ");
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (error) {
        if (report.status === "success") throw error;
        report.error += `; Cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
  if (report.status === "failed" && !deps.existsSync(paths.report))
    deps.writeFileSync(paths.report, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return report;
}

async function main(): Promise<void> {
  const report = await runMigration(parseArgs(process.argv.slice(2)));
  const output = `${JSON.stringify(report)}\n`;
  if (report.status === "success") process.stdout.write(output);
  else {
    process.stderr.write(output);
    process.exitCode = 1;
  }
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  await main().catch((error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({ status: "failed", error: error instanceof Error ? error.message : String(error) })}\n`,
    );
    process.exitCode = 1;
  });
}
