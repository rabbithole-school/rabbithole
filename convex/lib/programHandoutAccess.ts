import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { requireProgramPublishAccess } from "./programGroupAccess";

type ProgramHandoutCtx = (QueryCtx | MutationCtx) & { user: Doc<"users"> };

/**
 * The assignment schedule is the durable ownership link for a lesson-less
 * program handout. It exists while the handout is a draft, before a placement
 * gives it a time, so resources can be authored without curriculum access.
 */
export async function requireProgramHandoutAccess(
  ctx: ProgramHandoutCtx,
  args: {
    activityId: Id<"activities">;
    assignmentId: Id<"assignments">;
  },
) {
  const activity = await ctx.db.get(args.activityId);
  if (!activity || activity.lessonId || activity.kind !== "offline") {
    throw new Error("Program handout not found.");
  }
  const assignment = await ctx.db.get(args.assignmentId);
  if (
    !assignment ||
    assignment.archivedAt ||
    assignment.kind !== "adHocDispatch" ||
    !assignment.scholarGroupId ||
    !(assignment.activitySchedule ?? []).some(
      (entry) => entry.activityId === args.activityId,
    )
  ) {
    throw new Error("Program handout assignment not found.");
  }
  const group = await requireProgramPublishAccess(
    ctx,
    ctx.user,
    await ctx.db.get(assignment.scholarGroupId),
  );
  return { activity, assignment, group };
}
