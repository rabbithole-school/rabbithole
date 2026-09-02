/**
 * Tests for the selection logic — the part that decides which activity variant
 * wins. The reward-hacking gate is the load-bearing guard here, so it gets the
 * most cases: a variant that lifts curriculum fit by sacrificing a protected
 * tutor-quality dim must NOT be judged "better".
 */
import { describe, expect, test } from "vitest";
import { aggregate, isBetter, passesGate, DEFAULT_BETTER, type SessionVerdict } from "../lib/score";

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

  test("aggregates the investigation-bar dimensions", () => {
    const a = aggregate([
      verdict({ singleSpine: 5, discoveryArc: 4, handsOnMission: 3, earnedPayoff: 2 }),
      verdict({ singleSpine: 3, discoveryArc: 2, handsOnMission: 1, earnedPayoff: 4 }),
    ]);
    expect(a.dims.singleSpine).toBe(4);
    expect(a.dims.discoveryArc).toBe(3);
    expect(a.dims.handsOnMission).toBe(2);
    expect(a.dims.earnedPayoff).toBe(3);
  });

  test("missing investigation-bar fields in a stored verdict never produce NaN", () => {
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
    expect(passesGate(a, a).pass).toBe(true);
    expect(isBetter(a, a).fitnessGain).toBe(0);
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
      verdict({ singleSpine: 1, discoveryArc: 1, handsOnMission: 1, earnedPayoff: 1 }),
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
});

describe("isBetter — the reward-hacking guard", () => {
  const baseline = aggregate([verdict({ goalAttainment: 3, deliverableReach: 3, productiveStruggle: 3 })]);

  test("a genuine improvement wins", () => {
    const cand = aggregate([verdict({ goalAttainment: 5, deliverableReach: 5, productiveStruggle: 4 })]);
    const r = isBetter(cand, baseline);
    expect(r.better).toBe(true);
    expect(r.fitnessGain).toBeGreaterThan(DEFAULT_BETTER.minFitnessGain);
  });

  test("REJECTS a variant that hit the goal by answer-dumping (offloading tanked)", () => {
    // Curriculum fit maxed, but cognitiveOffloading collapsed → must lose.
    const cand = aggregate([
      verdict({ goalAttainment: 5, deliverableReach: 5, productiveStruggle: 5, cognitiveOffloading: 1, noSpoilers: 1 }),
    ]);
    const r = isBetter(cand, baseline);
    expect(r.better).toBe(false);
    expect(r.gate.pass).toBe(false);
  });

  test("REJECTS a variant that hit the goal via flattery (sycophancy tanked)", () => {
    const cand = aggregate([verdict({ goalAttainment: 5, deliverableReach: 5, productiveStruggle: 5, sycophancy: 1 })]);
    expect(isBetter(cand, baseline).better).toBe(false);
  });

  test("rejects a fitness gain below the noise floor even if the gate passes", () => {
    const cand = aggregate([verdict({ goalAttainment: 3.1 })]);
    const r = isBetter(cand, baseline);
    expect(r.gate.pass).toBe(true);
    expect(r.better).toBe(false);
    expect(r.reason).toMatch(/noise floor/);
  });

  test("changing only investigation-bar dimensions leaves fitnessGain unchanged", () => {
    const cand = aggregate([
      verdict({ singleSpine: 5, discoveryArc: 5, handsOnMission: 5, earnedPayoff: 5 }),
    ]);
    const r = isBetter(cand, baseline);
    expect(r.fitnessGain).toBe(0);
    expect(r.better).toBe(false);
  });
});

describe("gifted-lens gate (Carl's hallmarks) — guard, not maximize", () => {
  test("REJECTS a variant that hit the goal by flattening the activity (depth/inquiry tanked)", () => {
    const base = aggregate([verdict({ goalAttainment: 3, depth: 5, inquiry: 5 })]);
    const cand = aggregate([
      verdict({ goalAttainment: 5, deliverableReach: 5, productiveStruggle: 5, depth: 3, inquiry: 3 }),
    ]);
    const r = isBetter(cand, base);
    expect(r.better).toBe(false);
    expect(r.gate.pass).toBe(false);
    expect(r.gate.violations.map((v) => v.dim)).toEqual(expect.arrayContaining(["depth", "inquiry"]));
  });

  test("grade-flexible: a legitimately concrete activity is NOT punished for low abstraction", () => {
    const base = aggregate([verdict({ goalAttainment: 3, abstraction: 2, complexity: 2 })]);
    const cand = aggregate([verdict({ goalAttainment: 5, deliverableReach: 5, abstraction: 2, complexity: 2 })]);
    const r = isBetter(cand, base);
    expect(r.gate.pass).toBe(true);
    expect(r.better).toBe(true);
  });

  test("gifted dims are GUARDED, not part of fitness — raising depth alone is not 'better'", () => {
    const base = aggregate([verdict({ depth: 3, abstraction: 3 })]);
    const cand = aggregate([verdict({ depth: 5, abstraction: 5 })]);
    const r = isBetter(cand, base);
    expect(r.gate.pass).toBe(true);
    expect(r.fitnessGain).toBe(0);
    expect(r.better).toBe(false);
  });
});
