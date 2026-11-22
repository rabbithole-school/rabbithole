/**
 * Bedtime — Rabbithole sleeps from 8:00 pm to 6:00 am, school-local time,
 * every night. School is important; sleep is more important.
 *
 * The one home for the window and its copy. Web (`components/BedtimeGate.tsx`)
 * and native (`native/src/components/BedtimeGate.tsx`) both derive their state
 * from `bedtimeStateAt` against the client's own clock, so neither needs a
 * reactive server read of the time (T11: the server only says WHICH zone, via
 * `users.currentUser.bedtimeTimeZone`; the clock lives on the device).
 *
 * Who it applies to is decided server-side in `convex/lib/bedtime.ts`.
 *
 * A parent may set their own child's bedtime (TRA-625): one nightly window per
 * child, stored in `scholarBedtimes`, and only ever STRICTER than the school's
 * (an earlier start, a later wake). The server sends the child's window next
 * to the zone; a client too old to read it keeps the school's window, which
 * is the safe direction.
 */
import {
  dayKeyForTimezone,
  instantForLocalMinutes,
  minuteOfDayForTimezone,
  shiftDayKey,
} from "./institutionDay";

/** 20:00 local — the screen goes to sleep. */
export const BEDTIME_START_MINUTES = 20 * 60;
/** 06:00 local — Rabbithole wakes up. */
export const BEDTIME_END_MINUTES = 6 * 60;
/** A nightly window in minutes past local midnight: asleep from
 *  `startMinutes` (evening) until `endMinutes` the next morning. */
export type BedtimeWindow = { startMinutes: number; endMinutes: number };

/** The school's window, the one every child gets unless a parent sets a
 *  stricter one. */
export const SCHOOL_BEDTIME: BedtimeWindow = {
  startMinutes: BEDTIME_START_MINUTES,
  endMinutes: BEDTIME_END_MINUTES,
};

// The range a parent may choose from. Product bounds, not calibrated
// thresholds: no earlier than 6 pm (after the school day and dinner), and a
// wake no later than 8 am, the first bell (convex/teacherToday.ts), so the
// BunnyPad is awake for a school morning. Five-minute steps, because a
// parent asked for 7:50am and was refused (2026-11-18).
/** 18:00 — the earliest bedtime a parent can choose. */
export const EARLIEST_FAMILY_BEDTIME_MINUTES = 18 * 60;
/** 08:00 — the latest wake a parent can choose. */
export const LATEST_FAMILY_WAKE_MINUTES = 8 * 60;
/** Times move in five-minute steps. */
export const FAMILY_BEDTIME_STEP_MINUTES = 5;

/** Why a parent's window can't be used, or null when it can. The window is
 *  never looser than the school's. */
export function familyBedtimeProblem(window: BedtimeWindow): string | null {
  const { startMinutes, endMinutes } = window;
  const onStep = (m: number) =>
    Number.isInteger(m) && m % FAMILY_BEDTIME_STEP_MINUTES === 0;
  if (!onStep(startMinutes) || !onStep(endMinutes)) {
    return `Bedtime and wake-up times go in steps of ${FAMILY_BEDTIME_STEP_MINUTES} minutes.`;
  }
  if (
    startMinutes < EARLIEST_FAMILY_BEDTIME_MINUTES ||
    startMinutes > BEDTIME_START_MINUTES
  ) {
    return `Bedtime can be between ${clockWords(EARLIEST_FAMILY_BEDTIME_MINUTES)} and ${clockWords(BEDTIME_START_MINUTES)}.`;
  }
  if (
    endMinutes < BEDTIME_END_MINUTES ||
    endMinutes > LATEST_FAMILY_WAKE_MINUTES
  ) {
    return `Wake-up can be between ${clockWords(BEDTIME_END_MINUTES)} and ${clockWords(LATEST_FAMILY_WAKE_MINUTES)}.`;
  }
  return null;
}

/** Whether a window is the school's own. */
export function isSchoolBedtime(window: BedtimeWindow): boolean {
  return (
    window.startMinutes === BEDTIME_START_MINUTES &&
    window.endMinutes === BEDTIME_END_MINUTES
  );
}

/** The heads-up banner appears this long before bedtime. */
export const BEDTIME_WARNING_MS = 5 * 60 * 1000;

export type BedtimeState =
  | { phase: "awake"; changesAt: number }
  | { phase: "warning"; sleepsAt: number; changesAt: number }
  | { phase: "asleep"; wakesAt: number; changesAt: number };

/**
 * Where the night stands at `nowMs` in `timeZone`. `changesAt` is the next
 * instant the phase flips, so a caller can arm one timer instead of ticking.
 */
export function bedtimeStateAt(
  nowMs: number,
  timeZone: string,
  window: BedtimeWindow = SCHOOL_BEDTIME,
): BedtimeState {
  const { startMinutes, endMinutes } = window;
  const today = dayKeyForTimezone(nowMs, timeZone);
  const minute = minuteOfDayForTimezone(nowMs, timeZone);

  if (minute < endMinutes) {
    const wakesAt = instantForLocalMinutes(today, endMinutes, timeZone);
    return { phase: "asleep", wakesAt, changesAt: wakesAt };
  }
  if (minute >= startMinutes) {
    const wakesAt = instantForLocalMinutes(
      shiftDayKey(today, 1),
      endMinutes,
      timeZone,
    );
    return { phase: "asleep", wakesAt, changesAt: wakesAt };
  }

  const sleepsAt = instantForLocalMinutes(today, startMinutes, timeZone);
  const warnsAt = sleepsAt - BEDTIME_WARNING_MS;
  return nowMs >= warnsAt
    ? { phase: "warning", sleepsAt, changesAt: sleepsAt }
    : { phase: "awake", changesAt: warnsAt };
}

/** "6:00 am" / "8:00 pm" in the school's zone. */
export function formatBedtimeClock(atMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  })
    .format(new Date(atMs))
    .replace(/\s?AM$/i, " am")
    .replace(/\s?PM$/i, " pm");
}

/** "8pm" from minutes past midnight; minutes shown only when not on the hour. */
function clockWords(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  const tail = minute === 0 ? "" : `:${String(minute).padStart(2, "0")}`;
  return `${hour12}${tail}${hour < 12 ? "am" : "pm"}`;
}

/** "8pm to 6am": the nightly window in words, for copy that tells a parent
 *  when the BunnyPad sleeps (the SMS intro, the parent aide, the portal and
 *  the scholar profile), so the copy can't drift from the window the gate
 *  enforces. Defaults to the school's window. */
export function bedtimeWindowText(window: BedtimeWindow = SCHOOL_BEDTIME): string {
  return `${clockWords(window.startMinutes)} to ${clockWords(window.endMinutes)}`;
}

/** "Bedtime between 6pm and 8pm and wake-up between 6am and 8am, in steps
 *  of 5 minutes": the range a parent may choose, for the parent aide's
 *  prompt and tool description, so they can't drift from the check. */
export function familyBedtimeRangeText(): string {
  return `bedtime between ${clockWords(EARLIEST_FAMILY_BEDTIME_MINUTES)} and ${clockWords(BEDTIME_START_MINUTES)} and wake-up between ${clockWords(BEDTIME_END_MINUTES)} and ${clockWords(LATEST_FAMILY_WAKE_MINUTES)}, in steps of ${FAMILY_BEDTIME_STEP_MINUTES} minutes`;
}

/** "7:30pm": one end of a window in words, for pickers. */
export function bedtimeClockText(minutes: number): string {
  return clockWords(minutes);
}

export const BEDTIME_HEADLINE = "Rabbithole is asleep";

export function bedtimeSubline(wakesAt: number, timeZone: string): string {
  return `Sleep helps your brain keep everything you learned today. See you at ${formatBedtimeClock(wakesAt, timeZone)}!`;
}

export function bedtimeWarningText(sleepsAt: number, timeZone: string): string {
  return `Rabbithole goes to sleep at ${formatBedtimeClock(sleepsAt, timeZone)} — time to finish up what you're doing.`;
}
