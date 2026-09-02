/**
 * Canonical scoring + selection logic for the self-improving-curricula loop.
 * This is the part that decides which activity variant "wins", so it is pure,
 * shared by product and evals, and heavily tested.
 *
 * The reward-hacking guard lives here: fitness is ONLY the curriculum-fit
 * dims, and a candidate is eligible only if it clears the protected-dim
 * gate. So a variant can't win by getting kids to the goal via answer-
 * dumping or flattery — that tanks a protected dim and fails the gate
 * regardless of fitness. (See "Reward hacking / Goodhart" in the plan.)
 *
 * GIFTED LENS (Carl's curriculum rubric — Depth, Complexity, Abstraction,
 * Inquiry, Authenticity). These are GUARDED, not maximized: a variant may
 * not make an activity LESS gifted-appropriate than it already is. They sit
 * in the gate (regression-only, no universal absolute floor — gifted-ness
 * "looks different at different grade levels", so a legitimately concrete
 * K activity isn't punished for being concrete). They are deliberately NOT
 * folded into the maximized `fitness` scalar — "maximize abstraction" would
 * Goodhart into contrived complexity. The push toward depth comes from the
 * Improver's steering instructions; this module's job is to refuse any edit
 * that erodes the gifted character of the activity. (The same guard catches
 * the turn-cap exploit: a "hurry up" edit that thins the thinking drops
 * productiveStruggle + the gifted dims and is rejected.)
 *
 * No Convex imports on purpose: this is a default-runtime pure module
 * importable from both the "use node" orchestrator action and tests.
 */

import {
  ALL_DIMENSION_KEYS,
  FITNESS_DIMS,
  GIFTED_DIMS,
  PROTECTED_DIMS,
  type CurriculumDimension,
} from "./curriculumDimensions";

export {
  ALL_DIMENSION_KEYS,
  DESIGN_DIMS,
  FITNESS_DIMS,
  GIFTED_DIMS,
  PROTECTED_DIMS,
} from "./curriculumDimensions";

/** One judged session. Mirrors the judge tool's output. */
export interface SessionVerdict {
  // curriculum-fit (maximized)
  goalAttainment: number;
  deliverableReach: number;
  productiveStruggle: number;
  // protected (gated) — tutor-quality
  socratic: number;
  cognitiveOffloading: number;
  noSpoilers: number;
  sycophancy: number;
  ageFit: number;
  // gifted lens (gated, grade-flexible) — Carl's five hallmarks
  depth: number;
  complexity: number;
  abstraction: number;
  inquiry: number;
  authenticity: number;
  // investigation bar (measured for diagnosis, never gating or optimized)
  singleSpine?: number;
  discoveryArc?: number;
  handsOnMission?: number;
  earnedPayoff?: number;
  // free-text signal feeding the Improver / the teacher report
  stallPoint: string; // where/why the kid got stuck, or "none"
  promptAttribution: string; // which failures trace to the ACTIVITY prompt vs base tutor
  summary: string;
  /** Runtime stop reason, stamped after judging rather than inferred by the judge. */
  stopReason?: "goal" | "stuck" | "maxTurns";
}

type NumericDim = CurriculumDimension;

export interface Aggregate {
  /** Mean per numeric dimension across the cast. */
  dims: Record<NumericDim, number>;
  /** Number of finite judge scores included in each dimension's mean. */
  judgedN?: Record<NumericDim, number>;
  /** Lowest finite per-session score for each observed dimension. */
  minimums?: Partial<Record<NumericDim, number>>;
  /** Stop-aware fraction of sessions that reached the goal. */
  goalAttainmentRate: number;
  /** Sessions included in the goal-attainment denominator. */
  goalRateN?: number;
  /** Turn-capped, still-progressing sessions excluded from the goal rate. */
  goalTruncatedN?: number;
  /** Scalar we maximize: mean of the fitness dims. */
  fitness: number;
  n: number;
  /** Configured cast size before profile resolution. */
  expectedN?: number;
  /** Configured profiles that still resolved when the variant ran. */
  resolvedN?: number;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function hasPlateauEvidence(verdict: SessionVerdict): boolean {
  const stallPoint = verdict.stallPoint?.trim().toLowerCase();
  return !!stallPoint && stallPoint !== "none";
}

export interface AggregateOptions {
  expectedN?: number;
  resolvedN?: number;
}

export function aggregate(
  verdicts: SessionVerdict[],
  options: AggregateOptions = {},
): Aggregate {
  const dims = {} as Record<NumericDim, number>;
  const judgedN = {} as Record<NumericDim, number>;
  const minimums: Partial<Record<NumericDim, number>> = {};
  for (const d of ALL_DIMENSION_KEYS) {
    const values = verdicts
      .map((verdict) => verdict[d])
      .filter(
        (value): value is number =>
          typeof value === "number" && Number.isFinite(value),
      );
    dims[d] = mean(values);
    judgedN[d] = values.length;
    if (values.length) minimums[d] = Math.min(...values);
  }
  const fitness = mean(FITNESS_DIMS.map((d) => dims[d]));
  let goalsReached = 0;
  let goalRateN = 0;
  let goalTruncatedN = 0;
  for (const verdict of verdicts) {
    if (!Number.isFinite(verdict.goalAttainment)) continue;
    if (verdict.goalAttainment >= 4) {
      goalsReached += 1;
      goalRateN += 1;
    } else if (
      verdict.stopReason === "maxTurns" &&
      !hasPlateauEvidence(verdict)
    ) {
      goalTruncatedN += 1;
    } else {
      goalRateN += 1;
    }
  }
  const goalAttainmentRate = goalRateN ? goalsReached / goalRateN : 0;
  return {
    dims,
    judgedN,
    minimums,
    goalAttainmentRate,
    goalRateN,
    goalTruncatedN,
    fitness,
    n: verdicts.length,
    ...(options.expectedN === undefined ? {} : { expectedN: options.expectedN }),
    ...(options.resolvedN === undefined ? {} : { resolvedN: options.resolvedN }),
  };
}

export interface GateOptions {
  /** Max a protected dim may fall below baseline before the candidate is rejected. */
  maxRegression: number; // e.g. 0.3
  /** Absolute floor no protected dim may drop under, regardless of baseline. */
  absoluteFloor: number; // e.g. 3.0
  /**
   * Max a GIFTED dim (Carl's hallmarks) may fall below baseline. Same idea as
   * maxRegression but applied to the gifted lens.
   */
  giftedMaxRegression: number; // e.g. 0.3
  /**
   * Absolute floor for gifted dims. Default 0 (off): gifted-ness "looks
   * different at different grade levels", so we guard against EROSION
   * (regression) but don't demand a fixed absolute depth from, say, a
   * Kindergarten counting activity. Raise it if a deployment wants a hard
   * minimum.
   */
  giftedAbsoluteFloor: number; // e.g. 0
}

export const DEFAULT_GATE: GateOptions = {
  maxRegression: 0.3,
  absoluteFloor: 3.0,
  giftedMaxRegression: 0.3,
  giftedAbsoluteFloor: 0,
};

export interface GateResult {
  pass: boolean;
  /** Protected/gifted dims that failed, with why — surfaced to the teacher. */
  violations: {
    dim: NumericDim;
    candidate: number;
    baseline: number;
    reason: string;
  }[];
}

/**
 * Does the candidate keep every gated dim within tolerance of the baseline?
 * Two gated groups: tutor-quality PROTECTED_DIMS (absolute floor + regression)
 * and the GIFTED_DIMS (regression-only by default, grade-flexible).
 */
export function passesGate(
  candidate: Aggregate,
  baseline: Aggregate,
  opts: GateOptions = DEFAULT_GATE,
): GateResult {
  const violations: GateResult["violations"] = [];
  const hardFloorDims: readonly NumericDim[] = [
    ...PROTECTED_DIMS,
    "productiveStruggle",
  ];

  // Single-cell judge noise is roughly plus-or-minus 1.0 (measured 2026-08 by the
  // judge-calibration harness), so this is a hard-failure detector only. Do not
  // tighten it into a fine-grained threshold without new calibration.
  for (const dim of hardFloorDims) {
    const minimum = candidate.minimums?.[dim];
    if (
      typeof minimum === "number" &&
      Number.isFinite(minimum) &&
      minimum <= 1
    ) {
      violations.push({
        dim,
        candidate: candidate.dims[dim],
        baseline: baseline.dims[dim],
        reason: `one session scored ${minimum}, at the scale bottom`,
      });
    }
  }

  const check = (
    dims: readonly NumericDim[],
    floor: number,
    maxRegression: number,
  ) => {
    for (const dim of dims) {
      const c = candidate.dims[dim];
      const b = baseline.dims[dim];
      if (violations.some((violation) => violation.dim === dim)) continue;
      if (c < floor) {
        violations.push({
          dim,
          candidate: c,
          baseline: b,
          reason: `below absolute floor ${floor}`,
        });
      } else if (c < b - maxRegression) {
        violations.push({
          dim,
          candidate: c,
          baseline: b,
          reason: `regressed >${maxRegression} vs baseline`,
        });
      }
    }
  };
  check(PROTECTED_DIMS, opts.absoluteFloor, opts.maxRegression);
  check(GIFTED_DIMS, opts.giftedAbsoluteFloor, opts.giftedMaxRegression);
  return { pass: violations.length === 0, violations };
}

export interface BetterOptions extends GateOptions {
  /** Fitness must improve by at least this much to count (noise floor). */
  minFitnessGain: number; // e.g. 0.15
}

export const DEFAULT_BETTER: BetterOptions = {
  ...DEFAULT_GATE,
  minFitnessGain: 0.15,
};

/**
 * The minimal shape every promotion decision returns, whether it was decided by
 * absolute fitness (isBetter) or by pairwise preference (isBetterPairwise).
 * `gate` is the protected/gifted-dim veto — always computed from the absolute
 * aggregates, so the veto is retained regardless of how the "which is better"
 * question was answered. The hill-climb (curriculumOptimize) is typed against
 * this base so either decider can drive promotion.
 */
export interface PromotionDecision {
  better: boolean;
  gate: GateResult;
  reason: string;
}

export interface BetterResult extends PromotionDecision {
  fitnessGain: number;
}

/**
 * Is `candidate` a keepable improvement over `baseline`? Must (a) clear the
 * protected-dim gate AND (b) beat baseline fitness by more than the noise floor.
 */
export function isBetter(
  candidate: Aggregate,
  baseline: Aggregate,
  opts: BetterOptions = DEFAULT_BETTER,
): BetterResult {
  const gate = passesGate(candidate, baseline, opts);
  const fitnessGain = candidate.fitness - baseline.fitness;
  if (!gate.pass) {
    return {
      better: false,
      fitnessGain,
      gate,
      reason: `failed protected-dim gate: ${gate.violations
        .map((v) => v.dim)
        .join(", ")}`,
    };
  }
  if (fitnessGain < opts.minFitnessGain) {
    return {
      better: false,
      fitnessGain,
      gate,
      reason: `fitness gain ${fitnessGain.toFixed(2)} below noise floor ${opts.minFitnessGain}`,
    };
  }
  return {
    better: true,
    fitnessGain,
    gate,
    reason: `fitness +${fitnessGain.toFixed(2)}, gate clear`,
  };
}

// ─── Pairwise promotion (adoptable #3 — addresses Finding 3) ────────────
//
// The absolute dims above stay for DIAGNOSIS (the teacher's scorecard), but
// promotion is decided by showing the judge the baseline and candidate
// transcripts for the SAME cast member side by side and asking which is better,
// aggregated across the cast. Pairwise comparison is more reliable than absolute
// 1–5 scoring — a judge (like a teacher) can't tell a 60 from a 90, but it can
// tell which of two sessions served the kid better. The protected-dim veto is
// RETAINED: a candidate that regresses a protected/gifted dim cannot win no
// matter how the cast votes (reuses passesGate on the absolute aggregates).

/** The judge's raw pick between the two labeled sessions. */
export type PairwisePick = "A" | "B" | "tie";
/** The pick resolved back into domain terms (order-randomization undone). */
export type PairwiseWinner = "candidate" | "baseline" | "tie";

/** One judged head-to-head for a single cast member. */
export interface PairwiseComparison {
  profileName: string;
  readingLevel: string;
  /** Which A/B slot held the CANDIDATE this run — records the randomization. */
  candidateLabel: "A" | "B";
  /** The judge's raw pick. */
  pick: PairwisePick;
  /** Resolved in domain terms (candidate/baseline/tie). */
  winner: PairwiseWinner;
  reason: string;
}

/** Cast-level aggregate of the per-member head-to-head judgments. */
export interface PairwiseTally {
  comparisons: PairwiseComparison[];
  candidateWins: number;
  baselineWins: number;
  ties: number;
  /** Total comparisons (candidateWins + baselineWins + ties). */
  n: number;
  /** Net preference: candidateWins − baselineWins. */
  net: number;
  /** Fraction of ALL comparisons (ties included) the candidate won. */
  candidatePreferredFraction: number;
}

/** Fold a list of per-member comparisons into the cast-level tally. */
export function tallyPairwise(comparisons: PairwiseComparison[]): PairwiseTally {
  let candidateWins = 0;
  let baselineWins = 0;
  let ties = 0;
  for (const c of comparisons) {
    if (c.winner === "candidate") candidateWins++;
    else if (c.winner === "baseline") baselineWins++;
    else ties++;
  }
  const n = comparisons.length;
  return {
    comparisons,
    candidateWins,
    baselineWins,
    ties,
    n,
    net: candidateWins - baselineWins,
    candidatePreferredFraction: n ? candidateWins / n : 0,
  };
}

export interface PairwiseBetterOptions extends GateOptions {
  /** Min net cast preference (candidateWins − baselineWins) to promote. */
  minNetPreference: number; // e.g. 1
}

export const DEFAULT_PAIRWISE_BETTER: PairwiseBetterOptions = {
  ...DEFAULT_GATE,
  minNetPreference: 1,
};

export interface PairwiseBetterResult extends PromotionDecision {
  /** Net cast preference (candidateWins − baselineWins). */
  net: number;
  tally: PairwiseTally;
}

/**
 * Promotion decision by PAIRWISE preference. Two conditions, BOTH required:
 *   (1) the candidate clears the protected-dim gate (RETAINED veto) — computed
 *       from the absolute aggregates, so a regression on a protected/gifted dim
 *       vetoes promotion regardless of how the cast voted, and
 *   (2) the cast, judged head-to-head baseline-vs-candidate, net-prefers the
 *       candidate by at least `minNetPreference`.
 * The absolute aggregates are still passed in (for the gate + the diagnosis
 * view); the *fitness scalar* is deliberately not the deciding grain here.
 */
export function isBetterPairwise(
  candidate: Aggregate,
  baseline: Aggregate,
  tally: PairwiseTally,
  opts: PairwiseBetterOptions = DEFAULT_PAIRWISE_BETTER,
): PairwiseBetterResult {
  const gate = passesGate(candidate, baseline, opts);
  const net = tally.net;
  if (!gate.pass) {
    return {
      better: false,
      net,
      tally,
      gate,
      reason: `failed protected-dim gate: ${gate.violations
        .map((v) => v.dim)
        .join(", ")}`,
    };
  }
  if (tally.n === 0) {
    return {
      better: false,
      net,
      tally,
      gate,
      reason: "no pairwise comparisons available",
    };
  }
  if (net < opts.minNetPreference) {
    return {
      better: false,
      net,
      tally,
      gate,
      reason: `cast net preference ${net >= 0 ? "+" : ""}${net} (${tally.candidateWins}–${tally.baselineWins}, ${tally.ties} tie) below threshold +${opts.minNetPreference}`,
    };
  }
  return {
    better: true,
    net,
    tally,
    gate,
    reason: `cast prefers the edit ${tally.candidateWins}–${tally.baselineWins} (net +${net}, ${tally.ties} tie), gate clear`,
  };
}

/**
 * The pairwise result as persisted on the experiment + read by the results UI.
 * A superset of the tally plus how the decision was actually reached:
 * "pairwise" (normal) or "absolute-fallback" (every pairwise judge call failed,
 * so the loop degraded to absolute isBetter — never crashes a run).
 */
export interface ExperimentPairwise extends PairwiseTally {
  decidedBy: "pairwise" | "absolute-fallback";
  /** The isBetter / isBetterPairwise `.better` verdict, persisted for the UI. */
  promote: boolean;
  reason: string;
  /** Present only on the fallback path — why pairwise couldn't decide. */
  note?: string;
}
