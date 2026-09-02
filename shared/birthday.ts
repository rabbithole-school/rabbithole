// One canonical "is it a birthday" derivation over `users.dateOfBirth`
// (stored as an ISO "YYYY-MM-DD" string). Every surface that marks a birthday
// — the teacher schedule, the teacher Today front door, and the scholar's own
// iPad home — reads these pure helpers; none re-implements the date math. A
// birthday is a MONTH+DAY fact evaluated against an institution day-key (the
// same "YYYY-MM-DD" the bell schedule already resolves per timezone), so
// "today" flips at the school's midnight, not UTC or device-local.

type DateParts = { year: number; month: number; day: number };

/** Parse an ISO "YYYY-MM-DD" (leading portion) into numeric parts, or null. */
function parseIsoDate(iso: string | null | undefined): DateParts | null {
  if (!iso || typeof iso !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || month < 1 || month > 12 || day < 1) {
    return null;
  }
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [
    31,
    isLeap ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (day > daysInMonth[month - 1]) return null;
  return { year, month, day };
}

/**
 * True when an ISO "YYYY-MM-DD" birthday falls on the given institution
 * day-key ("YYYY-MM-DD"), comparing MONTH + DAY only.
 *
 * TODO(feb29): a Feb-29 birthday simply won't match in a common (non-leap)
 * year — we deliberately do NOT fall back to Feb 28 or Mar 1. The current
 * roster has no Feb-29 scholars, so this keeps the code simple; revisit (pick an
 * observed day) if that ever changes.
 */
export function isBirthdayOnDayKey(
  dobIso: string | null | undefined,
  dayKey: string | null | undefined,
): boolean {
  const dob = parseIsoDate(dobIso);
  const day = parseIsoDate(dayKey);
  if (!dob || !day) return false;
  return dob.month === day.month && dob.day === day.day;
}

/**
 * The integer age a scholar turns ON the given day-key (their Nth birthday),
 * or null when it isn't their birthday, the DOB is malformed, or the age is
 * not a positive number (guards a future / same-year DOB).
 */
export function nthBirthdayOnDayKey(
  dobIso: string | null | undefined,
  dayKey: string | null | undefined,
): number | null {
  const dob = parseIsoDate(dobIso);
  const day = parseIsoDate(dayKey);
  if (!dob || !day) return null;
  if (dob.month !== day.month || dob.day !== day.day) return null;
  const age = day.year - dob.year;
  return age > 0 ? age : null;
}

/**
 * Integer chronological age on an institution-local day-key, or null for a
 * missing/malformed DOB or an implausible result.
 */
export function ageOnDayKey(
  dobIso: string | null | undefined,
  dayKey: string | null | undefined,
): number | null {
  const dob = parseIsoDate(dobIso);
  const day = parseIsoDate(dayKey);
  if (!dob || !day) return null;
  let age = day.year - dob.year;
  if (
    day.month < dob.month ||
    (day.month === dob.month && day.day < dob.day)
  ) {
    age -= 1;
  }
  return age >= 0 && age <= 120 ? age : null;
}

/** English ordinal for an integer: 1 → "1st", 2 → "2nd", 11 → "11th". */
export function ordinal(n: number): string {
  const value = Math.trunc(n);
  const tens = Math.abs(value) % 100;
  const ones = Math.abs(value) % 10;
  let suffix = "th";
  if (tens < 11 || tens > 13) {
    if (ones === 1) suffix = "st";
    else if (ones === 2) suffix = "nd";
    else if (ones === 3) suffix = "rd";
  }
  return `${value}${suffix}`;
}

/**
 * "11th Birthday"-style label for the age a scholar turns on the day-key, or
 * null when it isn't their birthday. Per Andy's decision we say "Nth Birthday"
 * rather than "Turns N".
 */
export function nthBirthdayLabel(
  dobIso: string | null | undefined,
  dayKey: string | null | undefined,
): string | null {
  const n = nthBirthdayOnDayKey(dobIso, dayKey);
  return n == null ? null : `${ordinal(n)} Birthday`;
}

/**
 * Add `n` whole days to an ISO "YYYY-MM-DD" day-key, returning a new
 * "YYYY-MM-DD". Pure calendar arithmetic at UTC midnight (no timezone drift) —
 * used to derive each weekday column's date from a week's Monday day-key so
 * the schedule can match a birthday to the right column.
 */
export function addDaysToDayKey(dayKey: string, n: number): string {
  const parsed = parseIsoDate(dayKey);
  if (!parsed) return dayKey;
  const ms =
    Date.UTC(parsed.year, parsed.month - 1, parsed.day) +
    n * 24 * 60 * 60 * 1000;
  const date = new Date(ms);
  const yyyy = date.getUTCFullYear().toString().padStart(4, "0");
  const mm = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = date.getUTCDate().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
