/**
 * Tests for the product-side selection logic (convex/lib/curriculumScore.ts)
 * — the part that decides which activity variant wins. The reward-hacking
 * gate is the load-bearing guard, so it gets the most cases: a variant that
 * lifts curriculum fit by sacrificing a protected tutor-quality dim must NOT
 * be judged "better". Mirrors evals/curriculum-sim/__tests__/score.test.ts so
 * the two copies of the gate stay provably in sync.
 *
 * Pure functions, no convex-test / fixtures needed (see
 * .claude/rules/rabbithole-test-strategy.md — decision tree rung 1).
 */
import { describe, expect, test } from "vitest";
import {
  aggregate,
  isBetter,
  passesGate,
  DEFAULT_BETTER,
  tallyPairwise,
  isBetterPairwise,
  type PairwiseComparison,
  type SessionVerdict,
} from "../lib/curriculumScore";

function verdict(overrides: Partial<SessionVerdict> = {}): SessionVerdict {
  return {
    goalAttainment: 3,
    deliverableReach: 3,
    productiveStruggle: 3,
    socratic: 4,
    cognitiveOffloading: 4,
    noSpoilers: 4,
    sycophancy: 4,
    ageFit: 4,
    depth: 4,
    complexity: 4,
    abstraction: 4,
    inquiry: 4,
    authenticity: 4,
    singleSpine: 4,
    discoveryArc: 4,
    handsOnMission: 4,
    earnedPayoff: 4,
    stallPoint: "none",
    promptAttribution: "none",
    summary: "test",
    ...overrides,
  };
}

describe("aggregate", () => {
  test("means dims and computes fitness + goal rate", () => {
    const a = aggregate([
      verdict({ goalAttainment: 5, deliverableReach: 5, productiveStruggle: 5 }),
      verdict({ goalAttainment: 1, deliverableReach: 3, productiveStruggle: 1 }),
    ]);
    expect(a.n).toBe(2);
    expect(a.dims.goalAttainment).toBe(3); // (5+1)/2
    expect(a.dims.singleSpine).toBe(4);
    expect(a.fitness).toBeCloseTo((5 + 5 + 5 + 1 + 3 + 1) / 6, 5);
    expect(a.goalAttainmentRate).toBe(0.5); // one of two had goalAttainment>=4
  });

  test("empty input is zero, not NaN", () => {
    const a = aggregate([]);
    expect(a.fitness).toBe(0);
    expect(a.goalAttainmentRate).toBe(0);
  });

  test("aggregates all investigation-bar dimensions", () => {
    const a = aggregate([
      verdict({
        singleSpine: 5,
        discoveryArc: 4,
        handsOnMission: 3,
        earnedPayoff: 2,
      }),
      verdict({
        singleSpine: 3,
        discoveryArc: 2,
        handsOnMission: 1,
        earnedPayoff: 4,
      }),
    ]);
    expect(a.dims.singleSpine).toBe(4);
    expect(a.dims.discoveryArc).toBe(3);
    expect(a.dims.handsOnMission).toBe(2);
    expect(a.dims.earnedPayoff).toBe(3);
  });

  test("legacy verdicts with missing design fields never produce NaN", () => {
    const {
      singleSpine: _singleSpine,
      discoveryArc: _discoveryArc,
      handsOnMission: _handsOnMission,
      earnedPayoff: _earnedPayoff,
      ...legacy
    } = verdict();
    const a = aggregate([legacy as SessionVerdict]);
    expect(a.dims.singleSpine).toBe(0);
    expect(a.dims.discoveryArc).toBe(0);
    expect(a.dims.handsOnMission).toBe(0);
    expect(a.dims.earnedPayoff).toBe(0);
    expect(Object.values(a.dims).every(Number.isFinite)).toBe(true);
    expect(a.fitness).toBe(3);
  });

  test("excludes missing and non-finite scores instead of averaging them as zero", () => {
    const { goalAttainment: _goalAttainment, ...withoutGoal } = verdict();
    const missingGoal = withoutGoal as SessionVerdict;
    const nonFiniteGoal = verdict({ goalAttainment: Number.NaN });
    const a = aggregate([
      verdict({ goalAttainment: 5, productiveStruggle: 4 }),
      missingGoal,
      nonFiniteGoal,
    ]);

    expect(a.dims.goalAttainment).toBe(5);
    expect(a.judgedN?.goalAttainment).toBe(1);
    expect(a.judgedN?.productiveStruggle).toBe(3);
    expect(a.minimums?.goalAttainment).toBe(5);
  });

  test("excludes a turn-capped progressing session from the goal denominator", () => {
    const a = aggregate([
      verdict({ goalAttainment: 4, stopReason: "goal" }),
      verdict({
        goalAttainment: 3,
        stopReason: "maxTurns",
        stallPoint: "none",
      }),
    ]);

    expect(a.goalAttainmentRate).toBe(1);
    expect(a.goalRateN).toBe(1);
    expect(a.goalTruncatedN).toBe(1);
  });

  test("counts goal evidence before the cap but keeps a plateaued cap as a miss", () => {
    const reachedBeforeCap = aggregate([
      verdict({
        goalAttainment: 4,
        stopReason: "maxTurns",
        stallPoint: "none",
      }),
    ]);
    const plateaued = aggregate([
      verdict({
        goalAttainment: 3,
        stopReason: "maxTurns",
        stallPoint: "kept repeating the same guess",
      }),
    ]);

    expect(reachedBeforeCap.goalAttainmentRate).toBe(1);
    expect(reachedBeforeCap.goalRateN).toBe(1);
    expect(reachedBeforeCap.goalTruncatedN).toBe(0);
    expect(plateaued.goalAttainmentRate).toBe(0);
    expect(plateaued.goalRateN).toBe(1);
    expect(plateaued.goalTruncatedN).toBe(0);
  });
});

describe("passesGate", () => {
  const baseline = aggregate([verdict()]);

  test("passes when protected dims hold", () => {
    const cand = aggregate([verdict({ goalAttainment: 5 })]);
    expect(passesGate(cand, baseline).pass).toBe(true);
  });

  test("changing only investigation-bar dimensions cannot fail the gate", () => {
    const cand = aggregate([
      verdict({
        singleSpine: 1,
        discoveryArc: 1,
        handsOnMission: 1,
        earnedPayoff: 1,
      }),
    ]);
    expect(passesGate(cand, baseline).pass).toBe(true);
  });

  test("fails when a protected dim drops below the absolute floor", () => {
    const cand = aggregate([verdict({ cognitiveOffloading: 2 })]);
    const r = passesGate(cand, baseline);
    expect(r.pass).toBe(false);
    expect(r.violations.map((v) => v.dim)).toContain("cognitiveOffloading");
  });

  test("fails when a protected dim regresses past tolerance vs baseline", () => {
    const hi = aggregate([verdict({ socratic: 5 })]); // baseline socratic 5
    const cand = aggregate([verdict({ socratic: 3.5 })]); // 3.5 >= floor but regressed 1.5
    expect(passesGate(cand, hi).pass).toBe(false);
  });

  test("fails on one bottom-scale session even when the cast mean passes", () => {
    const cand = aggregate([
      verdict({ productiveStruggle: 1, socratic: 1 }),
      verdict({ productiveStruggle: 5, socratic: 5 }),
      verdict({ productiveStruggle: 5, socratic: 5 }),
    ]);
    expect(cand.dims.productiveStruggle).toBeCloseTo(11 / 3);
    expect(cand.dims.socratic).toBeCloseTo(11 / 3);

    const result = passesGate(cand, baseline);
    expect(result.pass).toBe(false);
    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dim: "productiveStruggle",
          reason: expect.stringContaining("scale bottom"),
        }),
        expect.objectContaining({
          dim: "socratic",
          reason: expect.stringContaining("scale bottom"),
        }),
      ]),
    );
  });
});

describe("isBetter — the reward-hacking guard", () => {
  const baseline = aggregate([
    verdict({ goalAttainment: 3, deliverableReach: 3, productiveStruggle: 3 }),
  ]);

  test("a genuine improvement wins", () => {
    const cand = aggregate([
      verdict({ goalAttainment: 5, deliverableReach: 5, productiveStruggle: 4 }),
    ]);
    const r = isBetter(cand, baseline);
    expect(r.better).toBe(true);
    expect(r.fitnessGain).toBeGreaterThan(DEFAULT_BETTER.minFitnessGain);
  });

  test("REJECTS a variant that hit the goal by answer-dumping (offloading tanked)", () => {
    // Curriculum fit maxed, but cognitiveOffloading collapsed → must lose.
    const cand = aggregate([
      verdict({
        goalAttainment: 5,
        deliverableReach: 5,
        productiveStruggle: 5,
        cognitiveOffloading: 1,
        noSpoilers: 1,
      }),
    ]);
    const r = isBetter(cand, baseline);
    expect(r.better).toBe(false);
    expect(r.gate.pass).toBe(false);
  });

  test("REJECTS a variant that hit the goal via flattery (sycophancy tanked)", () => {
    const cand = aggregate([
      verdict({
        goalAttainment: 5,
        deliverableReach: 5,
        productiveStruggle: 5,
        sycophancy: 1,
      }),
    ]);
    expect(isBetter(cand, baseline).better).toBe(false);
  });

  test("rejects a fitness gain below the noise floor even if the gate passes", () => {
    const cand = aggregate([verdict({ goalAttainment: 3.1 })]);
    const r = isBetter(cand, baseline);
    expect(r.gate.pass).toBe(true);
    expect(r.better).toBe(false);
    expect(r.reason).toMatch(/noise floor/);
  });

  test("changing only investigation-bar dimensions leaves fitness unchanged", () => {
    const cand = aggregate([
      verdict({
        singleSpine: 5,
        discoveryArc: 5,
        handsOnMission: 5,
        earnedPayoff: 5,
      }),
    ]);
    const r = isBetter(cand, baseline);
    expect(r.fitnessGain).toBe(0);
    expect(r.better).toBe(false);
  });
});

describe("gifted-lens gate (Carl's hallmarks) — guard, not maximize", () => {
  test("REJECTS a variant that hit the goal by flattening the activity (depth/inquiry tanked)", () => {
    // The turn-cap / 'hurry up' exploit: fitness maxes out (everyone reaches the
    // goal fast) but the activity got shallower — depth + inquiry dropped. The
    // gifted gate must reject it even though fitness improved and tutor-quality
    // protected dims held.
    const base = aggregate([
      verdict({ goalAttainment: 3, depth: 5, inquiry: 5 }),
    ]);
    const cand = aggregate([
      verdict({
        goalAttainment: 5,
        deliverableReach: 5,
        productiveStruggle: 5,
        depth: 3, // regressed 2.0 — well past the 0.3 tolerance
        inquiry: 3,
      }),
    ]);
    const r = isBetter(cand, base);
    expect(r.better).toBe(false);
    expect(r.gate.pass).toBe(false);
    expect(r.gate.violations.map((v) => v.dim)).toEqual(
      expect.arrayContaining(["depth", "inquiry"]),
    );
  });

  test("grade-flexible: a legitimately concrete activity is NOT punished for low abstraction", () => {
    // A Kindergarten counting activity sits low on abstraction (2.0) by nature.
    // As long as the candidate doesn't ERODE it, a real fitness gain wins —
    // there is no universal absolute floor on gifted dims.
    const base = aggregate([
      verdict({ goalAttainment: 3, abstraction: 2, complexity: 2 }),
    ]);
    const cand = aggregate([
      verdict({
        goalAttainment: 5,
        deliverableReach: 5,
        abstraction: 2, // held, not eroded
        complexity: 2,
      }),
    ]);
    const r = isBetter(cand, base);
    expect(r.gate.pass).toBe(true);
    expect(r.better).toBe(true);
  });

  test("gifted dims are GUARDED, not part of fitness — raising depth alone is not 'better'", () => {
    // A variant that only lifts gifted dims (no curriculum-fit gain) clears the
    // gate but does not beat the noise floor: gifted-ness is a floor, the push
    // toward it comes from the Improver, not from this scalar.
    const base = aggregate([verdict({ depth: 3, abstraction: 3 })]);
    const cand = aggregate([verdict({ depth: 5, abstraction: 5 })]);
    const r = isBetter(cand, base);
    expect(r.gate.pass).toBe(true);
    expect(r.fitnessGain).toBe(0);
    expect(r.better).toBe(false);
  });
});

// ─── Pairwise promote gate (adoptable #3 — addresses Finding 3) ────────

/** Build one per-cast head-to-head comparison. */
function comparison(
  winner: PairwiseComparison["winner"],
  overrides: Partial<PairwiseComparison> = {},
): PairwiseComparison {
  return {
    profileName: "Pip",
    readingLevel: "Grade 2",
    candidateLabel: "A",
    pick: winner === "tie" ? "tie" : winner === "candidate" ? "A" : "B",
    winner,
    reason: "test",
    ...overrides,
  };
}

describe("tallyPairwise", () => {
  test("counts wins/losses/ties and computes net + fraction", () => {
    const t = tallyPairwise([
      comparison("candidate"),
      comparison("candidate"),
      comparison("baseline"),
      comparison("tie"),
    ]);
    expect(t.n).toBe(4);
    expect(t.candidateWins).toBe(2);
    expect(t.baselineWins).toBe(1);
    expect(t.ties).toBe(1);
    expect(t.net).toBe(1); // 2 − 1
    expect(t.candidatePreferredFraction).toBe(0.5); // 2 of 4
  });

  test("empty tally is zero, not NaN", () => {
    const t = tallyPairwise([]);
    expect(t.n).toBe(0);
    expect(t.net).toBe(0);
    expect(t.candidatePreferredFraction).toBe(0);
  });
});

describe("isBetterPairwise — promotion by cast preference, veto retained", () => {
  const baseline = aggregate([
    verdict({ goalAttainment: 3, deliverableReach: 3, productiveStruggle: 3 }),
  ]);

  test("candidate preferred AND passes the gate → PROMOTE", () => {
    // A clean edit: cast net-prefers it and no protected/gifted dim regressed.
    const cand = aggregate([
      verdict({ goalAttainment: 4, deliverableReach: 4 }),
    ]);
    const tally = tallyPairwise([
      comparison("candidate"),
      comparison("candidate"),
      comparison("baseline"),
    ]);
    const r = isBetterPairwise(cand, baseline, tally);
    expect(r.gate.pass).toBe(true);
    expect(r.net).toBe(1);
    expect(r.better).toBe(true);
  });

  test("candidate preferred but FAILS the protected-dim gate → NOT promoted", () => {
    // The cast loves it, but it reached the goal by answer-dumping
    // (cognitiveOffloading collapsed) — the veto overrides the vote.
    const cand = aggregate([
      verdict({
        goalAttainment: 5,
        deliverableReach: 5,
        cognitiveOffloading: 1,
        noSpoilers: 1,
      }),
    ]);
    const tally = tallyPairwise([
      comparison("candidate"),
      comparison("candidate"),
      comparison("candidate"),
    ]);
    const r = isBetterPairwise(cand, baseline, tally);
    expect(r.gate.pass).toBe(false);
    expect(r.better).toBe(false);
    expect(r.reason).toMatch(/gate/i);
  });

  test("candidate preferred but a GIFTED dim regressed → NOT promoted", () => {
    // Same veto, gifted-lens edge: fitness up + cast prefers it, but depth
    // tanked (flattened the activity). The protected veto still wins.
    const base = aggregate([verdict({ goalAttainment: 3, depth: 5, inquiry: 5 })]);
    const cand = aggregate([
      verdict({ goalAttainment: 5, deliverableReach: 5, depth: 3, inquiry: 3 }),
    ]);
    const tally = tallyPairwise([comparison("candidate"), comparison("candidate")]);
    const r = isBetterPairwise(cand, base, tally);
    expect(r.gate.pass).toBe(false);
    expect(r.better).toBe(false);
  });

  test("baseline preferred (net ≤ 0) → NOT promoted even though the gate passes", () => {
    const cand = aggregate([verdict({ goalAttainment: 4 })]);
    const tally = tallyPairwise([
      comparison("baseline"),
      comparison("baseline"),
      comparison("candidate"),
    ]);
    const r = isBetterPairwise(cand, baseline, tally);
    expect(r.gate.pass).toBe(true); // no regression — gate is fine
    expect(r.net).toBe(-1);
    expect(r.better).toBe(false);
    expect(r.reason).toMatch(/net preference/i);
  });

  test("a dead tie (net 0) does not clear the +1 threshold → NOT promoted", () => {
    const cand = aggregate([verdict({ goalAttainment: 4 })]);
    const tally = tallyPairwise([
      comparison("candidate"),
      comparison("baseline"),
      comparison("tie"),
    ]);
    const r = isBetterPairwise(cand, baseline, tally);
    expect(r.net).toBe(0);
    expect(r.better).toBe(false);
  });

  test("no comparisons available → NOT promoted (caller degrades to absolute)", () => {
    const cand = aggregate([verdict({ goalAttainment: 5, deliverableReach: 5 })]);
    const r = isBetterPairwise(cand, baseline, tallyPairwise([]));
    expect(r.better).toBe(false);
    expect(r.reason).toMatch(/no pairwise/i);
  });

  test("a higher net threshold is respected", () => {
    const cand = aggregate([verdict({ goalAttainment: 4 })]);
    const tally = tallyPairwise([
      comparison("candidate"),
      comparison("baseline"),
    ]); // net 0
    const r = isBetterPairwise(cand, baseline, tally, {
      ...DEFAULT_BETTER,
      minNetPreference: 2,
    });
    expect(r.better).toBe(false);
  });
});
