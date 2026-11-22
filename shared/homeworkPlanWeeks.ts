import { dayKeyForTimezone, formatDueDate, shiftDayKey } from "./institutionDay";
import {
  isWeekEndDueDay,
  schoolWeekRange,
  thisSchoolWeekMonday,
  weekClosedNote,
  weekMondayKey,
  type WeekClosure,
} from "./homeworkWeek";
import { openUntilDayKey, splitOpenFromClass } from "./openUntil";
import { weekTripNote, type FieldTripSummary } from "./fieldTrips";

/**
 * The parent Homework tab (TRA-581): a child's homework plan for one month,
 * week by week, the way a teacher's hand-made calendar for families reads.
 * Each school week of the month is a subheading ("This week · Nov 9–13",
 * "Next week · Nov 16–20", "Nov 23–27") over that week's items, with one
 * quiet line for its no-school days and one for the child's field trips.
 *
 * Open-until work is not under the weeks: it is one list right after this
 * week (or the month's first week when this week isn't shown), headed
 * "Open from class" like the child's own section (TRA-724), soonest closing
 * first, each with its "Open until Saturday, Nov 14" line.
 *
 * The plan shows what was planned and when, never whether it is done or late
 * (TRA-574). The due phrase follows the "this week" display rule
 * (shared/homeworkWeek.ts), relative to today like the scholar's chip: work
 * due on the last school day of this week or next reads "Due this week" /
 * "Due next week"; any other day is named in full ("Due Wednesday"); today
 * and tomorrow say so.
 *
 * Pure, so web and Convex share it (no Convex or DOM imports).
 */

/** `openUntil`: open-until work (shared/openUntil.ts), placed by the day its
 *  window closes, where homework is placed by its due day. */
type PlanItem = { key: string; dueAt: number | null; openUntil?: number | null };

/** The day a plan item is placed on: the day its open-until window closes,
 *  else its due day; null for undated work. */
function planItemDayKey(
  item: Pick<PlanItem, "dueAt" | "openUntil">,
  timeZone: string,
): string | null {
  if (item.openUntil != null) return openUntilDayKey(item.openUntil, timeZone);
  if (item.dueAt != null) return dayKeyForTimezone(item.dueAt, timeZone);
  return null;
}

/** Which week a plan item falls in, relative to now, by the child's own week
 *  rule (shared/homeworkList.ts): weeks run Monday to Sunday, and on a
 *  Saturday or Sunday "this week" is the coming one. */
export type HomeworkPlanWeek =
  | "last week"
  | "this weekend"
  | "this week"
  | "next week"
  | "later";

/**
 * The week label the parent aide reads for each plan item (TRA-621), worked
 * out here because the model, left to do the date arithmetic, put Friday's
 * work in "next week". Null for undated work.
 *
 * Before this week's Monday there are two cases. On a weekend, work due today
 * or tomorrow sits before the coming Monday, and the child's list leads with
 * it as "This weekend". Anything earlier is last week: the plan's window
 * (`homeworkPlanWindowStart`) starts at last week's Monday, so nothing older
 * reaches here.
 */
export function homeworkPlanWeek(
  item: Pick<PlanItem, "dueAt" | "openUntil">,
  nowMs: number,
  timeZone: string,
): HomeworkPlanWeek | null {
  const dayKey = planItemDayKey(item, timeZone);
  if (dayKey == null) return null;
  const thisMonday = thisSchoolWeekMonday(nowMs, timeZone);
  if (dayKey < thisMonday) {
    return dayKey >= dayKeyForTimezone(nowMs, timeZone) ? "this weekend" : "last week";
  }
  const monday = weekMondayKey(dayKey);
  if (monday === thisMonday) return "this week";
  if (monday === shiftDayKey(thisMonday, 7)) return "next week";
  return "later";
}

/** The first day the plan shows by default: last week's Monday. A dated item
 *  due before it, or an undated item given before it, has left the plan. The
 *  server applies the same window, or an earlier `fromDayKey` when the
 *  calendar shows an earlier month. */
export function homeworkPlanWindowStart(nowMs: number, timeZone: string): string {
  return shiftDayKey(thisSchoolWeekMonday(nowMs, timeZone), -7);
}

/** "2026-11" for the month the calendar opens on: the month of this week's
 *  Monday. On a weekend "this week" is the coming one, so Sunday, Feb 28
 *  opens on March, where Monday's week is. */
export function homeworkMonthKeyFor(nowMs: number, timeZone: string): string {
  return thisSchoolWeekMonday(nowMs, timeZone).slice(0, 7);
}

/** `monthKey` moved by `months` ("2026-11", 2 → "2027-01"). */
export function shiftMonthKey(monthKey: string, months: number): string {
  const [year, month] = monthKey.split("-").map(Number);
  const index = year * 12 + (month - 1) + months;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

function lastDayOfMonth(monthKey: string): string {
  return shiftDayKey(`${shiftMonthKey(monthKey, 1)}-01`, -1);
}

/** The Mondays of the month's school weeks: every week with a weekday in the
 *  month. */
function monthMondays(monthKey: string): string[] {
  const first = `${monthKey}-01`;
  const last = lastDayOfMonth(monthKey);
  const mondays: string[] = [];
  for (
    let monday = weekMondayKey(first);
    monday <= last;
    monday = shiftDayKey(monday, 7)
  ) {
    if (shiftDayKey(monday, 4) >= first) mondays.push(monday);
  }
  return mondays;
}

/** The first day a month's calendar needs from the server: the Monday of
 *  the week holding the 1st. When the month opens on a weekend that week has
 *  no weekday in the month, but work due (or closing) on the 1st or 2nd
 *  still lives in it, so the read starts there. */
export function homeworkMonthFirstDay(monthKey: string): string {
  return weekMondayKey(`${monthKey}-01`);
}

export type HomeworkMonthEntry<T> = {
  item: T;
  /** "Due this week", "Due next week", "Due Wednesday", "Due today",
   *  "Open until Saturday, Nov 14". */
  when: string;
};

export type HomeworkMonthWeek<T> = {
  mondayKey: string;
  /** "This week · Nov 9–13", "Next week · Nov 16–20", "Nov 23–27". */
  heading: string;
  isThisWeek: boolean;
  /** "No school Wednesday (Veterans Day)", or null. */
  closedNote: string | null;
  /** "Field trip Tuesday 9:00–12:00 (Kualoa Ranch)", or null (TRA-601). */
  tripNote: string | null;
  entries: Array<HomeworkMonthEntry<T>>;
  /** What an empty week says: "Not posted yet." ahead, "No homework." now
   *  or before. */
  emptyText: string;
};

export type HomeworkMonth<T> = {
  monthKey: string;
  /** "November 2026". */
  title: string;
  weeks: Array<HomeworkMonthWeek<T>>;
  /** Work with no date, listed after the weeks. The server keeps only what was
   *  given inside the plan's window. */
  undated: T[];
  /** Open-until work still open (closing today or later) whose window closes
   *  in one of the month's weeks, soonest
   *  closing first, drawn under "Open from class" after `openFromClassAfter`
   *  (TRA-724).
   *  Its `when` names the date too ("Open until Saturday, Nov 14"), since no
   *  week heading sits above it. */
  openFromClass: Array<HomeworkMonthEntry<T>>;
  /** The week Open from class is drawn right after: this week when the month
   *  shows it, else the month's first week (another month, browsed). */
  openFromClassAfter: string;
};

const weekdayLong = (dayKey: string) =>
  new Date(`${dayKey}T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "long",
  });

/** The plain due phrase a family reads under a week heading. */
export function homeworkPlanWhen(
  item: PlanItem,
  dayKey: string,
  todayKey: string,
  thisMonday: string,
  closures: readonly WeekClosure[],
): string {
  if (item.openUntil != null) {
    const date = new Date(`${dayKey}T12:00:00Z`).toLocaleDateString("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
    });
    return `Open until ${weekdayLong(dayKey)}, ${date}`;
  }
  if (dayKey === todayKey) return "Due today";
  if (dayKey < todayKey) {
    // A day already past keeps its full date, the wording the scholar's chip
    // uses (`formatDueDate`), so "Due Monday" can't pass for the coming
    // Monday. A plain date, never a status. Day keys are formatted as UTC
    // noon so the date is the key's own, whatever the school's zone.
    const noon = (key: string) => Date.parse(`${key}T12:00:00Z`);
    return `Was due ${formatDueDate(noon(dayKey), noon(todayKey), "UTC")}`;
  }
  if (dayKey === shiftDayKey(todayKey, 1)) return "Due tomorrow";
  if (isWeekEndDueDay(dayKey, closures)) {
    // Relative to today, like the scholar's chip; any other week names the
    // day, since "this week" under "Nov 23–27" would mean the wrong week.
    const monday = weekMondayKey(dayKey);
    if (monday === thisMonday) return "Due this week";
    if (monday === shiftDayKey(thisMonday, 7)) return "Due next week";
  }
  return `Due ${weekdayLong(dayKey)}`;
}

export function buildHomeworkMonth<T extends PlanItem>(
  items: readonly T[],
  closures: readonly WeekClosure[],
  {
    monthKey,
    nowMs,
    timeZone,
    trips = [],
  }: {
    monthKey: string;
    nowMs: number;
    timeZone: string;
    /** The child's field trips. A trip day is still a school day, so trips
     *  never move a due phrase; they only add the week's trip line. */
    trips?: readonly FieldTripSummary[];
  },
): HomeworkMonth<T> {
  const todayKey = dayKeyForTimezone(nowMs, timeZone);
  const thisMonday = thisSchoolWeekMonday(nowMs, timeZone);
  const nextMonday = shiftDayKey(thisMonday, 7);
  const byWeek = new Map<string, Array<{ item: T; dayKey: string; at: number }>>();
  const undated: T[] = [];
  const { due, openFromClass } = splitOpenFromClass(items);
  for (const item of due) {
    const dayKey = planItemDayKey(item, timeZone);
    if (dayKey == null) {
      undated.push(item);
      continue;
    }
    const monday = weekMondayKey(dayKey);
    const bucket = byWeek.get(monday) ?? [];
    bucket.push({ item, dayKey, at: item.dueAt ?? item.openUntil ?? 0 });
    byWeek.set(monday, bucket);
  }

  // A month that opens on a Saturday or Sunday: the week holding the 1st has
  // no weekday in the month, so it is shown only when work in it is dated
  // in the month (due on, or open until, that weekend).
  const firstKey = `${monthKey}-01`;
  const openingMonday = weekMondayKey(firstKey);
  const mondays = monthMondays(monthKey);
  if (
    mondays[0] !== openingMonday &&
    (byWeek.get(openingMonday) ?? []).some(({ dayKey }) => dayKey >= firstKey)
  ) {
    mondays.unshift(openingMonday);
  }
  const weeks = mondays.map((mondayKey) => {
    const range = schoolWeekRange(mondayKey, todayKey);
    const heading =
      mondayKey === thisMonday
        ? `This week · ${range}`
        : mondayKey === nextMonday
          ? `Next week · ${range}`
          : range;
    return {
      mondayKey,
      heading,
      isThisWeek: mondayKey === thisMonday,
      closedNote: weekClosedNote(mondayKey, closures),
      tripNote: weekTripNote(mondayKey, trips),
      entries: (byWeek.get(mondayKey) ?? [])
        .sort((a, b) => a.at - b.at)
        .map(({ item, dayKey }) => ({
          item,
          when: homeworkPlanWhen(item, dayKey, todayKey, thisMonday, closures),
        })),
      emptyText: mondayKey > thisMonday ? "Not posted yet." : "No homework.",
    };
  });
  const title = new Date(`${monthKey}-15T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  });
  // The same month rule as the weeks: a window closing in one of the month's
  // weeks, or on the weekend the month opens on.
  const shownMondays = new Set(mondays);
  // Only windows still open (closing today or later): a closed one is no
  // longer open from class, so the parent tab doesn't show it.
  const openEntries = openFromClass.flatMap((item) => {
    const dayKey = planItemDayKey(item, timeZone)!;
    if (dayKey < todayKey) return [];
    const monday = weekMondayKey(dayKey);
    return shownMondays.has(monday) ||
      (monday === openingMonday && dayKey >= firstKey)
      ? [{ item, when: homeworkPlanWhen(item, dayKey, todayKey, thisMonday, closures) }]
      : [];
  });
  const openFromClassAfter =
    weeks.find((week) => week.isThisWeek)?.mondayKey ?? weeks[0].mondayKey;
  return {
    monthKey,
    title,
    weeks,
    undated,
    openFromClass: openEntries,
    openFromClassAfter,
  };
}
