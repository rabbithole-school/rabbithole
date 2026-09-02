import {
  DEFAULT_TIMEZONE,
  dayKeyForTimezone,
  mondayDayKeyForTimezone,
} from "../../shared/institutionDay";

export const DEFAULT_BLOCK_RUN_LIMIT = 3;
export const DEFAULT_WEEK_RUN_LIMIT = 12;

function localHour(now: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(now));
  return Number(parts.find((part) => part.type === "hour")?.value);
}

export function budgetWindowKeys(
  now: number,
  assignmentId: string | undefined,
  timeZone = DEFAULT_TIMEZONE,
) {
  const hour = localHour(now, timeZone);
  const date = dayKeyForTimezone(now, timeZone);
  const week = mondayDayKeyForTimezone(now, 0, timeZone);
  const scope = assignmentId ?? "unassigned";
  // Unscheduled Worlds use deterministic two-hour institution-local windows. A
  // future schedule-block id can replace this fallback without changing the ledger.
  return {
    blockKey: `${scope}:${date}:block-${Math.floor(hour / 2)}`,
    weekKey: `${scope}:week-${week}`,
  };
}
