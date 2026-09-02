import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { authedQuery } from "./lib/customFunctions";
import { requireTeacherOrSelf } from "./lib/auth";
import { requireActiveScholarAccess } from "./lib/access";
import { pcmDimensionValidator } from "./lib/pcm";

/**
 * Record a cross-domain connection (called by the observer action).
 */
export const record = internalMutation({
  args: {
    scholarId: v.id("users"),
    sessionId: v.id("sessions"),
    domains: v.array(v.string()),
    conceptLabels: v.array(v.string()),
    description: v.string(),
    studentInitiated: v.boolean(),
    transcriptExcerpt: v.optional(v.string()),
    pcmDimension: v.optional(pcmDimensionValidator),
  },
  handler: async (ctx, args) => {
    if (args.domains.length < 2) return null;

    return await ctx.db.insert("crossDomainConnections", {
      scholarId: args.scholarId,
      sessionId: args.sessionId,
      domains: args.domains,
      conceptLabels: args.conceptLabels,
      description: args.description,
      studentInitiated: args.studentInitiated,
      transcriptExcerpt: args.transcriptExcerpt,
      pcmDimension: args.pcmDimension,
    });
  },
});

/**
 * List all cross-domain connections for a scholar.
 */
export const listByScholar = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);

    return await ctx.db
      .query("crossDomainConnections")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .order("desc")
      .collect();
  },
});
