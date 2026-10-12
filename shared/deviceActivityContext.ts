// Pure derivation of the CONTEXT TAG stamped on every `deviceActivityEvents`
// row. No Convex or DOM imports, so both the server writer and any future
// re-derivation tool can share exactly one rule (see
// shared/deviceActivityContext.test.ts).
//
// The tag answers "which part of the school program was this device minute
// part of?", and it is derived on the SERVER at write time — never accepted
// from the client, and never re-derived at read time (a scholar's roster
// standing or the calendar can change months later, and a report of last
// October should not silently move).
//
// The four tags, and the ONLY inputs each is allowed to come from:
//
//   extended_ed — roster standing. A `program_guest` is enrolled in extended
//                 education and nothing else, so every minute they spend on a
//                 school iPad belongs to that program. Standing therefore wins
//                 outright rather than competing with the clock.
//   homework    — the homework flag on the scholar's active session. Homework
//                 is a property of the WORK, not of the hour: a homework
//                 activity worked at 10am is still homework.
//   core_day    — the enrolled scholar's ordinary school day: an open school
//                 day (not a weekend, not a `schoolClosures` row) inside the
//                 school-day wall-clock window.
//   unknown     — everything else, said out loud rather than guessed. An
//                 enrolled scholar on a closed day or outside school hours,
//                 with no homework session to attribute the time to, is a
//                 minute we genuinely cannot place.

export type DeviceActivityContext =
  | "core_day"
  | "extended_ed"
  | "homework"
  | "unknown";

export const DEVICE_ACTIVITY_CONTEXTS: readonly DeviceActivityContext[] = [
  "core_day",
  "extended_ed",
  "homework",
  "unknown",
] as const;

/** Wall-clock minutes-since-midnight span of a school day, end exclusive. */
export type SchoolDayWindow = { startMinute: number; endMinute: number };

/**
 * Used when an institution has no bell schedule for the day (a school that has
 * not built its Master Schedule yet, or a dev deployment). Deliberately wide
 * enough to cover an ordinary school day without pretending to precision:
 * a first cut, replaced by real `scheduleBlocks` the moment they exist.
 */
export const DEFAULT_SCHOOL_DAY_WINDOW: SchoolDayWindow = {
  startMinute: 8 * 60, // 08:00
  endMinute: 15 * 60, // 15:00
};

/** "08:30" → 510. Returns null for anything that is not a wall-clock time. */
export function minuteOfDayFromLocalTime(localTime: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(localTime.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/**
 * The school-day window implied by a term's bell schedule: earliest block
 * start to latest block end among the blocks that actually run on `weekday`
 * (1=Mon … 5=Fri, matching `scheduleBlocks.weekdays`).
 *
 * The virtual "homework" rail is excluded — it is a due-date band, not a
 * room-time slot, so it would otherwise stretch the day to nothing meaningful.
 * Returns null when no block runs that day, which the caller reads as "this
 * institution has no school-day window here" rather than as an empty day.
 */
export function schoolDayWindowFromBlocks(
  blocks: readonly {
    startLocal: string;
    endLocal: string;
    weekdays: readonly number[];
    kind?: string;
  }[],
  weekday: number,
): SchoolDayWindow | null {
  let startMinute = Number.POSITIVE_INFINITY;
  let endMinute = Number.NEGATIVE_INFINITY;
  for (const block of blocks) {
    if (block.kind === "homework") continue;
    if (!block.weekdays.includes(weekday)) continue;
    const start = minuteOfDayFromLocalTime(block.startLocal);
    const end = minuteOfDayFromLocalTime(block.endLocal);
    if (start === null || end === null || end <= start) continue;
    if (start < startMinute) startMinute = start;
    if (end > endMinute) endMinute = end;
  }
  if (!Number.isFinite(startMinute) || !Number.isFinite(endMinute)) return null;
  return { startMinute, endMinute };
}

export type DeviceActivityContextInput = {
  /** Roster standing of the scholar the device is signed in as. */
  enrollmentStanding: "enrolled" | "program_guest" | null | undefined;
  /**
   * Whether the scholar's active session is working a homework-mode activity.
   * `null` = not known (no recently active session), which is NOT the same as
   * "known to be classwork" — it simply removes homework from consideration.
   */
  isHomeworkSession: boolean | null | undefined;
  /** 1=Mon … 7=Sun, matching `scheduleBlocks.weekdays`. */
  weekday: number;
  /** True when a `schoolClosures` row covers this institution-local day. */
  isClosedDay: boolean;
  /** Institution-local minutes since midnight of the event. */
  minuteOfDay: number;
  /** Null when the institution has no bell schedule for this weekday. */
  schoolDayWindow: SchoolDayWindow | null;
};

/**
 * The one rule. Precedence is deliberate and is the part worth arguing about:
 *
 *   1. roster standing  (a program guest is only ever in extended education)
 *   2. homework flag    (a property of the work, independent of the clock)
 *   3. the clock        (open school day, inside the bell-schedule window)
 *   4. unknown          (said out loud instead of guessed)
 */
export function deriveDeviceActivityContext(
  input: DeviceActivityContextInput,
): DeviceActivityContext {
  if (input.enrollmentStanding === "program_guest") return "extended_ed";
  if (input.isHomeworkSession === true) return "homework";

  if (input.isClosedDay) return "unknown";
  if (input.weekday < 1 || input.weekday > 5) return "unknown";

  const window = input.schoolDayWindow;
  if (!window) return "unknown";
  if (
    input.minuteOfDay >= window.startMinute &&
    input.minuteOfDay < window.endMinute
  ) {
    return "core_day";
  }
  return "unknown";
}
