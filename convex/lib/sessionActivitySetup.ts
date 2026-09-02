import { sessionModeForActivityKind } from "../../lib/activityKinds";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

type SetupResult = {
  seededArtifact: boolean;
  scheduledCriteria: boolean;
};

export async function ensureSessionProcessState(
  ctx: MutationCtx,
  args: {
    sessionId: Id<"sessions">;
    processId?: Id<"processes">;
  },
): Promise<void> {
  if (!args.processId) return;
  const existingProcessState = await ctx.db
    .query("processState")
    .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
    .first();
  if (!existingProcessState) {
    await ctx.scheduler.runAfter(0, internal.processState.initialize, {
      sessionId: args.sessionId,
      processId: args.processId,
    });
  }
}

/**
 * Apply the shared runtime setup every activity-backed session needs.
 *
 * Session creation has several entry points (direct activity launch, unit card,
 * structured seed, and an in-place seed bake). Keeping this idempotent prevents
 * one path from silently missing its canvas, rubric, or completion handoff.
 */
export async function ensureSessionActivitySetup(
  ctx: MutationCtx,
  args: {
    sessionId: Id<"sessions">;
    activity: Doc<"activities">;
    unitId?: Id<"units">;
    processId?: Id<"processes">;
    retryErroredCriteria?: boolean;
  },
): Promise<SetupResult> {
  const session = await ctx.db.get(args.sessionId);
  if (!session || session.activityId !== args.activity._id) {
    return { seededArtifact: false, scheduledCriteria: false };
  }

  const patch: Record<string, unknown> = {};
  const desiredMode = sessionModeForActivityKind(args.activity.kind);
  if (session.sessionMode !== desiredMode) {
    patch.sessionMode = desiredMode;
  }

  const autoRubric = args.activity.deliverable?.mode === "auto";
  const hasGeneratedCriteria = (session.deliverableCriteria?.length ?? 0) > 0;
  let scheduledCriteria = false;
  if (autoRubric && hasGeneratedCriteria) {
    if (session.deliverableCriteriaStatus !== "ready") {
      patch.deliverableCriteriaStatus = "ready";
      patch.deliverableCriteriaError = undefined;
    }
  } else if (
    autoRubric &&
    (session.deliverableCriteriaStatus === undefined ||
      (args.retryErroredCriteria &&
        session.deliverableCriteriaStatus === "error"))
  ) {
    patch.deliverableCriteriaStatus = "pending";
    patch.deliverableCriteriaError = undefined;
    scheduledCriteria = true;
  }

  let scheduleReflection = false;
  if (args.unitId && session.reflectionStatus === undefined) {
    patch.reflectionStatus = "pending";
    patch.reflectionError = undefined;
    scheduleReflection = true;
  }

  if (Object.keys(patch).length > 0) {
    await ctx.db.patch(args.sessionId, patch);
  }

  const needsCanvas =
    args.activity.deliverable?.kind === "text" ||
    args.activity.deliverable?.kind === "artifact";
  let seededArtifact = false;
  if (needsCanvas) {
    const existingArtifact = await ctx.db
      .query("artifacts")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .first();
    if (!existingArtifact) {
      await ctx.db.insert("artifacts", {
        sessionId: args.sessionId,
        title: args.activity.title,
        content: "",
        lastEditedBy: "scholar",
        type:
          args.activity.deliverable?.kind === "artifact"
            ? ("code" as const)
            : ("text" as const),
      });
      seededArtifact = true;
    }
  }

  await ensureSessionProcessState(ctx, {
    sessionId: args.sessionId,
    processId: args.processId,
  });
  if (scheduledCriteria) {
    await ctx.scheduler.runAfter(
      0,
      internal.deliverables.generateCriteriaForSession,
      { sessionId: args.sessionId },
    );
  }
  if (scheduleReflection) {
    await ctx.scheduler.runAfter(
      0,
      internal.sessions.generateReflectionForSession,
      { sessionId: args.sessionId },
    );
  }

  return { seededArtifact, scheduledCriteria };
}
