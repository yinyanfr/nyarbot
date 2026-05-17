import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "./logger.js";
import config from "../configs/env.js";

interface HistoryEntry {
  uid: string;
  name: string;
  username?: string;
  text: string;
  timestamp: number;
}

const SAVE_PATH = path.resolve(config.conversationBufferPath);
const STALE_MS = 2 * 60 * 60 * 1000; // 2 hours

const MAX_HISTORY = 30;
const MAX_TEXT_LEN = 500;
const buffers = new Map<string, HistoryEntry[]>();

function xmlEscape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

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
  const lines: string[] = ['<recent_history order="oldest_to_newest">'];
  for (const entry of history) {
    lines.push(
      `  <message uid="${xmlEscape(entry.uid)}" name="${xmlEscape(entry.name)}" username="${xmlEscape(entry.username ?? "")}" ts="${entry.timestamp}">${xmlEscape(entry.text)}</message>`,
    );
  }
  lines.push("</recent_history>");
  return lines.join("\n");
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
