import { v } from "convex/values";
import { authedQuery } from "./lib/customFunctions";
import { requireTeacherOrSelf } from "./lib/auth";
import { requireActiveScholarAccess } from "./lib/access";

/**
 * Learning record — the kid-facing "peek behind the curtain."
 *
 * Powers the transparency surface on /how-it-works (the scholar's "How it
 * works" page — formerly tacked onto the bottom of /me): it demystifies how
 * Rabbithole works and reinforces the north star — continuity comes from
 * *saved notes a real teacher governs*, NOT from an AI that "remembers" or
 * "cares." (See review/learner-parent-pedagogy.md + the prompt-design doc's
 * "scholar memory is governed" section.)
 *
 * This is a learner-safe SUMMARY by construction: it returns COUNTS and a
 * date only — never the score-bearing / observer-voiced contents of the
 * record. The redaction-gated `scholarDocuments` (IQ/index/subtest scores,
 * IEPs, assessments) are not touched at all; neither are mastery levels,
 * confidence scores, Bloom labels, or transcript excerpts. So there is
 * nothing here a kid shouldn't see — just "how many little notes exist
 * about your learning, and since when."
 */
export const mySummary = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);

    // "Notes" = the observer-written learning record the kid already sees
    // reframed above (How you work / How you've grown): the current
    // (non-superseded) mastery observations plus the session signals.
    const observations = await ctx.db
      .query("masteryObservations")
      .withIndex("by_scholar_current", (q) =>
        q.eq("scholarId", args.scholarId).eq("isSuperseded", false),
      )
      .collect();
    const signals = await ctx.db
      .query("sessionSignals")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .collect();

    const noteCount = observations.length + signals.length;

    // Earliest note — the honest "going back to …" anchor. Mastery
    // observations stamp `observedAt`; signals only carry `_creationTime`.
    const times: number[] = [
      ...observations.map((o) => o.observedAt),
      ...signals.map((s) => s._creationTime),
    ];
    const firstNoteAt = times.length > 0 ? Math.min(...times) : null;

    return { noteCount, firstNoteAt };
  },
});
