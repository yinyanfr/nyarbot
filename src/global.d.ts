/**
 * The info of a telegram user stored in firebase users/{uid}
 */
export interface User {
  uid: string;
  nickname: string; // instead of their telegram username, users can explicitly ask you to register a nickname they want you to call them
  memories: string[]; // an array that contains all memories you add during the conversation with the user
  timeZone?: string; // optional IANA timezone gathered from an explicit client-side signal such as a Mini App
  nightyTimestamp?: number; // timestamp of last goodnight (server time, ms)
  lastMorningGreet?: number; // timestamp of last morning greeting (prevents duplicates within same cycle)
}

/** A single diary observation written by the bot during conversation. */
export interface DiaryEntry {
  ts: number; // Unix timestamp in ms
  content: string; // natural-language observation
}

export type DiaryObservationConfidence = "fact" | "inference" | "uncertain";
export type DiaryObservationStatus = "active" | "superseded" | "retracted";
export type DiaryObservationSalience = 1 | 2 | 3 | 4 | 5;

export interface DiaryObservationV2 {
  schemaVersion: 2;
  id: string;
  occurredAt?: string;
  recordedAt: string;
  localDate: string;
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
  status: DiaryObservationStatus;
  supersedesId?: string;
}

export interface DiaryGenerationRecord {
  date: string;
  generatedAt: string;
  modelProvider: string;
  modelName: string;
  promptVersion: string;
  styleReferenceVersion: string;
  observationIds: string[];
  inputTokens?: number;
  outputTokens?: number;
  status: "success" | "failed";
  error?: string;
}
