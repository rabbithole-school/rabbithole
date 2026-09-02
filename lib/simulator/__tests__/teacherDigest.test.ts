import { describe, expect, it } from "vitest";

import {
  computeTrail,
  criterionDelta,
  criterionSpread,
  invalidRate,
  strategySignature,
  zeroHypothesisScholars,
  type RunFact,
  type ScholarTrail,
} from "../teacherDigest";

function run(partial: Partial<RunFact>): RunFact {
  return {
    runId: partial.runId ?? "r",
    deckVersion: partial.deckVersion ?? 1,
    status: partial.status ?? "completed",
    criterionScore: partial.criterionScore ?? null,
    invalidActionCount: partial.invalidActionCount ?? 0,
    modelCallCount: partial.modelCallCount ?? 0,
    queuedAt: partial.queuedAt ?? 0,
    hasHypothesis: partial.hasHypothesis ?? false,
  };
}

describe("criterionSpread", () => {
  it("returns null for no values", () => {
    expect(criterionSpread([])).toBeNull();
  });
  it("computes min/max/mean", () => {
    expect(criterionSpread([10, 20, 30])).toEqual({ count: 3, min: 10, max: 30, mean: 20 });
  });
});

describe("invalidRate", () => {
  it("is zero when there were no model calls", () => {
    expect(invalidRate([run({ invalidActionCount: 0, modelCallCount: 0 })])).toBe(0);
  });
  it("is invalid over total calls", () => {
    expect(
      invalidRate([
        run({ invalidActionCount: 2, modelCallCount: 8 }),
        run({ invalidActionCount: 0, modelCallCount: 12 }),
      ]),
    ).toBeCloseTo(2 / 20);
  });
});

describe("criterionDelta (a fact, not a verdict)", () => {
  it("is null without both groups", () => {
    expect(criterionDelta({ count: 1, min: 1, max: 1, mean: 1 }, null, "maximize")).toBeNull();
  });
  it("is reasonable minus empty for maximize", () => {
    expect(
      criterionDelta(
        { count: 3, min: 100, max: 130, mean: 118 },
        { count: 3, min: 38, max: 44, mean: 40 },
        "maximize",
      ),
    ).toBe(78);
  });
  it("signs toward improvement for minimize", () => {
    expect(
      criterionDelta(
        { count: 3, min: 5, max: 9, mean: 7 },
        { count: 3, min: 48, max: 52, mean: 50 },
        "minimize",
      ),
    ).toBe(43);
  });
  it("uses distance-to-target for target", () => {
    expect(
      criterionDelta(
        { count: 1, min: 12, max: 12, mean: 12 },
        { count: 1, min: 40, max: 40, mean: 40 },
        "target",
        10,
      ),
    ).toBe(28); // |40-10| - |12-10| = 30 - 2
  });
});

describe("computeTrail", () => {
  it("tracks best score, personal delta, and deck revisions (maximize)", () => {
    const trail = computeTrail(
      {
        scholarId: "s1",
        name: "Ada",
        sessionId: "sess1",
        hypothesesCount: 2,
        runs: [
          run({ criterionScore: 40, deckVersion: 1, queuedAt: 1 }),
          run({ criterionScore: 90, deckVersion: 2, queuedAt: 2 }),
          run({ criterionScore: 75, deckVersion: 2, queuedAt: 3 }),
        ],
      },
      "maximize",
    );
    expect(trail.firstScore).toBe(40);
    expect(trail.bestScore).toBe(90);
    expect(trail.personalDelta).toBe(50);
    expect(trail.deckVersionCount).toBe(2);
    expect(trail.hasHypothesis).toBe(true);
  });
  it("signs personal delta toward improvement for minimize", () => {
    const trail = computeTrail(
      {
        scholarId: "s2",
        name: "Bo",
        sessionId: "sess2",
        hypothesesCount: 0,
        runs: [
          run({ criterionScore: 50, queuedAt: 1 }),
          run({ criterionScore: 12, queuedAt: 2 }),
        ],
      },
      "minimize",
    );
    expect(trail.bestScore).toBe(12);
    expect(trail.personalDelta).toBe(38);
    expect(trail.hasHypothesis).toBe(false);
  });
});

describe("zeroHypothesisScholars", () => {
  const trails: ScholarTrail[] = [
    {
      scholarId: "s1", name: "Ada", sessionId: "a", runCount: 4, hypothesesCount: 3,
      deckVersionCount: 3, firstScore: 40, bestScore: 120, personalDelta: 80,
      hasHypothesis: true, invalidRate: 0.02,
    },
    {
      scholarId: "s2", name: "Bo", sessionId: "b", runCount: 6, hypothesesCount: 0,
      deckVersionCount: 1, firstScore: 30, bestScore: 35, personalDelta: 5,
      hasHypothesis: false, invalidRate: 0.05,
    },
    {
      scholarId: "s3", name: "Cy", sessionId: "c", runCount: 0, hypothesesCount: 0,
      deckVersionCount: 0, firstScore: null, bestScore: null, personalDelta: null,
      hasHypothesis: false, invalidRate: 0,
    },
  ];
  it("flags scholars who ran but never formed a hypothesis (not the idle bench)", () => {
    expect(zeroHypothesisScholars(trails).map((t) => t.scholarId)).toEqual(["s2"]);
  });
});

describe("strategySignature", () => {
  it("is a sorted label×count of non-zero species", () => {
    expect(
      strategySignature([
        { label: "Shark", count: 1 },
        { label: "Grazers", count: 4 },
        { label: "Cleaners", count: 0 },
      ]),
    ).toBe("Grazers×4 · Shark×1");
  });
  it("groups identical shapes to the same key regardless of order", () => {
    const a = strategySignature([{ label: "A", count: 2 }, { label: "B", count: 1 }]);
    const b = strategySignature([{ label: "B", count: 1 }, { label: "A", count: 2 }]);
    expect(a).toBe(b);
  });
});
