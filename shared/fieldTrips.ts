// Field trips (TRA-601): pure helpers shared by Convex, web and native
// (vendored). A trip is its own record (convex/schema.ts `fieldTrips`): some
// groups leave school for part of one day. It is not a closure. School is
// open, the trip's groups miss only the classes that overlap its window, and
// every other group's day is untouched.
//
// Times are institution-local wall clock ("09:00"), like scheduleBlocks, so a
// trip and a class block compare in the same units and a DST change never
// moves a trip.

import { instantForLocalMinutes, weekdayForDayKey, shiftDayKey } from "./institutionDay";

/** The fields of a trip these helpers read. */
export type FieldTripWindow = {
  dayKey: string; // "YYYY-MM-DD", institution-local
  startLocal: string; // "09:00"
  endLocal: string; // "12:00"
};

export type FieldTripSummary = FieldTripWindow & { destination: string };

const HHMM = /^(\d{2}):(\d{2})$/;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** Minutes after local midnight for "HH:MM", or null. */
function tripMinutes(local: string): number | null {
  const match = HHMM.exec(local.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Why a trip's day and times can't be saved, worded for staff, or null. */
export function tripTimesProblem(trip: FieldTripWindow): string | null {
  const day = trip.dayKey.trim();
  const parsed = new Date(`${day}T00:00:00Z`);
  if (
    !DAY_KEY.test(day) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== day
  ) {
    return "Pick the day of the trip.";
  }
  const start = tripMinutes(trip.startLocal);
  const end = tripMinutes(trip.endLocal);
  if (start == null || end == null) return "Use times like 09:00.";
  if (end <= start) return "The trip has to end after it starts.";
  return null;
}

/** The trip's window as instants, or null when its times don't parse (or fall
 *  in a DST gap). */
function tripWindowAt(
  trip: FieldTripWindow,
  timeZone: string,
): { startsAt: number; endsAt: number } | null {
  const start = tripMinutes(trip.startLocal);
  const end = tripMinutes(trip.endLocal);
  if (start == null || end == null || end <= start) return null;
  try {
    return {
      startsAt: instantForLocalMinutes(trip.dayKey, start, timeZone),
      endsAt: instantForLocalMinutes(trip.dayKey, end, timeZone),
    };
  } catch {
    return null;
  }
}

/** Whether the trip's window overlaps [startsAt, endsAt): a class meeting
 *  that overlaps it at all doesn't meet. */
export function tripOverlaps(
  trip: FieldTripWindow,
  timeZone: string,
  startsAt: number,
  endsAt: number,
): boolean {
  const window = tripWindowAt(trip, timeZone);
  return !!window && window.startsAt < endsAt && startsAt < window.endsAt;
}

/** Whether `at` falls inside the trip's window. */
export function tripContains(trip: FieldTripWindow, timeZone: string, at: number): boolean {
  const window = tripWindowAt(trip, timeZone);
  return !!window && window.startsAt <= at && at < window.endsAt;
}

function clock(local: string): string {
  const minutes = tripMinutes(local);
  if (minutes == null) return local;
  const hour24 = Math.floor(minutes / 60);
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${String(minutes % 60).padStart(2, "0")}`;
}

/** "9:00–12:00" */
export function tripTimeRange(trip: Pick<FieldTripWindow, "startLocal" | "endLocal">): string {
  return `${clock(trip.startLocal)}–${clock(trip.endLocal)}`;
}

/** The scholar Home banner for a trip today, web and native alike:
 *  "Field trip today" over "Kualoa Ranch · 9:00–12:00". */
export const FIELD_TRIP_TODAY = "Field trip today";

export function fieldTripDetail(trip: Omit<FieldTripSummary, "dayKey">): string {
  return `${trip.destination} · ${tripTimeRange(trip)}`;
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** One quiet line for a week's trips, for families, beside the no-school
 *  line: "Field trip Tuesday 9:00–12:00 (Kualoa Ranch)". Null when the week
 *  (Mon–Sun) has none. */
export function weekTripNote(
  mondayKey: string,
  trips: readonly FieldTripSummary[],
): string | null {
  const sunday = shiftDayKey(mondayKey, 6);
  const inWeek = trips
    .filter((trip) => trip.dayKey >= mondayKey && trip.dayKey <= sunday)
    .sort((a, b) => a.dayKey.localeCompare(b.dayKey) || a.startLocal.localeCompare(b.startLocal));
  if (inWeek.length === 0) return null;
  return inWeek
    .map((trip, index) =>
      `${index === 0 ? "Field trip" : "field trip"} ${WEEKDAY_NAMES[weekdayForDayKey(trip.dayKey)]} ${tripTimeRange(trip)} (${trip.destination})`,
    )
    .join(", ");
}
