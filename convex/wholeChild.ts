import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { staffQuery, staffMutation } from "./lib/customFunctions";
import { requireActiveScholarAccess } from "./lib/access";

/**
 * Whole Child inputs, stored as category-tagged observations
 * (review/assessment-and-goals-plan.html §8).
 *
 * Any staffer's quick take on a scholar, tagged to one of the Whole Child
 * categories, accumulating all period long (via the app aide, the Slack bot, or
 * this CRUD). They pool into the team "meeting mode" surface where the advisor
 * captures the agreed read. Not scaled scores — texture for the narrative.
 */

const categoryValidator = v.union(
  v.literal("execFunction"),
  v.literal("socialEmotional"),
  v.literal("collaboration"),
  v.literal("passions"),
  v.literal("other"),
);

/** All inputs for a scholar in a period (any staffer), newest first. */
export const listForScholarPeriod = staffQuery({
  args: { scholarId: v.id("users"), periodId: v.id("reportingPeriods") },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const period = await ctx.db.get(args.periodId);
    if (!period) throw new Error("Reporting period not found");
    const rows = await ctx.db
      .query("observations")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .order("desc")
      .collect();
    const inputs = rows.filter(
      (row) =>
        row.category !== undefined &&
        (row.periodId === args.periodId ||
          (row.periodId === undefined &&
            row._creationTime >= period.startsAt &&
            row._creationTime < period.endsAt)),
    );
    // Attach author display names for the meeting-mode rows.
    return await Promise.all(
      inputs.map(async (r) => {
        const author = await ctx.db.get(r.teacherId);
        return { ...r, authorName: author?.name ?? "Staff" };
      }),
    );
  },
});

export const add = staffMutation({
  args: {
    scholarId: v.id("users"),
    periodId: v.id("reportingPeriods"),
    category: categoryValidator,
    note: v.string(),
  },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const note = args.note.trim();
    if (!note) throw new Error("Whole-child input needs a note");
    const id = await ctx.db.insert("observations", {
      teacherId: ctx.user._id,
      scholarId: args.scholarId,
      category: args.category,
      periodId: args.periodId,
      note,
      type: "note",
    });
    return await ctx.db.get(id);
  },
});

export const remove = staffMutation({
  args: { inputId: v.id("observations") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.inputId);
    if (!row) return;
    await requireActiveScholarAccess(ctx, ctx.user, row.scholarId);
    if (row.category === undefined) {
      throw new Error("Whole-child input not found");
    }
    await ctx.db.delete(args.inputId);
  },
});

/** Capture a whole-child input on a staffer's behalf (the Slack/app bot tool). */
export const addInternal = internalMutation({
  args: {
    scholarId: v.id("users"),
    periodId: v.id("reportingPeriods"),
    authorId: v.id("users"),
    category: categoryValidator,
    note: v.string(),
  },
  handler: async (ctx, args) => {
    const note = args.note.trim();
    if (!note) throw new Error("Whole-child input needs a note");
    return await ctx.db.insert("observations", {
      teacherId: args.authorId,
      scholarId: args.scholarId,
      category: args.category,
      periodId: args.periodId,
      note,
      type: "note",
    });
  },
});
