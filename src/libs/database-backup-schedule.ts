import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezone);

export interface ParsedBackupSchedule {
  hour: number;
  minute: number;
}

export function parseBackupSchedule(value: string): ParsedBackupSchedule {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  const hour = Number(match?.[1]);
  const minute = Number(match?.[2]);
  if (!match || hour > 23 || minute > 59) {
    throw new Error("DATABASE_BACKUP_SCHEDULE must use 24-hour HH:mm format");
  }
  return { hour, minute };
}

function scheduledTime(
  date: string,
  schedule: ParsedBackupSchedule,
  timeZone: string,
): dayjs.Dayjs {
  return dayjs.tz(
    `${date} ${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}:00`,
    timeZone,
  );
}

export function getBackupScheduleState(
  nowMs: number,
  scheduleValue: string,
  timeZone: string,
  completedDate?: string,
): { dueDate: string | null; nextRunMs: number } {
  const schedule = parseBackupSchedule(scheduleValue);
  const current = dayjs(nowMs).tz(timeZone);
  const today = current.format("YYYY-MM-DD");
  const todayRun = scheduledTime(today, schedule, timeZone);
  const latestDueDate =
    current.valueOf() >= todayRun.valueOf()
      ? today
      : current.subtract(1, "day").format("YYYY-MM-DD");
  const dueDate = completedDate && completedDate >= latestDueDate ? null : latestDueDate;
  const nextDate =
    dueDate || current.valueOf() < todayRun.valueOf()
      ? today
      : current.add(1, "day").format("YYYY-MM-DD");
  return {
    dueDate,
    nextRunMs: dueDate ? nowMs : scheduledTime(nextDate, schedule, timeZone).valueOf(),
  };
}
