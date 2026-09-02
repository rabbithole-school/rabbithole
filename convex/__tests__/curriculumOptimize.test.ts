/**
 * Phase-3 hill-climb control flow (convex/lib/curriculumOptimize.ts) with
 * deterministic fakes — no model calls, no Convex. Verifies: champion advances
 * only on a real improvement, the protected-dim gate blocks promotion mid-loop,
 * plateau / budget / cancel stops fire, and the budget honestly counts the
 * pre-evaluated baseline.
 *
 * Twin of evals/curriculum-sim/__tests__/optimizer.test.ts, adapted to the
 * product signature (baseline is evaluated by the caller and passed in).
 */
import { describe, expect, test } from "vitest";
import {
  optimize,
  type OptimizerDeps,
  type OptVariant,
} from "../lib/curriculumOptimize";
import {
  DESIGN_DIMS,
  FITNESS_DIMS,
  GIFTED_DIMS,
  PROTECTED_DIMS,
  type Aggregate,
} from "../lib/curriculumScore";

function fakeAgg(fitness: number, protectedVal = 4): Aggregate {
  const dims = {} as Aggregate["dims"];
  for (const d of FITNESS_DIMS) dims[d] = fitness;
  for (const d of PROTECTED_DIMS) dims[d] = protectedVal;
  for (const d of GIFTED_DIMS) dims[d] = protectedVal;
  for (const d of DESIGN_DIMS) dims[d] = protectedVal;
  return { dims, fitness, goalAttainmentRate: 0, n: 4 };
}

const BASELINE: OptVariant = { id: "baseline", systemPrompt: "base", generation: 0 };

/** evaluate() consumes `candFitnesses` in call order (candidates only — the
 *  baseline agg is passed to optimize() directly). */
function makeDeps(
  candFitnesses: number[],
  protectedFor: (i: number) => number = () => 4,
  extra: Partial<OptimizerDeps<OptVariant>> = {},
): OptimizerDeps<OptVariant> {
  let evalIdx = 0;
  let propIdx = 0;
  return {
    evaluate: async () => {
      const i = evalIdx++;
      return fakeAgg(candFitnesses[i], protectedFor(i));
    },
    propose: async (parent) => {
      propIdx++;
      return {
        id: `c${propIdx}`,
        systemPrompt: `prompt-${propIdx}`,
        generation: parent.generation + 1,
      };
    },
    ...extra,
  };
}

describe("optimize (product)", () => {
  test("climbs a monotonically improving sequence; stops at the generation cap", async () => {
    const deps = makeDeps([3.5, 4.0, 4.5]);
    const r = await optimize(BASELINE, fakeAgg(3.0), deps, {
      generations: 3,
      variantsPerGen: 1,
    });
    expect(r.best.agg.fitness).toBe(4.5);
    expect(r.evaluations).toBe(4); // baseline (pre-evaluated) + 3 candidates
    expect(r.stoppedReason).toBe("generations");
    expect(r.generations.every((g) => g.promotedVariantId !== null)).toBe(true);
    // child generation derives from the (advancing) champion.
    expect(r.best.variant.generation).toBe(3);
  });

  test("stops on plateau when no candidate beats the champion", async () => {
    const deps = makeDeps([3.0, 3.0]); // 2 flat candidates in gen 1
    const r = await optimize(BASELINE, fakeAgg(3.0), deps, {
      generations: 5,
      variantsPerGen: 2,
      patience: 1,
    });
    expect(r.stoppedReason).toBe("plateau");
    expect(r.best.agg.fitness).toBe(3.0); // champion never moved off baseline
    expect(r.best.variant.id).toBe("baseline");
    expect(r.generations).toHaveLength(1);
  });

  test("stops on budget mid-generation but keeps the best so far", async () => {
    const deps = makeDeps([4.0, 4.5, 9.9]); // 3rd never reached
    const r = await optimize(BASELINE, fakeAgg(3.0), deps, {
      generations: 5,
      variantsPerGen: 3,
      maxEvaluations: 3,
    });
    expect(r.stoppedReason).toBe("budget");
    expect(r.evaluations).toBe(3); // baseline + 2 candidates
    expect(r.best.agg.fitness).toBe(4.5);
  });

  test("does NOT promote a higher-fitness candidate that tanks a protected dim", async () => {
    // candidate has fitness 5.0 but protected dims at 1 → gate fails.
    const deps = makeDeps([5.0], () => 1);
    const r = await optimize(BASELINE, fakeAgg(3.0), deps, {
      generations: 1,
      variantsPerGen: 1,
      patience: 1,
    });
    expect(r.best.agg.fitness).toBe(3.0); // stayed on baseline
    expect(r.generations[0].candidates[0].decision.better).toBe(false);
    expect(r.generations[0].promotedVariantId).toBeNull();
  });

  test("stops immediately when shouldStop reports a cancel", async () => {
    const deps = makeDeps([4.0, 4.5], () => 4, { shouldStop: async () => true });
    const r = await optimize(BASELINE, fakeAgg(3.0), deps, {
      generations: 3,
      variantsPerGen: 2,
    });
    expect(r.stoppedReason).toBe("cancelled");
    expect(r.generations).toHaveLength(0);
    expect(r.best.variant.id).toBe("baseline");
  });

  test("stops on the wall-clock budget mid-loop, keeping the best so far", async () => {
    // Injected clock: startAt=0, gen-1 checks stay under the 1000ms budget, the
    // gen-2 top check trips it. So gen 1 runs (improves to 4.0) then we stop.
    const times = [0, 100, 200, 5000, 5000];
    let ci = 0;
    const now = () => times[Math.min(ci++, times.length - 1)];
    const deps = makeDeps([4.0], () => 4, { now });
    const r = await optimize(BASELINE, fakeAgg(3.0), deps, {
      generations: 5,
      variantsPerGen: 1,
      maxDurationMs: 1000,
    });
    expect(r.stoppedReason).toBe("timeBudget");
    expect(r.best.agg.fitness).toBe(4.0); // gen-1 champion kept, not lost
    expect(r.generations).toHaveLength(1);
  });

  test("skips a candidate slot when the Improver returns no edit (null)", async () => {
    let propCall = 0;
    const deps: OptimizerDeps<OptVariant> = {
      evaluate: async () => fakeAgg(4.0), // only called for the real candidate
      propose: async (parent) => {
        propCall++;
        if (propCall === 1) return null; // no usable edit → slot skipped
        return { id: "c", systemPrompt: "p", generation: parent.generation + 1 };
      },
    };
    const r = await optimize(BASELINE, fakeAgg(3.0), deps, {
      generations: 1,
      variantsPerGen: 2,
    });
    // The null slot is skipped (no evaluate, no crash); the real candidate runs.
    expect(r.generations[0].candidates).toHaveLength(1);
    expect(r.best.agg.fitness).toBe(4.0);
    expect(r.evaluations).toBe(2); // baseline + 1 real candidate (null didn't count)
  });

  // Adoptable #3 — the injected `decide` dep (the pairwise promote gate in
  // production) OVERRIDES the absolute isBetter for promotion.
  test("decide dep can BLOCK a candidate that absolute isBetter would promote", async () => {
    // Fitness jumps 3.0 → 4.5 and the gate is clean, so isBetter() alone would
    // promote — but the injected decide says the cast net-prefers the champion.
    const decide = async () => ({
      better: false,
      gate: { pass: true, violations: [] },
      reason: "cast net-prefers the champion (baseline)",
    });
    const deps = makeDeps([4.5], () => 4, { decide });
    const r = await optimize(BASELINE, fakeAgg(3.0), deps, {
      generations: 1,
      variantsPerGen: 1,
      patience: 1,
    });
    expect(r.best.agg.fitness).toBe(3.0); // stayed on baseline
    expect(r.generations[0].candidates[0].decision.better).toBe(false);
    expect(r.generations[0].candidates[0].decision.reason).toMatch(/net-prefers/);
    expect(r.generations[0].promotedVariantId).toBeNull();
    expect(r.stoppedReason).toBe("plateau");
  });

  test("decide dep can PROMOTE a candidate that absolute isBetter would reject", async () => {
    // Flat fitness (3.0 → 3.0): isBetter() would reject on the noise floor, but
    // the pairwise decide says the cast net-prefers the candidate → promote.
    const decide = async ({ candidate }: { candidate: OptVariant }) => ({
      better: true,
      gate: { pass: true, violations: [] },
      reason: `cast prefers ${candidate.id} 2–0`,
    });
    const deps = makeDeps([3.0], () => 4, { decide });
    const r = await optimize(BASELINE, fakeAgg(3.0), deps, {
      generations: 1,
      variantsPerGen: 1,
    });
    expect(r.best.variant.id).not.toBe("baseline"); // candidate promoted
    expect(r.generations[0].candidates[0].decision.better).toBe(true);
    expect(r.generations[0].promotedVariantId).toBe(r.best.variant.id);
  });
});
