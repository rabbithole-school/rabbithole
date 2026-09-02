import { v } from "convex/values";
import { authedQuery, teacherQuery, teacherMutation } from "./lib/customFunctions";
import { internalMutation } from "./_generated/server";
import { requireActiveScholarAccess } from "./lib/access";
import { reconcileActivityCompletion } from "./lib/activityCompletionCore";
import { isTeacherRole } from "./lib/roles";

/**
 * Get process state for a project (reactive, used by ProcessPanel).
 */
export const getBySession = authedQuery({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return null;
    const isTeacher = isTeacherRole(ctx.user.role);
    if (!isTeacher && session.userId !== ctx.user._id) return null;
    const accessScholarId = session.isTestDrive
      ? session.testDriveAsScholarId
      : session.userId;
    if (accessScholarId && accessScholarId !== ctx.user._id) {
      await requireActiveScholarAccess(ctx, ctx.user, accessScholarId);
    }
    return await ctx.db
      .query("processState")
      .withIndex("by_session", (q) =>
        q.eq("sessionId", args.sessionId)
      )
      .first();
  },
});

/**
 * Initialize process state when a process is set on a project.
 * Creates all steps as "not_started", sets currentStep to the first step.
 */
export const initialize = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    processId: v.id("processes"),
  },
  handler: async (ctx, args) => {
    // Delete existing processState for this project
    const existing = await ctx.db
      .query("processState")
      .withIndex("by_session", (q) =>
        q.eq("sessionId", args.sessionId)
      )
      .first();
    if (existing) {
      await ctx.db.delete(existing._id);
    }

    // Get the process to read its steps
    const process = await ctx.db.get(args.processId);
    if (!process || process.steps.length === 0) return;

    await ctx.db.insert("processState", {
      sessionId: args.sessionId,
      processId: args.processId,
      currentStep: process.steps[0].key,
      steps: process.steps.map((s) => ({
        key: s.key,
        status: "not_started" as const,
      })),
    });
  },
});

/**
 * Update a step's status and commentary. Called by AI tool handler in http.ts.
 */
export const updateStep = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    stepKey: v.string(),
    status: v.union(
      v.literal("in_progress"),
      v.literal("completed")
    ),
    commentary: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const state = await ctx.db
      .query("processState")
      .withIndex("by_session", (q) =>
        q.eq("sessionId", args.sessionId)
      )
      .first();
    if (!state) return;

    const updatedSteps = state.steps.map((s) => {
      if (s.key === args.stepKey) {
        return {
          ...s,
          status: args.status,
          commentary: args.commentary ?? s.commentary,
        };
      }
      return s;
    });

    await ctx.db.patch(state._id, {
      currentStep: args.stepKey,
      steps: updatedSteps,
    });
  },
});

/**
 * Teacher moves a scholar to a different process step (drag-and-drop in Activity View).
 * Special pseudo-steps:
 *   "__not_started" — clears currentStep (scholar hasn't started the process)
 *   "__complete"    — runs the full completion cascade for real activity-backed
 *                     sessions; stamps activityCompletedAt directly otherwise
 * Any real step key clears activityCompletedAt and sets currentStep normally.
 */
export const teacherMoveStep = teacherMutation({
  args: {
    sessionId: v.id("sessions"),
    stepKey: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return;
    if (session.userId !== ctx.user._id) {
      await requireActiveScholarAccess(ctx, ctx.user, session.userId);
    }

    // Handle pseudo-steps
    if (args.stepKey === "__complete") {
      if (session.activityId && !session.isTestDrive) {
        const { completionId } = await reconcileActivityCompletion(ctx, {
          scholarId: session.userId,
          activityId: session.activityId,
          sessionId: args.sessionId,
        });
        // The cascade already stamped activityCompletedAt. It no-ops
        // (completionId null) only when the activity was deleted out from under
        // the session — fall through to the plain stamp so the completion card
        // still fires.
        if (completionId) return;
      }
      await ctx.db.patch(args.sessionId, {
        activityCompletedAt: Date.now(),
        activityCompletionMessageId: undefined,
      });
      return;
    }

    // Moving to any non-complete step clears completion
    if (session.activityCompletedAt) {
      await ctx.db.patch(args.sessionId, {
        activityCompletedAt: undefined,
        activityCompletionMessageId: undefined,
      });
    }

    if (args.stepKey === "__not_started") {
      // Clear process state currentStep
      const state = await ctx.db
        .query("processState")
        .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
        .first();
      if (state) {
        await ctx.db.patch(state._id, {
          currentStep: "",
          steps: state.steps.map((s) => ({ ...s, status: "not_started" as const })),
        });
      }
      return;
    }

    // Normal step move
    const state = await ctx.db
      .query("processState")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .first();
    if (!state) return;

    const updatedSteps = state.steps.map((s) => {
      if (s.key === args.stepKey) {
        return { ...s, status: "in_progress" as const };
      }
      return s;
    });

    await ctx.db.patch(state._id, {
      currentStep: args.stepKey,
      steps: updatedSteps,
    });
  },
});

/**
 * Remove process state for a project (when process is cleared).
 */
export const remove = internalMutation({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("processState")
      .withIndex("by_session", (q) =>
        q.eq("sessionId", args.sessionId)
      )
      .first();
    if (existing) {
      await ctx.db.delete(existing._id);
    }
  },
});

/**
 * Get racetrack data: all scholars' progress on a specific process.
 * Used by teacher's Conductor View to show class-wide step progress.
 *
 * TODO(access-enforcement): this is an AGGREGATE roster surface keyed by
 * processId (returns scholar names/images/progress across institutions) — it
 * needs active-context scholar filtering, NOT a single-scholar gate. Deferred
 * to the aggregate/roster enforcement phase (alongside other
 * cross-institution roster reads); tracked so it's covered before the flag flips.
 */
export const getRacetrackData = teacherQuery({
  args: { processId: v.id("processes") },
  handler: async (ctx, args) => {
    const process = await ctx.db.get(args.processId);
    if (!process) return null;

    // Find all non-archived projects using this process (via unit building block)
    const unitsWithProcess = await ctx.db
      .query("units")
      .filter((q) => q.eq(q.field("processId"), args.processId))
      .collect();
    const allSessions = [];
    for (const unit of unitsWithProcess) {
      const unitSessions = await ctx.db
        .query("sessions")
        .withIndex("by_unit", (q) => q.eq("unitId", unit._id))
        .collect();
      allSessions.push(...unitSessions);
    }
    const activeSessions = allSessions.filter(
      (p) => !p.isArchived && !p.isOffline && !p.isTestDrive,
    );

    // For each project, get processState + scholar info
    const scholarResults = await Promise.all(
      activeSessions.map(async (proj) => {
        const state = await ctx.db
          .query("processState")
          .withIndex("by_session", (q) =>
            q.eq("sessionId", proj._id)
          )
          .first();
        const scholar = await ctx.db.get(proj.userId);
        if (!state || !scholar) return null;
        return {
          id: scholar._id,
          name: scholar.name ?? null,
          image: scholar.image ?? null,
          currentStep: state.currentStep,
        };
      })
    );

    return {
      process: {
        title: process.title,
        emoji: process.emoji ?? null,
        steps: process.steps,
      },
      scholars: scholarResults.filter(
        (s): s is NonNullable<typeof s> => s !== null
      ),
    };
  },
});
