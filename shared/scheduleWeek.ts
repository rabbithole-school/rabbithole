// Pure school-week arithmetic, shared by the Convex materializer / read surfaces
// (convex/masterSchedule.ts) and the web schedule grid
// (components/MasterSchedule/MasterScheduleView.tsx). No Convex or DOM imports so
// it stays trivially unit-testable and importable from both runtimes.
//
// Why a SHARED helper: the backend STAMPS each placement's `weekStartMs` while
// the grid COMPARES against the week on screen. If either side derives the week
// in the host runtime's timezone, chips silently vanish or stack on the wrong
// week. Both sides route through these institution-local helpers instead.

import {
  DEFAULT_TIMEZONE,
  dayKeyForTimezone,
  dayStartForDayKey,
  instantForLocalMinutes,
  mondayDayKeyForTimezone,
  shiftDayKey,
} from "./institutionDay";

/**
 * Epoch-ms of Monday 00:00 institution-local for the week containing `ms`.
 * `ms` is any instant in that week — `Date.now()` on the backend, or the grid's
 * on-screen anchor day on the client.
 */
export function scheduleWeekStartMs(
  ms: number,
  timeZone = DEFAULT_TIMEZONE,
): number {
  return dayStartForDayKey(
    mondayDayKeyForTimezone(ms, 0, timeZone),
    timeZone,
  );
}

/** Shift a Monday anchor by whole institution-local calendar weeks. */
export function shiftScheduleWeekStartMs(
  weekStartMs: number,
  weekOffset: number,
  timeZone = DEFAULT_TIMEZONE,
): number {
  const mondayKey = dayKeyForTimezone(weekStartMs, timeZone);
  return dayStartForDayKey(
    shiftDayKey(mondayKey, weekOffset * 7),
    timeZone,
  );
}

/** Institution-local day key for weekday N (Monday=1) of an anchored week. */
export function scheduleWeekdayDayKey(
  weekStartMs: number,
  weekday: number,
  timeZone = DEFAULT_TIMEZONE,
): string {
  if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
    throw new RangeError(`Invalid weekday: ${weekday}`);
  }
  return shiftDayKey(
    dayKeyForTimezone(weekStartMs, timeZone),
    weekday - 1,
  );
}

/** Epoch-ms for a local wall-clock minute on a weekday of an anchored week. */
export function scheduleWeekdayTimeMs(
  weekStartMs: number,
  weekday: number,
  minutesSinceMidnight: number,
  timeZone = DEFAULT_TIMEZONE,
): number {
  return instantForLocalMinutes(
    scheduleWeekdayDayKey(weekStartMs, weekday, timeZone),
    minutesSinceMidnight,
    timeZone,
  );
}
