const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(?:all|any|the|my|previous|above|prior)\s+(?:rules|instructions|prompts?|messages?|context)/i,
  /forget\s+(?:all|any|the|my|previous|above|prior)\s+(?:rules|instructions|prompts?|messages?|context)/i,
  /system\s*prompt/i,
  /developer\s*message/i,
  /you\s+are\s+now/i,
  /role\s*play/i,
  /output\s+only/i,
  /must\s+call\s+tool/i,
  /reveal\s+(?:your|the)\s+(?:prompt|instructions?)/i,
  /忽略.{0,8}(?:之前|前面|以上|所有).{0,8}(?:规则|指令|提示)/u,
  /忘掉.{0,8}(?:之前|前面|以上|所有).{0,8}(?:规则|指令|提示)/u,
  /系统提示|系统指令|开发者消息|越狱|提示词/u,
  /你现在是|从现在开始|扮演|角色设定|只输出/u,
  /<\/?[a-zA-Z][^>]*>/,
] as const;

function stripControlChars(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

export function truncateUnicode(text: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  const chars = Array.from(text);
  return chars.length > maxLen ? chars.slice(0, maxLen).join("") : text;
}

export function normalizePromptData(text: string, maxLen = 500): string {
  const normalized = stripControlChars(text).replace(/\r\n?/g, "\n").trim();
  if (!normalized) return "";
  return truncateUnicode(normalized, maxLen);
}

export function isPromptInjectionLike(text: string): boolean {
  const normalized = normalizePromptData(text, 2000);
  if (!normalized) return false;
  return PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function safePromptValue(
  text: string,
  options: { maxLen?: number; fallback?: string } = {},
): string {
  const normalized = normalizePromptData(text, options.maxLen ?? 500);
  if (!normalized) return options.fallback ?? "";
  if (isPromptInjectionLike(normalized)) return options.fallback ?? "[filtered suspicious content]";
  return normalized;
}

export function safePromptList(values: string[], maxLen = 200): string[] {
  return values.map((value) => safePromptValue(value, { maxLen })).filter(Boolean);
}

export function quoteAsUntrustedData(text: string, maxLen = 500): string {
  return JSON.stringify(normalizePromptData(text, maxLen));
}

export function prepareNicknameForStorage(nickname: string): string {
  return safePromptValue(nickname, { maxLen: 32, fallback: "" }).replace(/\s+/g, " ").trim();
}

export function prepareMemoryForStorage(memory: string): string {
  return safePromptValue(memory, { maxLen: 160, fallback: "" });
}

export function prepareDiaryNoteForStorage(note: string): string {
  return safePromptValue(note, { maxLen: 300, fallback: "" });
}
