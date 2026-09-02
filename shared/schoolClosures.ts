// Pure helpers for school closures (no-school days) — shared by the Convex
// materializer / read surfaces and the web + native schedule UIs. No Convex or
// DOM imports so it stays trivially unit-testable and importable from both
// runtimes (see shared/schoolClosures.test.ts).
//
// A closure covers an inclusive range of institution-local "YYYY-MM-DD" day
// keys. Because those keys sort lexicographically the same way they sort
// chronologically, a "is this day closed?" test is a pure string range compare
// — DST-safe, no timezone offset math. See convex/schema.ts `schoolClosures`.

import { dayKeyForTimezone } from "./institutionDay";

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
