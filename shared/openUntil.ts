import {
  dayKeyForTimezone,
  daysBetweenDayKeys,
  formatDueDate,
} from "./institutionDay";

/**
 * "Open until a date" (Finish → "Open until Sat"): work that stays available
 * until the end of a day, then leaves the scholar's list whether or not they
 * finished. It is never late.
 *
 * It is stored as a class focus whose `endsAt` is the end of that day
 * (convex/lib/giveWindow.ts). TRA-726 gives it its own stored timing kind,
 * `openUntil`, beside `focus`, `untilCleared` and `homework`. Until every row
 * carries that kind, this is the ONE test that tells it apart from "In that
 * class": a row stored as `openUntil` is open-until; any other class focus is
 * read by the date guess (an in-class give ends on the school day it starts,
 * its bell block or the end of that day; an open-until give ends on a later
 * day). Every surface asks this helper, never its own heuristic. The guess is
 * retired once writers store the kind and old rows are backfilled (TRA-726).
 *
 * The start is when it went live (`setAt`), or for planned work when it will
 * (`startsAt`). An end at exactly local midnight belongs to the day before,
 * so a block that runs to midnight is still "in that class".
 *
 * Pure, so Convex, web and native share it.
 */

type WindowEntry = {
  mode: "classFocus" | "homework";
  setAt?: number | null;
  startsAt?: number | null;
  endsAt?: number | null;
  /**
   * True when the row is stored with the `openUntil` timing kind (TRA-726).
   * Readers that hold the row pass it; absent, the date guess decides.
   */
  openUntilKind?: boolean | null;
};

export function isOpenUntil(entry: WindowEntry, timeZone: string): boolean {
  if (entry.mode !== "classFocus" || entry.endsAt == null) return false;
  if (entry.openUntilKind === true) return true;
  return isOpenUntilByDate(entry, timeZone);
}

/**
 * The date guess alone: the end falls on a later school-local day than the
 * start. Only `isOpenUntil` and the TRA-726 backfill and write-side kind
 * keeping read it directly; every surface asks `isOpenUntil`.
 */
export function isOpenUntilByDate(
  entry: Omit<WindowEntry, "openUntilKind">,
  timeZone: string,
): boolean {
  if (entry.mode !== "classFocus" || entry.endsAt == null) return false;
  const start = entry.setAt ?? entry.startsAt;
  if (start == null) return false;
  return (
    dayKeyForTimezone(entry.endsAt - 1, timeZone) >
    dayKeyForTimezone(start, timeZone)
  );
}

/**
 * Work the scholar does on their own time: homework, or an open-until give.
 * An "In that class" give is led by the teacher in the room. Offline work of
 * the first kind opens as a read-only page the scholar can mark done
 * (scholarPlate.ts `unstartedAssignedRowSurface`, sessions.openOfflineHomework,
 * activityCompletions.ts `resolveScholarHomework`).
 */
export function isOnOwnTime(entry: WindowEntry, timeZone: string): boolean {
  return entry.mode === "homework" || isOpenUntil(entry, timeZone);
}

/** When an open-until window closes, or null for any other entry. */
export function openUntilClosesAt(
  entry: WindowEntry,
  timeZone: string,
): number | null {
  return isOpenUntil(entry, timeZone) ? entry.endsAt! : null;
}

/** The institution-local day an open-until window closes on. */
export function openUntilDayKey(closesAt: number, timeZone: string): string {
  return dayKeyForTimezone(closesAt - 1, timeZone);
}

function dayKeyLabel(
  dayKey: string,
  options: Intl.DateTimeFormatOptions,
): string {
  // A day key is a calendar date: read it in UTC so it never slips a day.
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...options }).format(
    new Date(`${dayKey}T12:00:00Z`),
  );
}

/**
 * "Open until Sat", the weekday alone. For a surface that cannot read the
 * clock (a Convex query); the client then words it with `openUntilPhrase`.
 */
export function openUntilWeekdayPhrase(
  closesAt: number,
  timeZone: string,
): string {
  return `Open until ${dayKeyLabel(openUntilDayKey(closesAt, timeZone), { weekday: "short" })}`;
}

/**
 * The scholar's and teacher's pill: "Open until Fri" while the closing day is
 * within the coming week (0 to 6 school-local days from today), and
 * "Open until Tue, Nov 24" from seven days out, where a bare weekday would
 * read as today. Days are counted between local day keys, never as 168-hour
 * blocks. `nowMs` is the caller's clock value; this never reads the clock.
 */
export function openUntilPhrase(
  closesAt: number,
  timeZone: string,
  nowMs: number,
): string {
  const closeDay = openUntilDayKey(closesAt, timeZone);
  const daysOut = daysBetweenDayKeys(dayKeyForTimezone(nowMs, timeZone), closeDay);
  if (daysOut < 7) return openUntilWeekdayPhrase(closesAt, timeZone);
  return `Open until ${formatDueDate(closesAt - 1, nowMs, timeZone)}`;
}

/** "Open until Sat, Nov 14", where the parent plan shows a due date. */
export function openUntilDateLabel(closesAt: number, timeZone: string): string {
  return `Open until ${dayKeyLabel(openUntilDayKey(closesAt, timeZone), {
    weekday: "short",
    month: "short",
    day: "numeric",
  })}`;
}

/** "Closed Sat", the Run page's word for a window that has ended. */
export function openUntilClosedLabel(closesAt: number, timeZone: string): string {
  return `Closed ${dayKeyLabel(openUntilDayKey(closesAt, timeZone), { weekday: "short" })}`;
}

/**
 * The Run page's line for an open-until window that has closed: "Closed Sat ·
 * 4 of 6 finished", counted over the scholars the give reached (its
 * `scholarIds`, or the whole roster). Null while open, or for other entries.
 * Who didn't finish is one click away in the row's existing progress drill-in.
 */
export function openUntilClosedLine(
  entry: WindowEntry & { scholarIds?: readonly string[] | null },
  args: {
    rosterIds: readonly string[];
    completedScholarIds: readonly string[];
    nowMs: number;
    timeZone: string;
  },
): string | null {
  const closesAt = openUntilClosesAt(entry, args.timeZone);
  if (closesAt == null || closesAt > args.nowMs) return null;
  const audience = entry.scholarIds?.length
    ? entry.scholarIds.map(String)
    : args.rosterIds.map(String);
  const done = new Set(args.completedScholarIds.map(String));
  const finished = audience.filter((id) => done.has(id)).length;
  return `${openUntilClosedLabel(closesAt, args.timeZone)} · ${finished} of ${audience.length} finished`;
}

/**
 * The scholar's and the parent's section for open-until work (TRA-724).
 * Teachers give it for classwork that runs across several class meetings, so
 * it has its own section instead of sitting under Homework: on the scholar's
 * Now and subject tabs between the class section and Homework, and on the
 * parent Homework tab below the dated work.
 */
export const OPEN_FROM_CLASS_HEADING = "Open from class";

/**
 * The one split between "Homework" and "Open from class", used by the scholar
 * list (shared/homeworkList.ts, web and native) and the parent plan
 * (shared/homeworkPlanWeeks.ts): a row with an open-until window goes to
 * `openFromClass`, everything else (dated or undated homework) to `due`.
 * `openFromClass` is ordered soonest closing first; `due` keeps input order.
 */
export function splitOpenFromClass<T extends { openUntil?: number | null }>(
  items: readonly T[],
): { due: T[]; openFromClass: T[] } {
  const due: T[] = [];
  const openFromClass: T[] = [];
  for (const item of items) {
    (item.openUntil != null ? openFromClass : due).push(item);
  }
  openFromClass.sort((a, b) => a.openUntil! - b.openUntil!);
  return { due, openFromClass };
}
