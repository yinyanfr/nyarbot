interface HistoryEntry {
  uid: string;
  name: string;
  text: string;
  timestamp: number;
}

const MAX_HISTORY = 60;
const MAX_TEXT_LEN = 500;
const buffers = new Map<string, HistoryEntry[]>();

export function pushMessage(groupId: string, uid: string, name: string, text: string): void {
  if (!buffers.has(groupId)) {
    buffers.set(groupId, []);
  }
  const buffer = buffers.get(groupId)!;
  buffer.push({ uid, name, text: text.slice(0, MAX_TEXT_LEN), timestamp: Date.now() });
  while (buffer.length > MAX_HISTORY) {
    buffer.shift();
  }
}

export function getHistory(groupId: string): HistoryEntry[] {
  return buffers.get(groupId) ?? [];
}

export function formatHistoryAsContext(history: HistoryEntry[]): string {
  if (history.length === 0) return "";
  return history.map((entry) => `[${entry.name}]: ${entry.text}`).join("\n");
}

export function clearHistory(groupId: string): void {
  buffers.delete(groupId);
}
