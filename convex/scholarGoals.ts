import { v } from "convex/values";
import { internalMutation, internalQuery, MutationCtx } from "./_generated/server";
import { authedQuery, authedMutation } from "./lib/customFunctions";
import { requireTeacherOrSelf } from "./lib/auth";
import { requireActiveScholarAccess } from "./lib/access";
import { isTeacherRole } from "./lib/roles";
import { Doc, Id } from "./_generated/dataModel";

/**
 * Goals — the long-term primitive (review/assessment-and-goals-plan.html §9).
 *
 * A goal outlives sessions, units, and quests: the thread the year hangs on.
 * Governed authorship — teacher/scholar-authored (never model), schema'd +
 * reviewable, deterministically injected into the tutor prompt (buildGoalsSection
 * in sessionHelpers), and kid-safe by construction. Scholar-proposed goals await
 * teacher approval before they go `active` / feed the tutor.
 */

const goalKindValidator = v.union(
  v.literal("academic"),
  v.literal("personal"),
  v.literal("habit"),
  v.literal("hobby"),
);
const goalOriginValidator = v.union(
  v.literal("goalWeek"),
  v.literal("narrative"),
  v.literal("scholar"),
  v.literal("teacher"),
);
const goalStatusValidator = v.union(
  v.literal("proposed"),
  v.literal("active"),
  v.literal("achieved"),
  v.literal("retired"),
);

// ── Queries ───────────────────────────────────────────────────────────

/** All of a scholar's goals (teacher-or-self), newest first. */
export const listByScholar = authedQuery({
  args: {
    scholarId: v.id("users"),
    status: v.optional(goalStatusValidator),
  },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);

    const rows = await ctx.db
      .query("scholarGoals")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .order("desc")
      .collect();
    const filtered = args.status
      ? rows.filter((g) => g.status === args.status)
      : rows;

    // Attach check-in counts + latest note so cards render without a 2nd query.
    const withCheckins = await Promise.all(
      filtered.map(async (g) => {
        const checkins = await ctx.db
          .query("goalCheckins")
          .withIndex("by_goal", (q) => q.eq("goalId", g._id))
          .order("desc")
          .collect();
        return {
          ...g,
          checkinCount: checkins.length,
          latestCheckin: checkins[0] ?? null,
        };
      }),
    );
    return withCheckins;
  },
});

/** Check-ins recorded against one goal (teacher-or-self). */
export const listCheckins = authedQuery({
  args: { goalId: v.id("scholarGoals") },
  handler: async (ctx, args) => {
    const goal = await ctx.db.get(args.goalId);
    if (!goal) return [];
    const isTeacher = requireTeacherOrSelf(ctx.user, goal.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, goal.scholarId);
    return await ctx.db
      .query("goalCheckins")
      .withIndex("by_goal", (q) => q.eq("goalId", args.goalId))
      .order("desc")
      .collect();
  },
});

// ── Mutations ─────────────────────────────────────────────────────────

/**
 * Create a goal. A TEACHER creates it live (`active`, feeds the tutor); a
 * SCHOLAR proposing their own goal creates it `proposed` (awaits approval,
 * doesn't feed the tutor until approved).
 */
export const create = authedMutation({
  args: {
    scholarId: v.id("users"),
    title: v.string(),
    description: v.optional(v.string()),
    kind: goalKindValidator,
    origin: v.optional(goalOriginValidator),
    targetPeriodId: v.optional(v.id("reportingPeriods")),
    feedsTutor: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);

    const title = args.title.trim();
    if (!title) throw new Error("Goal needs a title");

    const status = isTeacher ? "active" : "proposed";
    const origin = isTeacher ? (args.origin ?? "teacher") : "scholar";
    // Only a teacher's live goal feeds the tutor; a proposal never does.
    const feedsTutor = isTeacher ? (args.feedsTutor ?? true) : false;

    const id = await ctx.db.insert("scholarGoals", {
      scholarId: args.scholarId,
      title,
      description: args.description?.trim() || undefined,
      kind: args.kind,
      origin,
      createdBy: ctx.user._id,
      status,
      feedsTutor,
      targetPeriodId: args.targetPeriodId,
    });
    return await ctx.db.get(id);
  },
});

/** Approve a scholar-proposed goal → active + feeds the tutor (teacher-only). */
export const approve = authedMutation({
  args: { goalId: v.id("scholarGoals") },
  handler: async (ctx, args) => {
    const goal = await requireTeacherGoal(ctx, args.goalId);
    await ctx.db.patch(args.goalId, { status: "active", feedsTutor: true });
    return await ctx.db.get(goal._id);
  },
});

/** Move a goal's lifecycle: active → achieved / retired (teacher-only). */
export const setStatus = authedMutation({
  args: { goalId: v.id("scholarGoals"), status: goalStatusValidator },
  handler: async (ctx, args) => {
    await requireTeacherGoal(ctx, args.goalId);
    // Achieved / retired goals stop feeding the tutor.
    const feedsPatch =
      args.status === "achieved" || args.status === "retired"
        ? { feedsTutor: false }
        : {};
    await ctx.db.patch(args.goalId, { status: args.status, ...feedsPatch });
    return await ctx.db.get(args.goalId);
  },
});

/** Toggle whether an active goal is injected into the tutor prompt. */
export const setFeedsTutor = authedMutation({
  args: { goalId: v.id("scholarGoals"), feedsTutor: v.boolean() },
  handler: async (ctx, args) => {
    await requireTeacherGoal(ctx, args.goalId);
    await ctx.db.patch(args.goalId, { feedsTutor: args.feedsTutor });
    return await ctx.db.get(args.goalId);
  },
});

/** Edit a goal's text/meta (teacher-only). */
export const update = authedMutation({
  args: {
    goalId: v.id("scholarGoals"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    kind: v.optional(goalKindValidator),
    targetPeriodId: v.optional(v.id("reportingPeriods")),
  },
  handler: async (ctx, args) => {
    await requireTeacherGoal(ctx, args.goalId);
    const patch: Record<string, unknown> = {};
    if (args.title !== undefined) {
      const t = args.title.trim();
      if (!t) throw new Error("Goal needs a title");
      patch.title = t;
    }
    if (args.description !== undefined)
      patch.description = args.description.trim() || undefined;
    if (args.kind !== undefined) patch.kind = args.kind;
    if (args.targetPeriodId !== undefined)
      patch.targetPeriodId = args.targetPeriodId;
    await ctx.db.patch(args.goalId, patch);
    return await ctx.db.get(args.goalId);
  },
});

/** Delete a goal + its check-ins (teacher-only). */
export const remove = authedMutation({
  args: { goalId: v.id("scholarGoals") },
  handler: async (ctx, args) => {
    await requireTeacherGoal(ctx, args.goalId);
    const checkins = await ctx.db
      .query("goalCheckins")
      .withIndex("by_goal", (q) => q.eq("goalId", args.goalId))
      .collect();
    for (const c of checkins) await ctx.db.delete(c._id);
    await ctx.db.delete(args.goalId);
  },
});

/**
 * Log a check-in against a goal. A scholar logs their own "I did this" moment
 * (authorType "scholar"); a teacher logs a note (authorType "teacher"). The
 * child's own sense of achievement is Identity-dimension evidence (§9).
 */
export const addCheckin = authedMutation({
  args: {
    goalId: v.id("scholarGoals"),
    note: v.string(),
    sessionId: v.optional(v.id("sessions")),
  },
  handler: async (ctx, args) => {
    const goal = await ctx.db.get(args.goalId);
    if (!goal) throw new Error("Goal not found");
    const isTeacher = requireTeacherOrSelf(ctx.user, goal.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, goal.scholarId);

    const note = args.note.trim();
    if (!note) throw new Error("Check-in needs a note");

    const id = await ctx.db.insert("goalCheckins", {
      goalId: args.goalId,
      scholarId: goal.scholarId,
      authorType: isTeacher ? "teacher" : "scholar",
      authorId: ctx.user._id,
      note,
      sessionId: args.sessionId,
    });
    return await ctx.db.get(id);
  },
});

// ── Internal (observer / bot) ─────────────────────────────────────────

/**
 * Active goals that feed the tutor prompt, for a scholar. Read by
 * getSessionContext to build the deterministic Goals section.
 */
export const activeForPrompt = internalQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("scholarGoals")
      .withIndex("by_scholar_status", (q) =>
        q.eq("scholarId", args.scholarId).eq("status", "active"),
      )
      .collect();
    return rows
      .filter((g) => g.feedsTutor)
      .sort((a, b) => a._creationTime - b._creationTime)
      .map((g) => ({ title: g.title, description: g.description, kind: g.kind }));
  },
});

/** Observer-noticed progress on a goal (a session plainly advanced it). */
export const recordCheckinInternal = internalMutation({
  args: {
    goalId: v.id("scholarGoals"),
    note: v.string(),
    sessionId: v.optional(v.id("sessions")),
    authorType: v.optional(
      v.union(v.literal("scholar"), v.literal("teacher"), v.literal("observer")),
    ),
  },
  handler: async (ctx, args) => {
    const goal = await ctx.db.get(args.goalId);
    if (!goal) throw new Error("Goal not found");
    return await ctx.db.insert("goalCheckins", {
      goalId: args.goalId,
      scholarId: goal.scholarId,
      authorType: args.authorType ?? "observer",
      note: args.note.trim(),
      sessionId: args.sessionId,
    });
  },
});

/** Create a goal on a teacher's behalf (the staff bot goal-setting tool). */
export const createForScholarInternal = internalMutation({
  args: {
    scholarId: v.id("users"),
    createdBy: v.id("users"),
    title: v.string(),
    description: v.optional(v.string()),
    kind: goalKindValidator,
    origin: goalOriginValidator,
    targetPeriodId: v.optional(v.id("reportingPeriods")),
  },
  handler: async (ctx, args) => {
    const title = args.title.trim();
    if (!title) throw new Error("Goal needs a title");
    return await ctx.db.insert("scholarGoals", {
      scholarId: args.scholarId,
      title,
      description: args.description?.trim() || undefined,
      kind: args.kind,
      origin: args.origin,
      createdBy: args.createdBy,
      status: "active",
      feedsTutor: true,
      targetPeriodId: args.targetPeriodId,
    });
  },
});

/**
 * Find a scholar's active goal whose title best matches a query string — for
 * the bot goal-checkin tool ("log that Kai built the solar oven for his goal").
 * Returns the single case-insensitive substring match, or null if 0/ambiguous.
 */
export const findActiveByTitleInternal = internalQuery({
  args: { scholarId: v.id("users"), titleQuery: v.string() },
  handler: async (ctx, args) => {
    const q = args.titleQuery.trim().toLowerCase();
    if (!q) return null;
    const rows = await ctx.db
      .query("scholarGoals")
      .withIndex("by_scholar_status", (qi) =>
        qi.eq("scholarId", args.scholarId).eq("status", "active"),
      )
      .collect();
    const matches = rows.filter((g) => g.title.toLowerCase().includes(q));
    if (matches.length === 1) return { _id: matches[0]._id, title: matches[0].title };
    // Exact-title tiebreak when several fuzzy-match.
    const exact = rows.find((g) => g.title.toLowerCase() === q);
    if (exact) return { _id: exact._id, title: exact.title };
    return null;
  },
});

// ── Helpers ───────────────────────────────────────────────────────────

/** Gate a goal mutation to teacher/admin + active scholar access. */
async function requireTeacherGoal(
  ctx: MutationCtx & { user: Doc<"users"> },
  goalId: Id<"scholarGoals">,
): Promise<Doc<"scholarGoals">> {
  const goal = await ctx.db.get(goalId);
  if (!goal) throw new Error("Goal not found");
  if (!isTeacherRole(ctx.user.role)) throw new Error("Forbidden");
  await requireActiveScholarAccess(ctx, ctx.user, goal.scholarId);
  return goal;
}
