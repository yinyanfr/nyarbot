import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "./logger.js";

interface HistoryEntry {
  uid: string;
  name: string;
  username?: string;
  text: string;
  timestamp: number;
}

const SAVE_PATH = path.resolve("data/conversation-buffer.json");
const STALE_MS = 2 * 60 * 60 * 1000; // 2 hours

const MAX_HISTORY = 60;
const MAX_TEXT_LEN = 500;
const buffers = new Map<string, HistoryEntry[]>();

export function pushMessage(
  groupId: string,
  uid: string,
  name: string,
  text: string,
  username?: string,
): void {
  if (!buffers.has(groupId)) {
    buffers.set(groupId, []);
  }
  const buffer = buffers.get(groupId)!;
  buffer.push({
    uid,
    name,
    ...(username ? { username } : {}),
    text: text.slice(0, MAX_TEXT_LEN),
    timestamp: Date.now(),
  });
  while (buffer.length > MAX_HISTORY) {
    buffer.shift();
  }
}

export function getHistory(groupId: string): HistoryEntry[] {
  return buffers.get(groupId) ?? [];
}

export function formatHistoryAsContext(history: HistoryEntry[]): string {
  if (history.length === 0) return "";
  return history
    .map((entry) => {
      const label = entry.username ? `[${entry.name} (@${entry.username})]` : `[${entry.name}]`;
      return `${label}: ${entry.text}`;
    })
    .join("\n");
}

export function clearHistory(groupId: string): void {
  buffers.delete(groupId);
}

export async function saveConversationBuffer(): Promise<void> {
  try {
    await fs.mkdir(path.dirname(SAVE_PATH), { recursive: true });
    const data = JSON.stringify(Array.from(buffers.entries()), null, 2);
    await fs.writeFile(SAVE_PATH, data, "utf-8");
  } catch (err) {
    logger.warn({ err }, "failed to save conversation buffer");
  }
}

export async function loadConversationBuffer(): Promise<void> {
  try {
    const data = await fs.readFile(SAVE_PATH, "utf-8");
    const entries: [string, HistoryEntry[]][] = JSON.parse(data);
    const now = Date.now();
    for (const [groupId, history] of entries) {
      if (!Array.isArray(history)) continue;
      const fresh = history.filter(
        (e: HistoryEntry) =>
          typeof e.uid === "string" &&
          typeof e.name === "string" &&
          typeof e.text === "string" &&
          typeof e.timestamp === "number" &&
          now - e.timestamp < STALE_MS,
      );
      if (fresh.length > 0) {
        buffers.set(groupId, fresh.slice(-MAX_HISTORY));
      }
    }
    const total = Array.from(buffers.values()).reduce((s, h) => s + h.length, 0);
    logger.info({ total, groups: buffers.size }, "conversation buffer loaded from disk");
  } catch {
    // File doesn't exist or is corrupted — start fresh
  }
}
