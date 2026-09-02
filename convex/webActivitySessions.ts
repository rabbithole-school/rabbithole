// Web Assignment sessions — the Observation-layer record of a scholar
// working inside a kind="web" activity's external site (e.g. Math
// Academy). The web layer (lib/webAssignment.ts) drives the lifecycle:
// start → heartbeat/screenshot/extract ticks → finalize on close.
// Teachers read sessions on the scholar page; the tutor reads today's
// sessions via the prompt context; finalize auto-completes the
// activity when the site's daily goal is met.
// See review/web-assignment-plan.md.

import { v } from "convex/values";
import {
  authedMutation,
  authedQuery,
  teacherQuery,
} from "./lib/customFunctions";
import {
  internalMutation,
  internalQuery,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { webSessionHasContent } from "./lib/webSessionSummary";
import { maybeAwardUnitBadge } from "./lib/badgeAward";
import { resolveActivityWebTarget } from "./lib/webActivityTarget";
import { requireActiveScholarAccess } from "./lib/access";
import {
  launcherShowsApp,
  scholarHasGrantForApp,
} from "./lib/appAudiences";
import { entryTargetsScholar } from "./assignments";

// FIFO cap on stored screenshots per session — a forgotten-open iPad
// must not fill storage. At one shot every ~3 min this is ~2 hours.
const MAX_SCREENSHOTS = 40;
const MAX_TASK_SUMMARIES = 30;
const MAX_SUMMARY_CHARS = 200;

const extractedValidator = v.object({
  xpToday: v.optional(v.number()),
  xpGoal: v.optional(v.number()),
  courseName: v.optional(v.string()),
  percentComplete: v.optional(v.number()),
  tasksCompletedToday: v.optional(v.number()),
  taskSummaries: v.optional(v.array(v.string())),
});

/** Owner-or-throw fetch shared by every per-session mutation. */
async function requireOwnSession(
  ctx: Pick<QueryCtx, "db">,
  sessionId: Id<"webActivitySessions">,
  userId: Id<"users">,
): Promise<Doc<"webActivitySessions">> {
  const session = await ctx.db.get(sessionId);
  if (!session) throw new Error("Session not found");
  if (session.scholarId !== userId) throw new Error("Forbidden");
  return session;
}

async function validateAssignmentScopeForWebActivity(
  ctx: Pick<QueryCtx, "db">,
  assignmentId: Id<"assignments"> | undefined,
  scholarId: Id<"users">,
  activity: Doc<"activities">,
  options: { requireLive?: boolean } = {},
) {
  if (!assignmentId) return undefined;
  const assignment = await ctx.db.get(assignmentId);
  if (!assignment) throw new Error("Assignment not found");
  if (options.requireLive !== false && assignment.archivedAt) {
    throw new Error("Assignment is archived");
  }
  if (!assignment.scholarIds.some((id) => String(id) === String(scholarId))) {
    throw new Error("Assignment does not include scholar");
  }
  if (activity.lessonId) {
    const lesson = await ctx.db.get(activity.lessonId);
    if (lesson && String(lesson.unitId) !== String(assignment.unitId)) {
      throw new Error("Assignment does not match activity");
    }
  }
  // NB (ad-hoc dispatch): a lesson-less activity has no lesson→unit chain to
  // anchor to, so it simply skips the unit-match check above. Web activities
  // are authored on lessons (kind "web"/external), so an ad-hoc dispatch
  // (kind "online", started via sessions.create) doesn't normally reach here —
  // but even if a lesson-less activity did, the activitySchedule-membership
  // check below (`matchingEntry`) is the authorization anchor, so this stays
  // safe without a unitId assumption.
  if (assignment.selfPaced) return assignmentId;
  const now = Date.now();
  const matchingEntry = (assignment.activitySchedule ?? []).find(
    (entry) =>
      String(entry.activityId) === String(activity._id) &&
      entryTargetsScholar(entry, scholarId),
  );
  if (!matchingEntry) throw new Error("Assignment does not include activity");
  if (
    options.requireLive !== false &&
    (matchingEntry.setAt == null ||
      (matchingEntry.endsAt != null && matchingEntry.endsAt <= now))
  ) {
    throw new Error("Assignment activity is not live");
  }
  return assignmentId;
}

function sanitizeExtracted(
  extracted: {
    xpToday?: number;
    xpGoal?: number;
    courseName?: string;
    percentComplete?: number;
    tasksCompletedToday?: number;
    taskSummaries?: string[];
  },
) {
  return {
    ...extracted,
    courseName: extracted.courseName?.slice(0, MAX_SUMMARY_CHARS),
    taskSummaries: extracted.taskSummaries
      ?.slice(0, MAX_TASK_SUMMARIES)
      .map((s) => s.slice(0, MAX_SUMMARY_CHARS)),
  };
}

/**
 * Open a session for a web activity. Caller becomes the session owner
 * (a teacher test-driving gets their own row — harmless, and filtered
 * from scholar reads by scholarId anyway).
 */
export const start = authedMutation({
  args: {
    activityId: v.optional(v.id("activities")),
    appId: v.optional(v.id("externalApps")),
    assignmentId: v.optional(v.id("assignments")),
  },
  handler: async (ctx, args) => {
    // App launch — a standing External App from the scholar's launcher.
    // No activity/assignment; ownership is "the app is on your launcher"
    // (a direct enabled row OR a live audience grant — see launcherShowsApp).
    if (args.appId) {
      const app = await ctx.db.get(args.appId);
      if (!app) throw new Error("App not found");
      if (app.archived) throw new Error("App is unavailable");
      if (!app.webUrl.trim()) throw new Error("App has no URL configured");
      const link = await ctx.db
        .query("scholarApps")
        .withIndex("by_scholar_app", (q) =>
          q.eq("scholarId", ctx.user._id).eq("appId", args.appId!),
        )
        .first();
      // Ownership is "the app is on your launcher" (`launcherShowsApp`), NOT
      // "you have a per-scholar row". A bulk `appAudiences` grant is resolved at
      // read time and never fanned out into rows, so the row-only check refused
      // every group-granted app: the tile opened, then this mutation threw and
      // the whole capture pipeline (session, heartbeat, screenshots, teacher
      // card) silently produced nothing.
      const granted = await scholarHasGrantForApp(ctx, ctx.user, args.appId);
      if (!launcherShowsApp({ link, granted })) {
        throw new Error("App not available to you");
      }
      const sessionId = await ctx.db.insert("webActivitySessions", {
        scholarId: ctx.user._id,
        appId: args.appId,
        startedAt: Date.now(),
        lastHeartbeatAt: Date.now(),
        screenshotIds: [],
      });
      return { sessionId };
    }

    if (!args.activityId) throw new Error("activityId or appId is required");
    const activity = await ctx.db.get(args.activityId);
    if (!activity) throw new Error("Activity not found");
    if (activity.kind !== "web")
      throw new Error("Not a web activity");
    const webTarget = await resolveActivityWebTarget(ctx, activity);
    if (!webTarget.webUrl?.trim())
      throw new Error("Web activity has no URL configured");
    const assignmentId = await validateAssignmentScopeForWebActivity(
      ctx,
      args.assignmentId,
      ctx.user._id,
      activity,
    );
    const sessionId = await ctx.db.insert("webActivitySessions", {
      scholarId: ctx.user._id,
      activityId: args.activityId,
      assignmentId,
      startedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
      screenshotIds: [],
    });
    return { sessionId };
  },
});

/**
 * Attach one webview screenshot (already uploaded via
 * files.generateUploadUrl). FIFO-evicts beyond the cap, deleting the
 * evicted blob so storage doesn't leak.
 */
export const attachScreenshot = authedMutation({
  args: {
    sessionId: v.id("webActivitySessions"),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    const session = await requireOwnSession(ctx, args.sessionId, ctx.user._id);
    const ids = [...session.screenshotIds, args.storageId];
    while (ids.length > MAX_SCREENSHOTS) {
      const evicted = ids.shift()!;
      await ctx.storage.delete(evicted);
    }
    await ctx.db.patch(args.sessionId, {
      screenshotIds: ids,
      lastHeartbeatAt: Date.now(),
    });
  },
});

/**
 * Periodic progress tick from the capture loop: extraction results,
 * watchdog counters, last URL. All fields optional — send what you
 * have. Also the heartbeat (keeps duration honest if the app dies
 * before finalize).
 */
export const recordProgress = authedMutation({
  args: {
    sessionId: v.id("webActivitySessions"),
    extracted: v.optional(extractedValidator),
    extractedSource: v.optional(v.union(v.literal("api"), v.literal("dom"))),
    lastUrl: v.optional(v.string()),
    offDomainBlockDelta: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const session = await requireOwnSession(ctx, args.sessionId, ctx.user._id);
    const patch: Partial<Doc<"webActivitySessions">> = {
      lastHeartbeatAt: Date.now(),
    };
    if (args.extracted) {
      patch.extracted = sanitizeExtracted(args.extracted);
      patch.extractedSource = args.extractedSource ?? "dom";
    }
    if (args.lastUrl) patch.lastUrl = args.lastUrl.slice(0, 500);
    if (args.offDomainBlockDelta && args.offDomainBlockDelta > 0) {
      patch.offDomainBlocks =
        (session.offDomainBlocks ?? 0) + Math.round(args.offDomainBlockDelta);
    }
    await ctx.db.patch(args.sessionId, patch);
  },
});

/**
 * Close the session. Marks the activity complete when the scholar
 * explicitly said Done, or when extraction shows the site's daily
 * goal met (xpToday >= xpGoal > 0). Completion stamps the session's
 * assignmentId and follows the same idempotent upsert as
 * activityCompletions.markComplete. Lesson-anchored activities only —
 * same rule as markComplete.
 */
export const finalize = authedMutation({
  args: {
    sessionId: v.id("webActivitySessions"),
    markDone: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const session = await requireOwnSession(ctx, args.sessionId, ctx.user._id);
    if (!session.endedAt) {
      await ctx.db.patch(args.sessionId, { endedAt: Date.now() });
    }

    // Kick the one-line teacher-card recap (cheap Haiku, best-effort) once
    // the session is ending — but only when there's captured content to
    // summarize and we haven't already written one. Fire-and-forget via the
    // scheduler so it never blocks completion.
    if (!session.summary && webSessionHasContent(session.extracted)) {
      await ctx.scheduler.runAfter(
        0,
        internal.webActivitySummary.summarize,
        { sessionId: args.sessionId },
      );
    }

    const goalMet =
      !!session.extracted &&
      typeof session.extracted.xpToday === "number" &&
      typeof session.extracted.xpGoal === "number" &&
      session.extracted.xpGoal > 0 &&
      session.extracted.xpToday >= session.extracted.xpGoal;

    if (!args.markDone && !goalMet) return { completed: false, goalMet };

    // App sessions (no activityId) have no activity/lesson to complete —
    // a standing app launch isn't an assignment. Stamp endedAt + summary
    // (already done above) and return without a completion.
    const activity = session.activityId
      ? await ctx.db.get(session.activityId)
      : null;
    if (!session.activityId || !activity?.lessonId) {
      return { completed: false, goalMet };
    }
    const assignmentId = await validateAssignmentScopeForWebActivity(
      ctx,
      session.assignmentId,
      session.scholarId,
      activity,
      { requireLive: false },
    );
    const lesson = await ctx.db.get(activity.lessonId);
    if (!lesson) return { completed: false, goalMet };

    const note = goalMet
      ? `Daily goal met (${session.extracted!.xpToday}/${session.extracted!.xpGoal} XP)`
      : undefined;
    const existing = assignmentId
      ? await ctx.db
          .query("activityCompletions")
          .withIndex("by_scholar_assignment", (q) =>
            q.eq("scholarId", session.scholarId).eq("assignmentId", assignmentId),
          )
          .filter((q) => q.eq(q.field("activityId"), session.activityId!))
          .first()
      : (
          await ctx.db
            .query("activityCompletions")
            .withIndex("by_scholar_activity", (q) =>
              q.eq("scholarId", session.scholarId).eq("activityId", session.activityId!),
            )
            .collect()
        ).find((row) => row.assignmentId === undefined);
    if (existing) {
      await ctx.db.patch(existing._id, {
        completedAt: Date.now(),
        assignmentId: assignmentId ?? existing.assignmentId,
        note: note ?? existing.note,
      });
    } else {
      await ctx.db.insert("activityCompletions", {
        scholarId: session.scholarId,
        activityId: session.activityId,
        lessonId: activity.lessonId,
        unitId: lesson.unitId,
        completedAt: Date.now(),
        assignmentId,
        note,
      });
    }
    // Mint the unit badge if this finishes the unit (idempotent) — same
    // award as the manual + rubric paths. See convex/lib/badgeAward.ts.
    await maybeAwardUnitBadge(ctx, session.scholarId, session.activityId);
    return { completed: true, goalMet };
  },
});

/**
 * The scholar's own most recent session for an activity (today's
 * progress chip on the assignment card). Cheap: one indexed read.
 */
export const myLatestForActivity = authedQuery({
  args: { activityId: v.id("activities") },
  handler: async (ctx, args) => {
    const latest = await ctx.db
      .query("webActivitySessions")
      .withIndex("by_scholar", (q) => q.eq("scholarId", ctx.user._id))
      .order("desc")
      .filter((q) => q.eq(q.field("activityId"), args.activityId))
      .first();
    if (!latest) return null;
    return {
      _id: latest._id,
      startedAt: latest.startedAt,
      endedAt: latest.endedAt ?? null,
      extracted: latest.extracted ?? null,
    };
  },
});

/**
 * Teacher view: a scholar's recent web sessions, newest first, with
 * activity titles and screenshot URLs resolved for the filmstrip.
 */
export const listRecentForScholar = teacherQuery({
  args: {
    scholarId: v.id("users"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
    const sessions = await ctx.db
      .query("webActivitySessions")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .order("desc")
      .take(limit);
    return Promise.all(
      sessions.map(async (s) => {
        const activity = s.activityId ? await ctx.db.get(s.activityId) : null;
        const app = s.appId ? await ctx.db.get(s.appId) : null;
        const screenshotUrls = (
          await Promise.all(s.screenshotIds.map((id) => ctx.storage.getUrl(id)))
        ).filter((u): u is string => !!u);
        const effectiveEnd = s.endedAt ?? s.lastHeartbeatAt ?? s.startedAt;
        return {
          _id: s._id,
          activityId: s.activityId ?? null,
          appId: s.appId ?? null,
          activityTitle:
            activity?.title ?? app?.name ?? "(deleted activity)",
          startedAt: s.startedAt,
          endedAt: s.endedAt ?? null,
          durationMs: Math.max(0, effectiveEnd - s.startedAt),
          extracted: s.extracted ?? null,
          extractedSource: s.extractedSource ?? null,
          summary: s.summary ?? null,
          offDomainBlocks: s.offDomainBlocks ?? 0,
          lastUrl: s.lastUrl ?? null,
          screenshotUrls,
        };
      }),
    );
  },
});

/**
 * Sessions for one scholar since a timestamp — the tutor-context read
 * (getSessionContext computes "start of today, HST" and passes it).
 * Internal: called from the streaming path's context assembly.
 */
export const sinceForScholarInternal = internalQuery({
  args: {
    scholarId: v.id("users"),
    sinceMs: v.number(),
  },
  handler: async (ctx, args) => {
    const sessions = await ctx.db
      .query("webActivitySessions")
      .withIndex("by_scholar", (q) =>
        q.eq("scholarId", args.scholarId).gte("startedAt", args.sinceMs),
      )
      .collect();
    return Promise.all(
      sessions.map(async (s) => {
        const activity = s.activityId ? await ctx.db.get(s.activityId) : null;
        const app = s.appId ? await ctx.db.get(s.appId) : null;
        const effectiveEnd = s.endedAt ?? s.lastHeartbeatAt ?? s.startedAt;
        return {
          activityTitle: activity?.title ?? app?.name ?? "external site",
          startedAt: s.startedAt,
          durationMs: Math.max(0, effectiveEnd - s.startedAt),
          extracted: s.extracted ?? null,
        };
      }),
    );
  },
});

/**
 * Read a session's captured metadata for the summary action
 * (webActivitySummary.summarize). Internal — no auth (action-only).
 */
export const getForSummary = internalQuery({
  args: { sessionId: v.id("webActivitySessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return null;
    return {
      scholarId: session.scholarId,
      extracted: session.extracted ?? null,
      summary: session.summary ?? null,
    };
  },
});

/** Store the Haiku-written one-liner. Internal — called by the action. */
export const setSummary = internalMutation({
  args: {
    sessionId: v.id("webActivitySessions"),
    summary: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return;
    await ctx.db.patch(args.sessionId, {
      summary: args.summary.slice(0, 280),
    });
  },
});
