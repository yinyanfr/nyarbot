import { createHash } from "node:crypto";
import type {
  DiaryEntry,
  DiaryObservationConfidence,
  DiaryObservationSalience,
  DiaryObservationV2,
} from "../global.d.js";
import { safePromptValue, truncateUnicode } from "./prompt-safety.js";

export const DIARY_PROMPT_VERSION = "diary-v2";
export const DIARY_STYLE_REFERENCE_VERSION = "lixia-v1";
export const MAX_DAILY_DIARY_OBSERVATIONS = 12;

const OBSERVATION_FIELD_LIMITS = {
  occurredAt: 64,
  event: 500,
  exactQuote: 500,
  immediateReaction: 500,
  interpretation: 800,
  unsaidThought: 800,
  unresolvedQuestion: 500,
  tag: 32,
  sourceRef: 120,
} as const;

export interface DiaryObservationDraft {
  occurredAt?: string;
  event: string;
  exactQuote?: string;
  immediateReaction?: string;
  interpretation?: string;
  unsaidThought?: string;
  unresolvedQuestion?: string;
  confidence: DiaryObservationConfidence;
  salience: DiaryObservationSalience;
  tags?: string[];
  sourceRefs?: string[];
  supersedesId?: string;
}

function xmlEscape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function cleanField(text: string | undefined, maxLen: number): string | undefined {
  if (!text) return undefined;
  const cleaned = safePromptValue(text, { maxLen, fallback: "" }).trim();
  return cleaned ? truncateUnicode(cleaned, maxLen) : undefined;
}

function normalizeConfidence(value: string | undefined): DiaryObservationConfidence {
  if (value === "fact" || value === "inference" || value === "uncertain") return value;
  return "uncertain";
}

function normalizeSalience(value: number | undefined): DiaryObservationSalience {
  if (value === 1 || value === 2 || value === 3 || value === 4 || value === 5) return value;
  return 3;
}

export function sanitizeDiaryObservationDraft(
  input: Partial<DiaryObservationDraft>,
): DiaryObservationDraft | null {
  const event = cleanField(input.event, OBSERVATION_FIELD_LIMITS.event);
  if (!event) return null;
  const occurredAt = cleanField(input.occurredAt, OBSERVATION_FIELD_LIMITS.occurredAt);
  const exactQuote = cleanField(input.exactQuote, OBSERVATION_FIELD_LIMITS.exactQuote);
  const immediateReaction = cleanField(
    input.immediateReaction,
    OBSERVATION_FIELD_LIMITS.immediateReaction,
  );
  const interpretation = cleanField(input.interpretation, OBSERVATION_FIELD_LIMITS.interpretation);
  const unsaidThought = cleanField(input.unsaidThought, OBSERVATION_FIELD_LIMITS.unsaidThought);
  const unresolvedQuestion = cleanField(
    input.unresolvedQuestion,
    OBSERVATION_FIELD_LIMITS.unresolvedQuestion,
  );
  const supersedesId = cleanField(input.supersedesId, OBSERVATION_FIELD_LIMITS.sourceRef);

  const tags = (input.tags ?? [])
    .map((tag) => cleanField(tag, OBSERVATION_FIELD_LIMITS.tag))
    .filter((tag): tag is string => Boolean(tag))
    .slice(0, 8);
  const sourceRefs = (input.sourceRefs ?? [])
    .map((ref) => cleanField(ref, OBSERVATION_FIELD_LIMITS.sourceRef))
    .filter((ref): ref is string => Boolean(ref))
    .slice(0, 12);

  return {
    event,
    ...(occurredAt ? { occurredAt } : {}),
    ...(exactQuote ? { exactQuote } : {}),
    ...(immediateReaction ? { immediateReaction } : {}),
    ...(interpretation ? { interpretation } : {}),
    ...(unsaidThought ? { unsaidThought } : {}),
    ...(unresolvedQuestion ? { unresolvedQuestion } : {}),
    confidence: normalizeConfidence(input.confidence),
    salience: normalizeSalience(input.salience),
    ...(tags.length > 0 ? { tags } : {}),
    ...(sourceRefs.length > 0 ? { sourceRefs } : {}),
    ...(supersedesId ? { supersedesId } : {}),
  };
}

function normalizeSimilarityText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "")
    .trim();
}

export function buildObservationFingerprint(
  localDate: string,
  event: string,
  sourceRefs: string[] = [],
): string {
  const normalizedEvent = normalizeSimilarityText(event);
  const normalizedRefs = [...sourceRefs]
    .map((ref) => normalizeSimilarityText(ref))
    .filter(Boolean)
    .sort()
    .join("|");
  return createHash("sha1")
    .update(`${localDate}\n${normalizedEvent}\n${normalizedRefs}`)
    .digest("hex");
}

export function observationsLikelyMatch(a: DiaryObservationV2, b: DiaryObservationDraft): boolean {
  const eventA = normalizeSimilarityText(a.event);
  const eventB = normalizeSimilarityText(b.event);
  if (!eventA || !eventB) return false;
  if (eventA === eventB) return true;
  if (eventA.includes(eventB) || eventB.includes(eventA)) return true;
  const refsA = new Set(a.sourceRefs ?? []);
  const refsB = new Set(b.sourceRefs ?? []);
  const hasSharedSource = [...refsB].some((ref) => refsA.has(ref));
  if (
    hasSharedSource &&
    (eventA.startsWith(eventB.slice(0, 12)) || eventB.startsWith(eventA.slice(0, 12)))
  ) {
    return true;
  }
  return false;
}

function observationPriority(observation: DiaryObservationV2): number {
  const hasQuote = observation.exactQuote ? 20 : 0;
  const hasQuestion = observation.unresolvedQuestion ? 15 : 0;
  const hasReflection = observation.interpretation || observation.unsaidThought ? 10 : 0;
  const hasReaction = observation.immediateReaction ? 5 : 0;
  return observation.salience * 100 + hasQuote + hasQuestion + hasReflection + hasReaction;
}

function topicKey(observation: DiaryObservationV2): string {
  const tag = observation.tags?.[0];
  if (tag) return normalizeSimilarityText(tag);
  return normalizeSimilarityText(observation.event).slice(0, 24);
}

export function selectObservationsForDiary(
  observations: DiaryObservationV2[],
  limit = MAX_DAILY_DIARY_OBSERVATIONS,
): DiaryObservationV2[] {
  const ranked = [...observations].sort((a, b) => {
    const byPriority = observationPriority(b) - observationPriority(a);
    if (byPriority !== 0) return byPriority;
    return a.recordedAt.localeCompare(b.recordedAt);
  });
  const selected: DiaryObservationV2[] = [];
  const usedTopics = new Map<string, number>();
  while (ranked.length > 0 && selected.length < limit) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < ranked.length; i++) {
      const candidate = ranked[i];
      if (!candidate) continue;
      const repeats = usedTopics.get(topicKey(candidate)) ?? 0;
      const score = observationPriority(candidate) - repeats * 25;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    const picked = ranked.splice(bestIndex, 1)[0];
    if (!picked) break;
    selected.push(picked);
    const key = topicKey(picked);
    usedTopics.set(key, (usedTopics.get(key) ?? 0) + 1);
  }
  return selected.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
}

export function serializeDiaryObservationsXml(
  date: string,
  observations: DiaryObservationV2[],
  legacyEntries: DiaryEntry[] = [],
): string {
  const lines = [`<daily_observations date="${xmlEscape(date)}" trust="untrusted-data">`];
  for (const observation of observations) {
    lines.push(
      `  <observation id="${xmlEscape(observation.id)}" confidence="${observation.confidence}" salience="${String(observation.salience)}" status="${observation.status}">`,
    );
    lines.push(`    <event>${xmlEscape(observation.event)}</event>`);
    if (observation.occurredAt) {
      lines.push(`    <occurred_at>${xmlEscape(observation.occurredAt)}</occurred_at>`);
    }
    lines.push(`    <recorded_at>${xmlEscape(observation.recordedAt)}</recorded_at>`);
    if (observation.exactQuote) {
      lines.push(`    <exact_quote>${xmlEscape(observation.exactQuote)}</exact_quote>`);
    }
    if (observation.immediateReaction) {
      lines.push(
        `    <immediate_reaction>${xmlEscape(observation.immediateReaction)}</immediate_reaction>`,
      );
    }
    if (observation.interpretation) {
      lines.push(
        `    <interpretation confidence="${observation.confidence}">${xmlEscape(observation.interpretation)}</interpretation>`,
      );
    }
    if (observation.unsaidThought) {
      lines.push(`    <unsaid_thought>${xmlEscape(observation.unsaidThought)}</unsaid_thought>`);
    }
    if (observation.unresolvedQuestion) {
      lines.push(
        `    <unresolved_question>${xmlEscape(observation.unresolvedQuestion)}</unresolved_question>`,
      );
    }
    if (observation.tags && observation.tags.length > 0) {
      lines.push("    <tags>");
      for (const tag of observation.tags) {
        lines.push(`      <tag>${xmlEscape(tag)}</tag>`);
      }
      lines.push("    </tags>");
    }
    if (observation.sourceRefs && observation.sourceRefs.length > 0) {
      lines.push("    <source_refs>");
      for (const ref of observation.sourceRefs) {
        lines.push(`      <ref>${xmlEscape(ref)}</ref>`);
      }
      lines.push("    </source_refs>");
    }
    lines.push("  </observation>");
  }
  if (legacyEntries.length > 0) {
    lines.push('  <legacy_notes trust="untrusted-data">');
    for (const entry of legacyEntries) {
      lines.push(`    <note>${xmlEscape(entry.content)}</note>`);
    }
    lines.push("  </legacy_notes>");
  }
  lines.push("</daily_observations>");
  return lines.join("\n");
}
