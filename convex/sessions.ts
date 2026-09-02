import { v } from "convex/values";
import {
  sessionModeForActivityKind,
  type ActivityKind,
} from "../lib/activityKinds";
import { authedQuery, authedMutation, teacherMutation, teacherQuery } from "./lib/customFunctions";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { chosenPathValidator } from "./bakeUnitFromSeed";
import type { ChosenPath } from "./bakeUnitFromSeed";
import {
  ROLES,
  isStaffRole,
  isTeacherRole,
} from "./lib/roles";
import { MODELS } from "./lib/models";
import { requireAnthropicApiKey } from "./lib/anthropic";
import { recordAnthropicUsage } from "./usage";
import {
  buildReplayScript,
  computeReplayStopAfter,
} from "./lib/testDriveReplay";
import { granuleTexts } from "./lib/granules";
import {
  firstIncompleteLaunchableActivityInUnit,
  firstIncompleteSessionActivityInUnit,
  isSessionActivityComplete,
} from "./lib/scholarReads";
import {
  requireActiveScholarAccess,
  resolveActiveMembership,
} from "./lib/access";
import { isProgramGuest } from "./lib/enrollmentStanding";
import { assignedProgramAssignmentForUnit } from "./lib/programGuestWork";
import {
  mintIndependentStudyUnit,
  questTitleFromSessionTitle,
  NEW_SESSION_TITLE,
} from "./lib/independentStudy";
import { computePromptVersion } from "./lib/promptVersion";
import {
  institutionPromptProfileForScholar,
  DEFAULT_INSTITUTION_PROMPT_PROFILE,
  type InstitutionPromptProfile,
} from "./lib/institutionPromptProfile";
import { deleteSessionAppStates } from "./appStates";
import { ensureOfflineSession } from "./portfolioMaterialize";
import { entryTargetsScholar, isLiveEntry } from "./assignments";
import {
  hasReadableOfflineHomeworkContent,
  resolveReachableActivityResources,
} from "./lib/activityResourceReachability";
import {
  ensureSessionActivitySetup,
  ensureSessionProcessState,
} from "./lib/sessionActivitySetup";
import { inputModalityValidator } from "./lib/inputModality";
import { rubricStarsEarned } from "../shared/rubricScore";
import {
  hasScholarMembership,
  requireActiveLearnerInstitution,
  requireActiveSessionOwnerInstitution,
  requireUnitInLearnerInstitution,
} from "./lib/scholarEnrollment";
import { TIME_LIMIT_WRAP_GUIDANCE } from "./lib/tutorClosingGuidance";

/** Parent password for time limit mode (set via PARENT_PASSWORD env var in Convex dashboard). */
const PARENT_PASSWORD = process.env.PARENT_PASSWORD ?? "";

async function findActiveSessionForScopedActivity(
  ctx: Pick<MutationCtx, "db">,
  userId: Id<"users">,
  activityId: Id<"activities">,
  assignmentId?: Id<"assignments">,
) {
  const sessions = await ctx.db
    .query("sessions")
    .withIndex("by_user_and_archived", (q) =>
      q.eq("userId", userId).eq("isArchived", false),
    )
    .collect();
  return (
    sessions.find(
      (session) =>
        !session.isTestDrive &&
        !session.isOffline &&
        !session.seedExemplar &&
        session.activityId &&
        String(session.activityId) === String(activityId) &&
        (assignmentId
          ? String(session.assignmentId ?? "") === String(assignmentId)
          : session.assignmentId === undefined),
    ) ?? null
  );
}

async function dispatchCompletionReceiptForSession(
  ctx: QueryCtx,
  session: Doc<"sessions">,
) {
  if (
    !session.activityCompletedAt ||
    !session.activityId ||
    !session.assignmentId
  ) {
    return [];
  }
  const assignment = await ctx.db.get(session.assignmentId);
  if (!assignment) return [];
  const scheduledEntry = assignment.activitySchedule?.find(
    (entry) =>
      entry.activityId === session.activityId &&
      entry.setAt != null,
  );
  if (!scheduledEntry) return [];

  const completion = await ctx.db
    .query("activityCompletions")
    .withIndex("by_scholar_assignment", (q) =>
      q
        .eq("scholarId", session.userId)
        .eq("assignmentId", assignment._id),
    )
    .filter((q) => q.eq(q.field("activityId"), session.activityId))
    .first();
  if (!completion) return [];

  const teacher = await ctx.db.get(assignment.teacherId);
  if (!teacher?.name) {
    console.error(
      `Cannot render dispatch receipt for assignment ${assignment._id}: teacher ${assignment.teacherId} has no display name`,
    );
    return [];
  }
  return [{ assignmentId: assignment._id, teacherName: teacher.name }];
}

async function validateAssignmentScope(
  ctx: Pick<MutationCtx, "db">,
  assignmentId: Id<"assignments"> | undefined,
  ownerUserId: Id<"users">,
  unitId?: Id<"units">,
  activityId?: Id<"activities">,
) {
  if (!assignmentId) return undefined;
  const assignment = await ctx.db.get(assignmentId);
  if (!assignment) throw new Error("Assignment not found");
  if (assignment.archivedAt) throw new Error("Assignment is archived");
  if (!assignment.scholarIds.some((id) => String(id) === String(ownerUserId))) {
    throw new Error("Assignment does not include scholar");
  }

  if (unitId && String(assignment.unitId) !== String(unitId)) {
    throw new Error("Assignment does not match unit");
  }
  if (activityId) {
    const activity = await ctx.db.get(activityId);
    if (!activity) {
      throw new Error("Assignment activity is not available");
    }
    if (activity.lessonId) {
      // Lesson-authored activity: it must belong to the assignment's unit.
      const lesson = await ctx.db.get(activity.lessonId);
      if (!lesson || String(lesson.unitId) !== String(assignment.unitId)) {
        throw new Error("Assignment does not match activity");
      }
    } else {
      // Lesson-less activity (an ad-hoc dispatch — see assignments.ts
      // coreDispatchActivity). There's no lesson→unit chain to anchor to, so
      // the assignment's own activitySchedule IS the authorization anchor:
      // the activity must be referenced there. Never accept an arbitrary
      // lesson-less activityId the assignment doesn't schedule.
      const referenced = (assignment.activitySchedule ?? []).some(
        (e) => String(e.activityId) === String(activityId),
      );
      if (!referenced) {
        throw new Error("Assignment does not match activity");
      }
    }
    if (assignment.selfPaced) return assignmentId;
    const now = Date.now();
    const liveEntry = (assignment.activitySchedule ?? []).find(
      (entry) =>
        String(entry.activityId) === String(activityId) &&
        entry.setAt != null &&
        (entry.endsAt == null || entry.endsAt > now),
    );
    if (!liveEntry) {
      throw new Error("Assignment activity is not live");
    }
    if (!entryTargetsScholar(liveEntry, ownerUserId)) {
      throw new Error("Assignment activity is not live for scholar");
    }
  }
  return assignmentId;
}

/**
 * Open the read-only, full-screen container for a live offline homework task.
 * Unlike `create`, this deliberately creates neither a tutor conversation nor
 * any completion evidence; scanner materialization owns the latter.
 */
export const openOfflineHomework = authedMutation({
  args: {
    activityId: v.id("activities"),
    assignmentId: v.id("assignments"),
    userId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const isTeacher = isTeacherRole(ctx.user.role);
    const ownerUserId =
      isTeacher && args.userId ? args.userId : ctx.user._id;
    if (isTeacher && ownerUserId !== ctx.user._id) {
      await requireActiveScholarAccess(ctx, ctx.user, ownerUserId);
    }

    const activity = await ctx.db.get(args.activityId);
    if (!activity) throw new Error("Activity not found");
    if (activity.kind !== "offline") {
      throw new Error("Activity is not offline homework");
    }
    await validateAssignmentScope(
      ctx,
      args.assignmentId,
      ownerUserId,
      undefined,
      args.activityId,
    );

    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) throw new Error("Assignment not found");
    const now = Date.now();
    const entry = (assignment.activitySchedule ?? []).find(
      (candidate) =>
        String(candidate.activityId) === String(args.activityId) &&
        candidate.mode === "homework" &&
        isLiveEntry(candidate, now) &&
        entryTargetsScholar(candidate, ownerUserId),
    );
    if (!entry) throw new Error("Offline homework is not live for scholar");
    if (!(await hasReadableOfflineHomeworkContent(ctx, activity))) {
      throw new Error("Offline homework needs instructions or materials");
    }

    return {
      id: await ensureOfflineSession(
        ctx,
        ownerUserId,
        args.activityId,
        args.assignmentId,
      ),
    };
  },
});

async function requireActiveSessionOwnerAccess(
  ctx: Parameters<typeof requireActiveScholarAccess>[0] & { user: Doc<"users"> },
  session: Doc<"sessions">,
) {
  await requireActiveSessionOwnerInstitution(ctx, ctx.user, session);
  const accessScholarId = session.isTestDrive
    ? session.testDriveAsScholarId
    : session.userId;
  if (!accessScholarId || accessScholarId === ctx.user._id) return;
  // Enforce for EVERY non-owner caller — not just teacher/admin — so the
  // session-owner boundary actually closes for operations staff / curriculum_designer /
  // another scholar once enforcement is on. requireActiveScholarAccess
  // fail-closes the non-staff + wrong-institution cases and no-ops while off.
  await requireActiveScholarAccess(ctx, ctx.user, accessScholarId);
}

/**
 * List sessions for a user (non-archived, most recent first).
 * Teachers can pass userId to view a scholar's sessions (remote mode).
 */
/**
 * Lean fetch of a single session by id. Used by the scholar's
 * UnitProgressNavigator to read unit/lesson/activity references without
 * pulling messages.
 */
export const get = authedQuery({
  args: { id: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.id);
    if (!session) return null;
    const isTeacher =
      isTeacherRole(ctx.user.role);
    if (!isTeacher && session.userId !== ctx.user._id) return null;
    await requireActiveSessionOwnerAccess(ctx, session);
    return session;
  },
});

/**
 * Enrich a raw session row into the shape the scholar's session-card surfaces
 * expect: unit title/emoji, a (deprecated, always-null) persona emoji, and a
 * user+assistant message count. Shared by `list` and `finishedForScholar` so
 * both lists render identical cards.
 */
async function enrichSessionForList(
  ctx: { db: QueryCtx["db"] },
  session: Doc<"sessions">,
) {
  let unitTitle: string | null = null;
  let unitEmoji: string | null = null;
  // DEPRECATED (anti-parasocial): personas are deprecated, so session
  // cards no longer surface a persona emoji even for legacy persona-wired
  // units. Kept in the return shape (always null) for reversibility.
  // See TODO.html "Reimagine personas (parasocially-safe)".
  const personaEmoji: string | null = null;
  if (session.unitId) {
    const unit = await ctx.db.get(session.unitId);
    unitTitle = unit?.title ?? null;
    unitEmoji = unit?.emoji ?? null;
  }
  const messages = await ctx.db
    .query("messages")
    .withIndex("by_session", (q) => q.eq("sessionId", session._id))
    .collect();
  const messageCount = messages.filter(
    (m) => m.role === "user" || m.role === "assistant",
  ).length;

  return {
    ...session,
    id: session._id,
    updatedAt: session._creationTime,
    personaEmoji,
    unitTitle,
    unitEmoji,
    messageCount,
  };
}

export const list = authedQuery({
  args: {
    userId: v.optional(v.id("users")),
    asLearner: v.optional(v.boolean()),
    // Default: only active (non-archived) sessions. Set to "archived" to get
    // just the archived ones (for the Finished section on /scholar). Set to
    // "all" to get both.
    archivedFilter: v.optional(
      v.union(
        v.literal("active"),
        v.literal("archived"),
        v.literal("all"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const isTeacher =
      isTeacherRole(ctx.user.role);
    const targetUserId =
      isTeacher && args.userId ? args.userId : ctx.user._id;
    if (isTeacher && args.userId && targetUserId !== ctx.user._id) {
      await requireActiveScholarAccess(ctx, ctx.user, targetUserId);
    }
    const learnerMode =
      targetUserId === ctx.user._id &&
      (args.asLearner ?? !isStaffRole(ctx.user.role));
    const learnerInstitutionId = learnerMode
      ? await requireActiveLearnerInstitution(ctx, targetUserId)
      : null;
    const canReadUnstampedLearnerSessions =
      learnerMode && (await hasScholarMembership(ctx, targetUserId));
    const archivedFilter = args.archivedFilter ?? "active";

    const baseQuery = ctx.db.query("sessions");
    const sessions = (
      archivedFilter === "all"
        ? await baseQuery
            .withIndex("by_user", (q) => q.eq("userId", targetUserId))
            .order("desc")
            .collect()
        : await baseQuery
            .withIndex("by_user_and_archived", (q) =>
              q
                .eq("userId", targetUserId)
                .eq("isArchived", archivedFilter === "archived"),
            )
            .order("desc")
            .collect()
    )
      // Test-drive sessions are throwaway teacher dry-runs; offline sessions
      // are scanned-deliverable containers with no chat — never list either.
      // TODO: add isTestDrive to the by_user_and_archived index to avoid
      // the post-collect JS filter as test-drive volume grows.
      .filter(
        (session) =>
          !session.isTestDrive &&
          !session.isOffline &&
          (!learnerInstitutionId ||
            session.institutionId === learnerInstitutionId ||
            (session.institutionId === undefined &&
              canReadUnstampedLearnerSessions)),
      );

    return Promise.all(sessions.map((s) => enrichSessionForList(ctx, s)));
  },
});

/**
 * The scholar's "📦 Finished" list — every finished session they can KEEP
 * WORKING on (see hooks/useKeepWorking + sessions.reopen).
 *
 * `list({ archivedFilter: "archived" })` only ever caught sessions the scholar
 * had explicitly ARCHIVED. But a completed class-focus activity (a finished
 * writing doc, a completed card-sort) leaves its session ACTIVE — completion
 * lives outside the session (activityCompletions / scholarUnitBadges), so once
 * the unit has no next incomplete activity the plate drops the row (see
 * scholarPlate.activeForMe) and the finished work becomes unreachable: not on
 * the plate, not archived, so nowhere on Home. Round-4 pilot day-5: "no
 * scholar-facing way to reopen the finished … sessions."
 *
 * This returns BOTH classes, in one recency-sorted list:
 *   - archived sessions (the historical Finished contents), and
 *   - completed-but-not-archived sessions that carry a real document — i.e. the
 *     activity is complete, the unit has no remaining incomplete activity for
 *     the caller's surface (so the plate has genuinely dropped the row), the
 *     scholar has NOT already re-entered it (reopenedAt unset — those are back
 *     on the active plate), and it holds a non-empty artifact.
 *
 * Read-only; never touches completion state. Re-entry still goes through
 * sessions.reopen, which stamps reopenedAt and moves the row onto the active
 * plate — so a session leaves this list exactly when it becomes active again.
 * Each row carries `finishedKind` ("archived" | "completed") for the UI.
 */
export const finishedForScholar = authedQuery({
  args: {
    userId: v.optional(v.id("users")),
    asLearner: v.optional(v.boolean()),
    // Match the caller's plate drop-rule so a session never both shows as an
    // active continuation AND appears here. Both surfaces count session-backed
    // online, Simulator, and Vibecode work; native also counts embedded web
    // activities — exactly like scholarPlate.activeForMe.
    includeWebActivities: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const isTeacher = isTeacherRole(ctx.user.role);
    const targetUserId =
      isTeacher && args.userId ? args.userId : ctx.user._id;
    if (isTeacher && args.userId && targetUserId !== ctx.user._id) {
      await requireActiveScholarAccess(ctx, ctx.user, targetUserId);
    }
    const learnerMode =
      targetUserId === ctx.user._id &&
      (args.asLearner ?? !isStaffRole(ctx.user.role));
    const learnerInstitutionId = learnerMode
      ? await requireActiveLearnerInstitution(ctx, targetUserId)
      : null;
    const canReadUnstampedLearnerSessions =
      learnerMode && (await hasScholarMembership(ctx, targetUserId));
    const firstIncompleteActivityInUnit = args.includeWebActivities
      ? firstIncompleteLaunchableActivityInUnit
      : firstIncompleteSessionActivityInUnit;

    const all = (
      await ctx.db
        .query("sessions")
        .withIndex("by_user", (q) => q.eq("userId", targetUserId))
        .order("desc")
        .collect()
    ).filter(
      (session) =>
        !session.isTestDrive &&
        !session.isOffline &&
        !session.seedExemplar &&
        (!learnerInstitutionId ||
          session.institutionId === learnerInstitutionId ||
          (session.institutionId === undefined &&
            canReadUnstampedLearnerSessions)),
    );

    const finished: Array<{
      session: Doc<"sessions">;
      finishedKind: "archived" | "completed";
    }> = [];
    for (const session of all) {
      if (session.isArchived) {
        finished.push({ session, finishedKind: "archived" });
        continue;
      }
      // Completed-but-not-archived class-focus work. A scholar who already
      // chose "Keep working on this" (reopenedAt) is back on the active plate —
      // don't double-surface them here.
      if (session.reopenedAt) continue;
      if (!session.activityId || !session.unitId) continue;
      const complete = await isSessionActivityComplete(
        ctx,
        targetUserId,
        session,
      );
      if (!complete) continue;
      // Only when the plate has actually dropped the row (no next incomplete
      // activity in the unit for this caller's surface); otherwise the session
      // is still reachable as a continuation and would double-surface.
      const nextIncomplete = await firstIncompleteActivityInUnit(
        ctx,
        targetUserId,
        session.unitId,
        session.assignmentId,
      );
      if (nextIncomplete) continue;
      // Must carry a real document worth re-entering.
      const artifact = await ctx.db
        .query("artifacts")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .filter((q) => q.neq(q.field("content"), ""))
        .first();
      if (!artifact) continue;
      finished.push({ session, finishedKind: "completed" });
    }

    return Promise.all(
      finished.map(async ({ session, finishedKind }) => ({
        ...(await enrichSessionForList(ctx, session)),
        finishedKind,
      })),
    );
  },
});

/**
 * Get a session with its messages.
 */
export const getWithMessages = authedQuery({
  args: { id: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.id);
    if (!session) throw new Error("Session not found");

    // Access check: scholars can only view their own
    const isTeacher =
      isTeacherRole(ctx.user.role);
    if (!isTeacher && session.userId !== ctx.user._id) {
      throw new Error("Forbidden");
    }
    await requireActiveSessionOwnerAccess(ctx, session);

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_session", (q) =>
        q.eq("sessionId", args.id)
      )
      .order("asc")
      .collect();

    // Scholar "Rabbithole got this wrong" flags for this session, loaded once
    // and keyed by messageId. Surfaces the pro-skepticism signal to BOTH the
    // scholar (active control state + in-the-moment acknowledgment) and the
    // teacher (transcript badge in SessionViewer) — both read this query.
    const wrongFlags = await ctx.db
      .query("messageFlags")
      .withIndex("by_session", (q) => q.eq("sessionId", args.id))
      .collect();
    const wrongByMessage = new Map(
      wrongFlags.map((f) => [String(f.messageId), f.reason ?? null] as const)
    );
    const reachableResources = session.activityId
      ? (await resolveReachableActivityResources(ctx, session.activityId)).all
      : [];
    const reachableResourcesById = new Map(
      reachableResources.map((resource) => [String(resource._id), resource]),
    );
    const dispatchCompleted = await dispatchCompletionReceiptForSession(
      ctx,
      session,
    );

    return {
      session: {
        ...session,
        id: session._id,
      },
      messages: await Promise.all(
        messages.map(async (m) => {
          let resourceShare:
            | {
                resourceId: Id<"activityResources">;
                title: string;
                kind: "file" | "link" | "video";
                fileName: string | null;
                mimeType: string | null;
                url: string | null;
              }
            | null = null;
          if (m.role === "tool" && m.toolAction === "resource_share") {
            const resourceId = ctx.db.normalizeId(
              "activityResources",
              m.content,
            );
            const resource = resourceId
              ? reachableResourcesById.get(String(resourceId))
              : null;
            if (resource) {
              resourceShare = {
                resourceId: resource._id,
                title: resource.title,
                kind: resource.source.kind,
                fileName:
                  resource.source.kind === "file"
                    ? resource.source.fileName
                    : null,
                mimeType:
                  resource.source.kind === "file"
                    ? resource.source.mimeType
                    : null,
                url:
                  resource.source.kind === "file"
                    ? await ctx.storage.getUrl(
                        resource.source.fileStorageId,
                      )
                    : resource.source.url,
              };
            }
          }
          return {
            ...m,
            id: m._id,
            createdAt: m._creationTime,
            resourceShare,
            gotItWrong: wrongByMessage.has(String(m._id)),
            gotItWrongReason: wrongByMessage.get(String(m._id)) ?? undefined,
          };
        }),
      ),
      dispatchCompleted,
    };
  },
});

/**
 * Create a new session.
 */
/**
 * Lean query for the right-panel DeliverableStatusCard: returns the
 * session's per-scholar criteria snapshot (auto-mode) and the
 * generation status. Falls through to the activity's criteria when
 * the session doesn't carry a snapshot (manual mode).
 *
 * Returns null when the session doesn't exist or doesn't have an
 * activity with a deliverable.
 */
/**
 * Lean query for the compass-button drawer: the big-picture
 * reflection + generation status. Also returns the deterministic
 * tree-view location (unit + lesson + activity, each with position
 * in the parent — "Lesson 3 of 5", "Activity 1 of 2") so the
 * drawer's "Where you are" section can render meaningful structure.
 */
export const getBigPicture = authedQuery({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return null;
    const isTeacher =
      isTeacherRole(ctx.user.role);
    if (!isTeacher && session.userId !== ctx.user._id) return null;
    await requireActiveSessionOwnerAccess(ctx, session);

    // Resolve the location chain with positions.
    type Loc = {
      unit: {
        id: Id<"units">;
        title: string;
        emoji: string | null;
      } | null;
      lesson: {
        id: Id<"lessons">;
        title: string;
        position: number;
        total: number;
      } | null;
      activity: {
        id: Id<"activities">;
        title: string;
        position: number;
        total: number;
      } | null;
    };
    const loc: Loc = { unit: null, lesson: null, activity: null };

    if (session.activityId) {
      const a = await ctx.db.get(session.activityId);
      if (a) {
        if (a.lessonId) {
          const l = await ctx.db.get(a.lessonId);
          if (l) {
            // Activity position = order within its lesson.
            const siblings = await ctx.db
              .query("activities")
              .withIndex("by_lesson", (q) => q.eq("lessonId", l._id))
              .collect();
            const sortedActs = siblings.sort((x, y) => x.order - y.order);
            const actIdx = sortedActs.findIndex((x) => x._id === a._id);
            loc.activity = {
              id: a._id,
              title: a.title,
              position: actIdx >= 0 ? actIdx + 1 : 1,
              total: sortedActs.length,
            };

            // Lesson position = order within its unit.
            const lessons = await ctx.db
              .query("lessons")
              .withIndex("by_unit", (q) => q.eq("unitId", l.unitId))
              .collect();
            const sortedLessons = lessons.sort((x, y) => x.order - y.order);
            const lessonIdx = sortedLessons.findIndex((x) => x._id === l._id);
            loc.lesson = {
              id: l._id,
              title: l.title,
              position: lessonIdx >= 0 ? lessonIdx + 1 : 1,
              total: sortedLessons.length,
            };

            const u = await ctx.db.get(l.unitId);
            if (u) loc.unit = { id: u._id, title: u.title, emoji: u.emoji ?? null };
          }
        } else {
          // Quest-anchored or scholar-scoped activity — no lesson chain.
          loc.activity = {
            id: a._id,
            title: a.title,
            position: 1,
            total: 1,
          };
        }
      }
    }

    // ── Build a unified "progress" view ─────────────────────────────
    // The Big Picture / Progress surfaces in two places (the drawer
    // and the full-screen route) share this shape so we can render
    // either with the same component.
    //
    // Only one frame remaining now that Quests are gone: lesson
    // progress. Independent Study Units are just regular units with
    // `authorScholarId` set, so they render through the same lesson
    // path. Scholar-scoped one-off tasks (legacy IS model) still
    // produce no frame — the drawer just shows the reflection.
    type ActivityRow = {
      activityId: Id<"activities">;
      sessionId: Id<"sessions"> | null;
      title: string;
      kind: ActivityKind;
      status: "passed" | "in-progress" | "not-started";
      starsEarned: number | null;
      starsTotal: number | null;
      isCurrent: boolean;
    };
    type LessonProgress = {
      kind: "lesson";
      unitId: Id<"units">;
      lessonId: Id<"lessons">;
      unitTitle: string;
      unitEmoji: string | null;
      lessonTitle: string;
      activities: ActivityRow[];
      currentActivityIndex: number;
      prevActivity: ActivityRow | null;
      nextActivity: ActivityRow | null;
    };
    let progress: LessonProgress | null = null;

    // Helper: resolve a session for (scholar, activity) — most recent
    // non-archived non-test-drive session owned by this scholar on
    // this activity. Used to make activity rows clickable in the UI.
    const findSessionForActivity = async (
      scholarId: Id<"users">,
      activityId: Id<"activities">,
    ): Promise<Id<"sessions"> | null> => {
      const rows = await ctx.db
        .query("sessions")
        .withIndex("by_user_and_archived", (q) =>
          q.eq("userId", scholarId).eq("isArchived", false),
        )
        .collect();
      const candidates = rows
        .filter(
          (r) =>
            !r.isTestDrive && !r.isOffline && r.activityId === activityId,
        )
        .sort((a, b) => b._creationTime - a._creationTime);
      return candidates[0]?._id ?? null;
    };

    // Helper: compute activity status from the canonical completion ledger.
    // - "passed" if there's an activityCompletions row.
    // - "in-progress" if a session exists for this (scholar, activity)
    //   but not passed.
    // - "not-started" otherwise.
    const computeStatus = async (
      scholarId: Id<"users">,
      activityId: Id<"activities">,
      sessionIdForActivity: Id<"sessions"> | null,
    ): Promise<"passed" | "in-progress" | "not-started"> => {
      const completion = await ctx.db
        .query("activityCompletions")
        .withIndex("by_scholar_activity", (q) =>
          q.eq("scholarId", scholarId).eq("activityId", activityId),
        )
        .first();
      if (completion) return "passed";
      if (sessionIdForActivity) return "in-progress";
      return "not-started";
    };

    // Helper: stars earned on an activity (best across this scholar's
    // sessions for that activity). Returns null when the activity has
    // no rubric, [earned, total] otherwise.
    const computeStars = async (
      scholarId: Id<"users">,
      activityId: Id<"activities">,
    ): Promise<{ earned: number; total: number } | null> => {
      const activity = await ctx.db.get(activityId);
      const criteria = activity?.deliverable?.criteria ?? null;
      if (!criteria) return null;
      const total = criteria.length;
      // Find all this scholar's sessions and the best per-artifact
      // deliverable for this activity.
      const sessions = await ctx.db
        .query("sessions")
        .withIndex("by_user_and_archived", (q) =>
          q.eq("userId", scholarId).eq("isArchived", false),
        )
        .collect();
      let best = 0;
      for (const session of sessions) {
        if (session.isTestDrive || session.isOffline) continue;
        const deliverables = await ctx.db
          .query("deliverables")
          .withIndex("by_session", (q) => q.eq("sessionId", session._id))
          .collect();
        for (const d of deliverables) {
          if (d.activityId !== activityId) continue;
          if (!d.verdicts) continue;
          // Score only the rubric's known criteria, taking the first verdict
          // for each so a stray or duplicate verdict cannot inflate the total.
          const earned = rubricStarsEarned(
            criteria.map(
              (criterion) =>
                d.verdicts?.find(
                  (verdict) => verdict.criterionId === criterion.id,
                )?.level,
            ),
          );
          if (earned > best) best = earned;
        }
      }
      return { earned: best, total };
    };

    // Lesson progress — every session rooted in a unit/lesson goes
    // through this branch (Quests are gone).
    if (loc.lesson && loc.unit && session.activityId) {
      const siblings = await ctx.db
        .query("activities")
        .withIndex("by_lesson", (q) =>
          q.eq("lessonId", loc.lesson!.id as Id<"lessons">),
        )
        .collect();
      const sorted = siblings.sort((a, b) => a.order - b.order);
      const activityRows: ActivityRow[] = [];
      for (const a of sorted) {
        const sessionForActivity = await findSessionForActivity(
          session.userId,
          a._id,
        );
        const status = await computeStatus(
          session.userId,
          a._id,
          sessionForActivity,
        );
        const stars = await computeStars(session.userId, a._id);
        activityRows.push({
          activityId: a._id,
          sessionId: sessionForActivity,
          title: a.title,
          kind: a.kind,
          status,
          starsEarned: stars?.earned ?? null,
          starsTotal: stars?.total ?? null,
          isCurrent: a._id === session.activityId,
        });
      }
      const currentIdx = activityRows.findIndex((r) => r.isCurrent);
      const prev = currentIdx > 0 ? activityRows[currentIdx - 1] : null;
      const next =
        currentIdx >= 0 && currentIdx < activityRows.length - 1
          ? activityRows[currentIdx + 1]
          : null;
      progress = {
        kind: "lesson",
        unitId: loc.unit.id,
        lessonId: loc.lesson.id,
        unitTitle: loc.unit.title,
        unitEmoji: loc.unit.emoji ?? null,
        lessonTitle: loc.lesson.title,
        activities: activityRows,
        currentActivityIndex: currentIdx,
        prevActivity: prev,
        nextActivity: next,
      };
    }

    return {
      reflection: session.reflection ?? null,
      reflectionStatus: session.reflectionStatus ?? null,
      reflectionError: session.reflectionError ?? null,
      location: loc,
      progress,
    };
  },
});

/**
 * Resolve a session for the current scholar in the given unit.
 * Returns the most-recent non-archived non-test-drive session. Used
 * by `/scholar/unit/[unitId]` so the URL can be unit-scoped while
 * the progress data underneath is still session-scoped.
 */
export const sessionForUnit = authedQuery({
  args: {
    unitId: v.id("units"),
    // Teacher remote mode — view as another scholar. Same gating as
    // `list`: only teachers/admins can pass `userId`; scholars get
    // their own row regardless of what they pass.
    userId: v.optional(v.id("users")),
    asLearner: v.optional(v.boolean()),
  },
  handler: async (ctx, { unitId, userId, asLearner }) => {
    const isTeacher =
      isTeacherRole(ctx.user.role);
    const targetUserId = isTeacher && userId ? userId : ctx.user._id;
    if (isTeacher && userId && targetUserId !== ctx.user._id) {
      await requireActiveScholarAccess(ctx, ctx.user, targetUserId);
    }
    if (targetUserId === ctx.user._id && asLearner === true) {
      await requireActiveLearnerInstitution(ctx, targetUserId);
    }
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_user_and_archived", (q) =>
        q.eq("userId", targetUserId).eq("isArchived", false),
      )
      .collect();
    const candidates = sessions
      .filter(
        (session) =>
          !session.isTestDrive && !session.isOffline && session.unitId === unitId,
      )
      .sort((a, b) => b._creationTime - a._creationTime);
    return { sessionId: candidates[0]?._id ?? null };
  },
});

export const getDeliverableSnapshot = authedQuery({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return null;
    const isTeacher = isTeacherRole(ctx.user.role);
    if (!isTeacher && session.userId !== ctx.user._id) return null;
    await requireActiveSessionOwnerAccess(ctx, session);
    return {
      mode: session.deliverableCriteria
        ? ("auto" as const)
        : ("manual" as const),
      criteria: session.deliverableCriteria ?? null,
      status: session.deliverableCriteriaStatus ?? null,
      error: session.deliverableCriteriaError ?? null,
    };
  },
});

export const create = authedMutation({
  args: {
    userId: v.optional(v.id("users")), // For teacher remote mode
    unitId: v.optional(v.id("units")),
    lessonId: v.optional(v.id("lessons")),
    // The lesson activity (sub-task) this session is for.
    activityId: v.optional(v.id("activities")),
    // The Assignment this session belongs to. Scopes the session's
    // execution data (deliverables, completions, share-back digests)
    // to the cohort that started it.
    assignmentId: v.optional(v.id("assignments")),
    // Test-drive mode: session is owned by the teacher; observer/dossier/etc.
    // writes are skipped. Only teachers/admins may set this.
    isTestDrive: v.optional(v.boolean()),
    // Test-drive "View as" — see schema.ts comments. Only honored when
    // isTestDrive is also true; ignored otherwise.
    testDriveAsScholarId: v.optional(v.id("users")),
    testDriveSyntheticName: v.optional(v.string()),
    testDriveSyntheticReadingLevel: v.optional(v.string()),
    testDriveSyntheticDossier: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const isTeacher =
      isTeacherRole(ctx.user.role);
    // Test-drive sessions always belong to the teacher initiating them, never
    // to a scholar. Reject attempts by non-teachers (defense in depth — UI
    // should never expose this to scholars).
    const isTestDrive = !!(args.isTestDrive && isTeacher);
    // View-as fields only carry through on test-drive sessions. Real-scholar
    // mode and synthetic mode are mutually exclusive — if both happen to be
    // set, real wins (it's the more common path) and synthetic is dropped.
    const useReal = isTestDrive && !!args.testDriveAsScholarId;
    const useSynthetic =
      isTestDrive &&
      !useReal &&
      (args.testDriveSyntheticName !== undefined ||
        args.testDriveSyntheticReadingLevel !== undefined ||
        args.testDriveSyntheticDossier !== undefined);
    const ownerUserId = isTestDrive
      ? ctx.user._id
      : isTeacher && args.userId
        ? args.userId
        : ctx.user._id;
    if (isTeacher && !isTestDrive && ownerUserId !== ctx.user._id) {
      await requireActiveScholarAccess(ctx, ctx.user, ownerUserId);
    }
    if (isTeacher && useReal && args.testDriveAsScholarId) {
      await requireActiveScholarAccess(ctx, ctx.user, args.testDriveAsScholarId);
    }
    const learnerInstitutionId = isTestDrive
      ? undefined
      : await requireActiveLearnerInstitution(ctx, ownerUserId);

    // Derive ancestors from activityId when caller only passed the leaf
    // (Test Drive button does this — it knows the activity but not the
    // unit/lesson chain).
    let unitId = args.unitId;
    let lessonId = args.lessonId;
    if (args.activityId && (!unitId || !lessonId)) {
      const activity = await ctx.db.get(args.activityId);
      // Quest-only activities have no lessonId/unitId to resolve — skip.
      if (activity && activity.lessonId) {
        if (!lessonId) lessonId = activity.lessonId;
        if (!unitId) {
          const lesson = await ctx.db.get(activity.lessonId);
          if (lesson) unitId = lesson.unitId;
        }
      }
    }
    if (!isTestDrive && unitId) {
      const unit = await ctx.db.get(unitId);
      if (!unit || !unit.isActive) throw new Error("Unit not found");
      await requireUnitInLearnerInstitution(
        ctx,
        ownerUserId,
        learnerInstitutionId,
        unit,
      );
    }

    const isDirectProgramGuest =
      !isTestDrive && !isTeacher && isProgramGuest(ctx.user);
    const programAssignment = isDirectProgramGuest && unitId && args.activityId
      ? await assignedProgramAssignmentForUnit(
          ctx,
          ownerUserId,
          unitId,
          args.activityId,
        )
      : null;
    if (isDirectProgramGuest && !programAssignment) {
      throw new Error("Unit activity is not assigned program work");
    }
    if (
      programAssignment &&
      args.assignmentId &&
      String(args.assignmentId) !== String(programAssignment._id)
    ) {
      throw new Error("Assignment does not match assigned program work");
    }
    const assignmentId = await validateAssignmentScope(
      ctx,
      programAssignment?._id ?? args.assignmentId,
      ownerUserId,
      unitId,
      args.activityId,
    );

    if (!isTestDrive && args.activityId) {
      const existing = await findActiveSessionForScopedActivity(
        ctx,
        ownerUserId,
        args.activityId,
        assignmentId,
      );
      if (existing) {
        const activity = await ctx.db.get(args.activityId);
        if (activity) {
          await ensureSessionActivitySetup(ctx, {
            sessionId: existing._id,
            activity,
            unitId: existing.unitId,
          });
        }
        return { id: existing._id };
      }
    }

    // Get unit title and process from unit's building block.
    // If the unit doesn't exist or isn't active, title stays "New Project".
    let title = NEW_SESSION_TITLE;
    let processId: Id<"processes"> | undefined = undefined;
    let unitInstitutionId: Id<"institutions"> | undefined;
    if (unitId) {
      const unit = await ctx.db.get(unitId);
      if (unit && unit.isActive) {
        title = unit.title;
        processId = unit.processId ?? undefined;
        unitInstitutionId = unit.institutionId;
      }
    }

    // Lesson overrides: use lesson title and process when present
    if (lessonId) {
      const lesson = await ctx.db.get(lessonId);
      if (lesson) {
        title = lesson.title;
        if (lesson.processId) processId = lesson.processId;
      }
    }

    // Activity overrides: most specific. Use activity title + process.
    if (args.activityId) {
      const activity = await ctx.db.get(args.activityId);
      if (activity) {
        title = activity.title;
        if (activity.processId) processId = activity.processId;
      }
    }

    // ── The unit-anchored-session invariant ─────────────────────────────
    // A free-form (Independent-Study) session — no unit, no assignment, no
    // seed, not a test-drive/offline row — is the one ambiguous state the
    // quest-lifecycle unification removes: "no IS session PERSISTS without a
    // unitId." Mint a THIN scholar-owned unit (pure identity — no LLM, no
    // bake, no activities) and anchor the session to it, synchronously and
    // invisibly, exactly the way the Custom-Quest flow already creates its
    // unit up front. `create` never carries a seedId or isOffline, so the
    // isTestDrive/unitId/assignmentId checks fully characterize "free-form"
    // here; the seed→bake path (sessions.createFromSeed) keeps its transient
    // unit-less window and stamps its own unit when the bake lands.
    // See review/quest-lifecycle-unification.html §3 (Identity) and §5.
    if (!isTestDrive && !unitId && !assignmentId) {
      unitId = await mintIndependentStudyUnit(ctx, {
        scholarId: ownerUserId,
        title: questTitleFromSessionTitle(title),
      });
    }

    // Resolve activity context one more time for deliverable hooks.
    const activityForHooks = args.activityId
      ? await ctx.db.get(args.activityId)
      : null;

    const institutionId = isTestDrive
      ? unitInstitutionId ??
        (await resolveActiveMembership(ctx, ctx.user))?.institutionId
      : learnerInstitutionId;
    const id = await ctx.db.insert("sessions", {
      userId: ownerUserId,
      ...(institutionId ? { institutionId } : {}),
      unitId,
      lessonId,
      activityId: args.activityId,
      assignmentId,
      sessionMode: sessionModeForActivityKind(activityForHooks?.kind),
      // Title stays clean — the cyan "Test Drive" banner makes the mode
      // obvious; a `[Test Drive]` prefix would just clutter every UI that
      // shows session titles.
      title,
      isArchived: false,
      isTestDrive: isTestDrive ? true : undefined,
      testDriveAsScholarId: useReal ? args.testDriveAsScholarId : undefined,
      testDriveSyntheticName: useSynthetic
        ? args.testDriveSyntheticName
        : undefined,
      testDriveSyntheticReadingLevel: useSynthetic
        ? args.testDriveSyntheticReadingLevel
        : undefined,
      testDriveSyntheticDossier: useSynthetic
        ? args.testDriveSyntheticDossier
        : undefined,
    });

    if (activityForHooks) {
      await ensureSessionActivitySetup(ctx, {
        sessionId: id,
        activity: activityForHooks,
        unitId,
        processId,
      });
    } else {
      await ensureSessionProcessState(ctx, {
        sessionId: id,
        processId,
      });
    }

    return { id };
  },
});

/**
 * Create a session from a seed: sets title to seed topic. The seed's "visited"
 * state is derived from this session's `seedId` link (DEC 3); when the spawned
 * session/unit later completes, completion paths deliberately flip the seed to
 * terminal `completed`.
 */
/**
 * The seed-launch CORE — "accept a star" turned into a real session. Shared by
 * the scholar-facing `createFromSeed` (opt into a star from the Sky) and the
 * quest transition surface (`quests.start` — accept a teacher offer), so both
 * paths create the session identically instead of forking the logic.
 *
 * A STRUCTURED destination (the seed points at a unit — a teacher/bot offer)
 * STARTS that unit: land on its first incomplete session-backed activity instead of an
 * anchorless, ad-libbed exploration. Bare proto-activity stars (no unitId) keep
 * their topic-only behavior — as does an offer whose unit has since been
 * DEACTIVATED (we don't anchor a new session to an inactive unit; same isActive
 * guard as startUnit), so the scholar's opt-in still works as a topic-only
 * exploration.
 */
export async function createSessionFromSeedCore(
  ctx: MutationCtx,
  userId: Id<"users">,
  seedId: Id<"seeds">,
  // The scholar's chosen bake shape (deep / wide / build) from the
  // "choose your path" menu. Only meaningful for topic seeds (which bake).
  bakePath?: ChosenPath,
): Promise<{ id: Id<"sessions"> }> {
  const institutionId = await requireActiveLearnerInstitution(ctx, userId);
  const seed = await ctx.db.get(seedId);
  if (!seed) throw new Error("Seed not found");
  if (seed.scholarId !== userId) throw new Error("Forbidden");
  if (seed.status === "completed") throw new Error("Seed already completed");

  let unitId: Id<"units"> | undefined;
  let lessonId: Id<"lessons"> | undefined;
  let activityId: Id<"activities"> | undefined;
  let activityForSetup: Doc<"activities"> | null = null;
  let processId: Id<"processes"> | undefined;
  let title = seed.topic;
  if (seed.unitId) {
    const unit = await ctx.db.get(seed.unitId);
    if (unit && unit.isActive) {
      await requireUnitInLearnerInstitution(
        ctx,
        userId,
        institutionId,
        unit,
      );
      unitId = unit._id;
      title = unit.title;
      const nextIncomplete = await firstIncompleteSessionActivityInUnit(
        ctx,
        userId,
        unit._id,
      );
      lessonId = nextIncomplete?.lesson._id;
      activityId = nextIncomplete?.activity._id;
      activityForSetup = nextIncomplete?.activity ?? null;
      processId =
        nextIncomplete?.activity.processId ??
        nextIncomplete?.lesson.processId ??
        unit.processId ??
        undefined;
    }
  }

  const id = await ctx.db.insert("sessions", {
    userId,
    ...(institutionId ? { institutionId } : {}),
    title,
    isArchived: false,
    // Attribute the session back to the originating seed so the
    // scholar plate / analytics can distinguish seed-spawned IS
    // work from other anchorless sessions.
    seedId,
    ...(unitId ? { unitId } : {}),
    ...(lessonId ? { lessonId } : {}),
    ...(activityId ? { activityId } : {}),
  });
  if (activityForSetup) {
    await ensureSessionActivitySetup(ctx, {
      sessionId: id,
      activity: activityForSetup,
      unitId,
      processId,
    });
  } else {
    await ensureSessionProcessState(ctx, { sessionId: id, processId });
  }

  // Topic-seed launch (no structured unit behind the star): instead of an
  // ad-lib-forever session, design a small real unit in the BACKGROUND and
  // upgrade this session in place once it lands. The scholar drops into the
  // warm ad-lib open immediately (above) and never waits for the ~1-2 min
  // bake. Structured seeds already start their unit's activity, so skip them.
  // Story seeds stay as durable grounded threads rather than being converted
  // into a generic multi-activity quest mid-conversation.
  // See review/seed-to-unit-bake-plan.md.
  if (!seed.unitId && seed.origin !== "story") {
    await ctx.scheduler.runAfter(
      0,
      internal.bakeUnitFromSeed.bakeUnitFromSeed,
      { seedId, sessionId: id, path: bakePath },
    );
  }

  return { id };
}

export const createFromSeed = authedMutation({
  args: {
    seedId: v.id("seeds"),
    // The scholar's chosen bake shape (deep / wide / build) from the
    // "choose your path" menu. Only meaningful for topic seeds (which bake).
    bakePath: v.optional(chosenPathValidator),
  },
  handler: async (ctx, args) =>
    createSessionFromSeedCore(ctx, ctx.user._id, args.seedId, args.bakePath),
});

/**
 * Start a scholar's OWN unit (an Independent-Study / Custom Quest card on the
 * home plate) by landing directly on its next incomplete session-backed activity — the
 * same direct launch a teacher-suggested star gets via createFromSeed, with no
 * "pick an activity" detour. A unit with no remaining session-backed activities (or an
 * empty Custom Quest) spawns an anchorless, ad-libbed session, exactly as before.
 */
export const startUnit = authedMutation({
  args: {
    unitId: v.id("units"),
    userId: v.optional(v.id("users")), // teacher remote mode
  },
  handler: async (ctx, args) => {
    const isTeacher =
      isTeacherRole(ctx.user.role);
    const ownerUserId =
      isTeacher && args.userId ? args.userId : ctx.user._id;
    if (isTeacher && ownerUserId !== ctx.user._id) {
      await requireActiveScholarAccess(ctx, ctx.user, ownerUserId);
    }
    const learnerInstitutionId = await requireActiveLearnerInstitution(
      ctx,
      ownerUserId,
    );

    const unit = await ctx.db.get(args.unitId);
    if (!unit || !unit.isActive) throw new Error("Unit not found");
    await requireUnitInLearnerInstitution(
      ctx,
      ownerUserId,
      learnerInstitutionId,
      unit,
    );
    const owner =
      ownerUserId === ctx.user._id ? ctx.user : await ctx.db.get(ownerUserId);
    let programAssignment = isProgramGuest(owner)
      ? await assignedProgramAssignmentForUnit(ctx, ownerUserId, unit._id)
      : null;
    if (isProgramGuest(owner) && !programAssignment) {
      throw new Error("Unit is not assigned program work");
    }

    const nextIncomplete = await firstIncompleteSessionActivityInUnit(
      ctx,
      ownerUserId,
      unit._id,
      programAssignment?._id,
    );
    const lessonId = nextIncomplete?.lesson._id;
    const activityId = nextIncomplete?.activity._id;
    if (isProgramGuest(owner)) {
      programAssignment = activityId
        ? await assignedProgramAssignmentForUnit(
            ctx,
            ownerUserId,
            unit._id,
            activityId,
          )
        : null;
      if (!programAssignment) {
        throw new Error("Unit activity is not assigned program work");
      }
    }

    if (activityId) {
      const existing = await findActiveSessionForScopedActivity(
        ctx,
        ownerUserId,
        activityId,
        programAssignment?._id,
      );
      if (existing && nextIncomplete?.activity) {
        await ensureSessionActivitySetup(ctx, {
          sessionId: existing._id,
          activity: nextIncomplete.activity,
          unitId: unit._id,
          processId:
            nextIncomplete.activity.processId ??
            nextIncomplete.lesson.processId ??
            unit.processId ??
            undefined,
        });
        return { id: existing._id };
      }
    }

    const id = await ctx.db.insert("sessions", {
      userId: ownerUserId,
      institutionId: learnerInstitutionId,
      title: unit.title,
      isArchived: false,
      unitId: unit._id,
      ...(lessonId ? { lessonId } : {}),
      ...(activityId ? { activityId } : {}),
      ...(programAssignment ? { assignmentId: programAssignment._id } : {}),
    });
    if (nextIncomplete?.activity) {
      await ensureSessionActivitySetup(ctx, {
        sessionId: id,
        activity: nextIncomplete.activity,
        unitId: unit._id,
        processId:
          nextIncomplete.activity.processId ??
          nextIncomplete.lesson.processId ??
          unit.processId ??
          undefined,
      });
    } else {
      await ensureSessionProcessState(ctx, {
        sessionId: id,
        processId: unit.processId ?? undefined,
      });
    }
    return { id };
  },
});

/**
 * Repair legacy activity sessions created before every launch path shared the
 * same setup hook. The scholar client calls this only when it sees an
 * uninitialized auto rubric; the helper itself remains idempotent.
 */
export const ensureActivitySetup = authedMutation({
  args: {
    sessionId: v.id("sessions"),
    retryErroredCriteria: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");
    const isTeacher = isTeacherRole(ctx.user.role);
    if (!isTeacher && session.userId !== ctx.user._id) {
      throw new Error("Forbidden");
    }
    await requireActiveSessionOwnerAccess(ctx, session);
    if (!session.activityId) return { initialized: false };
    const activity = await ctx.db.get(session.activityId);
    if (!activity) return { initialized: false };
    const lesson = session.lessonId ? await ctx.db.get(session.lessonId) : null;
    const unit = session.unitId ? await ctx.db.get(session.unitId) : null;
    const result = await ensureSessionActivitySetup(ctx, {
      sessionId: session._id,
      activity,
      unitId: session.unitId,
      processId:
        activity.processId ??
        lesson?.processId ??
        unit?.processId ??
        undefined,
      retryErroredCriteria: args.retryErroredCriteria,
    });
    return { initialized: true, ...result };
  },
});

/**
 * Update session (title, dimensions, whisper, status).
 * Scholars can update title + dimensions on their own sessions.
 * Teachers can update anything on any session.
 */
export const update = authedMutation({
  args: {
    id: v.id("sessions"),
    title: v.optional(v.string()),
    unitId: v.optional(v.union(v.id("units"), v.null())),
    assignmentId: v.optional(v.union(v.id("assignments"), v.null())),
    teacherWhisper: v.optional(v.union(v.string(), v.null())),
    pendingWhisper: v.optional(v.union(v.string(), v.null())),
    readingLevelOverride: v.optional(v.union(v.string(), v.null())),
    analysisSummary: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.id);
    if (!session) throw new Error("Session not found");

    const isTeacher =
      isTeacherRole(ctx.user.role);

    // Scholars can only update their own sessions
    if (!isTeacher && session.userId !== ctx.user._id) {
      throw new Error("Forbidden");
    }
    await requireActiveSessionOwnerAccess(ctx, session);

    const updates: Record<string, unknown> = {};

    // Both scholars and teachers can update these
    if (args.title !== undefined) updates.title = args.title;
    if (args.unitId !== undefined)
      updates.unitId = args.unitId ?? undefined;
    if (args.assignmentId !== undefined) {
      if (!isTeacher) {
        throw new Error("Only teachers can change assignment scope");
      }
      await validateAssignmentScope(
        ctx,
        args.assignmentId ?? undefined,
        session.userId,
        args.unitId === null ? undefined : (args.unitId ?? session.unitId),
        session.activityId,
      );
      updates.assignmentId = args.assignmentId ?? undefined;
    }

    // Only teachers can update these
    if (isTeacher) {
      if (args.teacherWhisper !== undefined)
        updates.teacherWhisper = args.teacherWhisper ?? undefined;
      if (args.pendingWhisper !== undefined)
        updates.pendingWhisper = args.pendingWhisper ?? undefined;
      if (args.readingLevelOverride !== undefined)
        updates.readingLevelOverride = args.readingLevelOverride ?? undefined;
      if (args.analysisSummary !== undefined)
        updates.analysisSummary = args.analysisSummary ?? undefined;
    }

    // Handle processState when unitId changes
    if (args.unitId !== undefined) {
      const oldUnit = session.unitId ? await ctx.db.get(session.unitId) : null;
      const newUnit = args.unitId ? await ctx.db.get(args.unitId) : null;
      const oldProcessId = oldUnit?.processId ?? null;
      const newProcessId = newUnit?.processId ?? null;

      if (newProcessId && newProcessId !== oldProcessId) {
        await ctx.scheduler.runAfter(0, internal.processState.initialize, {
          sessionId: args.id,
          processId: newProcessId,
        });
      } else if (!newProcessId && oldProcessId) {
        await ctx.scheduler.runAfter(0, internal.processState.remove, {
          sessionId: args.id,
        });
      }
    }

    await ctx.db.patch(args.id, updates);

    return await ctx.db.get(args.id);
  },
});

/**
 * Mark a scholar's session as complete/incomplete within an activity.
 * Setting complete=true stamps activityCompletedAt; false clears it.
 */
export const markActivityComplete = teacherMutation({
  args: {
    sessionId: v.id("sessions"),
    complete: v.boolean(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");
    await requireActiveSessionOwnerAccess(ctx, session);
    await ctx.db.patch(args.sessionId, {
      activityCompletedAt: args.complete ? Date.now() : undefined,
      activityCompletionMessageId: undefined,
    });
  },
});

/**
 * Archive a session (soft delete).
 */
export const archive = authedMutation({
  args: { id: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.id);
    if (!session) throw new Error("Session not found");

    const isTeacher =
      isTeacherRole(ctx.user.role);
    if (!isTeacher && session.userId !== ctx.user._id) {
      throw new Error("Forbidden");
    }
    await requireActiveSessionOwnerAccess(ctx, session);

    await ctx.db.patch(args.id, { isArchived: true });
  },
});

/**
 * Unarchive (restore) a session. Same auth as archive.
 */
export const unarchive = authedMutation({
  args: { id: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.id);
    if (!session) throw new Error("Session not found");

    const isTeacher =
      isTeacherRole(ctx.user.role);
    if (!isTeacher && session.userId !== ctx.user._id) {
      throw new Error("Forbidden");
    }
    await requireActiveSessionOwnerAccess(ctx, session);

    await ctx.db.patch(args.id, { isArchived: false });
  },
});

/**
 * Re-open a scholar's session so they can KEEP WORKING on finished work.
 *
 * The failure this fixes (seen in the blind scholar pilots, rounds 2 + 3): once
 * an activity/unit completes, the scholar's work reads as a non-editable badge
 * and the only way to keep revising was to detour through a brand-new Custom
 * Quest. Re-opening the SAME session is the clean primitive the model already
 * supports: completion lives OUTSIDE the session (activityCompletions +
 * scholarUnitBadges, keyed by scholar/activity/unit), so re-entry is a session
 * visibility/navigation concern — this flips `isArchived` back to false when
 * needed and stamps `reopenedAt` so the still-complete session remains findable
 * on Home. It touches NO completion record. The unit stays complete, the badge
 * is kept, and the continuation is new work on top. The session's artifact(s)
 * come along for free (artifacts are keyed by sessionId). Idempotent for
 * completion: safe on an already active session. Same auth as archive/unarchive.
 */
export const reopen = authedMutation({
  args: { id: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.id);
    if (!session) throw new Error("Session not found");

    const isTeacher = isTeacherRole(ctx.user.role);
    if (!isTeacher && session.userId !== ctx.user._id) {
      throw new Error("Forbidden");
    }
    await requireActiveSessionOwnerAccess(ctx, session);

    // Only ever touches session visibility. Completion + badge records are
    // deliberately never read or written here, so re-entry can never regress
    // completion or double-count a badge.
    await ctx.db.patch(args.id, {
      ...(session.isArchived ? { isArchived: false } : {}),
      reopenedAt: Date.now(),
    });
    return { id: args.id };
  },
});

/**
 * Resolve the calling scholar's re-openable session for a completed UNIT — the
 * "Keep working on this" target behind an earned unit badge, which is
 * unit-scoped (it knows a unitId, not a sessionId). A unit spans several
 * activities/sessions, so we pick the one a scholar would actually want to keep
 * revising: prefer a session that carries a real document (a non-empty
 * artifact), most-recently-touched first; otherwise the most recent session in
 * the unit. Returns null when there's nothing to re-open (e.g. a free-standing
 * teacher-awarded badge with no unit, or a unit the scholar never sessioned) so
 * the surface can hide the action. Read-only; never mutates completion state.
 */
export const reopenableForUnit = authedQuery({
  args: { unitId: v.id("units") },
  handler: async (ctx, { unitId }) => {
    await requireActiveLearnerInstitution(ctx, ctx.user._id);
    const sessions = (
      await ctx.db
        .query("sessions")
        .withIndex("by_user_unit", (q) =>
          q.eq("userId", ctx.user._id).eq("unitId", unitId),
        )
        .collect()
    ).filter((s) => !s.isTestDrive && !s.isOffline && !s.seedExemplar);
    if (sessions.length === 0) return null;

    // Most-recently-active first (lastMessageAt, else creation time).
    const recency = (s: Doc<"sessions">) =>
      s.lastMessageAt ?? s._creationTime;
    sessions.sort((a, b) => recency(b) - recency(a));

    let firstWithArtifact: Id<"sessions"> | null = null;
    for (const s of sessions) {
      const artifact = await ctx.db
        .query("artifacts")
        .withIndex("by_session", (q) => q.eq("sessionId", s._id))
        .filter((q) => q.neq(q.field("content"), ""))
        .first();
      if (artifact) {
        firstWithArtifact = s._id;
        break;
      }
    }

    const target = firstWithArtifact ?? sessions[0]._id;
    return { sessionId: target };
  },
});

/**
 * Reap any orphaned stream placeholders on this session, then insert a fresh
 * empty assistant placeholder (streamId + liveness heartbeat) for the turn
 * about to stream. Shared by `sendMessage` (a real scholar turn) and
 * `startRubricCheck` / `startActivityKickoff` (silent turns with NO user
 * message) so every streaming path stays in sync. See `sendMessage` below for
 * the full rationale on liveness-based reaping (why we key off
 * `lastStreamActivityAt`, not `_creationTime`).
 */
const STREAM_ORPHAN_REAP_AGE_MS = 20_000;

export async function reapAndInsertAssistantPlaceholder(
  ctx: MutationCtx,
  session: Doc<"sessions">,
  options?: { streamTrigger?: "activityKickoff" },
): Promise<{ streamId: string; assistantMsgId: Id<"messages"> }> {
  // Dimension snapshot (as strings, for historical reference), resolved from
  // the unit — mirrors the placeholder fields sendMessage used to set inline.
  const unit = session.unitId ? await ctx.db.get(session.unitId) : null;
  const unitId = session.unitId ? String(session.unitId) : undefined;
  const perspectiveId = unit?.perspectiveId
    ? String(unit.perspectiveId)
    : undefined;
  const processId = unit?.processId ? String(unit.processId) : undefined;

  const reapBefore = Date.now() - STREAM_ORPHAN_REAP_AGE_MS;
  const recentMessages = await ctx.db
    .query("messages")
    .withIndex("by_session", (q) => q.eq("sessionId", session._id))
    .order("desc")
    .take(10);
  for (const m of recentMessages) {
    const lastActivityAt = m.lastStreamActivityAt ?? m._creationTime;
    if (
      m.role === "assistant" &&
      m.streamId &&
      m.content.trim() === "" &&
      lastActivityAt < reapBefore
    ) {
      await ctx.db.delete(m._id);
    }
  }

  const streamId = crypto.randomUUID();
  const promptVersion = await computePromptVersion();
  const assistantMsgId = await ctx.db.insert("messages", {
    sessionId: session._id,
    role: "assistant",
    content: "",
    streamId,
    streamTrigger: options?.streamTrigger,
    promptVersion,
    unitId,
    perspectiveId,
    processId,
    flagged: false,
    lastStreamActivityAt: Date.now(),
  });
  return { streamId, assistantMsgId };
}

/**
 * Send a message: saves user message, creates stream ID, inserts placeholder.
 * Returns the streamId so the client can subscribe to streaming.
 * The actual Claude API call happens via the HTTP action.
 */
export const sendMessage = authedMutation({
  args: {
    sessionId: v.id("sessions"),
    message: v.string(),
    imageId: v.optional(v.id("_storage")),
    // Optional at the wire boundary so older installed native clients remain
    // compatible. Current clients always send this for real scholar turns.
    inputModality: v.optional(inputModalityValidator),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");

    // Access check: teachers can send in any session, scholars only their own
    const isTeacher =
      isTeacherRole(ctx.user.role);
    if (!isTeacher && session.userId !== ctx.user._id) {
      throw new Error("Forbidden");
    }
    await requireActiveSessionOwnerAccess(ctx, session);

    // Time limit enforcement: reject messages after timer expires
    if (
      !isTeacher &&
      session.sessionTimeLimit &&
      session.sessionStartTime
    ) {
      const elapsed = Date.now() - session.sessionStartTime;
      if (elapsed >= session.sessionTimeLimit * 60 * 1000) {
        throw new Error("Session time limit has expired");
      }
    }

    // Dimension snapshot (as strings, not IDs, for historical reference)
    // Resolve building blocks from the unit
    const unit = session.unitId ? await ctx.db.get(session.unitId) : null;
    // DEPRECATED (anti-parasocial): personas no longer drive the tutor, so new
    // messages are not snapshotted with a personaId (it would mislabel a turn
    // with a character the tutor no longer embodies). Historical snapshots and
    // the schema field are preserved. See TODO.html "Reimagine personas".
    const personaId = undefined;
    const unitId = session.unitId ? String(session.unitId) : undefined;
    const perspectiveId = unit?.perspectiveId ? String(unit.perspectiveId) : undefined;
    const processId = unit?.processId ? String(unit.processId) : undefined;

    // Save user message
    await ctx.db.insert("messages", {
      sessionId: args.sessionId,
      role: "user",
      content: args.message,
      personaId,
      unitId,
      perspectiveId,
      processId,
      flagged: false,
      ...(args.imageId ? { imageId: args.imageId } : {}),
      ...(args.inputModality
        ? { inputModality: args.inputModality }
        : {}),
    });

    // Denormalize last message info onto the session for efficient dashboard queries
    await ctx.db.patch(args.sessionId, {
      lastMessageAt: Date.now(),
      lastMessageRole: "user",
      lastMessagePreview: args.message.slice(0, 120) || undefined,
    });

    // If there's a pending whisper, record it between user msg and assistant placeholder
    if (session.pendingWhisper) {
      await ctx.db.insert("messages", {
        sessionId: args.sessionId,
        role: "tool",
        content: session.pendingWhisper,
        toolAction: "whisper",
        flagged: false,
      });
    }

    // Reap orphaned stream placeholders. An interrupted stream (client
    // disconnect, action timeout) leaves an assistant row with content "" and
    // its streamId still set — finalize never ran. The scholar sending another
    // message means any such prior placeholder is dead, so we reap it now (see
    // reapAndInsertAssistantPlaceholder for the liveness rationale) and insert
    // this turn's fresh placeholder in one step.
    const { streamId, assistantMsgId } =
      await reapAndInsertAssistantPlaceholder(ctx, session);

    return {
      streamId,
      assistantMsgId,
      sessionId: args.sessionId,
      imageId: args.imageId ?? null,
    };
  },
});

/**
 * Start a silent rubric check — the "Check my work" button on a deliverable.
 * Unlike {@link sendMessage}, this persists NO user
 * message: it only reaps orphans and inserts the assistant placeholder + a
 * streamId. The `/project-stream` handler then injects an ephemeral,
 * non-persisted instruction (see `rubricCheckInstruction`) telling the tutor to
 * re-score the rubric now. That preserves the honesty invariant — clicking
 * "Check my work" never fabricates a scholar turn in the transcript — while the
 * tutor still responds and calls `update_rubric_score` exactly as it would on a
 * normal turn. Returns the streamId + placeholder id so the client can stream.
 */
export const startRubricCheck = authedMutation({
  args: {
    sessionId: v.id("sessions"),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");

    // Access check: teachers (remote view / test-drive) or the owning scholar.
    const isTeacher = isTeacherRole(ctx.user.role);
    if (!isTeacher && session.userId !== ctx.user._id) {
      throw new Error("Forbidden");
    }
    await requireActiveSessionOwnerAccess(ctx, session);

    // Time limit enforcement: mirror sendMessage — the rubric-check path
    // went through sendMessage, so it was blocked after the timer expired. Keep
    // that behavior (scholars only; teachers are exempt).
    if (!isTeacher && session.sessionTimeLimit && session.sessionStartTime) {
      const elapsed = Date.now() - session.sessionStartTime;
      if (elapsed >= session.sessionTimeLimit * 60 * 1000) {
        throw new Error("Session time limit has expired");
      }
    }

    const { streamId, assistantMsgId } =
      await reapAndInsertAssistantPlaceholder(ctx, session);

    return {
      streamId,
      assistantMsgId,
      sessionId: args.sessionId,
    };
  },
});

/**
 * Start the tutor's opening turn for a new activity session without fabricating
 * a scholar message. The HTTP stream injects the model-only kickoff instruction;
 * the transcript stores only the assistant response.
 */
export const startActivityKickoff = authedMutation({
  args: {
    sessionId: v.id("sessions"),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");

    const isTeacher = isTeacherRole(ctx.user.role);
    if (!isTeacher && session.userId !== ctx.user._id) {
      throw new Error("Forbidden");
    }
    await requireActiveSessionOwnerAccess(ctx, session);

    if (session.isOffline || session.isArchived || !session.activityId) {
      return null;
    }

    if (!isTeacher && session.sessionTimeLimit && session.sessionStartTime) {
      const elapsed = Date.now() - session.sessionStartTime;
      if (elapsed >= session.sessionTimeLimit * 60 * 1000) {
        throw new Error("Session time limit has expired");
      }
    }

    const existingMessages = await ctx.db
      .query("messages")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    if (existingMessages.length > 0) {
      const existing = existingMessages[0];
      const isRecoverableKickoff =
        existingMessages.length === 1 &&
        existing.role === "assistant" &&
        existing.content.trim() === "" &&
        !!existing.streamId &&
        existing.streamTrigger === "activityKickoff";
      if (!isRecoverableKickoff) return null;

      const lastActivityAt =
        existing.lastStreamActivityAt ?? existing._creationTime;
      const retryAfterMs =
        lastActivityAt + STREAM_ORPHAN_REAP_AGE_MS - Date.now();
      if (retryAfterMs > 0) {
        return {
          status: "pending" as const,
          retryAfterMs,
        };
      }
    }

    const { streamId, assistantMsgId } =
      await reapAndInsertAssistantPlaceholder(ctx, session, {
        streamTrigger: "activityKickoff",
      });

    return {
      status: "started" as const,
      streamId,
      assistantMsgId,
      sessionId: args.sessionId,
    };
  },
});

/**
 * List all active (non-archived) sessions grouped by unitId.
 * Used by teacher Activity View to show which scholars are working on which units.
 */
export const listActiveByUnit = teacherQuery({
  args: {},
  handler: async (ctx) => {
    // Get all non-archived, non-test-drive, non-offline sessions (offline
    // sessions are scanned-deliverable containers with no live session).
    // TODO: add isTestDrive to a composite index once volume warrants it.
    const allSessions = (await ctx.db
      .query("sessions")
      .filter((q) => q.eq(q.field("isArchived"), false))
      .collect())
      .filter((session) => !session.isTestDrive && !session.isOffline);

    // Group by unitId
    const byUnit = new Map<string, typeof allSessions>();
    const unassigned: typeof allSessions = [];
    for (const session of allSessions) {
      if (session.unitId) {
        const key = String(session.unitId);
        if (!byUnit.has(key)) byUnit.set(key, []);
        byUnit.get(key)!.push(session);
      } else {
        unassigned.push(session);
      }
    }

    // Resolve each unit group
    const unitGroups = await Promise.all(
      Array.from(byUnit.entries()).map(async ([unitIdStr, sessions]) => {
        const unitId = unitIdStr as Id<"units">;
        const unit = await ctx.db.get(unitId);
        if (!unit) return null;

        const process = unit.processId
          ? await ctx.db.get(unit.processId)
          : null;

        const scholars = await Promise.all(
          sessions.map(async (session) => {
            const scholar = await ctx.db.get(session.userId);
            // Get process state
            const procState = await ctx.db
              .query("processState")
              .withIndex("by_session", (q) => q.eq("sessionId", session._id))
              .first();

            return {
              scholarId: session.userId,
              sessionId: session._id,
              sessionCreatedAt: session._creationTime,
              name: scholar?.name ?? null,
              image: scholar?.image ?? null,
              readingLevel: scholar?.readingLevel ?? null,
              dateOfBirth: scholar?.dateOfBirth ?? null,
              pulseScore: session.pulseScore ?? null,
              lastMessageAt: session.lastMessageAt ?? null,
              lastMessageContent: session.lastMessagePreview ?? null,
              lastMessageRole: session.lastMessageRole ?? null,
              processStep: procState?.currentStep ?? null,
              sessionTitle: session.title,
              analysisSummary: session.analysisSummary ?? null,
              assignmentId: session.assignmentId
                ? String(session.assignmentId)
                : null,
              activityCompletedAt: session.activityCompletedAt ?? null,
            };
          })
        );

        return {
          unitId: unit._id,
          unitTitle: unit.title,
          unitEmoji: unit.emoji ?? null,
          unitDescription: unit.description ?? null,
          processId: unit.processId ?? null,
          process: process
            ? {
                title: process.title,
                emoji: process.emoji ?? null,
                steps: process.steps,
              }
            : null,
          durationMinutes: unit.durationMinutes ?? null,
          scholars,
        };
      })
    );

    // Resolve unassigned scholars (sessions with no unit)
    const unassignedScholars = await Promise.all(
      unassigned.map(async (session) => {
        const scholar = await ctx.db.get(session.userId);
        return {
          scholarId: session.userId,
          sessionId: session._id,
          sessionCreatedAt: session._creationTime,
          name: scholar?.name ?? null,
          image: scholar?.image ?? null,
          readingLevel: scholar?.readingLevel ?? null,
          dateOfBirth: scholar?.dateOfBirth ?? null,
          pulseScore: session.pulseScore ?? null,
          lastMessageAt: session.lastMessageAt ?? null,
          lastMessageContent: session.lastMessagePreview ?? null,
          lastMessageRole: session.lastMessageRole ?? null,
          processStep: null,
          sessionTitle: session.title,
          analysisSummary: session.analysisSummary ?? null,
          assignmentId: session.assignmentId
            ? String(session.assignmentId)
            : null,
          activityCompletedAt: session.activityCompletedAt ?? null,
        };
      })
    );

    // Include scholars with no active sessions at all
    const allScholars = await ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", ROLES.SCHOLAR))
      .collect();
    const scholarsWithSessions = new Set(
      allSessions.map((session) => String(session.userId)),
    );
    const noSessionScholars = allScholars
      .filter((s) => !scholarsWithSessions.has(String(s._id)))
      .map((s) => ({
        scholarId: s._id,
        sessionId: "" as Id<"sessions">, // placeholder — no session yet
        sessionCreatedAt: s._creationTime,
        name: s.name ?? null,
        image: s.image ?? null,
        readingLevel: s.readingLevel ?? null,
        dateOfBirth: s.dateOfBirth ?? null,
        pulseScore: null,
        lastMessageAt: null,
        lastMessageContent: null,
        lastMessageRole: null,
        processStep: null,
        sessionTitle: "",
        analysisSummary: null,
        assignmentId: null,
        activityCompletedAt: null,
      }));

    return {
      unitGroups: unitGroups.filter(
        (g): g is NonNullable<typeof g> => g !== null
      ),
      unassigned: { scholars: [...unassignedScholars, ...noSessionScholars] },
    };
  },
});

// ── Time Limit Mode ─────────────────────────────────────────────────

/**
 * Set a session time limit (parent password required).
 * Starts the timer immediately.
 */
export const setTimeLimit = authedMutation({
  args: {
    sessionId: v.id("sessions"),
    minutes: v.number(),
    password: v.string(),
  },
  handler: async (ctx, args) => {
    if (args.password !== PARENT_PASSWORD) {
      throw new Error("Incorrect parent password");
    }
    if (args.minutes < 1 || args.minutes > 480) {
      throw new Error("Time limit must be between 1 and 480 minutes");
    }
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");
    await requireActiveSessionOwnerAccess(ctx, session);

    await ctx.db.patch(args.sessionId, {
      sessionTimeLimit: args.minutes,
      sessionStartTime: Date.now(),
    });
  },
});

/**
 * Clear the session time limit (parent password required).
 */
export const clearTimeLimit = authedMutation({
  args: {
    sessionId: v.id("sessions"),
    password: v.string(),
  },
  handler: async (ctx, args) => {
    if (args.password !== PARENT_PASSWORD) {
      throw new Error("Incorrect parent password");
    }
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");
    await requireActiveSessionOwnerAccess(ctx, session);

    await ctx.db.patch(args.sessionId, {
      sessionTimeLimit: undefined,
      sessionStartTime: undefined,
      pendingWhisper: undefined,
    });
  },
});

/**
 * Inject a time-limit whisper (called by frontend when timer is near expiry).
 */
export const injectTimeLimitWhisper = authedMutation({
  args: {
    sessionId: v.id("sessions"),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");
    await requireActiveSessionOwnerAccess(ctx, session);

    // Only inject if time limit is active and whisper not already set
    if (!session.sessionTimeLimit || !session.sessionStartTime) return;
    if (session.pendingWhisper) return;

    await ctx.db.patch(args.sessionId, {
      pendingWhisper:
        `The session time is almost up. Please wrap up the current topic naturally within the next minute. ${TIME_LIMIT_WRAP_GUIDANCE}`,
    });
  },
});

/**
 * Update the "View as" identity on an existing test-drive session. This is
 * the picker affordance in the cyan Test Drive banner — the teacher swaps
 * between viewing as themselves, a real scholar, or a synthetic profile,
 * and the next streamed turn picks up the new identity.
 *
 * Shape mirrors `create`'s view-as args. Pass `mode: "self"` to clear all
 * fields (the teacher's own identity, no dossier). `mode: "real"` requires
 * `realScholarId`. `mode: "synthetic"` lets you set any subset of the three
 * synthetic fields (name / reading level / dossier).
 *
 * Owner-only and test-drive-only — same gates as `testDriveFlags.toggle`.
 */
export const setTestDriveViewAs = authedMutation({
  args: {
    sessionId: v.id("sessions"),
    mode: v.union(
      v.literal("self"),
      v.literal("real"),
      v.literal("synthetic"),
    ),
    realScholarId: v.optional(v.id("users")),
    syntheticName: v.optional(v.string()),
    syntheticReadingLevel: v.optional(v.string()),
    syntheticDossier: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");
    if (!session.isTestDrive) {
      throw new Error("View-as is only available on test-drive projects");
    }
    const isTeacher =
      isTeacherRole(ctx.user.role);
    if (!isTeacher || session.userId !== ctx.user._id) {
      throw new Error("Forbidden");
    }
    if (args.mode === "real" && args.realScholarId) {
      await requireActiveScholarAccess(ctx, ctx.user, args.realScholarId);
    }

    if (args.mode === "self") {
      await ctx.db.patch(args.sessionId, {
        testDriveAsScholarId: undefined,
        testDriveSyntheticName: undefined,
        testDriveSyntheticReadingLevel: undefined,
        testDriveSyntheticDossier: undefined,
      });
      return null;
    }

    if (args.mode === "real") {
      if (!args.realScholarId) {
        throw new Error("realScholarId required for mode 'real'");
      }
      const target = await ctx.db.get(args.realScholarId);
      if (!target || target.role !== ROLES.SCHOLAR) {
        throw new Error("View-as target must be a scholar");
      }
      await ctx.db.patch(args.sessionId, {
        testDriveAsScholarId: args.realScholarId,
        testDriveSyntheticName: undefined,
        testDriveSyntheticReadingLevel: undefined,
        testDriveSyntheticDossier: undefined,
      });
      return null;
    }

    // Synthetic mode. All three fields are optional individually but at least
    // one must be present — otherwise the picker would be a no-op (and the
    // teacher should have used "self" instead).
    if (
      args.syntheticName === undefined &&
      args.syntheticReadingLevel === undefined &&
      args.syntheticDossier === undefined
    ) {
      throw new Error(
        "Synthetic mode requires at least one of name / reading level / dossier",
      );
    }
    await ctx.db.patch(args.sessionId, {
      testDriveAsScholarId: undefined,
      testDriveSyntheticName: args.syntheticName ?? undefined,
      testDriveSyntheticReadingLevel: args.syntheticReadingLevel ?? undefined,
      testDriveSyntheticDossier: args.syntheticDossier ?? undefined,
    });
    return null;
  },
});

/**
 * Reset a test-drive: archive the current throwaway session and start a
 * fresh one against the same activity, preserving the View as selection.
 *
 * Returns the new session's id so the FE can redirect to it. The old
 * session is archived rather than deleted so transcripts + flags remain
 * inspectable from Curriculum Bot history if anyone wants to dig back
 * into a prior iteration.
 *
 * Owner-only and test-drive-only.
 */
export const resetTestDrive = authedMutation({
  args: {
    sessionId: v.id("sessions"),
    // "Reset & replay": carry the current drive's scholar turns forward
    // onto the fresh drive so the teacher can auto-re-send them against the
    // edited prompt instead of re-typing. Absent/false preserves the plain
    // blank-reset behavior. See review/test-drive-replay-plan.md.
    withReplay: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");
    if (!session.isTestDrive) {
      throw new Error("Reset is only available on test-drive projects");
    }
    const isTeacher =
      isTeacherRole(ctx.user.role);
    if (!isTeacher || session.userId !== ctx.user._id) {
      throw new Error("Forbidden");
    }
    await deleteSessionAppStates(ctx, args.sessionId);

    // Derive the replay script from the OLD drive before archiving it: the
    // scholar turns the teacher typed, plus the pause boundary that lands
    // on the last flagged tutor response. Cheap reads; only when asked.
    let replayScript: string[] | undefined;
    let replayStopAfter: number | undefined;
    if (args.withReplay) {
      const oldMessages = await ctx.db
        .query("messages")
        .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
        .collect();
      oldMessages.sort((a, b) => a._creationTime - b._creationTime);
      const script = buildReplayScript(oldMessages);
      if (script.length > 0) {
        const flags = await ctx.db
          .query("testDriveFlags")
          .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
          .collect();
        const flaggedIds = new Set(flags.map((f) => String(f.messageId)));
        replayScript = script;
        replayStopAfter = computeReplayStopAfter(
          oldMessages.map((m) => ({
            _id: String(m._id),
            role: m.role,
            content: m.content,
          })),
          flaggedIds,
        );
      }
    }

    // Archive the old session so it disappears from any list views but
    // stays around for the curriculum bot to read.
    await ctx.db.patch(args.sessionId, { isArchived: true });

    // Recreate against the same activity (or unit/lesson, if the original
    // was anchored higher) with the same view-as fields.
    let title = session.title;
    let processId: Id<"processes"> | undefined = undefined;
    if (session.activityId) {
      const activity = await ctx.db.get(session.activityId);
      if (activity) {
        title = activity.title;
        if (activity.processId) processId = activity.processId;
      }
    } else if (session.lessonId) {
      const lesson = await ctx.db.get(session.lessonId);
      if (lesson) {
        title = lesson.title;
        if (lesson.processId) processId = lesson.processId;
      }
    } else if (session.unitId) {
      const unit = await ctx.db.get(session.unitId);
      if (unit && unit.isActive) {
        title = unit.title;
        if (unit.processId) processId = unit.processId;
      }
    }

    const activityForHooks = session.activityId
      ? await ctx.db.get(session.activityId)
      : null;
    const needsCriteriaGen =
      activityForHooks?.deliverable?.mode === "auto";
    const needsSeededArtifact =
      activityForHooks?.deliverable?.kind === "text" ||
      activityForHooks?.deliverable?.kind === "artifact";

    const newId = await ctx.db.insert("sessions", {
      userId: ctx.user._id,
      institutionId: session.institutionId,
      unitId: session.unitId,
      lessonId: session.lessonId,
      activityId: session.activityId,
      assignmentId: session.assignmentId,
      sessionMode: sessionModeForActivityKind(activityForHooks?.kind),
      title,
      isArchived: false,
      isTestDrive: true,
      testDriveAsScholarId: session.testDriveAsScholarId,
      testDriveSyntheticName: session.testDriveSyntheticName,
      testDriveSyntheticReadingLevel: session.testDriveSyntheticReadingLevel,
      testDriveSyntheticDossier: session.testDriveSyntheticDossier,
      replayScript,
      replayStopAfter,
      deliverableCriteriaStatus: needsCriteriaGen
        ? ("pending" as const)
        : undefined,
    });

    if (processId) {
      await ctx.scheduler.runAfter(0, internal.processState.initialize, {
        sessionId: newId,
        processId,
      });
    }

    // Seed the empty document for text / artifact deliverables — same
    // logic as sessions.create. Each reset gets its own fresh blank
    // canvas (the old session's artifacts stay with the archived row).
    if (needsSeededArtifact && activityForHooks) {
      await ctx.db.insert("artifacts", {
        sessionId: newId,
        title: activityForHooks.title,
        content: "",
        lastEditedBy: "scholar" as const,
        type:
          activityForHooks.deliverable?.kind === "artifact"
            ? ("code" as const)
            : ("text" as const),
      });
    }

    // Regenerate per-scholar criteria for auto-mode deliverables.
    // The teacher's "view as" reading level determines calibration —
    // they can flip View as between scholars and Reset to see how the
    // rubric adapts.
    if (needsCriteriaGen) {
      await ctx.scheduler.runAfter(
        0,
        internal.deliverables.generateCriteriaForSession,
        { sessionId: newId },
      );
    }

    // Reflection too — test-drive should see how the "big picture"
    // looks for the chosen view-as scholar.
    if (session.activityId && session.unitId) {
      await ctx.db.patch(newId, { reflectionStatus: "pending" as const });
      await ctx.scheduler.runAfter(
        0,
        internal.sessions.generateReflectionForSession,
        { sessionId: newId },
      );
    }

    return { id: newId };
  },
});

/**
 * Clear a fresh drive's replay script once the teacher has consumed or
 * dismissed the "Reset & replay" offer, so a page reload doesn't re-offer
 * a spent script. Owner-only and test-drive-only — same gates as the
 * reset/flag mutations. No-op if nothing is staged.
 */
export const clearReplayScript = authedMutation({
  args: {
    sessionId: v.id("sessions"),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");
    if (!session.isTestDrive) {
      throw new Error("Replay is only available on test-drive projects");
    }
    const isTeacher =
      isTeacherRole(ctx.user.role);
    if (!isTeacher || session.userId !== ctx.user._id) {
      throw new Error("Forbidden");
    }
    if (session.replayScript === undefined && session.replayStopAfter === undefined) {
      return null;
    }
    await ctx.db.patch(args.sessionId, {
      replayScript: undefined,
      replayStopAfter: undefined,
    });
    return null;
  },
});

// ── Big-picture reflection generator ──────────────────────────────────
//
// "Where am I?" content for the compass-button drawer. Generated once
// at session creation (or on teacher-triggered retry), grounded in
// real DB rows — unit + lesson + activity + prior activities in this
// unit + the scholar's prior deliverables for those activities.
//
// Structured output: four short paragraphs.
//   - bigIdea       : the unit's theme reframed for the scholar
//   - arcSoFar      : what the scholar has done in this unit already
//   - thisActivity  : how the current activity fits the theme
//   - whatsNext     : the next 1-2 activities, framed as direction
//
// Reading level is honored — vocabulary and sentence complexity
// match the scholar's level so a 1st grader doesn't read a 5th
// grader's reflection and vice versa.

const buildReflectionSystemPrompt = (
  profile: InstitutionPromptProfile = DEFAULT_INSTITUTION_PROMPT_PROFILE,
): string => `You write a short "big picture" reflection for a scholar at ${profile.schoolName}, a gifted elementary school. The scholar is asking "where am I in this unit, and what is this work for?"

OUTPUT FORMAT — call the report_reflection tool with an array of 1-4 sections. Each section has a 2-4 word heading + a short paragraph (1-3 sentences). YOU CHOOSE how many sections to write and what to call them; pick the shape that fits this scholar's situation.

When to use FEWER sections:
- A standalone single-activity unit. There's no "arc so far" or "what's next." Use 1-2 sections — maybe just "Why this matters" or "The big idea."
- The unit only has one lesson. Same — skip the structural framings.

When to use MORE sections (3-4):
- Multi-lesson units with real arc to summarize.
- The scholar has prior passing deliverables in this unit — surface what they've shown mastery on.
- There are real next activities to point toward.

NEVER do these (they're filler, not content):
- "This is your first activity in the unit." (Just leave that section out.)
- "This is the final activity in the unit." (Just leave that section out.)
- Headings or bodies that restate the activity title.
- Empty affirmations: "Great job", "You're doing great", "Nice work."

ALWAYS:
- Speak directly to the scholar in second person. Warm but not gushy.
- Ground every claim in the input data. Never fabricate prior activities, books, or events.
- Match the scholar's reading level. A K-2 scholar gets short sentences and common words. A 4-5 scholar can handle richer vocabulary.
- Use prose. No bullet points or markdown inside bodies.

Pick headings that fit the content. Examples (don't repeat them rotely):
- "The big idea"
- "Why this matters"
- "Your story so far"
- "What you've shown"
- "This activity"
- "Where this fits"
- "What's next"
- "Where this is heading"

You MUST call the report_reflection tool. Do not respond with raw text.`;

const REFLECTION_TOOL = {
  name: "report_reflection",
  description:
    "Report a 1-4 section big-picture reflection. Section count and headings are at your discretion — pick the shape that fits the scholar's situation.",
  input_schema: {
    type: "object" as const,
    properties: {
      sections: {
        type: "array" as const,
        minItems: 1,
        maxItems: 4,
        items: {
          type: "object" as const,
          properties: {
            heading: {
              type: "string" as const,
              description:
                "2-4 word section label. Pick wording that fits what's inside, not a generic template.",
            },
            body: {
              type: "string" as const,
              description:
                "1-3 sentence paragraph. Specific, grounded, scholar-facing.",
            },
          },
          required: ["heading", "body"] as const,
        },
      },
    },
    required: ["sections"],
  },
};

interface ReflectionContext {
  scholarId: Id<"users"> | null;
  unitTitle: string | null;
  unitBigIdea: string | null;
  unitEssentialQuestions: string[];
  unitEnduringUnderstandings: string[];
  lessonTitle: string | null;
  activityTitle: string;
  activityDescription: string | null;
  deliverablePrompt: string | null;
  readingLevel: string | null;
  scholarName: string | null;
  priorActivitiesInUnit: Array<{
    title: string;
    lessonTitle: string;
    completed: boolean;
    passingDeliverableSummary: string | null;
  }>;
  nextActivitiesInUnit: Array<{
    title: string;
    lessonTitle: string;
  }>;
  institutionProfile: InstitutionPromptProfile;
}

export const internalGetReflectionContext = internalQuery({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args): Promise<ReflectionContext | null> => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return null;
    if (!session.activityId) return null;
    const activity = await ctx.db.get(session.activityId);
    if (!activity) return null;

    let unitTitle: string | null = null;
    let unitBigIdea: string | null = null;
    let unitEssentialQuestions: string[] = [];
    let unitEnduringUnderstandings: string[] = [];
    let lessonTitle: string | null = null;
    let unitId: Id<"units"> | null = null;
    if (activity.lessonId) {
      const lesson = await ctx.db.get(activity.lessonId);
      if (lesson) {
        lessonTitle = lesson.title;
        const unit = await ctx.db.get(lesson.unitId);
        if (unit) {
          unitId = unit._id;
          unitTitle = unit.title;
          unitBigIdea = unit.bigIdea ?? null;
          unitEssentialQuestions = granuleTexts(unit.essentialQuestions);
          unitEnduringUnderstandings = granuleTexts(unit.enduringUnderstandings);
        }
      }
    }

    // Reading level + scholar name (same resolution as criteria-gen)
    let readingLevel: string | null = null;
    let scholarName: string | null = null;
    if (session.isTestDrive && session.testDriveSyntheticReadingLevel) {
      readingLevel = session.testDriveSyntheticReadingLevel;
      scholarName = session.testDriveSyntheticName ?? null;
    } else if (session.testDriveAsScholarId) {
      const s = await ctx.db.get(session.testDriveAsScholarId);
      readingLevel = s?.readingLevel ?? null;
      scholarName = s?.name ?? null;
    } else {
      const s = await ctx.db.get(session.userId);
      readingLevel = s?.readingLevel ?? null;
      scholarName = s?.name ?? null;
    }
    if (session.readingLevelOverride) readingLevel = session.readingLevelOverride;

    // Prior activities in this unit. Walk the unit's lessons (ordered),
    // then within each lesson the activities (ordered). Anything BEFORE
    // the current activity is "prior"; anything AFTER is "next".
    const priorActivitiesInUnit: ReflectionContext["priorActivitiesInUnit"] = [];
    const nextActivitiesInUnit: ReflectionContext["nextActivitiesInUnit"] = [];
    if (unitId) {
      const lessons = await ctx.db
        .query("lessons")
        .withIndex("by_unit", (q) => q.eq("unitId", unitId!))
        .collect();
      const orderedLessons = lessons.sort((a, b) => a.order - b.order);
      let seenCurrent = false;
      for (const lesson of orderedLessons) {
        const acts = await ctx.db
          .query("activities")
          .withIndex("by_lesson", (q) => q.eq("lessonId", lesson._id))
          .collect();
        const orderedActs = acts.sort((a, b) => a.order - b.order);
        for (const act of orderedActs) {
          if (act._id === activity._id) {
            seenCurrent = true;
            continue;
          }
          if (!seenCurrent) {
            // Look for the scholar's completion of this activity.
            const scholarId =
              session.testDriveAsScholarId ?? session.userId;
            const completions = await ctx.db
              .query("activityCompletions")
              .withIndex("by_scholar_activity", (q) =>
                q.eq("scholarId", scholarId).eq("activityId", act._id),
              )
              .collect();
            const completed = completions.length > 0;
            // If they passed a deliverable, surface the AI feedback
            // headline as the "mastery summary."
            let passingDeliverableSummary: string | null = null;
            if (completed) {
              const dels = await ctx.db
                .query("deliverables")
                .withIndex("by_activity", (q) => q.eq("activityId", act._id))
                .collect();
              const passing = dels.find(
                (d) =>
                  d.scholarId === scholarId && d.rubricPassed === true,
              );
              if (passing?.rubricFeedback) {
                passingDeliverableSummary = passing.rubricFeedback.slice(
                  0,
                  240,
                );
              }
            }
            priorActivitiesInUnit.push({
              title: act.title,
              lessonTitle: lesson.title,
              completed,
              passingDeliverableSummary,
            });
          } else if (nextActivitiesInUnit.length < 2) {
            nextActivitiesInUnit.push({
              title: act.title,
              lessonTitle: lesson.title,
            });
          }
        }
      }
    }

    return {
      scholarId: session.isTestDrive
        ? session.testDriveAsScholarId ?? null
        : session.userId,
      unitTitle,
      unitBigIdea,
      unitEssentialQuestions,
      unitEnduringUnderstandings,
      lessonTitle,
      activityTitle: activity.title,
      activityDescription: activity.description ?? null,
      deliverablePrompt: activity.deliverable?.prompt ?? null,
      readingLevel,
      scholarName,
      priorActivitiesInUnit,
      nextActivitiesInUnit,
      institutionProfile: await institutionPromptProfileForScholar(
        ctx,
        session.testDriveAsScholarId ?? session.userId,
      ),
    };
  },
});

export const persistReflection = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    sections: v.array(
      v.object({
        heading: v.string(),
        body: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.sessionId, {
      reflection: {
        sections: args.sections,
        generatedAt: Date.now(),
      },
      reflectionStatus: "ready" as const,
      reflectionError: undefined,
    });
  },
});

export const recordReflectionError = internalMutation({
  args: { sessionId: v.id("sessions"), error: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.sessionId, {
      reflectionStatus: "error" as const,
      reflectionError: args.error.slice(0, 500),
    });
  },
});

export const generateReflectionForSession = internalAction({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args): Promise<void> => {
    const bundle = await ctx.runQuery(
      internal.sessions.internalGetReflectionContext,
      { sessionId: args.sessionId },
    );
    if (!bundle) return;
    const institutionId = bundle.scholarId
      ? await ctx.runQuery(internal.usage.resolveInstitution, {
          userId: bundle.scholarId,
          principal: "scholar",
        })
      : null;

    const priorBlock =
      bundle.priorActivitiesInUnit.length === 0
        ? "(none — this is the scholar's first activity in this unit)"
        : bundle.priorActivitiesInUnit
            .map((a) => {
              const head = `- ${a.title} (lesson: ${a.lessonTitle}) — ${a.completed ? "DONE" : "not done"}`;
              return a.passingDeliverableSummary
                ? `${head}\n  feedback: ${a.passingDeliverableSummary}`
                : head;
            })
            .join("\n");

    const nextBlock =
      bundle.nextActivitiesInUnit.length === 0
        ? "(none — this is the last activity in the unit)"
        : bundle.nextActivitiesInUnit
            .map((a) => `- ${a.title} (lesson: ${a.lessonTitle})`)
            .join("\n");

    const userMessage = [
      `Scholar: ${bundle.scholarName ?? "(unknown)"} · reading level ${bundle.readingLevel ?? "(unspecified — write at K-2)"}`,
      "",
      `Unit: ${bundle.unitTitle ?? "(no unit — standalone activity)"}`,
      bundle.unitBigIdea ? `Unit big idea: ${bundle.unitBigIdea}` : null,
      bundle.unitEssentialQuestions.length > 0
        ? `Essential questions:\n${bundle.unitEssentialQuestions.map((q) => `  - ${q}`).join("\n")}`
        : null,
      bundle.unitEnduringUnderstandings.length > 0
        ? `Enduring understandings:\n${bundle.unitEnduringUnderstandings.map((u) => `  - ${u}`).join("\n")}`
        : null,
      bundle.lessonTitle ? `Lesson: ${bundle.lessonTitle}` : null,
      "",
      `Current activity: ${bundle.activityTitle}${bundle.activityDescription ? ` — ${bundle.activityDescription}` : ""}`,
      bundle.deliverablePrompt
        ? `Deliverable prompt: ${bundle.deliverablePrompt}`
        : null,
      "",
      `Prior activities in this unit (scholar's arc so far):\n${priorBlock}`,
      "",
      `Next activities in this unit:\n${nextBlock}`,
      "",
      "Produce the four-section reflection. Call report_reflection.",
    ]
      .filter((s) => s !== null)
      .join("\n");

    try {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const anthropic = new Anthropic({ apiKey: requireAnthropicApiKey() });
      const response = await anthropic.messages.create({
        model: MODELS.SONNET,
        max_tokens: 1500,
        system: buildReflectionSystemPrompt(bundle.institutionProfile),
        tools: [REFLECTION_TOOL],
        tool_choice: { type: "tool", name: "report_reflection" },
        messages: [{ role: "user", content: userMessage }],
      });
      const toolBlock = response.content.find((b) => b.type === "tool_use");
      if (!toolBlock || toolBlock.type !== "tool_use") {
        throw new Error("AI did not call report_reflection");
      }
      await recordAnthropicUsage(ctx, {
        source: "session-reflection",
        role: ROLES.SCHOLAR,
        model: MODELS.SONNET,
        usage: response.usage,
        institutionId,
      });
      const raw = toolBlock.input as {
        sections: Array<{ heading: string; body: string }>;
      };
      // Defensive: clamp to [1,4] in case the model ignores the bounds,
      // and trim each piece.
      const sections = (raw.sections ?? [])
        .slice(0, 4)
        .map((s) => ({
          heading: (s.heading ?? "").trim(),
          body: (s.body ?? "").trim(),
        }))
        .filter((s) => s.heading && s.body);
      if (sections.length === 0) {
        throw new Error("AI returned no usable sections");
      }
      await ctx.runMutation(internal.sessions.persistReflection, {
        sessionId: args.sessionId,
        sections,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[generateReflectionForSession] failed:", msg);
      await ctx.runMutation(internal.sessions.recordReflectionError, {
        sessionId: args.sessionId,
        error: msg,
      });
    }
  },
});

/**
 * Teacher / scholar can re-trigger reflection generation (e.g. after
 * completing prior activities or revising the unit's big idea).
 */
export const regenerateReflection = authedMutation({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");
    if (session.userId !== ctx.user._id) {
      const isTeacher =
        isTeacherRole(ctx.user.role);
      if (!isTeacher) throw new Error("Forbidden");
    }
    await requireActiveSessionOwnerAccess(ctx, session);
    await ctx.db.patch(args.sessionId, {
      reflectionStatus: "pending" as const,
      reflectionError: undefined,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.sessions.generateReflectionForSession,
      { sessionId: args.sessionId },
    );
  },
});

/**
 * Internal: a scholar's analyzable sessions, oldest→newest, for the one-time
 * mastery re-derivation (`masteryReDerive`). Mirrors the observer's own
 * eligibility (non-test-drive, ≥3 real messages) and stamps each session with
 * `observedAt` = its last message time, so rebuilt observations carry WHEN the
 * learning happened rather than the re-run time (preserves growth chronology).
 */
export const analyzableSessionsForScholar = internalQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_user", (q) => q.eq("userId", args.scholarId))
      .collect();
    const out: Array<{
      sessionId: Id<"sessions">;
      observedAt: number;
      title: string;
      messageCount: number;
    }> = [];
    for (const s of sessions) {
      if (s.isTestDrive) continue;
      const msgs = await ctx.db
        .query("messages")
        .withIndex("by_session", (q) => q.eq("sessionId", s._id))
        .collect();
      const convo = msgs.filter(
        (m) =>
          (m.role === "user" || m.role === "assistant") &&
          m.content !== "<start>",
      );
      if (convo.length < 3) continue;
      const observedAt = convo.reduce(
        (mx, m) => Math.max(mx, m._creationTime),
        s._creationTime,
      );
      out.push({
        sessionId: s._id,
        observedAt,
        title: s.title ?? "Untitled",
        messageCount: convo.length,
      });
    }
    out.sort((a, b) => a.observedAt - b.observedAt);
    return out;
  },
});
