/**
 * The plan-scope note's own tests: WHICH exclusion the panel is standing in
 * (pure), and the two invariants that make it one note rather than a second
 * vocabulary — it reuses the mapping strip's shell, and it replaces rather than
 * joins that strip.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

const stripSource = readFileSync(
  join(process.cwd(), "components/practice/MathPlanScopeStrip.tsx"),
  "utf8",
);
const mapStripSource = readFileSync(
  join(process.cwd(), "components/practice/DomainMapStatusStrip.tsx"),
  "utf8",
);
const viewSource = readFileSync(
  join(process.cwd(), "components/practice/MathSkillsMasteryView.tsx"),
  "utf8",
);

describe("MathPlanScopeStrip", () => {
  it("sits at the same hierarchy as the mapping strip, via one shared shell", () => {
    expect(stripSource).toContain("DetailNoteStrip");
    expect(mapStripSource).toContain("DetailNoteStrip");
    // Neither strip may re-declare the shell's chrome.
    expect(stripSource).not.toContain('borderRadius="lg"');
    expect(mapStripSource).not.toContain('borderRadius="lg"');
  });

  it("reuses the canonical out-of-scope glyph rather than a new mark", () => {
    expect(stripSource).toContain("OutOfScopeSlash");
  });

  it("reuses the canonical scope predicates", () => {
    expect(stripSource).toContain("scopeAllowsDomain");
    expect(stripSource).toContain("scopeAllowsStrand");
  });

  it("states policy, not error — no red, no alarm vocabulary", () => {
    expect(stripSource).not.toMatch(/red\.\d|colorPalette="red"|Warning/);
  });

  it("names the plan in sentence case without restating it", () => {
    expect(stripSource).toContain("Not served");
    expect(stripSource).toContain(
      "is outside ${firstName}\\u2019s Math plan, so nothing in it is served while the plan is active.",
    );
  });

  it("REPLACES the mapping strip — mapping guidance is not a next action here", () => {
    // Showing "run a check-in" alongside "nothing here is served" would send a
    // teacher to do work the plan makes inert.
    expect(viewSource).toMatch(
      /\{outOfScope \? \(\s*<MathPlanScopeStrip[\s\S]*?\) : \(\s*<DomainMapStatusStrip/,
    );
  });
});
