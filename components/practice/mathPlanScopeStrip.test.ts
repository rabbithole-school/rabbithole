/**
 * The plan-scope note's own tests: WHICH exclusion the panel is standing in
 * (pure).
 */

import { describe, expect, it } from "vitest";

import { planScopeExclusion } from "./MathPlanScopeStrip";
import type { MathPlanRow, PracticeScope } from "./mathPlanProjection";

const OPEN: PracticeScope = { kind: "open" };

function row(overrides: Partial<MathPlanRow> = {}): MathPlanRow {
  return {
    scholarId: "s1",
    practiceScope: OPEN,
    scopeSource: "math_plan",
    checkpoint: null,
    conflict: false,
    mode: "toward",
    bandSolid: 0,
    bandTotal: 0,
    ...overrides,
  };
}

const LIMITED: PracticeScope = {
  kind: "limited",
  domains: [
    { domain: "fractions", strands: ["compare_fractions"] },
    { domain: "geometry" },
  ],
};

describe("planScopeExclusion", () => {
  it("finds nothing to say for an open plan", () => {
    expect(planScopeExclusion(row(), "fractions")).toBeNull();
    expect(planScopeExclusion(row(), "fractions", "add_fractions")).toBeNull();
  });

  it("stays silent while the plan is still loading", () => {
    expect(planScopeExclusion(undefined, "fractions")).toBeNull();
  });

  it("says nothing at an altitude with no domain in view", () => {
    expect(planScopeExclusion(row({ practiceScope: LIMITED }), null)).toBeNull();
  });

  it("names the DOMAIN when the whole domain is out", () => {
    expect(
      planScopeExclusion(row({ practiceScope: LIMITED }), "measurement"),
    ).toBe("domain");
  });

  it("prefers the domain over its strands — every strand in it is out anyway", () => {
    expect(
      planScopeExclusion(
        row({ practiceScope: LIMITED }),
        "measurement",
        "length",
      ),
    ).toBe("domain");
  });

  it("names the STRAND when the domain is in but the strand is not", () => {
    expect(
      planScopeExclusion(
        row({ practiceScope: LIMITED }),
        "fractions",
        "add_fractions",
      ),
    ).toBe("strand");
    expect(
      planScopeExclusion(
        row({ practiceScope: LIMITED }),
        "fractions",
        "compare_fractions",
      ),
    ).toBeNull();
  });

  it("keeps an all-strands domain open to every strand", () => {
    expect(
      planScopeExclusion(row({ practiceScope: LIMITED }), "geometry", "angles"),
    ).toBeNull();
  });
});

