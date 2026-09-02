import { describe, expect, test } from "vitest";
import {
  normalizePracticeScope,
  practiceScopeAllowsCheckpoint,
  practiceScopeAllowsDomain,
  practiceScopeAllowsNode,
} from "../mathPlan";

describe("Math-plan Practice scope", () => {
  test("normalizes a limited scope deterministically", () => {
    expect(
      normalizePracticeScope({
        kind: "limited",
        domains: [
          { domain: "fractions", strands: ["equivalence", "comparison", "comparison"] },
          { domain: "whole" },
          { domain: "fractions", strands: ["concept"] },
        ],
      }),
    ).toEqual({
      kind: "limited",
      domains: [
        { domain: "fractions", strands: ["comparison", "concept", "equivalence"] },
        { domain: "whole" },
      ],
    });
  });

  test("does not allow a domain-wide checkpoint across a strand restriction", () => {
    const scope = { kind: "limited" as const, domains: [{ domain: "fractions", strands: ["comparison"] }] };
    expect(practiceScopeAllowsDomain(scope, "fractions")).toBe(true);
    expect(practiceScopeAllowsNode(scope, "fractions", "comparison")).toBe(true);
    expect(practiceScopeAllowsNode(scope, "fractions", "equivalence")).toBe(false);
    expect(practiceScopeAllowsCheckpoint(scope, { domain: "fractions" })).toBe(false);
    expect(practiceScopeAllowsCheckpoint(scope, { domain: "fractions", strand: "comparison" })).toBe(true);
  });
});
