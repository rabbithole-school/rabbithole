// Where a session sits on the scholar Home — one rule shared by the active
// plate (scholarPlate.activeForMe) and the Archived list
// (sessions.finishedForScholar), so a session never changes tab when it is
// archived (review/home-finished-filter.html).

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { isAppActivity } from "../../shared/appSurface";
import { sessionHasCodeArtifact } from "./teacherArchive";
import { pushLane, type ScheduleEntry } from "./pushes";

/** An assignment together with its schedule (lib/scheduleStore readSchedule). */
export type AssignmentWithSchedule = Pick<
  Doc<"assignments">,
  "archivedAt" | "scholarIds" | "selfPaced"
> & { schedule: ReadonlyArray<ScheduleEntry> };

/**
 * THE rule for picking one entry when an activity has several (one per mode)
 * on a schedule. Every reader that needs one entry per activity uses this (or
 * `decidingEntryByActivity`), never array or Map insertion order:
 *   1. a live entry (activated, not expired) beats any other;
 *   2. among live ones, the most recently activated (`setAt`); a tie goes to
 *      homework, the entry that stays on the list;
 *   3. with none live, a planned entry (never activated), soonest start first;
 *   4. with neither, the most recently activated expired entry (homework on a
 *      tie).
 * Order-independent: the same entries in any order give the same answer.
 */
export function decidingEntry(
  entries: ReadonlyArray<ScheduleEntry>,
  now: number,
): ScheduleEntry | undefined {
  const expired = (e: ScheduleEntry) => e.endsAt != null && e.endsAt <= now;
  const latest = (list: ScheduleEntry[]) =>
    list.reduce<ScheduleEntry | undefined>((best, e) => {
      if (!best) return e;
      if ((e.setAt ?? 0) !== (best.setAt ?? 0)) {
        return (e.setAt ?? 0) > (best.setAt ?? 0) ? e : best;
      }
      if (e.mode !== best.mode) return e.mode === "homework" ? e : best;
      return best;
    }, undefined);
  const soonest = (list: ScheduleEntry[]) =>
    list.reduce<ScheduleEntry | undefined>((best, e) => {
      if (!best) return e;
      const a = e.startsAt ?? Number.POSITIVE_INFINITY;
      const b = best.startsAt ?? Number.POSITIVE_INFINITY;
      if (a !== b) return a < b ? e : best;
      if (e.mode !== best.mode) return e.mode === "homework" ? e : best;
      return best;
    }, undefined);
  const activated = entries.filter((e) => e.setAt != null);
  return (
    latest(activated.filter((e) => !expired(e))) ??
    soonest(entries.filter((e) => e.setAt == null)) ??
    latest(activated.filter(expired))
  );
}

/** `decidingEntry` for each activity on a schedule, keyed by activity id. */
export function decidingEntryByActivity(
  schedule: ReadonlyArray<ScheduleEntry>,
  now: number,
): Map<string, ScheduleEntry> {
  const byActivity = new Map<string, ScheduleEntry[]>();
  for (const e of schedule) {
    const key = String(e.activityId);
    const list = byActivity.get(key);
    if (list) list.push(e);
    else byActivity.set(key, [e]);
  }
  const out = new Map<string, ScheduleEntry>();
  for (const [key, list] of byActivity) {
    const chosen = decidingEntry(list, now);
    if (chosen) out.set(key, chosen);
  }
  return out;
}

/** The mode of the deciding entry among `entries` (`decidingEntry`). */
function decidingMode(
  entries: ReadonlyArray<ScheduleEntry>,
  now: number,
): "classFocus" | "homework" | undefined {
  return decidingEntry(entries, now)?.mode;
}

/**
 * The mode assigned work runs in for this scholar: the most recently
 * activated live pushed entry for the activity; with none live, the most
 * recently activated expired one (`decidingMode`); a self-paced assignment
 * with no push reads as class focus. `undefined` when the assignment is
 * archived, doesn't include the scholar, or never pushed the activity to
 * them.
 */
export function assignedWorkMode(
  assignment: AssignmentWithSchedule | null | undefined,
  activityId: Id<"activities">,
  scholarId: Id<"users">,
  now: number,
): "classFocus" | "homework" | undefined {
  if (
    !assignment ||
    assignment.archivedAt ||
    !assignment.scholarIds.some((id) => String(id) === String(scholarId))
  ) {
    return undefined;
  }
  const pushed = assignment.schedule.filter(
    (entry) =>
      // Planned-but-never-pushed entries are invisible to scholars.
      entry.setAt != null &&
      String(entry.activityId) === String(activityId) &&
      // Per-scholar targeting: absent/empty scholarIds = cohort-wide.
      (entry.scholarIds == null ||
        entry.scholarIds.length === 0 ||
        entry.scholarIds.some((id) => String(id) === String(scholarId))),
  );
  return (
    decidingMode(pushed, now) ??
    (assignment.selfPaced ? "classFocus" : undefined)
  );
}

/**
 * The mode for a session the scholar already STARTED on this assignment.
 * Same as `assignedWorkMode`, except when the activity is still pushed on
 * the assignment but its entry now targets OTHER scholars: re-pushing an
 * activity to one scholar for extra time replaces the cohort-wide entry
 * with a one-scholar entry, and everyone else's started work used to vanish
 * from Home and Archived alike (2026-11-04). The re-push was about who gets
 * the push, not about taking work away, so a scholar who started it keeps it.
 *
 * An activity with no pushed entry at all still reads `undefined`: that is
 * the normal end of a timed class focus (`autoClearActivity` removes the
 * entry), and those sessions deliberately leave Home. Open-until work keeps
 * its entry after it closes (shared/openUntil.ts), so a session the scholar
 * started there reads as class focus and stays on Home as "Pick up where
 * you left off" until it's finished. Also `undefined` when
 * the assignment is archived or no longer includes the scholar.
 */
export function startedWorkMode(
  assignment: AssignmentWithSchedule | null | undefined,
  activityId: Id<"activities">,
  scholarId: Id<"users">,
  now: number,
): "classFocus" | "homework" | undefined {
  const mode = assignedWorkMode(assignment, activityId, scholarId, now);
  if (mode) return mode;
  if (
    !assignment ||
    assignment.archivedAt ||
    !assignment.scholarIds.some((id) => String(id) === String(scholarId))
  ) {
    return undefined;
  }
  // Same rule as assignedWorkMode, ignoring who the entry targets.
  return decidingMode(
    assignment.schedule.filter(
      (entry) =>
        entry.setAt != null &&
        String(entry.activityId) === String(activityId),
    ),
    now,
  );

}

/**
 * The tab for started, unfinished work whose activity has ENDED for this
 * scholar: `startedWorkMode` is undefined because no pushed entry reaches
 * them any more (the class focus ended and `autoClearActivity` removed it, or
 * the teacher replaced the activity). Home leaves such work out, so it lives
 * in Archived as "Not finished" (`sessions.finishedForScholar`, kind
 * "ended"), and "Keep working on this" brings it back to Home for the day
 * (`isReopenLive`). Either way it files with assigned work, never as a Quest.
 */
export async function endedWorkMode(
  ctx: Pick<QueryCtx, "db">,
  assignmentId: Id<"assignments"> | null | undefined,
  activityId: Id<"activities"> | null | undefined,
): Promise<"classFocus" | "homework"> {
  // Read the ended give's OWN window — its push row, which outlives the
  // schedule entry — never the activity's retired authored `defaultMode`
  // (TRA-571). The most recently ACTIVATED push wins (mirror rows are updated
  // in place, so creation order says nothing; a never-activated planned row
  // is not a give the scholar had). With none, it came and went as class time.
  if (!assignmentId || !activityId) return "classFocus";
  const pushes = await ctx.db
    .query("pushes")
    .withIndex("by_assignment", (q) => q.eq("assignmentId", assignmentId))
    .collect();
  const latest = pushes
    .filter(
      (push) =>
        push.setAt != null &&
        push.target.kind === "activity" &&
        String(push.target.activityId) === String(activityId),
    )
    .sort((a, b) => b.setAt! - a.setAt!)[0];
  return latest !== undefined && pushLane(latest) === "homework" ? "homework" : "classFocus";
}

/**
 * Does this session hold an app the scholar built? Only a session that could
 * hold one is probed for its code artifact: an app activity's session, or an
 * activity-less one (a free build or an open exploration). An ordinary
 * activity's chat is never probed, so its code writes don't re-run the hot
 * plate query. Decided from the activity, never the session's builder mode
 * (TRA-519, convex/__tests__/noRawAppKindChecks.test.ts).
 */
export async function isBuiltAppSession(
  ctx: Pick<QueryCtx, "db">,
  session: Pick<Doc<"sessions">, "_id" | "activityId">,
  activity: Pick<Doc<"activities">, "kind" | "appActivity"> | null,
): Promise<boolean> {
  return (
    couldHoldBuiltApp(session, activity) &&
    (await sessionHasCodeArtifact(ctx, session._id))
  );
}

/** The no-read half of isBuiltAppSession: could this session hold an app the
 *  scholar built? A caller that reads the artifact itself (the teacher Apps
 *  page) asks this first, so it never reads one twice. */
export function couldHoldBuiltApp(
  session: Pick<Doc<"sessions">, "activityId">,
  activity: Pick<Doc<"activities">, "kind" | "appActivity"> | null,
): boolean {
  return !session.activityId || isAppActivity(activity);
}
