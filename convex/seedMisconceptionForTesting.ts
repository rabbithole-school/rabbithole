/**
 * Dev-only helper: seed ONE open misconception on a whole-number-arithmetic
 * practice skill the scholar already has, so the misconception flag renders on
 * the TEACHER scholar-map (audience="teacher").
 *
 * Why it resolves: nodeReadingsForScholar matches an observation to a map node
 * by `node.nodeKey === normalizeLabel(conceptLabel)`, and normalizeLabel only
 * lowercases + collapses whitespace — so setting conceptLabel to the skill's
 * nodeKey (already lowercase, no spaces) lands it exactly on that node.
 */
import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

export const seedMisconceptionForTesting = internalMutation({
  args: { scholarUsername: v.string(), skillKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const scholar = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.scholarUsername))
      .first();
    if (!scholar) throw new Error(`no scholar '${args.scholarUsername}'`);

    const skillKey = args.skillKey ?? "subtract_3digit_regroup";
    const session =
      (await ctx.db
        .query("sessions")
        .withIndex("by_user", (q) => q.eq("userId", scholar._id))
        .first()) ?? (await ctx.db.query("sessions").first());
    if (!session) throw new Error("no session to attach the observation to");

    const observationId = await ctx.db.insert("masteryObservations", {
      scholarId: scholar._id,
      conceptLabel: skillKey, // == node.nodeKey ⇒ resolves onto the map node
      domain: "whole-number-arithmetic",
      observedAt: Date.now(),
      sessionId: session._id,
      transcriptExcerpt:
        '"652 minus 387… ones: 7 take away 2 is 5; tens: 8 take away 5 is 3; so 335." (took the smaller digit from the larger in each column instead of borrowing.)',
      masteryLevel: 1,
      confidenceScore: 0.9,
      evidenceSummary:
        "Subtracts the smaller digit from the larger within each column regardless of position (the classic 'always take smaller from bigger' bug) — borrowing never happens.",
      evidenceType: "misconception_signal",
      attemptContext:
        "Practice — a 3-digit subtraction needing regrouping across two columns.",
      studentInitiated: false,
      isSuperseded: false,
      misconceptionStatus: "open",
      misconceptionNote:
        "Doesn't yet treat subtraction as position-dependent. A base-ten-blocks 'you can't take 7 from 2 — trade a ten' demo should make the borrow concrete before more symbolic drill.",
    });
    return { observationId, scholar: scholar.username, skillKey, sessionId: session._id };
  },
});
