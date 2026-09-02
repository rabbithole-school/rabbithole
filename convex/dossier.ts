import { v } from "convex/values";
import { internalQuery, internalMutation } from "./_generated/server";
import { authedQuery, authedMutation } from "./lib/customFunctions";
import { requireTeacherOrSelf } from "./lib/auth";
import { requireActiveScholarAccess } from "./lib/access";
import { attributedScholarIds } from "./lib/portfolioAttributions";

/**
 * Learner-stated interests and self-reflections from profile surveys. The
 * portfolio item remains the source of truth, so each profile entry carries its
 * source item rather than becoming an ungrounded dossier assertion.
 */
export const learnerStatementsForTeacher = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);

    const directItems = await ctx.db
      .query("portfolioItems")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .collect();
    const attributions = await ctx.db
      .query("portfolioAttributions")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .collect();
    const items = new Map(directItems.map((item) => [item._id, item]));
    for (const attribution of attributions) {
      const item = await ctx.db.get(attribution.portfolioItemId);
      if (item) items.set(item._id, item);
    }

    const entries = [];
    for (const item of items.values()) {
      if (!item.learnerStatements?.length) continue;
      const sourceScholarIds = await attributedScholarIds(ctx, item);
      // A shared page cannot safely carry one learner's self-report. Only retain
      // sources with one unambiguous learner attribution.
      if (
        sourceScholarIds.length !== 1 ||
        sourceScholarIds[0] !== args.scholarId
      ) {
        continue;
      }
      entries.push({
        sourceItemId: item._id,
        sourceLabel: item.label || item.documentHeading || item.title,
        statements: item.learnerStatements,
        createdAt: item._creationTime,
      });
    }
    return entries
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(({ createdAt: _createdAt, ...entry }) => entry);
  },
});

/**
 * Get dossier for a scholar (used by system prompt builder).
 */
export const aiGet = internalQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("scholarDossiers")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .first();
  },
});

/**
 * Upsert dossier content (called by AI tool handler).
 */
export const aiUpdate = internalMutation({
  args: {
    scholarId: v.id("users"),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("scholarDossiers")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, { content: args.content });
    } else {
      await ctx.db.insert("scholarDossiers", {
        scholarId: args.scholarId,
        content: args.content,
      });
    }
  },
});

/**
 * Get dossier for teacher UI (ScholarProfile).
 */
export const getForTeacher = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);

    const dossier = await ctx.db
      .query("scholarDossiers")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .first();
    return dossier?.content ?? null;
  },
});

/**
 * Teacher manual edit of dossier.
 */
export const updateByTeacher = authedMutation({
  args: {
    scholarId: v.id("users"),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);

    const existing = await ctx.db
      .query("scholarDossiers")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, { content: args.content });
    } else {
      await ctx.db.insert("scholarDossiers", {
        scholarId: args.scholarId,
        content: args.content,
      });
    }
  },
});
