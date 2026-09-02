/**
 * Shared completion core.
 *
 * `activityCompletions` is the lesson-completion stamp. Historically the
 * find-existing-then-patch-or-insert dance (assignment-scoped via
 * `by_scholar_assignment`, with a `by_scholar_activity` legacy fallback for
 * bare rows) was copy-pasted between `deliverables.markActivityCompleted` (the
 * rubric-pass path) and `activityCompletions.markComplete` (the manual path).
 * A third caller — the tutor's `mark_activity_complete` tool for
 * conversation-only activities — would have been a third copy. This module is
 * the single source of truth for that upsert + the post-completion
 * process-state fast-forward, so a schema or dedupe change can't desync the
 * three paths.
 */
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import {
  maybeMarkCompletedSeedsForActivity,
  maybeMarkCompletedSeedsForSession,
} from "./seeds";
import { maybeAwardUnitBadge } from "./badgeAward";

/**
 * Idempotently upsert a `(scholar, activity)` completion row, scoped to the
 * session's assignment when there is one. Mirrors the exact dedupe the two
 * legacy paths used:
 *  - assignment-scoped: `by_scholar_assignment` filtered by activity, with a
 *    `by_scholar_activity` legacy fallback (bare row of the same session, then
 *    a bare unit-level row);
 *  - un-scoped: the newest bare / non-assignment row for the activity.
 * On a fresh insert, lessonId/unitId are derived from the activity → lesson.
 * `note` overwrites only when provided (an undefined note never clobbers an
 * existing one). Returns the row id and whether it was freshly created (so the
 * caller can fire one-time side effects like Slack only on first completion).
 */
export async function upsertActivityCompletion(
  ctx: MutationCtx,
  args: {
    scholarId: Id<"users">;
    activityId: Id<"activities">;
    sessionId?: Id<"sessions">;
    // Explicit assignment scope for session-less writers (markCompleteForGroup
    // — the offline class write path — knows its assignment but has no
    // session). A session's own assignmentId still wins when present, so the
    // two can't disagree about a session-scoped completion.
    assignmentId?: Id<"assignments">;
    note?: string;
    // Set only by an intentional scholar action from the take-home plan.
    // Other completion paths retain their existing, unstamped provenance.
    source?: "scholar_home";
    action?: "scholar_marked_take_home_done";
  },
): Promise<{ completionId: Id<"activityCompletions"> | null; created: boolean }> {
  const { scholarId, activityId, sessionId, note } = args;
  const session = sessionId ? await ctx.db.get(sessionId) : null;
  const assignmentId = session?.assignmentId ?? args.assignmentId;
  let existing: Doc<"activityCompletions"> | null = null;
  if (assignmentId) {
    existing = await ctx.db
      .query("activityCompletions")
      .withIndex("by_scholar_assignment", (q) =>
        q.eq("scholarId", scholarId).eq("assignmentId", assignmentId),
      )
      .filter((q) => q.eq(q.field("activityId"), activityId))
      .first();
    if (!existing && sessionId) {
      const legacy = await ctx.db
        .query("activityCompletions")
        .withIndex("by_scholar_activity", (q) =>
          q.eq("scholarId", scholarId).eq("activityId", activityId),
        )
        .collect();
      existing =
        legacy.find(
          (row) =>
            row.assignmentId === undefined &&
            String(row.sessionId ?? "") === String(sessionId),
        ) ??
        legacy.find(
          (row) =>
            row.assignmentId === undefined &&
            !row.sessionId &&
            row.unitId &&
            String(row.unitId) === String(session?.unitId ?? ""),
        ) ??
        null;
    } else if (!existing && !sessionId) {
      // Explicit-assignment, session-less path (the offline class write): adopt
      // an existing TRULY-BARE row (no session AND no assignment — e.g. a
      // scholar's own outline self-mark) rather than inserting a duplicate; the
      // patch below stamps the assignment on. A row carrying a sessionId is NOT
      // adopted even when its assignmentId is unset: that session may belong to
      // ANOTHER assignment run (session.assignmentId set, row un-backfilled), so
      // adopting it would steal that run's completion for this assignment. When
      // no bare row exists we insert a fresh one instead.
      const legacy = await ctx.db
        .query("activityCompletions")
        .withIndex("by_scholar_activity", (q) =>
          q.eq("scholarId", scholarId).eq("activityId", activityId),
        )
        .collect();
      existing =
        legacy.find((row) => row.assignmentId === undefined && !row.sessionId) ??
        null;
    }
  } else {
    const candidates = await ctx.db
      .query("activityCompletions")
      .withIndex("by_scholar_activity", (q) =>
        q.eq("scholarId", scholarId).eq("activityId", activityId),
      )
      .collect();
    for (const row of candidates) {
      if (row.assignmentId !== undefined) continue;
      if (sessionId && String(row.sessionId ?? "") === String(sessionId)) {
        existing = row;
        break;
      }
      if (!row.sessionId) {
        existing ??= row;
        continue;
      }
      const rowSession = await ctx.db.get(row.sessionId);
      if (rowSession?.assignmentId === undefined) existing ??= row;
    }
  }

  if (existing) {
    await ctx.db.patch(existing._id, {
      completedAt: Date.now(),
      sessionId: sessionId ?? existing.sessionId,
      assignmentId: assignmentId ?? existing.assignmentId,
      note: note ?? existing.note,
    });
    return { completionId: existing._id, created: false };
  }

  const activity = await ctx.db.get(activityId);
  if (!activity) return { completionId: null, created: false };
  let unitId: Id<"units"> | undefined;
  let lessonId: Id<"lessons"> | undefined;
  if (activity.lessonId) {
    lessonId = activity.lessonId;
    const lesson = await ctx.db.get(activity.lessonId);
    if (lesson) unitId = lesson.unitId;
  }
  const completionId = await ctx.db.insert("activityCompletions", {
    scholarId,
    activityId,
    lessonId,
    unitId,
    completedAt: Date.now(),
    sessionId,
    assignmentId,
    note,
    source: args.source,
    action: args.action,
  });
  return { completionId, created: true };
}

/**
 * Fast-forward processState + stamp `session.activityCompletedAt` when an
 * activity is completed. Idempotent — a second call is a no-op. Shared by every
 * completion path (rubric pass, advance-rubric pass, and the conversation-only
 * `mark_activity_complete` tool) so the celebration card fires and any process
 * pipeline lands on its terminal step.
 */
export async function fastForwardSessionCompletion(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
) {
  const session = await ctx.db.get(sessionId);
  if (!session) return;
  if (!session.activityCompletedAt) {
    await ctx.db.patch(sessionId, {
      activityCompletedAt: Date.now(),
      activityCompletionMessageId: undefined,
    });
  }
  await maybeMarkCompletedSeedsForSession(ctx, sessionId);
  const state = await ctx.db
    .query("processState")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .first();
  if (!state || state.steps.length === 0) return;
  const lastStep = state.steps[state.steps.length - 1];
  const allDone = state.steps.every((s) => s.status === "completed");
  if (allDone && state.currentStep === lastStep.key) return;
  await ctx.db.patch(state._id, {
    currentStep: lastStep.key,
    steps: state.steps.map((s) => ({ ...s, status: "completed" as const })),
  });
}

/**
 * THE single completion cascade — "one completion, one truth".
 *
 * Every path that completes an activity (the AI rubric pass, the advance-rubric
 * pass, the teacher manual override, the manual "Mark complete" toggle, and the
 * conversation-only `mark_activity_complete` tool) funnels through here, so the
 * canonical `activityCompletions` write and the four downstream ledgers it must
 * reconcile can never drift out of a single mutation:
 *
 *   1. `activityCompletions` — the canonical completion event (idempotent upsert).
 *   2. the unit badge — minted once when the unit is complete.
 *   3. the SESSION card state — `session.activityCompletedAt` (celebration card /
 *      focus-pin lift) + the `processState` step counter fast-forwarded to done.
 *   4. the SEED / quest state — the exploration seed(s) for this unit flipped to
 *      `completed` (so a finished quest is never re-suggested), covering both the
 *      session-linked seed AND any unit-linked teacher-quest offer.
 *
 * ATOMIC: it all runs inside the caller's mutation. IDEMPOTENT: every sub-step
 * no-ops when already done, so a re-mark (or a second completion path firing for
 * the same activity) is safe. Returns `{ completionId, created }` so the caller
 * can fire its OWN one-time side effects (Slack pings, class-digest regen) only
 * on a fresh completion — those stay with the writer, not in this shared core.
 */
export async function reconcileActivityCompletion(
  ctx: MutationCtx,
  args: {
    scholarId: Id<"users">;
    activityId: Id<"activities">;
    sessionId?: Id<"sessions">;
    assignmentId?: Id<"assignments">;
    note?: string;
    source?: "scholar_home";
    action?: "scholar_marked_take_home_done";
  },
): Promise<{ completionId: Id<"activityCompletions"> | null; created: boolean }> {
  // 1. Canonical event first — the ledger everything else projects from.
  const result = await upsertActivityCompletion(ctx, args);
  if (!result.completionId) return result;

  // 2. Badge (no-ops when already earned or the unit isn't complete yet).
  await maybeAwardUnitBadge(ctx, args.scholarId, args.activityId);

  // 3. Session card state: activityCompletedAt + processState fast-forward
  //    (also flips the session's own seed on unit completion). Skipped when
  //    there's no session (e.g. a teacher marking complete from the outline).
  if (args.sessionId) {
    await fastForwardSessionCompletion(ctx, args.sessionId);
  }

  // 4. Seed / quest reconciliation for the activity's unit — flips any
  //    unit-linked teacher-quest seed to `completed` too, so a completed quest
  //    never re-surfaces as a fresh "Suggested by your teacher" card. Runs even
  //    without a session (covers the outline / teacher-override paths).
  await maybeMarkCompletedSeedsForActivity(
    ctx,
    args.scholarId,
    args.activityId,
    args.sessionId,
  );

  return result;
}
