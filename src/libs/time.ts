import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = "Asia/Shanghai";

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"] as const;

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
  const t = now();
  return `${t.format("YYYY年MM月DD日")} 周${WEEKDAYS[t.day()]} ${t.format("HH:mm")} (UTC+8)`;
}
