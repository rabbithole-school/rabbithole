/**
 * TEACHER-SIDE digest math for Worlds — framework-free so it unit-tests without
 * Convex or React. Plan §8: the Debrief shows FACTUAL, sortable direction trails
 * and the Preflight tab shows RAW achievability evidence. This module owns that
 * arithmetic only.
 *
 * DOCTRINE (plan §8, §9.5): criterion scores are facts about DECKS, never about
 * scholars. Everything here compares designs and effort trails; nothing ranks a
 * child. No uncalibrated verdict or "worth discussing" classifier lives here —
 * the adversarial review (T6) ruled those do not ship before P0 calibration.
 * We surface numbers and let the teacher judge.
 */

import { isBetterBy } from "./helpers";

export type CriterionDirection = "maximize" | "minimize" | "target";

/** One completed/among-flight run reduced to the numbers the digest needs. */
export interface RunFact {
  runId: string;
  deckVersion: number;
  /** "queued" | "ticking" | "completed" | "halted" | "crashed". */
  status: string;
  /** Final measured criterion value, or null for a gallery/unscored run. */
  criterionScore: number | null;
  invalidActionCount: number;
  modelCallCount: number;
  queuedAt: number;
  hasHypothesis: boolean;
}

export interface Spread {
  count: number;
  min: number;
  max: number;
  mean: number;
}

export function criterionSpread(values: readonly number[]): Spread | null {
  if (values.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
  }
  return { count: values.length, min, max, mean: sum / values.length };
}

/**
 * Invalid actions as a fraction of model calls across a set of runs. A high rate
 * means automata could not parse the action prompt — a FACT the teacher reads,
 * not a pass/fail threshold (plan §8, the writing lesson).
 */
export function invalidRate(runs: readonly RunFact[]): number {
  let invalid = 0;
  let calls = 0;
  for (const run of runs) {
    invalid += run.invalidActionCount;
    calls += run.modelCallCount;
  }
  return calls === 0 ? 0 : invalid / calls;
}

/**
 * The signed, direction-aware improvement of a REASONABLE deck's mean over an
 * EMPTY deck's mean (plan §8a). Positive = the reasonable deck did better on the
 * criterion. This is a FACT (a difference of means), NOT a verdict — the UI
 * shows it next to both spreads and the teacher judges whether authored prompts
 * move the criterion. No calibrated threshold is applied (review T6).
 */
export function criterionDelta(
  reasonable: Spread | null,
  empty: Spread | null,
  direction: CriterionDirection,
  target?: number,
): number | null {
  if (!reasonable || !empty) return null;
  if (direction === "minimize") return empty.mean - reasonable.mean;
  if (direction === "target") {
    const goal = target ?? 0;
    return Math.abs(empty.mean - goal) - Math.abs(reasonable.mean - goal);
  }
  return reasonable.mean - empty.mean;
}

export interface ScholarTrailInput {
  scholarId: string;
  name: string;
  sessionId: string;
  runs: readonly RunFact[];
  hypothesesCount: number;
}

export interface ScholarTrail {
  scholarId: string;
  name: string;
  sessionId: string;
  runCount: number;
  hypothesesCount: number;
  /** Distinct deck versions actually launched — the arc of revisions. */
  deckVersionCount: number;
  firstScore: number | null;
  bestScore: number | null;
  /** Signed toward improvement (positive = got better), direction-aware. */
  personalDelta: number | null;
  hasHypothesis: boolean;
  invalidRate: number;
}

/**
 * One scholar's direction trail (plan §8): how many runs, whether they ever
 * formed a hypothesis, how many deck revisions, and their personal-best
 * progression. All factual and sortable; the UI ranks by whichever column the
 * teacher chooses. Runs are ordered by queuedAt.
 */
export function computeTrail(
  input: ScholarTrailInput,
  direction: CriterionDirection,
  target?: number,
): ScholarTrail {
  const scored = [...input.runs]
    .filter((run) => run.criterionScore !== null)
    .sort((a, b) => a.queuedAt - b.queuedAt);
  const deckVersions = new Set(input.runs.map((run) => run.deckVersion));
  const firstScore = scored.length > 0 ? scored[0].criterionScore! : null;
  let bestScore: number | null = null;
  for (const run of scored) {
    const value = run.criterionScore!;
    if (bestScore === null || isBetterBy(value, bestScore, direction, target)) bestScore = value;
  }
  let personalDelta: number | null = null;
  if (firstScore !== null && bestScore !== null) {
    personalDelta =
      direction === "minimize"
        ? firstScore - bestScore
        : direction === "target"
          ? Math.abs(firstScore - (target ?? 0)) - Math.abs(bestScore - (target ?? 0))
          : bestScore - firstScore;
  }
  return {
    scholarId: input.scholarId,
    name: input.name,
    sessionId: input.sessionId,
    runCount: input.runs.length,
    hypothesesCount: input.hypothesesCount,
    deckVersionCount: deckVersions.size,
    firstScore,
    bestScore,
    personalDelta,
    hasHypothesis: input.hypothesesCount > 0,
    invalidRate: invalidRate(input.runs),
  };
}

/** Scholars who ran the bench but never wrote a hypothesis (plan §8 flag). */
export function zeroHypothesisScholars(trails: readonly ScholarTrail[]): ScholarTrail[] {
  return trails.filter((t) => t.runCount > 0 && t.hypothesesCount === 0);
}

/**
 * A deterministic, FACTUAL descriptor of a deck's population shape — the sorted
 * "label×count" of its species (plan §8 "decks grouped by strategy"). Decks with
 * the same signature took the same approach SHAPE; this groups by a literal
 * config fact, not an invented quality ranking (so it doesn't fall to T6). The
 * prompt text is the star exhibit and is shown per deck; the signature only
 * clusters the diversity-of-approach view.
 */
export function strategySignature(
  cards: readonly { label: string; count: number }[],
): string {
  return [...cards]
    .filter((card) => card.count > 0)
    .map((card) => `${card.label}×${card.count}`)
    .sort()
    .join(" · ");
}
