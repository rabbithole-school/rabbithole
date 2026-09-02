import { describe, expect, it } from "vitest";
import {
  PRACTICE_SCOPE_BLOCKED_DETAIL,
  PRACTICE_SCOPE_BLOCKED_HEADLINE,
  practiceScopeSentence,
  scopeAllowsChoice,
  scopeAllowsDomain,
  scopeAllowsStrand,
} from "./mathPlanScope";

const labels = {
  domainLabel: (domain: string) => ({ algebra: "Early algebra", discrete: "Discrete math" })[domain] ?? domain,
  strandLabel: (strand: string) => strand.replace(/-/g, " "),
};

describe("Math-plan scholar scope projection", () => {
  const limited = {
    kind: "limited" as const,
    domains: [{ domain: "algebra", strands: ["patterns"] }, { domain: "discrete" }],
  };

  it("keeps open scope unconstrained", () => {
    expect(scopeAllowsDomain({ kind: "open" }, "anything")).toBe(true);
    expect(scopeAllowsStrand({ kind: "open" }, "anything", null)).toBe(true);
    expect(practiceScopeSentence({ kind: "open" }, labels)).toBeNull();
  });

  it("filters domains and strand-restricted choices", () => {
    expect(scopeAllowsDomain(limited, "algebra")).toBe(true);
    expect(scopeAllowsDomain(limited, "geometry")).toBe(false);
    expect(scopeAllowsStrand(limited, "algebra", "patterns")).toBe(true);
    expect(scopeAllowsStrand(limited, "algebra", "equations")).toBe(false);
    expect(scopeAllowsChoice(limited, { domain: "discrete", strand: "counting" })).toBe(true);
  });

  it("names only resolved limited territory in scholar language", () => {
    expect(practiceScopeSentence(limited, labels)).toBe(
      "Your practice today stays within Early algebra · patterns and Discrete math.",
    );
    expect(practiceScopeSentence({ kind: "limited", domains: [] }, labels)).toBeNull();
  });
});

describe("the scope-blocked boundary copy", () => {
  it("names the PLAN as the boundary, never the scholar", () => {
    const both = `${PRACTICE_SCOPE_BLOCKED_HEADLINE} ${PRACTICE_SCOPE_BLOCKED_DETAIL}`;
    expect(PRACTICE_SCOPE_BLOCKED_HEADLINE).toContain("Math plan");
    // A boundary is about what is open right now, not about the kid: no
    // congratulation, no verdict, no locked-out framing.
    for (const banned of ["caught up", "🎉", "done for today", "you can't", "not allowed"]) {
      expect(both.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });

  it("gives the boundary a time horizon", () => {
    // "Come back later" is the whole difference between a boundary and a wall.
    expect(PRACTICE_SCOPE_BLOCKED_DETAIL.toLowerCase()).toContain("check back later");
  });

  it("is sentence case", () => {
    for (const line of [PRACTICE_SCOPE_BLOCKED_HEADLINE, PRACTICE_SCOPE_BLOCKED_DETAIL]) {
      // Only the first word of a sentence and the locked "Math plan"
      // nomenclature may capitalize — nothing else.
      const capitalized = line.match(/(?<!^)(?<![.!?] )\b[A-Z][a-z]+/g) ?? [];
      expect(capitalized.filter((word) => word !== "Math")).toEqual([]);
    }
  });
});
