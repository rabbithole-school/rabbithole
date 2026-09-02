/**
 * Predict-then-Check calibration — the read surface.
 *
 * Predictions are written on the grade path (convex/practiceSkills.ts →
 * submitAnswer); this file only reads them back through the pure summarizer
 * (convex/lib/practice/calibration.ts). Three audiences, three shapes:
 *
 *   • myCalibrationSummary — the SCHOLAR's own read. Returns ONLY { n, band } —
 *     no raw gap/bias numbers ever reach the kid (they see gentle per-item
 *     mismatch reveals in the practice loop, and at most a soft
 *     "getting to know what you know" line). Self-only: no scholarId arg, so a
 *     scholar can never read another scholar's calibration.
 *   • calibrationForSelf — the SCHOLAR's OWN calibration MIRROR (the "Getting
 *     to know what you know" section on /me): a per-confidence-level
 *     correct/total breakdown + a growth-framed sentence key for the band —
 *     still never a raw bias/gap number. Self-or-teacher gated like
 *     crossDomainConnections.listByScholar; null below CALIBRATION_MIN_N (no
 *     nag to "collect more" — the section just doesn't render).
 *   • calibrationForScholar — the TEACHER's read. Full summary + a per-domain
 *     breakdown. Teacher-gated (teacherQuery) + institution-scoped
 *     (requireActiveScholarAccess), mirroring cohortPractice.ts.
 *
 * The redaction boundary is structural: the teacher-facing numbers live only in
 * the teacher query; the scholar-facing queries never return raw bias/gap.
 */

import { v } from "convex/values";
import { authedQuery, teacherQuery } from "./lib/customFunctions";
import { requireActiveScholarAccess } from "./lib/access";
import { requireTeacherOrSelf } from "./lib/auth";
import {
  growthLineForBand,
  summarizeByConfidenceLevel,
  summarizeCalibration,
} from "./lib/practice/calibration";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

/** How many recent predictions feed a summary (both audiences). */
const CALIBRATION_WINDOW = 50;

/** Most-recent-first predictions for a scholar, capped at the window. */
async function recentPredictions(
  ctx: QueryCtx,
  scholarId: Id<"users">,
): Promise<Doc<"practicePredictions">[]> {
  return await ctx.db
    .query("practicePredictions")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .order("desc")
    .take(CALIBRATION_WINDOW);
}

/**
 * The scholar's OWN recent calibration band. Returns only { n, band } — never
 * raw bias/gap numbers (kid-facing redaction). Self-scoped: reads ctx.user, so
 * there is no way to ask for someone else's.
 */
export const myCalibrationSummary = authedQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await recentPredictions(ctx, ctx.user._id);
    const { n, band } = summarizeCalibration(
      rows.map((r) => ({ confidence: r.confidence, correct: r.correct })),
    );
    return { n, band };
  },
});

/**
 * The scholar's OWN calibration MIRROR: a per-confidence-level correct/total
 * breakdown plus a growth-framed sentence key for the band — never the raw
 * bias/gap numbers (same redaction as myCalibrationSummary, richer shape).
 * Self-or-teacher gated exactly like crossDomainConnections.listByScholar.
 * Returns null below CALIBRATION_MIN_N (growthLineForBand("insufficient_data")
 * is null) — the SAME gate summarizeCalibration already applies, not a
 * duplicated n ≥ 8 check.
 */
export const calibrationForSelf = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);

    const rows = await recentPredictions(ctx, args.scholarId);
    const pairs = rows.map((r) => ({ confidence: r.confidence, correct: r.correct }));
    const { n, band } = summarizeCalibration(pairs);

    const growthLine = growthLineForBand(band);
    if (growthLine === null) return null; // insufficient data

    return { n, byLevel: summarizeByConfidenceLevel(pairs), growthLine };
  },
});

/**
 * Teacher-facing full calibration for one scholar: the overall summary plus a
 * per-domain breakdown (skillKey → knowledgeNodes.domain). Teacher-only +
 * institution-scoped. Never surfaced to the scholar (only myCalibrationSummary
 * is, and it omits the numbers).
 */
export const calibrationForScholar = teacherQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);

    const rows = await recentPredictions(ctx, args.scholarId);
    const overall = summarizeCalibration(
      rows.map((r) => ({ confidence: r.confidence, correct: r.correct })),
    );

    // Per-domain breakdown. Resolve each distinct skillKey → its node's domain
    // (a small number of lookups over the window). A skillKey with no node falls
    // back to "unknown" rather than being dropped, so the totals still reconcile.
    const domainByKey = new Map<string, string>();
    for (const key of new Set(rows.map((r) => r.skillKey))) {
      const node = await ctx.db
        .query("knowledgeNodes")
        .withIndex("by_nodeKey", (q) => q.eq("nodeKey", key))
        .first();
      domainByKey.set(key, node?.domain ?? "unknown");
    }

    const byDomainPairs = new Map<
      string,
      { confidence: number; correct: boolean }[]
    >();
    for (const r of rows) {
      const domain = domainByKey.get(r.skillKey) ?? "unknown";
      const list = byDomainPairs.get(domain) ?? [];
      list.push({ confidence: r.confidence, correct: r.correct });
      byDomainPairs.set(domain, list);
    }

    const byDomain = [...byDomainPairs.entries()]
      .map(([domain, pairs]) => ({ domain, ...summarizeCalibration(pairs) }))
      .sort((a, b) => b.n - a.n);

    return { overall, byDomain };
  },
});
