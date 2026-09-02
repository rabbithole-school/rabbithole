/**
 * Judge ↔ teacher micro-validation (sim-realism adoptable #2 — see
 * review/sim-realism-lessons.html §5 #2, addressing §4 Finding 4).
 *
 * The curriculum judge scores REAL transcripts during grounding, but because
 * the SAME judge scores both the sim and the real transcript, any judge bias
 * cancels in the calibration delta — grounding tells us how realistic the SIM
 * KID is, never how trustworthy the JUDGE is. This module runs the paper's own
 * validation at our scale: a teacher makes ~10 pairwise "which session went
 * better for this kid?" calls on real transcripts, and we correlate their picks
 * against the judge's fitness ranking (persisted per-session by grounding in
 * `groundedSessionVerdicts`). The result — an agreement rate + an r-value —
 * tells the team how much to trust every scorecard the loop produces.
 *
 * Teacher-gated via requireUnitEditAccess (same gate as curriculumExperiments).
 * All reads are of the teacher's OWN comparison state. The math lives in the
 * pure, unit-tested lib/judgeCorrelation.ts.
 */

import { v } from "convex/values";
import { authedQuery, authedMutation } from "./lib/customFunctions";
import { requireUnitEditAccess } from "./lib/auth";
import type { Doc, Id } from "./_generated/dataModel";
import {
  computeCorrelation,
  type PairObservation,
  type TeacherChoice,
} from "./lib/judgeCorrelation";

const MAX_PAIRS = 10;

const teacherChoiceValidator = v.union(
  v.literal("A"),
  v.literal("B"),
  v.literal("tie"),
);

/** Stable unordered key for a session pair (order-independent). */
function pairKey(a: Id<"sessions">, b: Id<"sessions">): string {
  return [String(a), String(b)].sort().join("|");
}

/**
 * Deterministically pick up to `limit` informative pairs from judged sessions
 * sorted by fitness: alternate MAX-CONTRAST pairs (clearest judge signal —
 * outermost vs. innermost) with ADJACENT pairs (the close calls where the judge
 * is most likely to disagree with a human). Deterministic so the deck is
 * reproducible across reloads. Each pair is canonicalized A=min-id / B=max-id so
 * the on-screen position never leaks the judge's ranking.
 */
function selectPairs(
  sorted: { sessionId: Id<"sessions"> }[],
  limit: number,
): { sessionAId: Id<"sessions">; sessionBId: Id<"sessions"> }[] {
  const n = sorted.length;
  const seen = new Set<string>();
  const out: { sessionAId: Id<"sessions">; sessionBId: Id<"sessions"> }[] = [];
  const push = (i: number, j: number) => {
    if (i === j || out.length >= limit) return;
    const a = sorted[i].sessionId;
    const b = sorted[j].sessionId;
    const key = pairKey(a, b);
    if (seen.has(key)) return;
    seen.add(key);
    // Canonical A/B by id so position doesn't hint at the judge's pick.
    const [lo] = [String(a), String(b)].sort();
    const sessionAId = String(a) === lo ? a : b;
    const sessionBId = sessionAId === a ? b : a;
    out.push({ sessionAId, sessionBId });
  };
  // Max-contrast sweep from the ends inward.
  let lo = 0;
  let hi = n - 1;
  while (lo < hi && out.length < limit) {
    push(lo, hi);
    lo++;
    hi--;
  }
  // Fill the rest with adjacent (close-fitness) pairs.
  for (let i = 0; i + 1 < n && out.length < limit; i++) push(i, i + 1);
  return out;
}

/**
 * ~10 candidate pairs of REAL judged sessions for this activity, each with a
 * side-by-side excerpt, ready for a teacher to pick "which went better". The
 * judge's own preference (`judgeMargin`/`judgePrefers`) is returned so the UI
 * can reveal it AFTER a pick — never render it before, or it anchors the
 * teacher. `alreadyChoice` carries the teacher's prior pick for a pair (mapped
 * to the returned A/B order) so the deck can resume.
 */
export const pairsForActivity = authedQuery({
  args: { activityId: v.id("activities"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const { user } = await requireUnitEditAccess(ctx, {
      activityId: args.activityId,
    });
    const limit = Math.max(1, Math.min(args.limit ?? MAX_PAIRS, 25));

    const verdicts = await ctx.db
      .query("groundedSessionVerdicts")
      .withIndex("by_activity", (q) => q.eq("activityId", args.activityId))
      .collect();

    if (verdicts.length < 2) {
      return {
        judgedSessions: verdicts.length,
        recordedCount: 0,
        pairs: [] as PairRow[],
        note:
          "Ground this activity against real sessions first — the judge needs at least two real transcripts before you can validate it.",
      };
    }

    // Highest judge-fitness first (ties broken by id for determinism).
    const sorted = [...verdicts].sort(
      (a, b) => b.fitness - a.fitness || String(a._id).localeCompare(String(b._id)),
    );
    const byId = new Map<string, Doc<"groundedSessionVerdicts">>();
    for (const v of verdicts) byId.set(String(v.sessionId), v);

    // The teacher's prior picks, keyed by unordered pair.
    const priorRows = await ctx.db
      .query("judgeComparisons")
      .withIndex("by_activity_teacher", (q) =>
        q.eq("activityId", args.activityId).eq("teacherId", user._id),
      )
      .collect();
    const prior = new Map<string, Doc<"judgeComparisons">>();
    for (const r of priorRows) prior.set(pairKey(r.sessionAId, r.sessionBId), r);

    const chosen = selectPairs(
      sorted.map((v) => ({ sessionId: v.sessionId })),
      limit,
    );

    const pairs: PairRow[] = chosen.map(({ sessionAId, sessionBId }) => {
      const a = byId.get(String(sessionAId))!;
      const b = byId.get(String(sessionBId))!;
      const judgeMargin = a.fitness - b.fitness;
      const judgePrefers: TeacherChoice =
        judgeMargin > 1e-9 ? "A" : judgeMargin < -1e-9 ? "B" : "tie";
      // Map any prior pick into THIS pair's A/B order.
      const priorRow = prior.get(pairKey(sessionAId, sessionBId));
      let alreadyChoice: TeacherChoice | null = null;
      if (priorRow) {
        if (priorRow.teacherChoice === "tie") alreadyChoice = "tie";
        else {
          const priorPickedSession =
            priorRow.teacherChoice === "A"
              ? priorRow.sessionAId
              : priorRow.sessionBId;
          alreadyChoice =
            String(priorPickedSession) === String(sessionAId) ? "A" : "B";
        }
      }
      return {
        sessionAId,
        sessionBId,
        a: excerptCard(a),
        b: excerptCard(b),
        judgeMargin,
        judgePrefers,
        alreadyChoice,
      };
    });

    return {
      judgedSessions: verdicts.length,
      recordedCount: priorRows.length,
      pairs,
      note: null,
    };
  },
});

type PairCard = {
  profileName: string;
  readingLevel: string;
  goalAttainment: number;
  excerpt: string;
};
type PairRow = {
  sessionAId: Id<"sessions">;
  sessionBId: Id<"sessions">;
  a: PairCard;
  b: PairCard;
  judgeMargin: number;
  judgePrefers: TeacherChoice;
  alreadyChoice: TeacherChoice | null;
};

function excerptCard(v: Doc<"groundedSessionVerdicts">): PairCard {
  return {
    profileName: v.profileName,
    readingLevel: v.readingLevel,
    goalAttainment: v.goalAttainment,
    excerpt: v.excerpt,
  };
}

/**
 * Record the teacher's pick for one pair. Upserts by the unordered pair (last
 * pick wins), storing the A/B order the teacher saw so `correlation` can align
 * the choice with the judge's margin.
 */
export const recordChoice = authedMutation({
  args: {
    activityId: v.id("activities"),
    sessionAId: v.id("sessions"),
    sessionBId: v.id("sessions"),
    teacherChoice: teacherChoiceValidator,
  },
  handler: async (ctx, args) => {
    const { user } = await requireUnitEditAccess(ctx, {
      activityId: args.activityId,
    });
    if (String(args.sessionAId) === String(args.sessionBId)) {
      throw new Error("Cannot compare a session with itself");
    }
    // Both sessions must be judged for THIS activity — that's what makes the
    // comparison reproducible against a persisted judge ranking.
    for (const sessionId of [args.sessionAId, args.sessionBId]) {
      const judged = await ctx.db
        .query("groundedSessionVerdicts")
        .withIndex("by_activity_session", (q) =>
          q.eq("activityId", args.activityId).eq("sessionId", sessionId),
        )
        .unique();
      if (!judged) {
        throw new Error("Session has no judge verdict for this activity");
      }
    }

    const priorRows = await ctx.db
      .query("judgeComparisons")
      .withIndex("by_activity_teacher", (q) =>
        q.eq("activityId", args.activityId).eq("teacherId", user._id),
      )
      .collect();
    const key = pairKey(args.sessionAId, args.sessionBId);
    const existing = priorRows.find(
      (r) => pairKey(r.sessionAId, r.sessionBId) === key,
    );

    const row = {
      teacherId: user._id,
      activityId: args.activityId,
      sessionAId: args.sessionAId,
      sessionBId: args.sessionBId,
      teacherChoice: args.teacherChoice,
      createdAt: Date.now(),
    };
    if (existing) {
      await ctx.db.patch(existing._id, row);
    } else {
      await ctx.db.insert("judgeComparisons", row);
    }
    return { ok: true };
  },
});

/**
 * The judge↔teacher agreement for THIS teacher's picks on THIS activity:
 * agreement rate over decisive pairs + a Pearson r over the judge's fitness
 * margins vs. the teacher's choices, with n. Reproducible because it reads the
 * persisted judge verdicts, not an ad-hoc re-score.
 */
export const correlation = authedQuery({
  args: { activityId: v.id("activities") },
  handler: async (ctx, args) => {
    const { user } = await requireUnitEditAccess(ctx, {
      activityId: args.activityId,
    });

    const verdicts = await ctx.db
      .query("groundedSessionVerdicts")
      .withIndex("by_activity", (q) => q.eq("activityId", args.activityId))
      .collect();
    const fitnessById = new Map<string, number>();
    for (const v of verdicts) fitnessById.set(String(v.sessionId), v.fitness);

    const comparisons = await ctx.db
      .query("judgeComparisons")
      .withIndex("by_activity_teacher", (q) =>
        q.eq("activityId", args.activityId).eq("teacherId", user._id),
      )
      .collect();

    const observations: PairObservation[] = [];
    for (const c of comparisons) {
      const fa = fitnessById.get(String(c.sessionAId));
      const fb = fitnessById.get(String(c.sessionBId));
      // A verdict could have been dropped (e.g. session archived since); skip.
      if (fa === undefined || fb === undefined) continue;
      observations.push({
        judgeMargin: fa - fb,
        teacherChoice: c.teacherChoice as TeacherChoice,
      });
    }

    return {
      ...computeCorrelation(observations),
      judgedSessions: verdicts.length,
    };
  },
});
