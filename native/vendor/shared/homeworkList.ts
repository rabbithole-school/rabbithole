import { dayKeyForTimezone, dueStatus, shiftDayKey } from "./institutionDay";
import {
  schoolWeekRange,
  thisSchoolWeekMonday,
  weekMondayKey,
  type WeekClosure,
} from "./homeworkWeek";
import { splitOpenFromClass } from "./openUntil";

/**
 * The scholar's Homework section on the Now tab (TRA-581): one surface,
 * split by quiet subheadings, in this order:
 *
 *   [This weekend] → This week (Nov 9–13) → Late → Next week (Nov 16–20) →
 *   Later → No date
 *
 * On a Saturday or Sunday "this week" is the coming one (shared/
 * homeworkWeek.ts), so work due that weekend can't sit under its range: it
 * leads the section as "This weekend", where its chip says due today or due
 * tomorrow.
 *
 * A subheading is left out when its group is empty, so the common week (one
 * homework item) reads "Homework → This week → one row". Every live,
 * not-finished homework item from every teacher is on it exactly once, from
 * the moment it is live until the scholar finishes it; the only filter is
 * `completedByMe`. Open-until work is not homework: it has its own section,
 * "Open from class" (`buildOpenFromClass`, TRA-724), drawn above this one.
 *
 * Next week and Later rows are forecasts: the scholar sees what's coming
 * without being asked to start it yet. A row there still opens when there is
 * something to open — work already started (Continue) — see
 * `homeworkRowCta`. Closures feed only the
 * due phrase ("due this week"), never a row of their own.
 *
 * Shared by web (app/scholar/page.tsx) and native (native/src/app/index.tsx).
 */

type HomeworkListEntry = {
  dueAt?: number | null;
  /** Open-until work (shared/openUntil.ts): when its window closes. It is in
   *  "Open from class", never Homework, and is gone once it closes. */
  openUntil?: number | null;
  completedByMe?: boolean;
  /** Finished work the scholar chose "Keep working on this" for: resumable,
   *  but not owed (scholarPlate.ts `isReopenedComplete`). Never Late: a past
   *  due date puts it in This week, with no late chip. */
  isReopenedComplete?: boolean;
};

export type HomeworkSectionKind =
  | "weekend"
  | "thisWeek"
  | "late"
  | "nextWeek"
  | "later"
  | "undated"
  | "openFromClass";

export type HomeworkSection<T> = {
  key: HomeworkSectionKind;
  kind: HomeworkSectionKind;
  /** "This weekend", "This week", "Late", "Next week", "Later", "No date";
   *  null for Open from class's one list, which has no subheading. */
  heading: string | null;
  /** "Nov 9–13" for This week and Next week, else null. */
  range: string | null;
  /** False for Next week and Later: forecast rows (see `homeworkRowCta`). */
  actionable: boolean;
  items: T[];
};

export type HomeworkWeek<T> = {
  /** Only the non-empty sections, in reading order. */
  sections: Array<HomeworkSection<T>>;
  isEmpty: boolean;
};

const SECTIONS: Array<{
  kind: HomeworkSectionKind;
  heading: string;
  actionable: boolean;
}> = [
  { kind: "weekend", heading: "This weekend", actionable: true },
  { kind: "thisWeek", heading: "This week", actionable: true },
  { kind: "late", heading: "Late", actionable: true },
  { kind: "nextWeek", heading: "Next week", actionable: false },
  { kind: "later", heading: "Later", actionable: false },
  { kind: "undated", heading: "No date", actionable: true },
];

export function buildHomeworkWeek<T extends HomeworkListEntry>(
  homework: T[],
  { nowMs, timeZone }: { nowMs: number; timeZone: string },
): HomeworkWeek<T> {
  const todayKey = dayKeyForTimezone(nowMs, timeZone);
  const thisMonday = thisSchoolWeekMonday(nowMs, timeZone);
  const nextMonday = shiftDayKey(thisMonday, 7);
  const weekday = new Date(`${todayKey}T12:00:00Z`).getUTCDay();
  const isWeekend = weekday === 0 || weekday === 6;
  const buckets: Record<HomeworkSectionKind, T[]> = {
    weekend: [],
    thisWeek: [],
    late: [],
    nextWeek: [],
    later: [],
    undated: [],
    openFromClass: [],
  };
  const byWeek = (dayKey: string) => {
    // This weekend's own due days (today or tomorrow on a Sat/Sun): ahead
    // of the coming week, never under its range.
    if (isWeekend && dayKey >= todayKey && dayKey < thisMonday) {
      return buckets.weekend;
    }
    const monday = weekMondayKey(dayKey);
    if (monday <= thisMonday) return buckets.thisWeek;
    if (monday === nextMonday) return buckets.nextWeek;
    return buckets.later;
  };

  for (const item of splitOpenFromClass(homework).due) {
    if (item.completedByMe) continue;
    if (item.dueAt == null) {
      buckets.undated.push(item);
      continue;
    }
    if (
      !item.isReopenedComplete &&
      dueStatus(item.dueAt, nowMs, timeZone)?.status === "overdue"
    ) {
      buckets.late.push(item);
      continue;
    }
    byWeek(dayKeyForTimezone(item.dueAt, timeZone)).push(item);
  }

  const byDue = (a: T, b: T) => (a.dueAt ?? 0) - (b.dueAt ?? 0);
  const sections = SECTIONS.filter(({ kind }) => buckets[kind].length > 0).map(
    ({ kind, heading, actionable }) => ({
      key: kind,
      kind,
      heading,
      range:
        kind === "thisWeek"
          ? schoolWeekRange(thisMonday, todayKey)
          : kind === "nextWeek"
            ? schoolWeekRange(nextMonday, todayKey)
            : null,
      actionable,
      items: kind === "undated" ? buckets[kind] : buckets[kind].sort(byDue),
    }),
  );
  return { sections, isEmpty: sections.length === 0 };
}

/**
 * The "Open from class" section (TRA-724): open-until work whose window is
 * open, not finished, soonest closing first, as one list with no subheading.
 * Each row keeps the homework row's shape and its "Open until Fri" pill. The
 * plate lists only work that is live, so every row here is open now and
 * keeps its CTA (`homeworkRowCta`). Empty when there is none, and then the
 * section is not drawn.
 */
function buildOpenFromClass<T extends HomeworkListEntry>(
  rows: T[],
  nowMs: number,
): HomeworkWeek<T> {
  const items = splitOpenFromClass(rows).openFromClass.filter(
    (row) => !row.completedByMe && row.openUntil! > nowMs,
  );
  const sections: Array<HomeworkSection<T>> =
    items.length === 0
      ? []
      : [
          {
            key: "openFromClass",
            kind: "openFromClass",
            heading: null,
            range: null,
            actionable: true,
            items,
          },
        ];
  return { sections, isEmpty: sections.length === 0 };
}

/**
 * A tab's list: the Open from class section and the Homework section, from
 * the same rows (`yourListRowsForTab`), plus whether both are empty. That
 * `isEmpty` is the list's half of the quiet-day check ("Your day is clear"),
 * so open-until work alone keeps the clear-day state away.
 *
 * Shared by web (app/scholar/page.tsx) and native (native/src/app/index.tsx).
 */
export function buildYourList<T extends HomeworkListEntry>(
  rows: T[],
  { nowMs, timeZone }: { nowMs: number; timeZone: string },
): { openFromClass: HomeworkWeek<T>; homework: HomeworkWeek<T>; isEmpty: boolean } {
  const openFromClass = buildOpenFromClass(rows, nowMs);
  const homework = buildHomeworkWeek(rows, { nowMs, timeZone });
  return {
    openFromClass,
    homework,
    isEmpty: openFromClass.isEmpty && homework.isEmpty,
  };
}

/**
 * Whether a homework row shows its DueChip. Open-until rows carry their own
 * pill instead, undated rows have nothing to show, and finished work the
 * scholar reopened is never late, so once its date has passed it shows no
 * chip at all rather than a loud "was due" one.
 */
export function showsHomeworkDueChip(
  row: HomeworkListEntry,
  nowMs: number,
  timeZone: string,
): boolean {
  if (row.openUntil != null || row.dueAt == null) return false;
  if (!row.isReopenedComplete) return true;
  return dueStatus(row.dueAt, nowMs, timeZone)?.status !== "overdue";
}

export type HomeworkCta = "Start" | "Continue" | "Open";

/**
 * The CTA a homework row shows, or null for a row with nothing to open yet.
 * Offline work opens its read-only page ("Open"); started work — any row
 * with a session, even one opened with nothing sent yet (the plate reports
 * those as `notStarted` with a real `sessionId`) — says "Continue", as the
 * plate does; anything else "Start". In a forecast
 * section (Next week, Later) a row keeps its CTA only when there is
 * something to open now — work already started, or open-until work whose
 * window is open — so moving a started item into Next week never takes the
 * scholar's way back into it away.
 */
export function homeworkRowCta(
  row: { notStarted?: boolean; sessionId?: string | null; openUntil?: number | null },
  { isOffline, forecast, nowMs }: { isOffline: boolean; forecast: boolean; nowMs: number },
): HomeworkCta | null {
  const started = row.sessionId != null || row.notStarted === false;
  const openNow = row.openUntil != null && row.openUntil > nowMs;
  if (forecast && !started && !openNow) return null;
  if (isOffline) return "Open";
  return started ? "Continue" : "Start";
}

/**
 * Whether a row opens as an offline activity's read-only page (the "Open"
 * CTA, sessions.openOfflineHomework) instead of a session: offline homework,
 * and offline work given "Open until a date" (TRA-739). Offline work given
 * "In that class" is the teacher's to run in the room and has no row.
 * Web (components/HomeworkSection.tsx) and native (useRowAction) both ask.
 */
export function opensOfflinePage(row: {
  activityKind?: string | null;
  origin?: string | null;
  openUntil?: number | null;
}): boolean {
  return (
    row.activityKind === "offline" &&
    (row.origin === "homework" || row.openUntil != null)
  );
}

export const HOMEWORK_SECTION_HEADING = "Homework";

/** Closures for the "this week" phrase, from `currentDayForScholar`. */
export type HomeworkClosures = readonly WeekClosure[] | undefined;

/** The row's secondary line: "Science · with Ms. Rivera · away from the
 *  BunnyPad", the scholar activity row's "unit · with Teacher" attribution. */
export function homeworkListRowMeta({
  subject,
  teacherName,
  isOffline,
}: {
  subject: string | null | undefined;
  teacherName: string | null | undefined;
  isOffline: boolean;
}): string {
  return [
    subject?.trim() || null,
    teacherName?.trim() ? `with ${teacherName.trim()}` : null,
    isOffline ? "away from the BunnyPad" : null,
  ]
    .filter((part): part is string => !!part)
    .join(" · ");
}
