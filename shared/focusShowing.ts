import { dayKeyForTimezone } from "./institutionDay";

type FocusShowingEntry = {
  setAt?: number | null;
  endsAt?: number | null;
};

export function isFocusShowing(
  entry: FocusShowingEntry,
  nowMs: number,
  todayDayKey: string,
  timeZone: string,
): boolean {
  return (
    entry.setAt != null &&
    (dayKeyForTimezone(entry.setAt, timeZone) === todayDayKey ||
      (entry.endsAt != null && entry.endsAt > nowMs))
  );
}

/**
 * Is this schedule entry in front of scholars right now? A focus shows for
 * the rest of the day it was set (or until a later `endsAt`). Homework is
 * live from `setAt` until staff end it early — on homework `endsAt` means
 * "ended", never a window, so it must not take the focus rule.
 */
export function isScheduleEntryActive(
  entry: FocusShowingEntry & { mode: "classFocus" | "homework" },
  nowMs: number,
  todayDayKey: string,
  timeZone: string,
): boolean {
  return entry.mode === "classFocus"
    ? isFocusShowing(entry, nowMs, todayDayKey, timeZone)
    : entry.setAt != null && (entry.endsAt == null || entry.endsAt > nowMs);
}
