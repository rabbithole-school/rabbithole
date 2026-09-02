import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { deleteResourcesForActivity } from "../activityResources";
import { removeSchedulePlacementsForActivity } from "../masterSchedule";

/**
 * True if scholars have done REAL work on this activity — any non-test-drive
 * session, any completion, or any submitted deliverable. Mirrors the
 * unit-level "Guard 2" in `units.remove` (test-drive projects, the teacher's
 * own throwaway rehearsals, do NOT count). Schedule state (placements /
 * activitySchedule entries) is intentionally NOT work: the cascade unschedules
 * correctly, so deleting an unworked-but-scheduled activity just unschedules it.
 */
export async function activityHasScholarWork(
  ctx: MutationCtx,
  activityId: Id<"activities">,
): Promise<boolean> {
  const sessions = await ctx.db
    .query("sessions")
    .withIndex("by_activity", (q) => q.eq("activityId", activityId))
    .collect();
  if (sessions.some((s) => !s.isTestDrive)) return true;

  const completion = await ctx.db
    .query("activityCompletions")
    .withIndex("by_activity", (q) => q.eq("activityId", activityId))
    .first();
  if (completion) return true;

  const deliverables = await ctx.db
    .query("deliverables")
    .withIndex("by_activity", (q) => q.eq("activityId", activityId))
    .collect();
  // A deliverable submitted inside the teacher's own test-drive rehearsal is
  // not scholar work (same exemption as sessions above). Resolve each
  // deliverable's session through the sessions we already collected (they're
  // the same activity's sessions in the normal case) rather than one get per
  // row; a session we can't resolve conservatively counts as scholar work.
  const testDriveSessionIds = new Set(
    sessions.filter((s) => s.isTestDrive).map((s) => String(s._id)),
  );
  const knownSessionIds = new Set(sessions.map((s) => String(s._id)));
  for (const d of deliverables) {
    if (testDriveSessionIds.has(String(d.sessionId))) continue;
    if (knownSessionIds.has(String(d.sessionId))) return true;
    const session = await ctx.db.get(d.sessionId);
    if (!session?.isTestDrive) return true;
  }

  return false;
}

/**
 * Remove every SCHEDULING reference to an activity: its schedule placements
 * (plan layer) and its `activitySchedule` entries — planned AND live — with any
 * pending activation job cancelled. Used by both hard delete and archive:
 * schedule state must never point at an activity scholars can't reach.
 *
 * `activitySchedule` is a nested array and cannot be indexed by activityId, so
 * this infrequent design-side operation intentionally scans assignments.
 */
export async function removeScheduleStateForActivity(
  ctx: MutationCtx,
  activityId: Id<"activities">,
): Promise<void> {
  await removeSchedulePlacementsForActivity(ctx, activityId);

  const assignments = await ctx.db.query("assignments").collect();
  for (const assignment of assignments) {
    const entries = (assignment.activitySchedule ?? []).filter(
      (entry) => entry.activityId === activityId,
    );
    if (entries.length === 0) continue;
    for (const entry of entries) {
      if (entry.scheduledFnId) {
        await ctx.scheduler.cancel(entry.scheduledFnId);
      }
    }
    await ctx.db.patch(assignment._id, {
      activitySchedule: (assignment.activitySchedule ?? []).filter(
        (entry) => entry.activityId !== activityId,
      ),
    });
  }
}

/**
 * Delete an activity and every scheduling reference to it.
 *
 * By default this refuses to delete an activity scholars have worked on
 * (`activityHasScholarWork`) — the teacher should archive it instead — throwing
 * a teacher-facing error BEFORE anything is removed. `skipWorkGuard: true` is
 * for callers that already enforced the no-scholar-work rule at their own
 * altitude: `units.remove` (its Guard 2 refuses real scholar work unit-wide)
 * and the lesson cascades (which pre-check every child via
 * `activityHasScholarWork` to throw a lesson-level message first).
 */
export async function deleteActivityCascade(
  ctx: MutationCtx,
  activityId: Id<"activities">,
  options: { skipWorkGuard?: boolean } = {},
): Promise<void> {
  if (!options.skipWorkGuard && (await activityHasScholarWork(ctx, activityId))) {
    throw new Error(
      "Can't delete: scholars have worked on this activity. Archive it instead.",
    );
  }

  await removeScheduleStateForActivity(ctx, activityId);
  await deleteResourcesForActivity(ctx, activityId);
  await ctx.db.delete(activityId);
}
