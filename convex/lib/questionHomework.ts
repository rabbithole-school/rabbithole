/**
 * THE predicate for "a teacher made this question live homework for this
 * scholar" (Scholar's Prep "Assign…" → `assignments.assignQuestionAsHomework`).
 * Shared by the question queue (which drops the question from the backlog while
 * it is homework) and the assign mutation (idempotency / one live homework per
 * question), so the two can never disagree: a question is on exactly one list.
 *
 * LIVE means the homework entry still exists on a non-archived one-scholar
 * dispatch assignment that still lists this scholar. An archived dispatch, or a
 * scholar removed from it, returns the question to the queue — where it can be
 * assigned again.
 *
 * Indexed end to end: `activities.by_seed` (the seed's launcher activities —
 * one per assignment, so a handful at most), then each launcher's own
 * `dispatchAssignmentId`. No assignment-table scan.
 */

import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

export type LiveQuestionHomework = {
  assignmentId: Id<"assignments">;
  activityId: Id<"activities">;
  dueAt: number | null;
};

/** Pure: is `entry` on `assignment` live homework for `scholarId` launching
 *  `activityId`? Exported for tests. */
export function isLiveQuestionHomeworkEntry(
  assignment: Pick<Doc<"assignments">, "archivedAt" | "kind" | "scholarIds">,
  entry: { mode?: string; activityId: Id<"activities"> },
  scholarId: Id<"users">,
  activityId: Id<"activities">,
): boolean {
  return (
    !assignment.archivedAt &&
    assignment.kind === "adHocDispatch" &&
    assignment.scholarIds.some((id) => id === scholarId) &&
    entry.mode === "homework" &&
    entry.activityId === activityId
  );
}

export async function liveQuestionHomework(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
  seedId: Id<"seeds">,
): Promise<LiveQuestionHomework | null> {
  const launchers = await ctx.db
    .query("activities")
    .withIndex("by_seed", (q) => q.eq("seedId", seedId))
    .collect();
  for (const launcher of launchers) {
    if (!launcher.dispatchAssignmentId) continue;
    const assignment = await ctx.db.get(launcher.dispatchAssignmentId);
    if (!assignment) continue;
    for (const entry of assignment.activitySchedule ?? []) {
      if (!isLiveQuestionHomeworkEntry(assignment, entry, scholarId, launcher._id)) {
        continue;
      }
      return {
        assignmentId: assignment._id,
        activityId: launcher._id,
        dueAt: entry.dueAt ?? null,
      };
    }
  }
  return null;
}
