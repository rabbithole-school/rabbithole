import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalQuery,
  internalMutation,
  type MutationCtx,
} from "./_generated/server";
import {
  OBSERVER_DEBOUNCE_CANCEL_GRACE_MS,
  planObserverRun,
  type PendingObserverRun,
} from "./lib/observerShared";
import { maybeRaiseOffMissionAlert } from "./appOffTrackAlert";
import { validTalkJudgment } from "./lib/levelEvidence";

/**
 * Save an observer analysis result.
 */
export const saveAnalysis = internalMutation({
  args: {
    /** Raw model answer for the talk judgment (TRA-515); validated here. */
    talkLevel: v.optional(v.string()),
    /** Words the scholar said or typed in the window the observer read. */
    scholarWords: v.optional(v.number()),
    sessionId: v.id("sessions"),
    engagementScore: v.number(),
    complexityLevel: v.number(),
    onTaskScore: v.number(),
    topics: v.array(v.string()),
    learningIndicators: v.array(v.string()),
    concernFlags: v.array(v.string()),
    summary: v.string(),
    suggestedIntervention: v.optional(v.string()),
    pulseScore: v.optional(v.number()),
    promptVersion: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Save the analysis record
    await ctx.db.insert("analyses", {
      sessionId: args.sessionId,
      engagementScore: args.engagementScore,
      complexityLevel: args.complexityLevel,
      onTaskScore: args.onTaskScore,
      topics: args.topics,
      learningIndicators: args.learningIndicators,
      concernFlags: args.concernFlags,
      summary: args.summary,
      suggestedIntervention: args.suggestedIntervention,
      promptVersion: args.promptVersion,
      ...(validTalkJudgment(args.talkLevel, args.scholarWords) ?? {}),
    });

    // Update project pulse score
    await ctx.db.patch(args.sessionId, {
      analysisSummary: args.summary,
      pulseScore: args.pulseScore,
    });

    // Sessions with a mission: page the owning teacher when this reading makes
    // it two off-track readings in a row (TRA-481, TRA-519 B3). Never throws.
    await maybeRaiseOffMissionAlert(ctx, args.sessionId);
  },
});

/**
 * Record how far the observer pass that just RAISED a conversational alert had
 * read this session (`sessions.alertEvidenceThrough`; see the schema comment).
 * Called fire-only — observer.ts §6.9 invokes it solely on a pass whose
 * chat_stuck / chat_overwhelm raise succeeded, never on a quiet pass. Monotonic:
 * the watermark only ever moves forward, so an out-of-order or retried run
 * cannot re-open a window a later run already closed.
 *
 * Deliberately separate from `saveAnalysis`: the pulse write is skipped on a
 * degraded run, and alerting must not inherit that skip in either direction.
 */
export const recordAlertEvidenceThrough = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    through: v.number(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return;
    const current = session.alertEvidenceThrough;
    if (typeof current === "number" && current >= args.through) return;
    await ctx.db.patch(args.sessionId, { alertEvidenceThrough: args.through });
  },
});

/**
 * Debounced scheduling of the automatic observer run (TRA-152). Called from
 * `sessionHelpers.finalizeStream` on every assistant turn in place of the old
 * unconditional `runAfter(0)`. Reads the live scheduler state of the session's
 * pending job (`ctx.db.system`) rather than trusting the stamp alone, so a job
 * that already started or finished is never "cancelled" — Convex does not treat
 * cancelling an executing function as a safe no-op — and never mistaken for one
 * that will still read this turn. The decision itself is the pure
 * `planObserverRun`.
 */
export async function scheduleObserverRun(
  ctx: MutationCtx,
  session: Doc<"sessions">,
): Promise<void> {
  const now = Date.now();
  let pending: PendingObserverRun | null = null;
  if (session.observerPendingJobId) {
    const job = await ctx.db.system.get(session.observerPendingJobId);
    pending = {
      jobId: session.observerPendingJobId,
      since: session.observerPendingSince ?? now,
      state: job?.state.kind ?? "missing",
      scheduledTime: job?.scheduledTime,
    };
  }
  const plan = planObserverRun(now, pending);
  if (plan.kind === "leave") return;
  if (plan.cancelJobId) {
    await ctx.scheduler.cancel(plan.cancelJobId as Id<"_scheduled_functions">);
  }
  const jobId = await ctx.scheduler.runAt(
    plan.runAt,
    internal.observer.analyzeSession,
    { sessionId: session._id },
  );
  await ctx.db.patch(session._id, {
    observerPendingJobId: jobId,
    observerPendingSince: plan.since,
  });
}

/**
 * The observer's first step on every run: release the session's debounce
 * window. Clears the pending stamp so the next assistant turn opens a fresh
 * window, and cancels a DIFFERENT job that is still pending — the case where a
 * direct caller (`requestRecap`, the end-of-session flush) ran the analysis
 * while a debounced run was queued; that queued run would only re-read what
 * this one is about to. Never cancels the calling job itself: the caller is
 * `inProgress`, and only a `pending` job is ever cancelled.
 */
export const beginObserverRun = internalMutation({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return;
    if (session.observerPendingJobId) {
      const job = await ctx.db.system.get(session.observerPendingJobId);
      // Same grace as the trigger: a job due within it may be claimed before
      // this commits, and letting it run only re-reads the same turns.
      if (
        job?.state.kind === "pending" &&
        job.scheduledTime > Date.now() + OBSERVER_DEBOUNCE_CANCEL_GRACE_MS
      ) {
        await ctx.scheduler.cancel(session.observerPendingJobId);
      }
    }
    if (
      session.observerPendingJobId !== undefined ||
      session.observerPendingSince !== undefined
    ) {
      await ctx.db.patch(args.sessionId, {
        observerPendingJobId: undefined,
        observerPendingSince: undefined,
      });
    }
  },
});

/**
 * Get a project (for use in actions that need the userId).
 */
export const getSession = internalQuery({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.sessionId);
  },
});

/**
 * Update project's analysis summary.
 */
export const updateSessionSummary = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    summary: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.sessionId, {
      analysisSummary: args.summary,
    });
  },
});
