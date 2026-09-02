import { dayKeyForTimezone } from "./institutionDay";

/**
 * Shared pure grouping for the scholar "Coming up" lookahead (Move 3 of the
 * homework-flow plan). The Convex query resolves the horizon (the next 5 open
 * school days) and the enriched candidate rows; this file owns the deadline
 * boundary + the group-by-day shape so it can be unit-tested without a backend.
 *
 * It is a FORECAST, not a todo (T4): rows are non-actionable and this module
 * never decides launchability — the live/planned `setAt` boundary still governs
 * whether a scholar can start anything.
 */

export type ComingUpDisplay = {
  assignmentId: string;
  activityId: string;
  activityTitle: string;
  unitTitle: string | null;
  unitEmoji: string | null;
  teacherName: string | null;
};

export type ComingUpHomework = ComingUpDisplay & {
  kind: "homework";
  dueAt: number;
};

export type ComingUpPlanned = ComingUpDisplay & {
  kind: "planned";
  startsAt: number;
};

export type ComingUpEntry = ComingUpHomework | ComingUpPlanned;

export type ComingUpDayGroup = {
  dayKey: string;
  entries: ComingUpEntry[];
};

/** Day heading copy shared by both frontends: e.g. "Thursday · Aug 27". */
export function formatComingUpDayHeading(dayKey: string): string {
  // The day key already encodes the institution-local calendar date, so format
  // it in UTC to read the weekday/month/day straight off it without a second
  // timezone shift moving it to the wrong day.
  const date = new Date(`${dayKey}T00:00:00Z`);
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
  }).format(date);
  const monthDay = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  }).format(date);
  return `${weekday} \u00b7 ${monthDay}`;
}

/**
 * The wall-clock start of a PLANNED (not-yet-live) placement — e.g. "10:30".
 * Planned rows have no deadline, so this is what fills their status slot; a
 * chip reading "planned" only restates the section it sits in (T3).
 */
export function formatStartTime(startsAt: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(startsAt));
  } catch {
    return "";
  }
}

function entryTime(entry: ComingUpEntry): number {
  return entry.kind === "homework" ? entry.dueAt : entry.startsAt;
}

/** Homework leads a day (it carries a real deadline), then planned previews. */
function compareEntries(a: ComingUpEntry, b: ComingUpEntry): number {
  if (a.kind !== b.kind) return a.kind === "homework" ? -1 : 1;
  return entryTime(a) - entryTime(b);
}

/**
 * Group the lookahead by institution-local day, in horizon order.
 *
 * - Homework is included only for days STRICTLY AFTER `nextOpenSchoolDayKey`:
 *   the tonight card (`filterHomeworkForNow`) already owns everything due on or
 *   before the next open school day, so Coming up begins exactly where it ends.
 * - Planned previews are included for every day in the horizon (including the
 *   next open school day), because `todayScheduleForSelf` exposes only TODAY's
 *   planned entries — a placement committed for tomorrow is otherwise invisible
 *   to the scholar. This is the deliberate visibility widening the plan calls
 *   out; callers must pass ONLY committed-`startsAt` placements here.
 * - Days outside the horizon are dropped; empty days produce no group.
 */
export function buildComingUpGroups({
  homework,
  planned,
  horizonDayKeys,
  nextOpenSchoolDayKey,
  timeZone,
}: {
  homework: ComingUpHomework[];
  planned: ComingUpPlanned[];
  horizonDayKeys: string[];
  nextOpenSchoolDayKey: string | null;
  timeZone: string;
}): ComingUpDayGroup[] {
  const horizon = new Set(horizonDayKeys);
  const byDay = new Map<string, ComingUpEntry[]>();

  const add = (dayKey: string, entry: ComingUpEntry) => {
    const bucket = byDay.get(dayKey);
    if (bucket) bucket.push(entry);
    else byDay.set(dayKey, [entry]);
  };

  for (const hw of homework) {
    const dayKey = dayKeyForTimezone(hw.dueAt, timeZone);
    if (nextOpenSchoolDayKey != null && dayKey <= nextOpenSchoolDayKey) continue;
    if (!horizon.has(dayKey)) continue;
    add(dayKey, hw);
  }

  for (const item of planned) {
    const dayKey = dayKeyForTimezone(item.startsAt, timeZone);
    if (!horizon.has(dayKey)) continue;
    add(dayKey, item);
  }

  const groups: ComingUpDayGroup[] = [];
  for (const dayKey of horizonDayKeys) {
    const entries = byDay.get(dayKey);
    if (!entries || entries.length === 0) continue;
    entries.sort(compareEntries);
    groups.push({ dayKey, entries });
  }
  return groups;
}
