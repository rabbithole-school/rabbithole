import { describe, expect, it } from "vitest";

import {
  effectivePracticeDomain,
  practiceDomainForConcept,
} from "../practiceDomain";

// Mirrors the web coverage in lib/__tests__/practiceDomainForConcept.test.ts.
// The native helper is a copy (see lib/practiceDomain.ts for why) — this test
// guards the copy against drift and documents the on-ramp precedence.

describe("practiceDomainForConcept (native)", () => {
  it("resolves a known display domain to its drill key", () => {
    expect(practiceDomainForConcept("Mathematics")).toBe(
      "whole-number-arithmetic",
    );
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(practiceDomainForConcept("mathematics")).toBe(
      "whole-number-arithmetic",
    );
    expect(practiceDomainForConcept("  MATHEMATICS  ")).toBe(
      "whole-number-arithmetic",
    );
  });

  it("resolves an unknown domain (no drill yet) to null", () => {
    expect(practiceDomainForConcept("Biology")).toBeNull();
    expect(practiceDomainForConcept("History")).toBeNull();
    expect(practiceDomainForConcept("general")).toBeNull();
  });

  it("resolves empty/missing to null", () => {
    expect(practiceDomainForConcept("")).toBeNull();
    expect(practiceDomainForConcept(undefined)).toBeNull();
    expect(practiceDomainForConcept(null)).toBeNull();
  });
});

describe("effectivePracticeDomain (native star resolution)", () => {
  it("prefers a stamped on-ramp target over the display-domain allowlist", () => {
    // The fractions on-ramp: display domain "Mathematics" would resolve to
    // whole-number via the allowlist, but the stamped slug wins so the star
    // routes into fractions.
    expect(
      effectivePracticeDomain({
        practiceDomain: "fraction-arithmetic",
        domain: "Mathematics",
      }),
    ).toBe("fraction-arithmetic");
  });

  it("falls back to the display-domain allowlist when unstamped", () => {
    expect(
      effectivePracticeDomain({ practiceDomain: null, domain: "Mathematics" }),
    ).toBe("whole-number-arithmetic");
    expect(
      effectivePracticeDomain({ domain: "Mathematics" }),
    ).toBe("whole-number-arithmetic");
  });

  it("returns null when neither a stamp nor the allowlist resolves", () => {
    expect(
      effectivePracticeDomain({ practiceDomain: null, domain: "Biology" }),
    ).toBeNull();
    expect(effectivePracticeDomain({})).toBeNull();
  });

  it("ignores a blank stamp and defers to the allowlist", () => {
    expect(
      effectivePracticeDomain({ practiceDomain: "   ", domain: "Mathematics" }),
    ).toBe("whole-number-arithmetic");
  });
});
