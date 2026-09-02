/**
 * FIRe — Fractional Implicit Repetition (raise-the-ceiling / parity plan §4A).
 *
 * When a scholar answers an advanced skill correctly, spaced-repetition credit
 * "trickles down" the prerequisite DAG to the skills that skill builds on: a
 * fraction of a real review, weighted by how strongly the answered skill
 * exercises each prerequisite. This is one well-known practice-app's Fractional Implicit
 * Repetition, done over our existing `buildsOn` graph with per-edge weights.
 *
 * TWO functions, both PURE (no Convex imports — mirrors scheduler.ts):
 *  - `ancestorWeights` computes, for one answered skill, the implicit-credit
 *    weight for each of its (transitive) prerequisites: max over paths of the
 *    product of edge weights, pruned below a floor.
 *  - `applyImplicitCredit` turns a weight into a partial retention refresh:
 *    it shrinks the elapsed-decay interval and grows the half-life by a
 *    fractional power — but NEVER touches `repetition` (implicit credit is not
 *    a demonstration, so it can never flip a provisional skill to earned
 *    fluency — "colors are evidence", plan-of-record §10).
 *
 * The edge relation reuses `kind:"buildsOn"` rows and their optional `weight`
 * field; direction is "toKey builds on fromKey" (fromKey is the prerequisite).
 */

import type { GraphEdge, SkillState } from "./scheduler";
import { HALFLIFE_GROWTH } from "./scheduler";

/** Default per-edge weight when a `buildsOn` edge carries no explicit `weight`. */
export const IMPLICIT_WEIGHT_DEFAULT = 0.5;

/**
 * Path-weight floor: a prerequisite whose max path weight falls below this gets
 * no credit, and the walk stops expanding through it. Bounds propagation depth
 * (0.5³ = 0.125 passes; 0.5⁴ = 0.0625 prunes → ≤3 hops at default weights).
 */
export const IMPLICIT_CREDIT_FLOOR = 0.1;

/**
 * Cap on the half-life implicit credit can grow a skill to (days). Stops a low
 * prerequisite practiced daily via its descendants from ballooning to a
 * year-long half-life on inferred credit alone.
 */
export const IMPLICIT_HALFLIFE_CAP_DAYS = 60;
export const IMPLICIT_CREDIT_SLOW_LATENCY_MULTIPLE = 2;

export type ImplicitCreditAttemptSignal = {
  correct: boolean;
  firstKeyMs?: number;
};

/**
 * MA-style guard: implicit credit should not paper over a prerequisite that the
 * scholar just struggled on. Unknown correctness/latency signals preserve the
 * old FIRe behavior (credit flows).
 */
export function shouldSkipImplicitCredit(
  signal: ImplicitCreditAttemptSignal | undefined,
  scholarLatencyBaselineMs: number | undefined,
): boolean {
  if (!signal) return false;
  if (!signal.correct) return true;
  return (
    scholarLatencyBaselineMs !== undefined &&
    signal.firstKeyMs !== undefined &&
    signal.firstKeyMs > scholarLatencyBaselineMs * IMPLICIT_CREDIT_SLOW_LATENCY_MULTIPLE
  );
}

/** Clamp a raw edge weight to the honored range (0,1]; absent/invalid → default. */
function clampWeight(weight: number | undefined): number {
  if (weight === undefined || !Number.isFinite(weight) || weight <= 0) {
    return IMPLICIT_WEIGHT_DEFAULT;
  }
  return Math.min(weight, 1);
}

/**
 * For the answered skill, the implicit-credit weight of each transitive
 * prerequisite: the MAX over all prerequisite paths of the product of the
 * path's edge weights, pruned (and not expanded) below `IMPLICIT_CREDIT_FLOOR`.
 * Excludes the answered skill itself. Order-independent and idempotent.
 *
 * `edges` are the same `buildsOn` edges the scheduler consumes; each edge's
 * optional `weight` is honored (clamped to (0,1]) or defaulted. Direction is
 * "toKey builds on fromKey", so we walk from `skillKey` toward its `fromKey`
 * prerequisites.
 */
export function ancestorWeights(
  skillKey: string,
  edges: GraphEdge[],
): Map<string, number> {
  // Adjacency: a dependent node → the prerequisites it directly builds on.
  const prereqsOf = new Map<string, { prereq: string; weight: number }[]>();
  for (const e of edges) {
    const entry = { prereq: e.fromKey, weight: clampWeight(e.weight) };
    const list = prereqsOf.get(e.toKey);
    if (list) list.push(entry);
    else prereqsOf.set(e.toKey, [entry]);
  }

  const best = new Map<string, number>();
  // Max-product relaxation over the DAG (weights ≤ 1, so products only shrink;
  // strict-improvement re-pushes terminate even on malformed cyclic input).
  const stack: { node: string; weight: number }[] = [{ node: skillKey, weight: 1 }];
  while (stack.length > 0) {
    const { node, weight } = stack.pop()!;
    // Skip a stale entry superseded by a better path already relaxed.
    if (node !== skillKey && weight < (best.get(node) ?? 0)) continue;
    for (const { prereq, weight: edgeWeight } of prereqsOf.get(node) ?? []) {
      if (prereq === skillKey) continue; // never credit the answered skill itself
      const next = weight * edgeWeight;
      if (next < IMPLICIT_CREDIT_FLOOR) continue; // prune below the floor
      if (next > (best.get(prereq) ?? 0)) {
        best.set(prereq, next);
        stack.push({ node: prereq, weight: next });
      }
    }
  }
  return best;
}

/**
 * Apply fractional implicit credit `weight` (0,1] to a prerequisite's state:
 *  - shrink the elapsed-decay interval by `weight`
 *      lastPracticedAt′ = now − (1 − weight)·(now − lastPracticedAt)
 *  - grow the half-life by a fractional power, capped
 *      halfLifeDays′ = min(halfLifeDays · HALFLIFE_GROWTH^weight, CAP)
 * `repetition` is returned UNCHANGED — implicit credit refreshes retention only.
 *
 * No-op (returns `prev` unchanged, same reference) when the skill has never been
 * demonstrated (`repetition === 0`), has no `lastPracticedAt`, or the weight is
 * below the credit floor — the same rows `ancestorWeights` would never emit, but
 * guarded here too so the function is safe to call directly.
 */
export function applyImplicitCredit(
  prev: SkillState,
  weight: number,
  now: number,
): SkillState {
  if (
    prev.repetition === 0 ||
    prev.lastPracticedAt === undefined ||
    weight < IMPLICIT_CREDIT_FLOOR
  ) {
    return prev;
  }
  const elapsed = now - prev.lastPracticedAt;
  const lastPracticedAt = now - (1 - weight) * elapsed;
  const halfLifeDays = Math.min(
    prev.halfLifeDays * Math.pow(HALFLIFE_GROWTH, weight),
    IMPLICIT_HALFLIFE_CAP_DAYS,
  );
  return {
    repetition: prev.repetition,
    halfLifeDays,
    lastPracticedAt,
  };
}
