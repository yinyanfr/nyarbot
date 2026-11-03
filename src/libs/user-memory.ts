import nodejieba from "nodejieba";
import { normalizePromptData, safePromptValue } from "./prompt-safety.js";

export type MemoryImportance = 1 | 2 | 3 | 4 | 5;
export type MemoryKind =
  | "preference"
  | "background"
  | "project"
  | "recent_state"
  | "interaction"
  | "legacy";

export interface UserMemoryDraft {
  content: string;
  kind?: Exclude<MemoryKind, "legacy">;
  occurredAt?: number;
  importance?: MemoryImportance;
  confidence?: "fact" | "inference" | "uncertain";
  exactQuote?: string;
  reflection?: string;
  tags?: string[];
  expiresAt?: number;
  supersedesId?: string;
}

export interface UserMemory {
  id: string;
  subjectUid: string;
  content: string;
  kind: MemoryKind;
  occurredAt: number | null;
  recordedAt: number | null;
  importance: MemoryImportance;
  confidence: "fact" | "inference" | "uncertain";
  exactQuote: string | null;
  reflection: string | null;
  tags: string[];
  sourceRefs: string[];
  expiresAt: number | null;
  status: "active" | "superseded";
  supersedesId: string | null;
  origin: "conversation" | "legacy";
}

export interface MemoryQuery {
  mode?: "relevant" | "recent";
  query?: string;
  limit?: number;
  since?: number;
  until?: number;
}

const kinds = new Set(["preference", "background", "project", "recent_state", "interaction"]);

export function sanitizeUserMemory(input: UserMemoryDraft): UserMemoryDraft | null {
  const content = safePromptValue(input.content, { maxLen: 500, fallback: "" });
  if (!content) return null;
  const clean = (value: string | undefined, maxLen: number) =>
    value ? safePromptValue(value, { maxLen, fallback: "" }) : "";
  const exactQuote = clean(input.exactQuote, 300);
  const reflection = clean(input.reflection, 300);
  const tags = [...new Set((input.tags ?? []).map((tag) => clean(tag, 32)).filter(Boolean))].slice(
    0,
    8,
  );
  const validTime = (value: number | undefined) =>
    value !== undefined &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 8_640_000_000_000_000;
  if (
    (input.occurredAt !== undefined && !validTime(input.occurredAt)) ||
    (input.expiresAt !== undefined && !validTime(input.expiresAt))
  )
    return null;
  return {
    content,
    kind: input.kind && kinds.has(input.kind) ? input.kind : "background",
    importance: [1, 2, 3, 4, 5].includes(input.importance ?? 0) ? input.importance! : 2,
    confidence:
      input.confidence === "fact" || input.confidence === "inference"
        ? input.confidence
        : "uncertain",
    ...(input.occurredAt !== undefined ? { occurredAt: input.occurredAt } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    ...(exactQuote ? { exactQuote } : {}),
    ...(reflection ? { reflection } : {}),
    ...(tags.length ? { tags } : {}),
    ...(input.supersedesId ? { supersedesId: normalizePromptData(input.supersedesId, 200) } : {}),
  };
}

/** Bounded literal keywords, not SQL/FTS syntax. Chinese is segmented locally. */
export function memoryKeywords(query: string): string[] {
  const normalized = normalizePromptData(query, 200).toLowerCase();
  const parts = normalized.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const words = parts.flatMap((part) =>
    /\p{Script=Han}/u.test(part) ? [part, ...nodejieba.cut(part)] : [part],
  );
  const stopwords = new Set([
    "我",
    "你",
    "他",
    "她",
    "的",
    "了",
    "是",
    "在",
    "什么",
    "之前",
    "记得",
    "记忆",
  ]);
  return [...new Set(words.filter((word) => word.length > 1 && !stopwords.has(word)))].slice(0, 12);
}
