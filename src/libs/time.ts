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
