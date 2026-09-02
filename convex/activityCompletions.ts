import { v } from "convex/values";
import type { ActivityKind } from "../lib/activityKinds";
import {
  authedQuery,
  authedMutation,
  teacherQuery,
  teacherMutation,
} from "./lib/customFunctions";
import { requireTeacherOrSelf } from "./lib/auth";
import { isTeacherRole } from "./lib/roles";
import {
  requireActiveScholarAccess,
  filterToAccessibleScholars,
} from "./lib/access";
import { internalQuery, internalMutation } from "./_generated/server";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { reconcileActivityCompletion } from "./lib/activityCompletionCore";
import { isConversationCompletable } from "./lib/activityCompletionEligibility";
import type { Id, Doc } from "./_generated/dataModel";
import { fanOutScholarEvent, fanOutClassEvent, scholarDeepLink } from "./slackNotifications";
import { resolveAssignmentClass } from "./classResolver";

/**
 * List the scholar's completed activities within a unit. Returns an array of
 * activity IDs (with completedAt timestamps), suitable for marking checks
 * in the outline tree.
 */
export const listForScholarInUnit = authedQuery({
  args: {
    scholarId: v.optional(v.id("users")),
    unitId: v.id("units"),
    assignmentId: v.optional(v.id("assignments")),
  },
  handler: async (ctx, args) => {
    const scholarId = args.scholarId ?? ctx.user._id;
    // Gate cross-scholar reads: only a teacher/admin (or the scholar
    // themselves) may read a given scholar's completion record.
    const isTeacher = requireTeacherOrSelf(ctx.user, scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, scholarId);
    const rows = args.assignmentId
      ? await completionsForScopedUnit(
          ctx,
          scholarId,
          args.unitId,
          args.assignmentId,
        )
      : await completionsForUnassignedUnit(ctx, scholarId, args.unitId);
    return rows.map((r) => ({
      activityId: r.activityId,
      lessonId: r.lessonId,
      completedAt: r.completedAt,
    }));
  },
});

async function completionsForScopedUnit(
  ctx: Pick<QueryCtx, "db">,
  scholarId: Id<"users">,
  unitId: Id<"units">,
  assignmentId: Id<"assignments">,
) {
  const [scoped, unitCompletions] = await Promise.all([
    ctx.db
      .query("activityCompletions")
      .withIndex("by_scholar_assignment", (q) =>
        q.eq("scholarId", scholarId).eq("assignmentId", assignmentId),
      )
      .collect(),
    ctx.db
      .query("activityCompletions")
      .withIndex("by_scholar_unit", (q) =>
        q.eq("scholarId", scholarId).eq("unitId", unitId),
      )
      .collect(),
  ]);
  const rows = scoped.filter(
    (r) => r.unitId && String(r.unitId) === String(unitId),
  );
  for (const r of unitCompletions) {
    if (r.assignmentId !== undefined) continue;
    if (r.sessionId) {
      const session = await ctx.db.get(r.sessionId);
      if (String(session?.assignmentId ?? "") === String(assignmentId)) {
        rows.push(r);
      }
      continue;
    }
    const matchingSessions = await ctx.db
      .query("sessions")
      .withIndex("by_user", (q) => q.eq("userId", scholarId))
      .filter((q) => q.eq(q.field("activityId"), r.activityId))
      .collect();
    if (
      matchingSessions.some(
        (s) => String(s.assignmentId ?? "") === String(assignmentId),
      )
    ) {
      rows.push(r);
    }
  }
  return rows;
}

async function completionsForUnassignedUnit(
  ctx: Pick<QueryCtx, "db">,
  scholarId: Id<"users">,
  unitId: Id<"units">,
) {
  const candidates = (
    await ctx.db
      .query("activityCompletions")
      .withIndex("by_scholar_unit", (q) =>
        q.eq("scholarId", scholarId).eq("unitId", unitId),
      )
      .collect()
  ).filter((r) => r.assignmentId === undefined);
  const rows: typeof candidates = [];
  for (const r of candidates) {
    if (!r.sessionId) {
      const matchingAssignedSession = await ctx.db
        .query("sessions")
        .withIndex("by_user", (q) => q.eq("userId", scholarId))
        .filter((q) => q.eq(q.field("activityId"), r.activityId))
        .filter((q) => q.neq(q.field("assignmentId"), undefined))
        .first();
      if (matchingAssignedSession) continue;
      rows.push(r);
      continue;
    }
    const session = await ctx.db.get(r.sessionId);
    if (session?.assignmentId === undefined) rows.push(r);
  }
  return rows;
}

/**
 * Mark an activity complete for the current scholar (or, when called by a
 * teacher with a scholarId override, for that scholar). Idempotent — re-marks
 * just bump completedAt.
 */
export const markComplete = authedMutation({
  args: {
    activityId: v.id("activities"),
    scholarId: v.optional(v.id("users")),
    sessionId: v.optional(v.id("sessions")),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const scholarId = args.scholarId ?? ctx.user._id;
    const isTeacher = requireTeacherOrSelf(ctx.user, scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, scholarId);
    const activity = await ctx.db.get(args.activityId);
    if (!activity) throw new Error("Activity not found");
    // Quest-only activities have no lessonId. activityCompletions is the
    // lesson-completion stamp; we only record one when the activity is
    // anchored in a lesson. Quest progress is tracked via deliverables.
    if (!activity.lessonId) {
      throw new Error(
        "markComplete is only valid for lesson-anchored activities",
      );
    }
    const lessonId = activity.lessonId;
    const lesson = await ctx.db.get(lessonId);
    if (!lesson) throw new Error("Lesson not found");

    const session = args.sessionId ? await ctx.db.get(args.sessionId) : null;
    if (args.sessionId) {
      if (!session) throw new Error("Session not found");
      if (String(session.userId) !== String(scholarId)) {
        throw new Error("Session does not belong to scholar");
      }
      if (String(session.activityId ?? "") !== String(args.activityId)) {
        throw new Error("Session does not match activity");
      }
    }

    // Upsert + full reconciliation via the shared completion core (canonical
    // row → badge → session card state incl. activityCompletedAt + processState
    // fast-forward → seed/quest completion). Activity + lesson are validated
    // above, so this always resolves to a row. Atomic + idempotent: a re-mark
    // just bumps completedAt and re-checks the downstream ledgers.
    const { completionId, created } = await reconcileActivityCompletion(ctx, {
      scholarId,
      activityId: args.activityId,
      sessionId: args.sessionId,
      note: args.note,
    });
    if (!completionId) throw new Error("Failed to record completion");

    if (!created) return completionId;

    // Slack: fresh completions ping any group channel this scholar's
    // groups opted into (no-op when nothing is linked).
    const scholar = await ctx.db.get(scholarId);
    const unit = await ctx.db.get(lesson.unitId);
    const assignmentClass = session?.assignmentId
      ? await resolveAssignmentClass(
          ctx,
          session.assignmentId,
          args.activityId,
        )
      : null;
    await fanOutScholarEvent(ctx, {
      scholarId,
      text: `*${scholar?.name ?? "A scholar"}* completed *${activity.title}*${unit ? ` (${unit.title})` : ""} — <${scholarDeepLink(scholarId)}|open>`,
      subject: assignmentClass?.subject,
    });

    // Class Digest: prompt-path auto-(re)generation. The cron sweep is the
    // safety net; this fires it promptly when the completing project tells
    // us the assignment. Debounced + threshold-gated inside
    // maybeAutoGenerate, so calling on every completion is safe.
    if (args.sessionId) {
      const proj = await ctx.db.get(args.sessionId);
      if (proj?.assignmentId) {
        await ctx.scheduler.runAfter(
          0,
          internal.classDigests.maybeAutoGenerate,
          {
            scope: "activity",
            assignmentId: proj.assignmentId,
            activityId: args.activityId,
          },
        );
        await ctx.scheduler.runAfter(
          0,
          internal.classDigests.maybeAutoGenerate,
          { scope: "cohort", assignmentId: proj.assignmentId },
        );
      }
    }

    return completionId;
  },
});

/**
 * Tutor-tool write path: complete a CONVERSATION-ONLY online activity
 * (kind="online", no deliverable, no advanceRubric) when the `mark_activity_complete`
 * tool fires. Deliverable / advance-rubric activities complete via the
 * `update_rubric_score` cascade instead; a conversation-only activity has no
 * automatic completion writer, so without this the Home "due" count and the
 * live class focus (assignments.scholarCompletedFocusActivity) never clear.
 *
 * Never trusts the stream: the whole gate is re-validated server-side, and on a
 * failure it returns a STRUCTURED refusal ({ ok:false, reason, message }) rather
 * than throwing — a raw tool error must never reach a scholar (see the
 * scholar-safe redaction in lib/toolActivityGroups). Idempotent: a second call
 * is a no-op success.
 */
export const markCompleteFromTool = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    summary: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const refuse = (reason: string, message: string) =>
      ({ ok: false as const, reason, message });

    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      return refuse(
        "no_session",
        "That activity session no longer exists — don't say anything special to the scholar; just keep going.",
      );
    }
    // A test drive (teacher rehearsal) must never write a real completion —
    // mirrors the observer / dossier / rubric test-drive guards.
    if (session.isTestDrive) {
      return refuse(
        "test_drive",
        "This is a rehearsal (test drive), so completion isn't recorded. Just wrap up the conversation naturally.",
      );
    }
    if (!session.activityId) {
      return refuse(
        "no_activity",
        "This session isn't anchored to an activity, so there's nothing to mark complete. Keep exploring with the scholar.",
      );
    }
    const activity = await ctx.db.get(session.activityId);
    if (!activity) {
      return refuse(
        "no_activity",
        "The activity for this session is missing, so there's nothing to mark complete.",
      );
    }
    // Only an eligible online activity uses this path. Keep the
    // granular refusals (they give the tutor actionable next steps), then defer
    // the lesson-vs-ad-hoc anchoring decision to the shared eligibility gate so
    // it can never drift from the tool-exposure gate in sessionHelpers.
    if (activity.kind !== "online") {
      return refuse(
        "not_conversation_activity",
        "This isn't a conversation activity you can mark complete this way. Keep going.",
      );
    }
    if (activity.advanceRubric) {
      return refuse(
        "has_advance_rubric",
        "This activity is completed by scoring its ready-to-advance rubric with update_rubric_score, not by marking it complete. Score the rubric instead.",
      );
    }
    // Authoritative eligibility: lesson-anchored, OR a lesson-less ad-hoc
    // dispatch whose assignment schedule references this activity. A bare
    // lesson-less activity with no such dispatch still can't complete this way.
    if (!(await isConversationCompletable(ctx, session, activity))) {
      return refuse(
        "not_conversation_activity",
        "This isn't a conversation activity you can mark complete this way. Keep going.",
      );
    }
    if (session.activityCompletedAt) {
      return { ok: true as const, alreadyComplete: true };
    }

    // Guard against premature completion: a conversation-only activity needs the
    // scholar to have actually engaged. Require at least two scholar (role
    // "user") turns before we write the completion — excluding the synthetic
    // "<start>" auto-opener the web client sends, which is persisted as a user
    // row but isn't a real scholar turn (same convention as getSessionContext).
    // Walks the index and stops at 2 — never reads the whole transcript.
    let userTurns = 0;
    for await (const m of ctx.db
      .query("messages")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))) {
      if (m.role === "user" && m.content !== "<start>") {
        userTurns++;
        if (userTurns >= 2) break;
      }
    }
    if (userTurns < 2) {
      return refuse(
        "too_early",
        "It's too early to wrap this up — the scholar has barely started. Keep drawing out their thinking; don't mark it complete yet.",
      );
    }

    // Run the SAME single completion cascade as every other path (canonical
    // row → unit badge → session card state incl. activityCompletedAt +
    // processState fast-forward → seed/quest completion), so a tutor completion
    // reconciles every ledger identically to the other completion paths.
    await reconcileActivityCompletion(ctx, {
      scholarId: session.userId,
      activityId: session.activityId,
      sessionId: args.sessionId,
      note: args.summary?.trim() ? args.summary.trim().slice(0, 500) : undefined,
    });

    return { ok: true as const, alreadyComplete: false };
  },
});

export const unmarkComplete = authedMutation({
  args: {
    activityId: v.id("activities"),
    scholarId: v.optional(v.id("users")),
    sessionId: v.optional(v.id("sessions")),
  },
  handler: async (ctx, args) => {
    const scholarId = args.scholarId ?? ctx.user._id;
    const isTeacher = requireTeacherOrSelf(ctx.user, scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, scholarId);
    const session = args.sessionId ? await ctx.db.get(args.sessionId) : null;
    if (args.sessionId) {
      if (!session) throw new Error("Session not found");
      if (String(session.userId) !== String(scholarId)) {
        throw new Error("Session does not belong to scholar");
      }
      if (String(session.activityId ?? "") !== String(args.activityId)) {
        throw new Error("Session does not match activity");
      }
    }
    const candidates = await ctx.db
      .query("activityCompletions")
      .withIndex("by_scholar_activity", (q) =>
        q.eq("scholarId", scholarId).eq("activityId", args.activityId),
      )
      .collect();
    let existing: Doc<"activityCompletions"> | undefined;
    if (session?.assignmentId) {
      existing =
        candidates.find(
          (c) => String(c.assignmentId ?? "") === String(session.assignmentId),
        ) ??
        candidates.find((c) => String(c.sessionId ?? "") === String(args.sessionId)) ??
        candidates.find(
          (c) =>
            c.assignmentId === undefined &&
            !c.sessionId &&
            c.unitId &&
            String(c.unitId) === String(session.unitId ?? ""),
        );
    } else {
      for (const c of candidates) {
        if (args.sessionId && String(c.sessionId ?? "") === String(args.sessionId)) {
          existing = c;
          break;
        }
        if (c.assignmentId !== undefined) continue;
        if (!c.sessionId) {
          existing ??= c;
          continue;
        }
        const completedSession = await ctx.db.get(c.sessionId);
        if (completedSession?.assignmentId === undefined) existing ??= c;
      }
    }
    if (!existing) return;
    const inferredBareIds =
      session?.assignmentId && session.unitId
        ? candidates
            .filter(
              (c) =>
                c._id !== existing._id &&
                c.assignmentId === undefined &&
                !c.sessionId &&
                c.unitId &&
                String(c.unitId) === String(session.unitId),
            )
            .map((c) => c._id)
        : [];
    // Mirror the un-mark on the project: if we recorded which
    // project produced this completion AND that project still has
    // activityCompletedAt set, clear it so the celebration card +
    // focus-pin-hide flip back. Idempotent.
    const completedSessionId = existing.sessionId ?? args.sessionId;
    if (completedSessionId) {
      const completedSession =
        session && String(session._id) === String(completedSessionId)
          ? session
          : await ctx.db.get(completedSessionId);
      if (completedSession?.activityCompletedAt) {
        await ctx.db.patch(completedSessionId, {
          activityCompletedAt: undefined,
          activityCompletionMessageId: undefined,
        });
      }
    }
    await ctx.db.delete(existing._id);
    for (const id of inferredBareIds) {
      await ctx.db.delete(id);
    }
  },
});

/**
 * Mark ONE activity complete for a whole CLASS in one write — the [Yes — mark as
 * done] answer to "Did this activity happen?" (§7 of
 * review/unit-flow-into-class-plan.html). This is the missing write path for
 * OFFLINE class activities: without it the schedule UI can't record that offline
 * work happened, so badges / digests / due-counts never fire.
 *
 * Loops the SAME shared `reconcileActivityCompletion` core per scholar (canonical
 * row → badge → seed/quest ledgers, idempotent), defaulting to the assignment's
 * active roster with a provided `scholarIds` letting the teacher uncheck
 * absentees. Always intersects with the roster (never marks a non-member). The
 * per-scholar Slack fan-out is COLLAPSED to one class-level message per linked
 * channel via `fanOutClassEvent`, so 12 completions don't spam the channel. The
 * plan layer (activitySchedule / live push) is deliberately untouched — this
 * writes the learning record only.
 */
async function coreMarkCompleteForGroup(
  ctx: MutationCtx,
  actor: Doc<"users">,
  args: {
    assignmentId: Id<"assignments">;
    activityId: Id<"activities">;
    scholarIds?: Id<"users">[];
    note?: string;
  },
): Promise<{ marked: number; created: number }> {
  const assignment = await ctx.db.get(args.assignmentId);
  if (!assignment) throw new Error("Assignment not found");
  const activity = await ctx.db.get(args.activityId);
  if (!activity) throw new Error("Activity not found");
  const isAdHocOfflineHomework =
    assignment.kind === "adHocDispatch" &&
    activity.kind === "offline" &&
    assignment.activitySchedule?.some(
      (entry) =>
        String(entry.activityId) === String(activity._id) &&
        entry.mode === "homework",
    );
  // The one lesson-less completion is ad-hoc offline homework. It has an
  // explicit assignment scope and no session, so the teacher closes it through
  // the same roster completion path used for teacher-run offline class work.
  if (!activity.lessonId && !isAdHocOfflineHomework) {
    throw new Error(
      "markCompleteForGroup is only valid for lesson-anchored activities",
    );
  }

  const roster = new Set((assignment.scholarIds ?? []).map(String));
  // Default = the whole active roster; a provided list unchecks absentees.
  // Always intersect with the roster so a stale/foreign id can't slip through.
  const requested = (args.scholarIds ?? assignment.scholarIds ?? []).filter(
    (id) => roster.has(String(id)),
  );

  // INSTITUTION BOUNDARY (same boundary markComplete/unmarkComplete enforce),
  // with roster-aware semantics because a class group can legitimately span
  // institutions (the seed's 🌊 3-5 group does):
  //   • EXPLICIT scholarIds → hard per-scholar throw BEFORE any write. The
  //     caller named scholars; naming one outside your context fails the whole
  //     mutation (no partial cross-boundary writes, and a foreign-assignment
  //     attack stays loud).
  //   • DEFAULT (ids omitted, "mark it done for my class") → silently intersect
  //     the roster with the actor's accessible set. You can't cross the
  //     boundary by omission: a wholly-foreign assignment intersects to ∅ —
  //     zero writes, zero Slack — while a mixed-roster class marks exactly the
  //     scholars in your context.
  let targetIds: Id<"users">[];
  if (args.scholarIds) {
    for (const scholarId of requested) {
      await requireActiveScholarAccess(ctx, actor, scholarId);
    }
    targetIds = requested;
  } else {
    targetIds = await filterToAccessibleScholars(ctx, actor, requested);
  }

  let created = 0;
  for (const scholarId of targetIds) {
    const { created: fresh } = await reconcileActivityCompletion(ctx, {
      scholarId,
      activityId: args.activityId,
      // Stamp the run: without it, "already done" bleeds across future runs
      // of the same unit with the same scholars (the schema's exact warning).
      assignmentId: args.assignmentId,
      note: args.note,
    });
    if (fresh) created++;
  }

  if (created > 0) {
    const lesson = activity.lessonId ? await ctx.db.get(activity.lessonId) : null;
    const unit = lesson?.unitId ? await ctx.db.get(lesson.unitId) : null;
    const assignmentClass = await resolveAssignmentClass(
      ctx,
      args.assignmentId,
      args.activityId,
    );
    // ONE class-level Slack message per linked channel (not one per scholar).
    await fanOutClassEvent(ctx, {
      scholarIds: targetIds,
      subject: assignmentClass?.subject,
      makeText: (group) =>
        `${group.emoji ? `${group.emoji} ` : "🐦 "}*${group.name}* completed *${activity.title}*${unit ? ` (${unit.title})` : ""}`,
    });
    // Class Digest: prompt-path auto-(re)generation (debounced + threshold-gated
    // inside maybeAutoGenerate, so firing on the class mark is safe).
    await ctx.scheduler.runAfter(0, internal.classDigests.maybeAutoGenerate, {
      scope: "activity",
      assignmentId: args.assignmentId,
      activityId: args.activityId,
    });
    await ctx.scheduler.runAfter(0, internal.classDigests.maybeAutoGenerate, {
      scope: "cohort",
      assignmentId: args.assignmentId,
    });
  }

  return { marked: targetIds.length, created };
}

export const markCompleteForGroup = teacherMutation({
  args: {
    assignmentId: v.id("assignments"),
    activityId: v.id("activities"),
    scholarIds: v.optional(v.array(v.id("users"))),
    note: v.optional(v.string()),
  },
  handler: (ctx, args) => coreMarkCompleteForGroup(ctx, ctx.user, args),
});

/** Bot-tool parity (mark_class_activity_done): the verified-caller wrapper. */
export const aideMarkCompleteForGroup = internalMutation({
  args: {
    callerUserId: v.id("users"),
    assignmentId: v.id("assignments"),
    activityId: v.id("activities"),
    scholarIds: v.optional(v.array(v.id("users"))),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { callerUserId, ...args }) => {
    const caller = await ctx.db.get(callerUserId);
    if (!caller || !isTeacherRole(caller.role)) {
      throw new Error("Forbidden: teacher/admin only");
    }
    return coreMarkCompleteForGroup(ctx, caller, args);
  },
});

/** Roster (scholar id + name) for an assignment — feeds the "Did this activity
 *  happen?" dialog's uncheck-absentees checklist. Teacher-gated AND
 *  institution-scoped: a teacher may only read the roster of an assignment whose
 *  scholars are in their context — otherwise this leaks cross-institution PII
 *  (names + ids) on a role-only gate. Mirrors the per-scholar boundary
 *  listForScholarInUnit / markComplete enforce, but as a STRUCTURED refusal
 *  ({ forbidden: true }, no names) rather than a throw: this read prefills a
 *  drawer widget, and an uncaught useQuery throw takes down the whole route
 *  (the ErrorBoundary class from /verify-ui #8). Same
 *  precedent as markCompleteFromTool's structured refusal. The WRITE
 *  (markCompleteForGroup) keeps its hard per-scholar throw. */
export const rosterForAssignment = teacherQuery({
  args: { assignmentId: v.id("assignments") },
  handler: async (ctx, { assignmentId }) => {
    const empty = [] as { _id: Id<"users">; name: string }[];
    const a = await ctx.db.get(assignmentId);
    if (!a) return { scholars: empty, forbidden: false };
    // FILTER to the caller's context rather than refuse-on-first (a class group
    // can legitimately span institutions — the mixed-roster case). Nothing
    // foreign is named; `forbidden` is true only when the caller can access
    // NONE of a non-empty roster (a wholly-foreign assignment).
    const accessible = await filterToAccessibleScholars(
      ctx,
      ctx.user,
      a.scholarIds,
    );
    if (a.scholarIds.length > 0 && accessible.length === 0) {
      return { scholars: empty, forbidden: true };
    }
    const rows = await Promise.all(accessible.map((id) => ctx.db.get(id)));
    return {
      forbidden: false,
      scholars: rows
        .filter((u): u is Doc<"users"> => u != null)
        .map((u) => ({ _id: u._id, name: u.name ?? "Scholar" })),
    };
  },
});

/** Teacher tool: clear all completions in a unit for a scholar (rare, but useful for resetting). */
export const clearForScholarInUnit = teacherMutation({
  args: {
    scholarId: v.id("users"),
    unitId: v.id("units"),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("activityCompletions")
      .withIndex("by_scholar_unit", (q) =>
        q.eq("scholarId", args.scholarId).eq("unitId", args.unitId),
      )
      .collect();
    for (const r of rows) await ctx.db.delete(r._id);
  },
});

// ── Internal helpers ─────────────────────────────────────────────────

/**
 * Quick read for test fixtures / debug — list completion rows for a
 * given (scholar, activity). Internal-only because no auth context.
 */
export const listForScholarActivityInternal = internalQuery({
  args: {
    scholarId: v.id("users"),
    activityId: v.id("activities"),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("activityCompletions")
      .withIndex("by_scholar_activity", (q) =>
        q.eq("scholarId", args.scholarId).eq("activityId", args.activityId),
      )
      .collect();
  },
});

/**
 * Return a structured summary of a scholar's completed activities in a unit,
 * with full activity details for system-prompt construction.
 */
export const summaryForScholarInUnit = internalQuery({
  args: {
    scholarId: v.id("users"),
    unitId: v.id("units"),
  },
  handler: async (ctx, args) => {
    const completions = await ctx.db
      .query("activityCompletions")
      .withIndex("by_scholar_unit", (q) =>
        q.eq("scholarId", args.scholarId).eq("unitId", args.unitId),
      )
      .collect();

    const enriched: Array<{
      activityId: Id<"activities">;
      lessonId: Id<"lessons">;
      completedAt: number;
      title: string;
      kind: ActivityKind;
      description: string | null;
      lessonTitle: string;
      note: string | null;
    }> = [];

    for (const c of completions) {
      // This summary is keyed on (scholarId, unitId), so completions
      // missing a lessonId (scholar-scoped tasks) wouldn't be in
      // scope anyway. Skip defensively.
      if (!c.lessonId) continue;
      const a = (await ctx.db.get(c.activityId)) as Doc<"activities"> | null;
      const l = (await ctx.db.get(c.lessonId)) as Doc<"lessons"> | null;
      if (!a || !l) continue;
      enriched.push({
        activityId: c.activityId,
        lessonId: c.lessonId,
        completedAt: c.completedAt,
        title: a.title,
        kind: a.kind,
        description: a.description ?? null,
        lessonTitle: l.title,
        note: c.note ?? null,
      });
    }

    enriched.sort((a, b) => a.completedAt - b.completedAt);
    return enriched;
  },
});
