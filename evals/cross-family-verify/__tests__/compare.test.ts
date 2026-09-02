/**
 * Tests for the cross-family comparison logic — the part that decides whether a
 * second model family AGREES with the curriculum judge at the promotion boundary.
 * Pure: no API, no key (the OpenAI judge itself is exercised by the run.ts
 * --dry-run smoke path). Mirrors the "material |Δ| > 1" contract in compare.ts.
 */
import { describe, expect, test } from "vitest";
import {
  compareJudges,
  dimGroup,
  NUMERIC_DIMS,
  MATERIAL_DELTA,
} from "../lib/compare";
import type { SessionVerdict } from "../../curriculum-sim/lib/score";

function verdict(overrides: Partial<SessionVerdict> = {}): SessionVerdict {
  return {
    goalAttainment: 4,
    deliverableReach: 4,
    productiveStruggle: 4,
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

const base = {
  activityTitle: "Test activity",
  anthropicJudge: "claude-opus-4-8",
  openaiJudge: "gpt-4o",
  dryRun: false,
};

describe("dimension bookkeeping", () => {
  test("17 numeric dims include the diagnosis-only design lens", () => {
    expect(NUMERIC_DIMS.length).toBe(17);
  });

  test("dimGroup maps each lens correctly", () => {
    expect(dimGroup("goalAttainment")).toBe("fitness");
    expect(dimGroup("socratic")).toBe("protected");
    expect(dimGroup("depth")).toBe("gifted");
    expect(dimGroup("singleSpine")).toBe("design");
  });
});

describe("compareJudges", () => {
  test("identical verdicts → total agreement", () => {
    const v = [verdict(), verdict({ goalAttainment: 5 })];
    const r = compareJudges({ ...base, anthropicVerdicts: v, openaiVerdicts: v.map((x) => ({ ...x })) });
    expect(r.agree).toBe(true);
    expect(r.fitnessAgree).toBe(true);
    expect(r.meanAbsDelta).toBe(0);
    expect(r.materialDisagreements).toHaveLength(0);
    expect(r.recommendation).toContain("CONFIRMS");
  });

  test("a >1 point gap on a fitness dim is material and blocks confirmation", () => {
    const anthropic = [verdict({ goalAttainment: 5 }), verdict({ goalAttainment: 5 })];
    // GPT family reads the outcome claim far lower (Finding 1/2): 5 → 2.
    const openai = [verdict({ goalAttainment: 2 }), verdict({ goalAttainment: 2 })];
    const r = compareJudges({ ...base, anthropicVerdicts: anthropic, openaiVerdicts: openai });

    expect(r.agree).toBe(false);
    const ga = r.dims.find((d) => d.dim === "goalAttainment")!;
    expect(ga.delta).toBe(-3);
    expect(ga.material).toBe(true);
    expect(r.materialDisagreements[0].dim).toBe("goalAttainment");
    // The fitness MEAN moved only −1.0 (one of three fitness dims), so the scalar
    // itself isn't material — but the per-dimension gap still blocks confirmation.
    // That's the value of per-dim reporting: a single load-bearing dim can't hide
    // inside an averaged scalar.
    expect(r.fitnessAgree).toBe(true);
    expect(r.recommendation).toContain("DOES NOT confirm");
  });

  test("fitness scalar disagrees when the whole curriculum-fit lens drops", () => {
    const anthropic = [verdict({ goalAttainment: 5, deliverableReach: 5, productiveStruggle: 5 })];
    const openai = [verdict({ goalAttainment: 2, deliverableReach: 2, productiveStruggle: 2 })];
    const r = compareJudges({ ...base, anthropicVerdicts: anthropic, openaiVerdicts: openai });
    expect(r.fitness.delta).toBe(-3);
    expect(r.fitnessAgree).toBe(false);
    expect(r.agree).toBe(false);
    expect(r.recommendation).toContain("DOES NOT confirm");
  });

  test("exactly a 1-point gap is NOT material (noise-floor boundary)", () => {
    const anthropic = [verdict({ socratic: 5 })];
    const openai = [verdict({ socratic: 4 })];
    const r = compareJudges({ ...base, anthropicVerdicts: anthropic, openaiVerdicts: openai });
    const soc = r.dims.find((d) => d.dim === "socratic")!;
    expect(soc.absDelta).toBe(1);
    expect(soc.material).toBe(false); // strictly > MATERIAL_DELTA
    expect(MATERIAL_DELTA).toBe(1);
    expect(r.agree).toBe(true);
  });

  test("gifted-only material gap keeps the promotion signal but is flagged softly", () => {
    const anthropic = [verdict({ depth: 5 })];
    const openai = [verdict({ depth: 2 })];
    const r = compareJudges({ ...base, anthropicVerdicts: anthropic, openaiVerdicts: openai });
    expect(r.agree).toBe(false);
    expect(r.fitnessAgree).toBe(true);
    expect(r.materialDisagreements.map((d) => d.dim)).toContain("depth");
    expect(r.recommendation).toContain("gifted lens");
  });

  test("design-only disagreement remains diagnosis-only", () => {
    const anthropic = [verdict({ singleSpine: 5 })];
    const openai = [verdict({ singleSpine: 2 })];
    const r = compareJudges({
      ...base,
      anthropicVerdicts: anthropic,
      openaiVerdicts: openai,
    });
    expect(r.fitnessAgree).toBe(true);
    expect(r.materialDisagreements[0].group).toBe("design");
    expect(r.recommendation).toContain("diagnosis-only design lens");
    expect(r.recommendation).toContain("Promotion signal holds");
  });

  test("throws on mismatched verdict counts", () => {
    expect(() =>
      compareJudges({ ...base, anthropicVerdicts: [verdict()], openaiVerdicts: [] }),
    ).toThrow(/differ|no Anthropic/);
  });
});
