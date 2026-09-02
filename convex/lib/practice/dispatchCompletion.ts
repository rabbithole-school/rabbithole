import type { MutationCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import {
  entryTargetsScholar,
  isLiveEntry,
  targetsScholar,
} from "../../assignments";
import { PRACTICE_SESSION_SIZE } from "../../../shared/practiceLoop";
import { dedupeDispatchCompletionReceipts } from "../../../shared/dispatchCompletionReceipt";
import { reconcileActivityCompletion } from "../activityCompletionCore";

export type DispatchCompleted = {
  assignmentId: Id<"assignments">;
  teacherName: string;
};

export async function reconcileProblemSetDispatchCompletions(
  ctx: MutationCtx,
  args: {
    scholarId: Id<"users">;
    skillKey?: string;
    now: number;
  },
): Promise<{ created: number; dispatchCompleted: DispatchCompleted[] }> {
  // Accepted trade-off: assignments is currently small, assignment writes are
  // rare, and this mirrors the full-table scan used by the reactive scholar
  // queries. Revisit with a narrower index if the table grows or OCC noise
  // appears on the practice write path.
  const assignments = await ctx.db.query("assignments").collect();
  let created = 0;
  const dispatchCompleted: DispatchCompleted[] = [];

  for (const assignment of assignments) {
    if (assignment.archivedAt || !targetsScholar(assignment, args.scholarId)) {
      continue;
    }

    for (const entry of assignment.activitySchedule ?? []) {
      if (
        !isLiveEntry(entry, args.now) ||
        !entryTargetsScholar(entry, args.scholarId)
      ) {
        continue;
      }

      const existing = await ctx.db
        .query("activityCompletions")
        .withIndex("by_scholar_assignment", (q) =>
          q
            .eq("scholarId", args.scholarId)
            .eq("assignmentId", assignment._id),
        )
        .filter((q) => q.eq(q.field("activityId"), entry.activityId))
        .first();
      if (existing) continue;

      const activity = await ctx.db.get(entry.activityId);
      if (activity?.kind !== "problem_set" || !activity.problemSet) continue;

      const targetSkillKeys = [...new Set(activity.problemSet.targetSkillKeys)];
      if (
        args.skillKey !== undefined &&
        !targetSkillKeys.includes(args.skillKey)
      ) {
        continue;
      }

      // Practice serves six items per run, while dispatch itemCount defaults to
      // ten and is not teacher-configurable in the UI. One full session's worth
      // of fresh, non-retry items since the push is therefore the honest
      // completion contract; an explicitly smaller itemCount is still honored.
      const requiredAttempts = Math.min(
        activity.problemSet.itemCount ?? 10,
        PRACTICE_SESSION_SIZE,
      );
      let attemptCount = 0;
      for (const targetSkillKey of targetSkillKeys) {
        const remaining = requiredAttempts - attemptCount;
        if (remaining <= 0) break;
        const attempts = await ctx.db
          .query("practiceAttempts")
          .withIndex("by_scholar_node_createdAt", (q) =>
            q
              .eq("scholarId", args.scholarId)
              .eq("nodeKey", targetSkillKey)
              .gte("createdAt", entry.setAt!),
          )
          // A placement/check-in probe on this skill is not work on the
          // dispatched set and must never clear it. Normal practice and stretch
          // attempts still count; diagnostic retries do not.
          .filter((q) =>
            q.and(
              q.neq(q.field("retry"), true),
              q.neq(q.field("lane"), "placement"),
            ),
          )
          .take(remaining);
        attemptCount += attempts.length;
      }
      if (attemptCount < requiredAttempts) continue;

      const result = await reconcileActivityCompletion(ctx, {
        scholarId: args.scholarId,
        activityId: entry.activityId,
        assignmentId: assignment._id,
      });
      if (result.created) {
        created++;
        const teacher = await ctx.db.get(assignment.teacherId);
        if (!teacher?.name) {
          console.error(
            `Cannot render dispatch receipt for assignment ${assignment._id}: teacher ${assignment.teacherId} has no display name`,
          );
          continue;
        }
        dispatchCompleted.push({
          assignmentId: assignment._id,
          teacherName: teacher.name,
        });
      }
    }
  }

  return {
    created,
    dispatchCompleted: dedupeDispatchCompletionReceipts(dispatchCompleted),
  };
}
