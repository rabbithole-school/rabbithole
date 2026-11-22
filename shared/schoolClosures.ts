// Pure helpers for school closures (no-school days) — shared by the Convex
// materializer / read surfaces and the web + native schedule UIs. No Convex or
// DOM imports so it stays trivially unit-testable and importable from both
// runtimes (see shared/schoolClosures.test.ts).
//
// A closure covers an inclusive range of institution-local "YYYY-MM-DD" day
// keys. Because those keys sort lexicographically the same way they sort
// chronologically, a "is this day closed?" test is a pure string range compare
// — DST-safe, no timezone offset math. See convex/schema.ts `schoolClosures`.

import { dayKeyForTimezone, shiftDayKey, weekdayForDayKey } from "./institutionDay";

export type SchoolClosureKind = "holiday" | "staffOnly";

/** The minimal closure shape the pure helpers need (a subset of the row). */
export type SchoolClosure = {
  startDayKey: string; // "YYYY-MM-DD", inclusive
  endDayKey: string; // "YYYY-MM-DD", inclusive (== start for a single day)
  label: string;
  kind: SchoolClosureKind;
};

const DAY_MS = 86_400_000;

/**
 * The closure covering `dayKey`, or null if that day is open. Tolerates a
 * start/end stored in either order. If several closures overlap a day, the
 * first match wins (seed data never overlaps in practice).
 */
export function isClosedDay(
  dayKey: string,
  closures: readonly SchoolClosure[],
): SchoolClosure | null {
  for (const closure of closures) {
    const lo =
      closure.startDayKey <= closure.endDayKey
        ? closure.startDayKey
        : closure.endDayKey;
    const hi =
      closure.startDayKey <= closure.endDayKey
        ? closure.endDayKey
        : closure.startDayKey;
    if (dayKey >= lo && dayKey <= hi) return closure;
  }
  return null;
}

/**
 * The institution-local day key for weekday N (1=Mon … 7=Sun) of the week whose
 * Monday 00:00 (institution-local) is `weekStartMs`. Sampled at local midday so
 * it never lands on a day boundary, then formatted in `timeZone`.
 */
export function dayKeyForWeekday(
  weekStartMs: number,
  weekday: number,
  timeZone: string,
): string {
  const sample = weekStartMs + (weekday - 1) * DAY_MS + DAY_MS / 2;
  return dayKeyForTimezone(sample, timeZone);
}

/**
 * Map each weekday (1–5, Mon–Fri) of a concrete week to the closure that
 * covers it, if any. The grid + "today" surfaces use this to draw a
 * "No School" band per closed column. Weekend columns are intentionally
 * omitted (the timetable renders Mon–Fri).
 */
export function closuresForWeek(
  weekStartMs: number,
  timeZone: string,
  closures: readonly SchoolClosure[],
): Map<number, SchoolClosure> {
  const byWeekday = new Map<number, SchoolClosure>();
  for (let weekday = 1; weekday <= 5; weekday++) {
    const dayKey = dayKeyForWeekday(weekStartMs, weekday, timeZone);
    const closure = isClosedDay(dayKey, closures);
    if (closure) byWeekday.set(weekday, closure);
  }
  return byWeekday;
}

/**
 * Whether scholars have school on an institution-local day key: a weekday
 * with no closure. A closure is named even on a weekend ("Winter Break" says
 * more than "a weekend"). Day keys are already local, so no timezone is needed.
 */
export type SchoolDayStatus =
  | { schoolDay: true }
  | { schoolDay: false; reason: "closure"; closure: SchoolClosure }
  | { schoolDay: false; reason: "weekend" };

export function schoolDayStatus(
  dayKey: string,
  closures: readonly SchoolClosure[],
): SchoolDayStatus {
  const closure = isClosedDay(dayKey, closures);
  if (closure) return { schoolDay: false, reason: "closure", closure };
  const weekday = weekdayForDayKey(dayKey);
  if (weekday === 0 || weekday === 6) return { schoolDay: false, reason: "weekend" };
  return { schoolDay: true };
}

/** "Wed, Nov 11" for a day key. */
export function shortDayLabel(dayKey: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${dayKey}T12:00:00.000Z`));
}

/**
 * One sentence saying why a day isn't a school day, or null when it is:
 * "Wed, Nov 11 is a no-school day (Veterans Day)." / "Sat, Nov 14 is a
 * weekend." The give form and the aide's give reply both use it.
 */
export function nonSchoolDayNote(
  dayKey: string,
  closures: readonly SchoolClosure[],
): string | null {
  const status = schoolDayStatus(dayKey, closures);
  if (status.schoolDay) return null;
  return status.reason === "closure"
    ? `${shortDayLabel(dayKey)} is a no-school day (${status.closure.label}).`
    : `${shortDayLabel(dayKey)} is a weekend.`;
}

/**
 * The next `count` school days strictly after `dayKey`, ascending. A closed
 * candidate jumps past the whole closure, so closures of any length are
 * honored; `maxCalendarDays` optionally bounds how far ahead to look.
 */
export function schoolDayKeysAfter(
  dayKey: string,
  closures: readonly SchoolClosure[],
  count: number,
  opts?: { maxCalendarDays?: number },
): string[] {
  const out: string[] = [];
  const lastCandidate =
    opts?.maxCalendarDays != null ? shiftDayKey(dayKey, opts.maxCalendarDays) : null;
  let candidate = shiftDayKey(dayKey, 1);
  // A termination guard for a hypothetically always-closed institution.
  for (let i = 0; i < 5000 && out.length < count; i += 1) {
    if (lastCandidate != null && candidate > lastCandidate) break;
    const status = schoolDayStatus(candidate, closures);
    if (status.schoolDay) {
      out.push(candidate);
      candidate = shiftDayKey(candidate, 1);
    } else if (status.reason === "closure") {
      // `endDayKey` is inclusive; resume the day after it (or after the
      // candidate when the row is stored end-before-start).
      const end = status.closure.endDayKey;
      candidate = shiftDayKey(end >= candidate ? end : candidate, 1);
    } else {
      candidate = shiftDayKey(candidate, 1);
    }
  }
  return out;
}
