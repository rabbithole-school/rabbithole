import { describe, expect, it } from "vitest";

import { flagMisconceptionArgs } from "../flagMisconceptionArgs";

// The flag-misconception create path moved from the retired CohortFrontier onto
// the roster row. It must call `masteryObservations.flagMisconception` with the
// SAME arguments the old control did — this pins that contract.
describe("flagMisconceptionArgs", () => {
  it("builds { scholarId, conceptLabel } from a typed label, trimmed", () => {
    expect(
      flagMisconceptionArgs({ scholarId: "s1", conceptLabel: "  regroups wrong  " }),
    ).toEqual({ scholarId: "s1", conceptLabel: "regroups wrong" });
  });

  it("passes domain through only when present (else the mutation defaults it)", () => {
    expect(
      flagMisconceptionArgs({ scholarId: "s1", conceptLabel: "x", domain: "whole-number-arithmetic" }),
    ).toEqual({ scholarId: "s1", conceptLabel: "x", domain: "whole-number-arithmetic" });
    expect(flagMisconceptionArgs({ scholarId: "s1", conceptLabel: "x" })).not.toHaveProperty(
      "domain",
    );
  });

  it("falls back to the default label when nothing was typed", () => {
    expect(
      flagMisconceptionArgs({ scholarId: "s1", conceptLabel: "  ", defaultLabel: "carries the 1" }),
    ).toEqual({ scholarId: "s1", conceptLabel: "carries the 1" });
  });

  it("returns null when there is nothing to flag (no typed label, no default)", () => {
    expect(flagMisconceptionArgs({ scholarId: "s1", conceptLabel: "   " })).toBeNull();
    expect(
      flagMisconceptionArgs({ scholarId: "s1", conceptLabel: "", defaultLabel: "  " }),
    ).toBeNull();
  });
});
