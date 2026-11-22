/** Default calendar for institutions that predate per-school time zones. */
// Deployment configuration — see DEPLOYMENT.md (Default time zone).
export const DEFAULT_TIMEZONE = "Pacific/Honolulu";

const SEARCH_MARGIN_MS = 48 * 60 * 60 * 1000;

const dayFormatters = new Map<string, Intl.DateTimeFormat>();
const timeFormatters = new Map<string, Intl.DateTimeFormat>();

function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = dayFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dayFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function timeFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = timeFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    timeFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function partNumber(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): number {
  const value = parts.find((part) => part.type === type)?.value;
  if (value === undefined) {
    throw new Error(`Intl formatter omitted ${type}`);
  }
  return Number(value);
}

function parseDayKey(dayKey: string): {
  year: number;
  month: number;
  day: number;
} {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) throw new RangeError(`Invalid day key: ${dayKey}`);
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const canonical = new Date(Date.UTC(year, month - 1, day))
    .toISOString()
    .slice(0, 10);
  if (canonical !== dayKey) throw new RangeError(`Invalid day key: ${dayKey}`);
  return { year, month, day };
}

/** True for a real IANA timezone string (validated by the host Intl runtime). */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || typeof timeZone !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** "YYYY-MM-DD" for an instant in an IANA timezone. */
export function dayKeyForTimezone(
  nowMs: number,
  timeZone = DEFAULT_TIMEZONE,
): string {
  const parts = dayFormatter(timeZone).formatToParts(new Date(nowMs));
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Shift an institution-local day key by whole calendar days. */
export function shiftDayKey(dayKey: string, days: number): string {
  const { year, month, day } = parseDayKey(dayKey);
  return new Date(Date.UTC(year, month - 1, day + days))
    .toISOString()
    .slice(0, 10);
}

/** 0=Sun … 6=Sat for an institution-local day key. */
export function weekdayForDayKey(dayKey: string): number {
  const { year, month, day } = parseDayKey(dayKey);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Whether two institution-local days fall in the same Monday–Sunday week. */
export function dayKeysShareCalendarWeek(
  firstDayKey: string,
  secondDayKey: string,
): boolean {
  const weekStart = (dayKey: string) =>
    shiftDayKey(dayKey, -((weekdayForDayKey(dayKey) + 6) % 7));
  return weekStart(firstDayKey) === weekStart(secondDayKey);
}

/** 0=Sun … 6=Sat for the local day containing an instant. */
export function weekdayForTimezone(
  nowMs: number,
  timeZone = DEFAULT_TIMEZONE,
): number {
  return weekdayForDayKey(dayKeyForTimezone(nowMs, timeZone));
}

/** 0–1439 for the wall-clock minute containing an instant in an IANA timezone. */
export function minuteOfDayForTimezone(
  nowMs: number,
  timeZone = DEFAULT_TIMEZONE,
): number {
  const parts = timeFormatter(timeZone).formatToParts(new Date(nowMs));
  return partNumber(parts, "hour") * 60 + partNumber(parts, "minute");
}

/**
 * First millisecond of a named local day. Searching for the day-key boundary
 * avoids assuming a fixed UTC offset and handles 23- and 25-hour days.
 */
export function dayStartForDayKey(
  dayKey: string,
  timeZone = DEFAULT_TIMEZONE,
): number {
  const { year, month, day } = parseDayKey(dayKey);
  const nominalUtc = Date.UTC(year, month - 1, day);
  let before = nominalUtc - SEARCH_MARGIN_MS;
  let withinOrAfter = nominalUtc + SEARCH_MARGIN_MS;

  while (withinOrAfter - before > 1) {
    const midpoint = Math.floor((before + withinOrAfter) / 2);
    if (dayKeyForTimezone(midpoint, timeZone) < dayKey) {
      before = midpoint;
    } else {
      withinOrAfter = midpoint;
    }
  }
  if (dayKeyForTimezone(withinOrAfter, timeZone) !== dayKey) {
    throw new RangeError(`${dayKey} does not exist in ${timeZone}`);
  }
  return withinOrAfter;
}

/** Last millisecond of a named local day (handles 23- and 25-hour days). */
export function dayEndForDayKey(
  dayKey: string,
  timeZone = DEFAULT_TIMEZONE,
): number {
  return dayStartForDayKey(shiftDayKey(dayKey, 1), timeZone) - 1;
}

/**
 * First millisecond of the local day containing an instant.
 */
export function dayStartForTimezone(
  nowMs: number,
  timeZone = DEFAULT_TIMEZONE,
): number {
  return dayStartForDayKey(dayKeyForTimezone(nowMs, timeZone), timeZone);
}

/** Shift a local day boundary by whole calendar days, preserving local midnight. */
export function shiftDayStartForTimezone(
  dayStartMs: number,
  days: number,
  timeZone = DEFAULT_TIMEZONE,
): number {
  const shiftedKey = shiftDayKey(
    dayKeyForTimezone(dayStartMs, timeZone),
    days,
  );
  return dayStartForDayKey(shiftedKey, timeZone);
}

/**
 * Epoch-ms for a wall-clock minute on a named local day. Ambiguous fall-back
 * times resolve to the earlier occurrence; nonexistent spring-forward times
 * throw instead of silently moving the schedule.
 */
export function instantForLocalMinutes(
  dayKey: string,
  minutesSinceMidnight: number,
  timeZone = DEFAULT_TIMEZONE,
): number {
  if (
    !Number.isInteger(minutesSinceMidnight) ||
    minutesSinceMidnight < 0 ||
    minutesSinceMidnight >= 24 * 60
  ) {
    throw new RangeError(
      `Invalid minutes since midnight: ${minutesSinceMidnight}`,
    );
  }
  const { year, month, day } = parseDayKey(dayKey);
  const hour = Math.floor(minutesSinceMidnight / 60);
  const minute = minutesSinceMidnight % 60;
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = targetAsUtc;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = timeFormatter(timeZone).formatToParts(new Date(candidate));
    const observedAsUtc = Date.UTC(
      partNumber(parts, "year"),
      partNumber(parts, "month") - 1,
      partNumber(parts, "day"),
      partNumber(parts, "hour"),
      partNumber(parts, "minute"),
    );
    const correction = targetAsUtc - observedAsUtc;
    if (correction === 0) return candidate;
    candidate += correction;
  }
  throw new RangeError(
    `${dayKey} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} does not exist in ${timeZone}`,
  );
}

/** Monday day key for the institution-local week containing an instant. */
export function mondayDayKeyForTimezone(
  nowMs: number,
  weekOffset = 0,
  timeZone = DEFAULT_TIMEZONE,
): string {
  const dayKey = dayKeyForTimezone(nowMs, timeZone);
  const daysSinceMonday = (weekdayForDayKey(dayKey) + 6) % 7;
  return shiftDayKey(dayKey, -daysSinceMonday + weekOffset * 7);
}

/** Milliseconds until the next local day, with a small post-midnight cushion. */
export function millisecondsUntilNextDay(
  nowMs: number,
  timeZone = DEFAULT_TIMEZONE,
): number {
  const dayKey = dayKeyForTimezone(nowMs, timeZone);
  const nextDayStart = dayStartForDayKey(shiftDayKey(dayKey, 1), timeZone);
  return Math.max(1_000, nextDayStart - nowMs + 1_000);
}

export type InstitutionDay = {
  timeZone: string;
  dayKey: string;
  dayStart: number;
};

export function institutionDayAt(
  nowMs: number,
  timeZone = DEFAULT_TIMEZONE,
): InstitutionDay {
  return {
    timeZone,
    dayKey: dayKeyForTimezone(nowMs, timeZone),
    dayStart: dayStartForTimezone(nowMs, timeZone),
  };
}

/**
 * The one due-date format: weekday + month + day, "Thu, Nov 5", with the year
 * appended only when it differs from the current institution year
 * ("Tue, Jan 5, 2027"). Every scholar-facing due date goes through this, so a
 * late item can never read as a bare weekday that looks like this week.
 */
export function formatDueDate(
  dueAt: number,
  nowMs: number,
  timeZone: string,
): string {
  const sameYear =
    dayKeyForTimezone(dueAt, timeZone).slice(0, 4) ===
    dayKeyForTimezone(nowMs, timeZone).slice(0, 4);
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(new Date(dueAt));
}

/** Whole calendar days from `fromDayKey` to `toDayKey` (negative = earlier). */
export function daysBetweenDayKeys(fromDayKey: string, toDayKey: string): number {
  const from = parseDayKey(fromDayKey);
  const to = parseDayKey(toDayKey);
  return Math.round(
    (Date.UTC(to.year, to.month - 1, to.day) -
      Date.UTC(from.year, from.month - 1, from.day)) /
      86_400_000,
  );
}

/**
 * The relative day heading a scholar reads over a group of work, shared by
 * the Homework section (verb "due") and "Coming up" (verb "starts"). Calendar days in
 * the institution's time zone, counted between day keys:
 *
 *   today            "Due today"
 *   tomorrow         "Due tomorrow"
 *   2 to 6 days out  "Due Wednesday · in 3 days"
 *   7+ days out      "Due Mon, Nov 23 · in 15 days" (year added when it differs)
 *   an earlier day   "Was due Sat, Nov 7" / "Started Sat, Nov 7"
 *
 * The weekday stands alone only inside the next six days, where it can name
 * one day; the count after it says which. Further out the date uses the same
 * form as the "was due Sat, Nov 7" chip (`formatDueDate`).
 */
export function formatRelativeDayHeading(
  dayKey: string,
  todayKey: string,
  /** null: no verb ("Saturday · in 3 days"), for a day whose rows each say
   *  what they are. */
  verb: "due" | "starts" | null,
): string {
  const { year } = parseDayKey(dayKey);
  // The key already IS the institution-local date, so read it in UTC.
  const date = new Date(`${dayKey}T12:00:00Z`);
  const days = daysBetweenDayKeys(todayKey, dayKey);
  if (verb === null) {
    const label = formatRelativeDayHeading(dayKey, todayKey, "due").replace(
      /^(Was due|Due) /,
      "",
    );
    return label.charAt(0).toUpperCase() + label.slice(1);
  }
  const lead = verb === "due" ? "Due" : "Starts";
  const shortDate = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(String(year) === todayKey.slice(0, 4) ? {} : { year: "numeric" }),
  }).format(date);

  if (days < 0) {
    return `${verb === "due" ? "Was due" : "Started"} ${shortDate}`;
  }
  if (days === 0) return `${lead} today`;
  if (days === 1) return `${lead} tomorrow`;
  if (days <= 6) {
    const weekday = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      weekday: "long",
    }).format(date);
    return `${lead} ${weekday} · in ${days} days`;
  }
  return `${lead} ${shortDate} · in ${days} days`;
}

/**
 * The one homework-deadline primitive: institution-day status + human phrase,
 * derived together so they can never disagree.
 *
 * Returns `null` when `dueAt == null` (no deadline claimed → callers treat as
 * not due, no phrase). Otherwise `{ status, phrase }`:
 *   - status "upcoming" | "dueToday" | "overdue" by day-key comparison in the
 *     institution timezone. Day-key granularity (not `dueAt <= now`) so
 *     "due today" owns the entire due day and overdue starts at 00:00 the next
 *     institution day — no overlap, no gap.
 *   - phrase, always through `formatDueDate`:
 *       dueToday: "due today"
 *       upcoming: "due tomorrow" (next day) · "due Thu, Nov 5" (anything later)
 *       overdue:  "was due Fri, Oct 16" (always the full date)
 *
 * Only "today" and "tomorrow" may be relative. A weekday never stands alone:
 * "was due Thursday" and "due Thursday" used to read the same at a glance.
 * (Group headings add a day count instead: `formatRelativeDayHeading`.)
 * The phrase includes its own "due"/"was due", so callers add only their
 * separator (e.g. " · ").
 *
 * Callers must derive this from the ticking `nowMs`, never a stored field
 * (T11), so a row crossing institution midnight re-derives on the next tick.
 */
export function dueStatus(
  dueAt: number | null | undefined,
  nowMs: number,
  timeZone: string,
): { status: "upcoming" | "dueToday" | "overdue"; phrase: string } | null {
  if (dueAt == null) return null;

  const nowKey = dayKeyForTimezone(nowMs, timeZone);
  const dueKey = dayKeyForTimezone(dueAt, timeZone);

  if (dueKey === nowKey) return { status: "dueToday", phrase: "due today" };
  if (dueKey < nowKey) {
    return {
      status: "overdue",
      phrase: `was due ${formatDueDate(dueAt, nowMs, timeZone)}`,
    };
  }
  if (dueKey === shiftDayKey(nowKey, 1)) {
    return { status: "upcoming", phrase: "due tomorrow" };
  }
  return {
    status: "upcoming",
    phrase: `due ${formatDueDate(dueAt, nowMs, timeZone)}`,
  };
}
