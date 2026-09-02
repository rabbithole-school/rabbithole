/**
 * understandingsData — the (non-node) query + mutation the "use node"
 * understandings.translateBand action calls. Kept separate because queries and
 * mutations may not live in a `"use node"` module.
 */

import { v } from "convex/values";
import { internalQuery, internalMutation } from "./_generated/server";
import { isGradeSpecific, strandForStandard, trackedGrades } from "./lib/standardStrand";

/** The grade-specific leaf standards in one (strand, grade) band. */
export const bandForTranslation = internalQuery({
  args: { strandKey: v.string(), grade: v.string() },
  handler: async (ctx, args) => {
    const all = await ctx.db.query("standards").collect();
    return all.filter((s) => {
      if (!s.isLeaf || !isGradeSpecific(s.gradeLevels)) return false;
      if (!trackedGrades(s.gradeLevels).includes(args.grade)) return false;
      const strand = strandForStandard(s.subject, s.notation);
      return strand?.key === args.strandKey;
    });
  },
});

/** Persist LLM-translated understandings onto their standards. */
export const setUnderstandings = internalMutation({
  args: {
    patches: v.array(v.object({ id: v.id("standards"), understanding: v.string() })),
    source: v.string(),
  },
  handler: async (ctx, args) => {
    for (const p of args.patches) {
      await ctx.db.patch(p.id, {
        understanding: p.understanding,
        understandingSource: args.source,
      });
    }
    return { patched: args.patches.length };
  },
});
