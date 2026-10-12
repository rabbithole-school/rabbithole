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
