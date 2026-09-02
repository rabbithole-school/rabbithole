/**
 * feedMetrics — the scholar Feed's secondary "reassurance strip": coverage
 * (breadth, standards-as-tags) + momentum (practice velocity). Both signals
 * are self-vs-expectation — NEVER a composite "level" scalar, NEVER a
 * percentile/leaderboard/learner↔learner comparison. See
 * review/practice/practice-engine-roadmap.html §6 for the design rationale +
 * guardrails this file must honour.
 *
 * Coverage REUSES the exact per-standard rigor read convex/acceleration.ts is
 * built from (lib/standardStrand + lib/bloomRigor's `summarizeBand` — the ONE
 * place a band's headline is computed), narrowed to just the scholar's OWN
 * chronological grade band across every strand, so "N of M" is an exact
 * standard tally (dist.met + dist.beyond, out of total) — not a re-derived
 * percentage. No new standards logic; this is the same shared building blocks
 * acceleration.ts uses, just aggregated across strands at one grade.
 *
 * Momentum blends the two "did real practice happen" signals already in the
 * schema — practiceMastery (the new problem-set engine) and
 * masteryObservations (the observer's tutoring-session evidence) — via the
 * pure convex/lib/feedMomentum.ts helper. No new table, no stored history.
 *
 * TODO(parent portal): the parent surface is a separate surface, out of scope
 * for this lane — wire this same query there when that surface lands.
 */

import { v } from "convex/values";
import { authedQuery } from "./lib/customFunctions";
import { ROLES, isTeacherRole } from "./lib/roles";
import { canReadScholarAsTeacher } from "./lib/access";
import { isGradeSpecific, strandForStandard, trackedGrades } from "./lib/standardStrand";
import { expectedBloomForStandard, summarizeBand, type BandStandard } from "./lib/bloomRigor";
import { computeMomentum, MOMENTUM_WINDOW_DAYS, type Momentum } from "./lib/feedMomentum";

export type Coverage = { onTrackOrAhead: number; total: number };

export type FeedMetrics = {
  coverage: Coverage | null;
  momentum: Momentum;
};

function emptyResult(): FeedMetrics {
  return {
    coverage: null,
    momentum: { daysActive: 0, windowDays: MOMENTUM_WINDOW_DAYS, skillsStrengthened: 0 },
  };
}

/**
 * Coverage + momentum for one scholar. Teacher- or self-facing, matching the
 * gating other per-scholar Feed reads use (requireTeacherOrSelf) — but,
 * following convex/messages.ts's getScholarReadingTrend, denial returns the
 * safe EMPTY shape rather than throwing, so a thrown query never trips the
 * Feed's route ErrorBoundary.
 */
export const forScholar = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const isTeacher = isTeacherRole(ctx.user.role);
    if (!isTeacher && ctx.user._id !== args.scholarId) return emptyResult();

    const scholar = await ctx.db.get(args.scholarId);
    if (!scholar || scholar.role !== ROLES.SCHOLAR) return emptyResult();

    // Institution scope — mirrors getScholarReadingTrend exactly: enforced
    // unless the rollout flag is explicitly "off", and a denial returns the
    // safe empty shape (never throws) so the profile/Feed keeps rendering.
    if (isTeacher && !(await canReadScholarAsTeacher(ctx, ctx.user, args.scholarId))) {
      return emptyResult();
    }

    // Current (non-superseded) mastery evidence — the shared input for both
    // coverage (standardIds → per-standard demonstrated level) and momentum
    // (observedAt/masteryLevel → "strengthened this week").
    const observations = await ctx.db
      .query("masteryObservations")
      .withIndex("by_scholar_current", (q) =>
        q.eq("scholarId", args.scholarId).eq("isSuperseded", false),
      )
      .collect();

    // ── Coverage: on track or ahead vs. the scholar's OWN grade-level standards ──
    let coverage: Coverage | null = null;
    const chronologicalGrade = scholar.gradeLevel ?? null;
    if (chronologicalGrade) {
      const levelByStandard = new Map<string, number>();
      for (const obs of observations) {
        for (const sid of obs.standardIds ?? []) {
          const k = sid as unknown as string;
          levelByStandard.set(k, Math.max(levelByStandard.get(k) ?? 0, obs.masteryLevel));
        }
      }

      const allStandards = await ctx.db.query("standards").collect();
      const bandStandards: BandStandard[] = [];
      for (const s of allStandards) {
        if (!s.isLeaf || !isGradeSpecific(s.gradeLevels)) continue; // skip anchor/skill standards
        if (!trackedGrades(s.gradeLevels).includes(chronologicalGrade)) continue; // not this grade
        if (!strandForStandard(s.subject, s.notation)) continue; // not grade-banded (excluded)
        bandStandards.push({
          demonstrated: levelByStandard.get(s._id as unknown as string),
          expected: expectedBloomForStandard(s.description),
        });
      }

      if (bandStandards.length > 0) {
        const summary = summarizeBand(bandStandards);
        coverage = { onTrackOrAhead: summary.dist.met + summary.dist.beyond, total: summary.total };
      }
    }

    // ── Momentum: practice velocity, blended across both practice signals ──
    const practiceRows = await ctx.db
      .query("practiceMastery")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .collect();

    const momentum = computeMomentum(
      practiceRows.map((r) => ({
        skillKey: r.skillKey,
        repetition: r.repetition,
        updatedAt: r.updatedAt,
        lastAttemptAt: r.lastAttemptAt,
        lastPracticedAt: r.lastPracticedAt,
        becameFluentAt: r.becameFluentAt,
        frontierAdvancedAt: r.frontierAdvancedAt,
      })),
      observations.map((o) => ({
        conceptLabel: o.conceptLabel,
        masteryLevel: o.masteryLevel,
        observedAt: o.observedAt,
        attemptContext: o.attemptContext,
      })),
      Date.now(),
    );

    return { coverage, momentum };
  },
});
