import { v } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { teacherMutation, teacherQuery } from "./lib/customFunctions";
import { filterToAccessibleScholars, requireActiveScholarAccess } from "./lib/access";
import { requirePeriodForScholar } from "./reportingPeriods";
import {
  INTERIM_FLAG_KEYS,
  INTERIM_ITEM_KEYS,
  interimHasContent,
  interimRatedCount,
} from "./lib/interimCheckinTemplate";

/**
 * Interim check-ins — the mid-term Interim Academic & Whole Child Evaluation,
 * one per scholar × reporting period.
 *
 * The form's shape lives in `lib/interimCheckinTemplate.ts`; this file only
 * stores answers against its item keys and refuses keys the template doesn't
 * know. `open` is idempotent, which is the once-per-term guarantee: a second
 * open for the same scholar and period returns the existing check-in.
 *
 * Teacher-only (the same gate as course narratives): operations staff cannot
 * read or write it. Nothing here reaches the tutor or the parent portal.
 */

const ratingValidator = v.union(
  v.literal("consistently"),
  v.literal("usually"),
  v.literal("developing"),
  v.literal("needsSupport"),
  v.literal("notObserved"),
);

const commentField = v.union(
  v.literal("strengths"),
  v.literal("growth"),
  v.literal("familyGoals"),
);

// ── Queries ───────────────────────────────────────────────────────────

export const getForScholarPeriod = teacherQuery({
  args: { scholarId: v.id("users"), periodId: v.id("reportingPeriods") },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const row = await ctx.db
      .query("interimCheckins")
      .withIndex("by_scholar_period", (q) =>
        q.eq("scholarId", args.scholarId).eq("periodId", args.periodId),
      )
      .unique();
    if (!row) return null;
    const teacher = await ctx.db.get(row.teacherId);
    return { ...row, teacherName: teacher?.name ?? null };
  },
});

/** Per-scholar check-in status for a period — the Reports roster's dots. */
export const listForPeriod = teacherQuery({
  args: { periodId: v.id("reportingPeriods") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("interimCheckins")
      .withIndex("by_period", (q) => q.eq("periodId", args.periodId))
      .collect();
    const allowed = new Set(
      await filterToAccessibleScholars(
        ctx,
        ctx.user,
        rows.map((r) => r.scholarId),
      ),
    );
    return rows
      .filter((r) => allowed.has(r.scholarId))
      .map((r) => ({
        _id: r._id,
        scholarId: r.scholarId,
        status: r.status,
        ratedCount: interimRatedCount(r.ratings),
        hasContent: interimHasContent(r),
      }));
  },
});

// ── Mutations ─────────────────────────────────────────────────────────

/** Start (or return) the scholar's one check-in for this period. */
export const open = teacherMutation({
  args: { scholarId: v.id("users"), periodId: v.id("reportingPeriods") },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    await requirePeriodForScholar(ctx, args.periodId, args.scholarId);
    const existing = await ctx.db
      .query("interimCheckins")
      .withIndex("by_scholar_period", (q) =>
        q.eq("scholarId", args.scholarId).eq("periodId", args.periodId),
      )
      .unique();
    if (existing) return existing._id;
    return await ctx.db.insert("interimCheckins", {
      scholarId: args.scholarId,
      periodId: args.periodId,
      teacherId: ctx.user._id,
      ratings: {},
      flags: [],
      comments: { strengths: "", growth: "", familyGoals: "" },
      status: "draft",
    });
  },
});

/** Rate one item, or clear it by omitting `rating`. */
export const setRating = teacherMutation({
  args: {
    checkinId: v.id("interimCheckins"),
    itemKey: v.string(),
    rating: v.optional(ratingValidator),
  },
  handler: async (ctx, args) => {
    if (!INTERIM_ITEM_KEYS.includes(args.itemKey))
      throw new Error(`Unknown check-in item: ${args.itemKey}`);
    const row = await requireCheckin(ctx, args.checkinId);
    const ratings = { ...row.ratings };
    if (args.rating === undefined) delete ratings[args.itemKey];
    else ratings[args.itemKey] = args.rating;
    await ctx.db.patch(args.checkinId, { ratings });
  },
});

/** Set or clear a subject's "not a preferred subject" flag. */
export const setFlag = teacherMutation({
  args: { checkinId: v.id("interimCheckins"), flagKey: v.string(), on: v.boolean() },
  handler: async (ctx, args) => {
    if (!INTERIM_FLAG_KEYS.includes(args.flagKey))
      throw new Error(`Unknown check-in flag: ${args.flagKey}`);
    const row = await requireCheckin(ctx, args.checkinId);
    const flags = row.flags.filter((f) => f !== args.flagKey);
    if (args.on) flags.push(args.flagKey);
    await ctx.db.patch(args.checkinId, { flags });
  },
});

export const saveComment = teacherMutation({
  args: { checkinId: v.id("interimCheckins"), field: commentField, body: v.string() },
  handler: async (ctx, args) => {
    const row = await requireCheckin(ctx, args.checkinId);
    await ctx.db.patch(args.checkinId, {
      comments: { ...row.comments, [args.field]: args.body },
    });
  },
});

/** Mark the check-in done (stamps the evaluation date) or reopen it. */
export const setDone = teacherMutation({
  args: { checkinId: v.id("interimCheckins"), done: v.boolean() },
  handler: async (ctx, args) => {
    await requireCheckin(ctx, args.checkinId);
    await ctx.db.patch(args.checkinId, {
      status: args.done ? "final" : "draft",
      completedAt: args.done ? Date.now() : undefined,
    });
  },
});

// ── Helpers ───────────────────────────────────────────────────────────

async function requireCheckin(
  ctx: MutationCtx & { user: Doc<"users"> },
  checkinId: Id<"interimCheckins">,
): Promise<Doc<"interimCheckins">> {
  const row = await ctx.db.get(checkinId);
  if (!row) throw new Error("Interim check-in not found");
  await requireActiveScholarAccess(ctx, ctx.user, row.scholarId);
  return row;
}
