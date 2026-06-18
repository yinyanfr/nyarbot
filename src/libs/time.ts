import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import config from "../configs/env.js";

dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = config.appTimezone;

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"] as const;

export function isValidTimezone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function formatPromptTimeForTimezone(timeZone: string): string {
  const t = dayjs().tz(timeZone);
  const tzOffset = t.format("Z");
  return `${t.format("YYYY年MM月DD日")} 周${WEEKDAYS[t.day()]} ${t.format("HH:mm")} (${timeZone}, UTC${tzOffset})`;
}

export function dateStrForTimezone(tsMs: number, timeZone: string): string {
  return dayjs(tsMs).tz(timeZone).format("YYYY-MM-DD");
}

export function parseTimestampInputForTimezone(value: string, timeZone: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  // If the input already carries an explicit offset/Z, trust that absolute time.
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(trimmed)) {
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const zoned = dayjs.tz(trimmed, timeZone);
  return zoned.isValid() ? zoned.valueOf() : null;
}

export function formatTimestampInputForTimezone(
  value: string,
  timeZone: string,
  fmt = "YYYY-MM-DD HH:mm",
): string | null {
  const parsed = parseTimestampInputForTimezone(value, timeZone);
  if (parsed == null) return null;
  return dayjs(parsed).tz(timeZone).format(fmt);
}

export function now(): dayjs.Dayjs {
  return dayjs().tz(TZ);
}

export function nowMs(): number {
  return Date.now();
}

export function todayDateStr(): string {
  return now().format("YYYY-MM-DD");
}

export function yesterdayDateStr(): string {
  return now().subtract(1, "day").format("YYYY-MM-DD");
}

export function formatTimestamp(tsMs: number, fmt: string): string {
  return dayjs(tsMs).tz(TZ).format(fmt);
}

export function formatSystemPromptTime(): string {
  return formatPromptTimeForTimezone(TZ);
}

export function formatUserPromptTime(timeZone?: string): string | null {
  if (!timeZone) return null;
  if (!isValidTimezone(timeZone)) return null;
  return formatPromptTimeForTimezone(timeZone);
}
