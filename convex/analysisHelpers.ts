import { v } from "convex/values";
import { internalQuery, internalMutation } from "./_generated/server";

/**
 * Save an observer analysis result.
 */
export const saveAnalysis = internalMutation({
  args: {
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
    });

    // Update project pulse score
    await ctx.db.patch(args.sessionId, {
      analysisSummary: args.summary,
      pulseScore: args.pulseScore,
    });
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
