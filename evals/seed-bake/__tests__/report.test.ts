/**
 * Pure tests for the seed-bake ship decision (no models, no backend). Pins that
 * `decide` aggregates both arms, computes per-dimension deltas, and surfaces the
 * `isBetter` gate — including the reward-hacking guard (a fitness win that
 * regresses a protected dim must NOT pass).
 */
import { describe, expect, test } from "vitest";
import { decide, renderReport } from "../lib/report";
import type { SessionVerdict } from "../../curriculum-sim/lib/score";

/** Build a verdict with every dim = `base`, then apply overrides. */
function verdict(base: number, over: Partial<SessionVerdict> = {}): SessionVerdict {
  return {
    goalAttainment: base,
    deliverableReach: base,
    productiveStruggle: base,
    socratic: base,
    cognitiveOffloading: base,
    noSpoilers: base,
    sycophancy: base,
    ageFit: base,
    depth: base,
    complexity: base,
    abstraction: base,
    inquiry: base,
    authenticity: base,
    singleSpine: base,
    discoveryArc: base,
    handsOnMission: base,
    earnedPayoff: base,
    stallPoint: "none",
    promptAttribution: "none",
    summary: "test",
    ...over,
  };
}

describe("seed-bake decision", () => {
  test("a clean fitness win with no regressions clears the gate", () => {
    const adLib = [verdict(3), verdict(3)];
    // Baked lifts the fitness dims, holds the protected/gifted dims.
    const baked = [
      verdict(3, { goalAttainment: 5, deliverableReach: 5, productiveStruggle: 4 }),
      verdict(3, { goalAttainment: 5, deliverableReach: 5, productiveStruggle: 4 }),
    ];
    const d = decide(adLib, baked);
    expect(d.result.better).toBe(true);
    expect(d.deltas.goalAttainment).toBeCloseTo(2);
    expect(d.baked.fitness).toBeGreaterThan(d.adLib.fitness);
  });

  test("a fitness win bought by tanking a protected dim FAILS the gate (no reward hacking)", () => {
    const adLib = [verdict(4), verdict(4)];
    // Higher goal attainment, but the tutor offloaded the thinking → protected
    // dim collapses; must not be shippable.
    const baked = [
      verdict(4, { goalAttainment: 5, cognitiveOffloading: 1 }),
      verdict(4, { goalAttainment: 5, cognitiveOffloading: 1 }),
    ];
    const d = decide(adLib, baked);
    expect(d.result.better).toBe(false);
    expect(d.result.gate.violations.some((v) => v.dim === "cognitiveOffloading")).toBe(true);
  });

  test("a sub-noise-floor fitness gain does not count as a win", () => {
    const adLib = [verdict(3)];
    const baked = [verdict(3, { goalAttainment: 3.1 })];
    const d = decide(adLib, baked);
    expect(d.result.better).toBe(false);
    expect(d.result.reason).toMatch(/noise floor/);
  });

  test("renders the measured investigation-bar section and all four dimensions", () => {
    const decision = decide(
      [verdict(3)],
      [
        verdict(3, {
          singleSpine: 5,
          discoveryArc: 4,
          handsOnMission: 3,
          earnedPayoff: 2,
        }),
      ],
    );
    const report = renderReport(
      decision,
      { perTopicMs: [90_000] },
      { topics: 1, scholarsPerTopic: 1, offline: true },
    );
    expect(report).toContain("### Investigation bar (design)");
    expect(report).toContain("bar mean:");
    expect(report).toContain("singleSpine");
    expect(report).toContain("discoveryArc");
    expect(report).toContain("handsOnMission");
    expect(report).toContain("earnedPayoff");
  });
});
