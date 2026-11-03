import { createHash } from "node:crypto";

export interface SourceDocument {
  id: string;
  data: unknown;
}

export const FORMAL_COLLECTIONS = [
  "users",
  "diary",
  "diaryObservations",
  "runtime",
  "events",
  "turns",
  "compactions",
] as const;

export type FormalCollection = (typeof FORMAL_COLLECTIONS)[number];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function jsonSafe(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : { $number: String(value) };
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (typeof value === "undefined") return { $undefined: true };
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { $bytes: Buffer.from(value).toString("base64") };
  }
  if (typeof value !== "object") return { $unsupported: String(value) };
  if (seen.has(value)) throw new Error("cyclic value cannot be archived");
  seen.add(value);
  try {
    const candidate = value as Record<string, unknown> & {
      path?: unknown;
      latitude?: unknown;
      longitude?: unknown;
      toDate?: unknown;
    };
    if (typeof candidate.toDate === "function") {
      const date = (candidate.toDate as () => unknown)();
      if (!(date instanceof Date) || Number.isNaN(date.valueOf()))
        throw new Error("invalid timestamp");
      return { $timestamp: date.toISOString() };
    }
    if (typeof candidate.path === "string" && candidate.constructor?.name === "DocumentReference") {
      return { $reference: candidate.path };
    }
    if (typeof candidate.latitude === "number" && typeof candidate.longitude === "number") {
      return { $geopoint: { latitude: candidate.latitude, longitude: candidate.longitude } };
    }
    if (Array.isArray(value)) return value.map((item) => jsonSafe(item, seen));
    return Object.fromEntries(
      Object.keys(candidate)
        .sort()
        .map((key) => [key, jsonSafe(candidate[key], seen)]),
    );
  } finally {
    seen.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(jsonSafe(value));
}

export function compareDocumentIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function collectionHash(documents: SourceDocument[]): string {
  const hash = createHash("sha256");
  for (const document of [...documents].sort((a, b) => compareDocumentIds(a.id, b.id))) {
    hash.update(document.id);
    hash.update("\0");
    hash.update(canonicalJson(document.data));
    hash.update("\n");
  }
  return hash.digest("hex");
}

export function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new Error(`Invalid IANA timezone: ${timezone}`);
  }
}
