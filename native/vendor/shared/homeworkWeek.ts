import {
  dayKeyForTimezone,
  dueStatus,
  shiftDayKey,
  weekdayForDayKey,
} from "./institutionDay";

/**
 * Homework by the school week (TRA-581): the week primitives the scholar's
 * Homework section, the parent Homework tab, the session header and the "this
 * week" display rule share.
 *
 * A week runs Monday to Sunday; its school days are Mon–Fri minus the
 * school's closures. On a Saturday or Sunday the school week that just
 * ended is over, so "this week" means the coming one: a kid or parent looking
 * on Sunday night means Monday's week.
 *
 * **"This week" is a display rule, not a kind of due date.** Due dates stay
 * day-precise. A due date that falls on its week's LAST SCHOOL DAY reads as
 * "this week" (or "next week"); a holiday Friday makes Thursday the last
 * school day, so Thursday-due work reads that way too.
 *
 * Pure, so web, native (vendored) and Convex share it.
 */

/** A no-school range of institution-local day keys, inclusive. */
export type WeekClosure = {
  startDayKey: string;
  endDayKey: string;
  label: string;
};

/** The Monday of `dayKey`'s week (weeks run Monday to Sunday). */
export function weekMondayKey(dayKey: string): string {
  return shiftDayKey(dayKey, -((weekdayForDayKey(dayKey) + 6) % 7));
}

/** The Monday of "this week": the week containing today, or on a weekend the
 *  coming one. */
export function thisSchoolWeekMonday(nowMs: number, timeZone: string): string {
  return schoolWeekMondayForDayKey(dayKeyForTimezone(nowMs, timeZone));
}

/** `thisSchoolWeekMonday` from a school-local day key ("today"). */
export function schoolWeekMondayForDayKey(todayKey: string): string {
  const weekday = weekdayForDayKey(todayKey);
  const monday = weekMondayKey(todayKey);
  return weekday === 0 || weekday === 6 ? shiftDayKey(monday, 7) : monday;
}

/** The closure covering `dayKey`, or null on an open day. */
export function closureOn(
  dayKey: string,
  closures: readonly WeekClosure[],
): WeekClosure | null {
  return (
    closures.find((c) => c.startDayKey <= dayKey && c.endDayKey >= dayKey) ??
    null
  );
}

/** The week's last school day (Friday unless closed, then Thursday, …), or
 *  null when the whole week is closed. */
export function lastSchoolDayOfWeek(
  mondayKey: string,
  closures: readonly WeekClosure[],
): string | null {
  for (let offset = 4; offset >= 0; offset -= 1) {
    const dayKey = shiftDayKey(mondayKey, offset);
    if (!closureOn(dayKey, closures)) return dayKey;
  }
  return null;
}

/** Whether `dayKey` is its week's last school day: the day "this week"
 *  homework is due. */
export function isWeekEndDueDay(
  dayKey: string,
  closures: readonly WeekClosure[],
): boolean {
  return lastSchoolDayOfWeek(weekMondayKey(dayKey), closures) === dayKey;
}

/** "Nov 2–6", "Oct 30–Nov 3", with the year when it isn't this year's. */
export function schoolWeekRange(mondayKey: string, todayKey: string): string {
  const part = (dayKey: string) => {
    const date = new Date(`${dayKey}T12:00:00Z`);
    return {
      month: date.toLocaleDateString("en-US", { timeZone: "UTC", month: "short" }),
      day: date.getUTCDate(),
      year: dayKey.slice(0, 4),
    };
  };
  const start = part(mondayKey);
  const end = part(shiftDayKey(mondayKey, 4));
  const range =
    start.month === end.month
      ? `${start.month} ${start.day}–${end.day}`
      : `${start.month} ${start.day}–${end.month} ${end.day}`;
  return end.year === todayKey.slice(0, 4) ? range : `${range}, ${end.year}`;
}

const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"] as const;

/** One quiet line for a week's no-school days, for families:
 *  "No school Wednesday (Veterans Day)",
 *  "No school Thursday–Friday (Thanksgiving Break)". Null when the week has
 *  none. Consecutive days with the same closure join into one run. */
export function weekClosedNote(
  mondayKey: string,
  closures: readonly WeekClosure[],
): string | null {
  const runs: Array<{ from: number; to: number; label: string }> = [];
  for (let offset = 0; offset < 5; offset += 1) {
    const label = closureOn(shiftDayKey(mondayKey, offset), closures)?.label;
    if (!label) continue;
    const last = runs[runs.length - 1];
    if (last && last.to === offset - 1 && last.label === label) last.to = offset;
    else runs.push({ from: offset, to: offset, label });
  }
  if (runs.length === 0) return null;
  return `No school ${runs
    .map((run) => {
      const days =
        run.from === run.to
          ? WEEKDAY_NAMES[run.from]
          : `${WEEKDAY_NAMES[run.from]}–${WEEKDAY_NAMES[run.to]}`;
      return `${days} (${run.label})`;
    })
    .join(", ")}`;
}

const WEEKDAY_LONG = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/**
 * `dueStatus()` with the kid's week wording applied (TRA-581). Only the
 * phrase changes, and only for upcoming work due in this week or next week,
 * which the Homework section shows under their own subheadings:
 *
 *   - the day itself: "due today"; the day before: "due tomorrow";
 *   - the week's last school day: "due this week" / "due next week"
 *     (needs `closures`, since a holiday Friday moves it to Thursday);
 *   - any other day: the weekday name, "due Thursday", "due Monday".
 *
 * Late work keeps its exact date ("was due Sat, Nov 7"), and work further
 * out keeps the full date ("due Fri, Nov 27"). Without `closures` the
 * last-school-day rule is skipped (a surface that doesn't know the calendar
 * never guesses a Friday) and that day reads by its weekday name.
 */
export function homeworkDueStatus(
  dueAt: number | null | undefined,
  nowMs: number,
  timeZone: string,
  closures: readonly WeekClosure[] | undefined,
): ReturnType<typeof dueStatus> {
  const due = dueStatus(dueAt, nowMs, timeZone);
  if (!due || due.status !== "upcoming" || dueAt == null) return due;
  const dueKey = dayKeyForTimezone(dueAt, timeZone);
  const tomorrowKey = shiftDayKey(dayKeyForTimezone(nowMs, timeZone), 1);
  if (dueKey === tomorrowKey) return due;
  const thisMonday = thisSchoolWeekMonday(nowMs, timeZone);
  const dueMonday = weekMondayKey(dueKey);
  const isThisWeek = dueMonday === thisMonday;
  const isNextWeek = dueMonday === shiftDayKey(thisMonday, 7);
  if (!isThisWeek && !isNextWeek) return due;
  if (closures && isWeekEndDueDay(dueKey, closures)) {
    return { ...due, phrase: isThisWeek ? "due this week" : "due next week" };
  }
  return { ...due, phrase: `due ${WEEKDAY_LONG[weekdayForDayKey(dueKey)]}` };
}

/** The closures that touch `dayKey`'s school week (Mon–Fri): all a due date
 *  needs for the "this week" rule. Lets a read hand each homework row only
 *  its own week's closures. */
export function closuresInWeekOf<T extends WeekClosure>(
  dayKey: string,
  closures: readonly T[],
): T[] {
  const monday = weekMondayKey(dayKey);
  const friday = shiftDayKey(monday, 4);
  return closures.filter((c) => c.startDayKey <= friday && c.endDayKey >= monday);
}

/** The first school day of a week (Monday unless closed, then Tuesday, …),
 *  or null when the whole week is closed. */
export function firstSchoolDayOfWeek(
  mondayKey: string,
  closures: readonly WeekClosure[],
): string | null {
  for (let offset = 0; offset <= 4; offset += 1) {
    const dayKey = shiftDayKey(mondayKey, offset);
    if (!closureOn(dayKey, closures)) return dayKey;
  }
  return null;
}

/** A school week as homework uses it: it shows up on the first school day
 *  and is due at the end of the last one. */
export type HomeworkWeekWindow = {
  mondayKey: string;
  showsUpDayKey: string;
  dueDayKey: string;
};

/** The homework window of the week starting `mondayKey`, or null when the
 *  school is closed all week. */
export function homeworkWeekWindow(
  mondayKey: string,
  closures: readonly WeekClosure[],
): HomeworkWeekWindow | null {
  const showsUpDayKey = firstSchoolDayOfWeek(mondayKey, closures);
  const dueDayKey = lastSchoolDayOfWeek(mondayKey, closures);
  return showsUpDayKey && dueDayKey ? { mondayKey, showsUpDayKey, dueDayKey } : null;
}

/** The Monday of next school week: the week after "this week". On a
 *  Saturday or Sunday "this week" is already the coming one, so "next week"
 *  is the week after it, the same reading the scholar and the give form use. */
export function nextSchoolWeekMonday(nowMs: number, timeZone: string): string {
  return shiftDayKey(thisSchoolWeekMonday(nowMs, timeZone), 7);
}

/** The day "due this week" means for work showing up on `startDayKey`: the
 *  last school day of that week, or of the following week when it shows up
 *  on a weekend or after that day. Null when neither week has a school day. */
export function weekEndDueDayFor(
  startDayKey: string,
  closures: readonly WeekClosure[],
): string | null {
  const monday = weekMondayKey(startDayKey);
  const thisWeek = lastSchoolDayOfWeek(monday, closures);
  if (thisWeek && thisWeek >= startDayKey) return thisWeek;
  return lastSchoolDayOfWeek(shiftDayKey(monday, 7), closures);
}
