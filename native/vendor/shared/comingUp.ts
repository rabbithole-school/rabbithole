import { dayKeyForTimezone } from "./institutionDay";

/**
 * Shared pure grouping for the scholar "Coming up" lookahead. The Convex query
 * resolves the horizon (the next 5 open school days) and the enriched planned
 * rows; this file owns the group-by-day shape so it can be unit-tested without
 * a backend.
 *
 * Coming up is planned CLASS work that hasn't started yet. Homework is not
 * here: every live homework item, whatever its due date, is in the Homework
 * section (shared/homeworkList.ts), which renders above this card.
 *
 * It is a FORECAST, not a todo (T4): rows are non-actionable and this module
 * never decides launchability — the live/planned `setAt` boundary still governs
 * whether a scholar can start anything.
 */

export type ComingUpPlanned = {
  kind: "planned";
  assignmentId: string;
  activityId: string;
  activityTitle: string;
  unitTitle: string | null;
  unitEmoji: string | null;
  teacherName: string | null;
  startsAt: number;
};

export type ComingUpEntry = ComingUpPlanned;

export type ComingUpDayGroup = {
  dayKey: string;
  entries: ComingUpEntry[];
};

/**
 * The wall-clock start of a PLANNED (not-yet-live) placement — e.g. "10:30 AM".
 * Planned rows have no deadline, so this is what fills their status slot. The
 * day heading above already says "Starts tomorrow", so the chip carries the
 * time alone; "starts" or "planned" there would restate it (T3).
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

/**
 * Group the lookahead by institution-local day, in horizon order.
 *
 * Planned previews are included for every day in the horizon (including the
 * next open school day), because `todayScheduleForSelf` exposes only TODAY's
 * planned entries — a placement committed for tomorrow is otherwise invisible
 * to the scholar. Callers must pass ONLY committed-`startsAt` placements here.
 * Days outside the horizon are dropped; empty days produce no group.
 */
export function buildComingUpGroups({
  planned,
  horizonDayKeys,
  timeZone,
}: {
  planned: ComingUpPlanned[];
  horizonDayKeys: string[];
  timeZone: string;
}): ComingUpDayGroup[] {
  const horizon = new Set(horizonDayKeys);
  const byDay = new Map<string, ComingUpEntry[]>();

  for (const item of planned) {
    const dayKey = dayKeyForTimezone(item.startsAt, timeZone);
    if (!horizon.has(dayKey)) continue;
    const bucket = byDay.get(dayKey);
    if (bucket) bucket.push(item);
    else byDay.set(dayKey, [item]);
  }

  const groups: ComingUpDayGroup[] = [];
  for (const dayKey of horizonDayKeys) {
    const entries = byDay.get(dayKey);
    if (!entries || entries.length === 0) continue;
    entries.sort((a, b) => a.startsAt - b.startsAt);
    groups.push({ dayKey, entries });
  }
  return groups;
}
