/**
 * Tests for the hill-climb control flow with deterministic fakes (no model
 * calls). Verifies: champion advances only on a real improvement, the
 * protected-dim gate blocks promotion mid-loop, and plateau / budget stops fire.
 */
import { describe, expect, test } from "vitest";
import { optimize, type OptimizerDeps } from "../lib/optimizer";
import {
  DESIGN_DIMS,
  FITNESS_DIMS,
  GIFTED_DIMS,
  PROTECTED_DIMS,
  type Aggregate,
} from "../lib/score";
import { baselineVariant } from "../lib/variant";
import type { SimActivity } from "../lib/types";

const ACTIVITY: SimActivity = {
  title: "T",
  kind: "online",
  systemPrompt: "base",
  learningGoal: "g",
};

function fakeAgg(fitness: number, protectedVal = 4): Aggregate {
  const dims = {} as Aggregate["dims"];
  for (const d of FITNESS_DIMS) dims[d] = fitness;
  for (const d of PROTECTED_DIMS) dims[d] = protectedVal;
  // Gifted dims held constant across baseline/candidates → the gifted gate
  // (regression-only) never trips, so these tests isolate the fitness + protected logic.
  for (const d of GIFTED_DIMS) dims[d] = protectedVal;
  for (const d of DESIGN_DIMS) dims[d] = protectedVal;
  return { dims, fitness, goalAttainmentRate: 0, n: 4 };
}

/** evaluate() consumes `fitnesses` in call order (baseline first, then candidates). */
function makeDeps(fitnesses: number[], protectedFor: (i: number) => number = () => 4): OptimizerDeps {
  let evalIdx = 0;
  let propIdx = 0;
  return {
    evaluate: async () => {
      const i = evalIdx++;
      return fakeAgg(fitnesses[i], protectedFor(i));
    },
    propose: async (parent) => {
      propIdx++;
      return {
        id: `c${propIdx}`,
        parentId: parent.id,
        generation: parent.generation + 1,
        origin: "ai-proposed" as const,
        systemPrompt: `prompt-${propIdx}`,
        rationale: "fake",
      };
    },
  };
}

describe("optimize", () => {
  test("climbs a monotonically improving sequence and stops at the generation cap", async () => {
    const deps = makeDeps([3.0, 3.5, 4.0, 4.5]);
    const r = await optimize(baselineVariant(ACTIVITY), deps, { generations: 3, variantsPerGen: 1 });
    expect(r.best.agg.fitness).toBe(4.5);
    expect(r.evaluations).toBe(4); // baseline + 3 candidates
    expect(r.stoppedReason).toBe("generations");
    expect(r.generations.every((g) => g.promotedVariantId !== null)).toBe(true);
  });

  test("stops on plateau when no candidate beats the champion", async () => {
    const deps = makeDeps([3.0, 3.0, 3.0]); // baseline + 2 flat candidates
    const r = await optimize(baselineVariant(ACTIVITY), deps, { generations: 5, variantsPerGen: 2, patience: 1 });
    expect(r.stoppedReason).toBe("plateau");
    expect(r.best.agg.fitness).toBe(3.0); // champion never moved off baseline
    expect(r.generations).toHaveLength(1);
  });

  test("stops on budget mid-generation but still keeps the best so far", async () => {
    const deps = makeDeps([3.0, 4.0, 4.5, 9.9]); // 4th never reached
    const r = await optimize(baselineVariant(ACTIVITY), deps, {
      generations: 5,
      variantsPerGen: 3,
      maxEvaluations: 3,
    });
    expect(r.stoppedReason).toBe("budget");
    expect(r.evaluations).toBe(3);
    expect(r.best.agg.fitness).toBe(4.5); // best of the two it managed to evaluate
  });

  test("does NOT promote a higher-fitness candidate that tanks a protected dim", async () => {
    // candidate (index 1) has fitness 5.0 but protected dims at 1 → gate fails.
    const deps = makeDeps([3.0, 5.0], (i) => (i === 1 ? 1 : 4));
    const r = await optimize(baselineVariant(ACTIVITY), deps, { generations: 1, variantsPerGen: 1, patience: 1 });
    expect(r.best.agg.fitness).toBe(3.0); // stayed on baseline
    expect(r.generations[0].candidates[0].decision.better).toBe(false);
    expect(r.generations[0].promotedVariantId).toBeNull();
  });

  test("stops on the wall-clock budget mid-loop, keeping the best so far", async () => {
    // Injected clock: startAt=0, gen-1 checks stay under the 1000ms budget, the
    // gen-2 top check trips it. So gen 1 runs (improves to 4.0) then we stop.
    const times = [0, 100, 200, 5000, 5000];
    let ci = 0;
    const now = () => times[Math.min(ci++, times.length - 1)];
    const deps = makeDeps([3.0, 4.0]); // baseline 3.0, gen-1 candidate 4.0
    const r = await optimize(baselineVariant(ACTIVITY), deps, {
      generations: 5,
      variantsPerGen: 1,
      maxDurationMs: 1000,
      now,
    });
    expect(r.stoppedReason).toBe("timeBudget");
    expect(r.best.agg.fitness).toBe(4.0); // gen-1 champion kept, not lost
    expect(r.generations).toHaveLength(1);
  });

  test("skips a candidate slot when the Improver returns no edit (null)", async () => {
    let propCall = 0;
    let evalIdx = 0;
    const fitnesses = [3.0, 4.0]; // baseline, then the one real candidate
    const deps: OptimizerDeps = {
      evaluate: async () => fakeAgg(fitnesses[evalIdx++]),
      propose: async (parent) => {
        propCall++;
        if (propCall === 1) return null; // no usable edit → slot skipped
        return {
          id: "c",
          parentId: parent.id,
          generation: parent.generation + 1,
          origin: "ai-proposed" as const,
          systemPrompt: "p",
          rationale: "fake",
        };
      },
    };
    const r = await optimize(baselineVariant(ACTIVITY), deps, {
      generations: 1,
      variantsPerGen: 2,
    });
    expect(r.generations[0].candidates).toHaveLength(1);
    expect(r.best.agg.fitness).toBe(4.0);
    expect(r.evaluations).toBe(2); // baseline + 1 real candidate (null didn't count)
  });
});
