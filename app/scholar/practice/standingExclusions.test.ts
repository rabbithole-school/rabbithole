import { describe, expect, it } from "vitest";
import { standingExcludedStrands } from "./standingExclusions";

const probabilityStanding = {
  domain: "probability",
  domains: ["probability"],
  excludedStrands: ["compound"],
};

const base = {
  isProblemSet: false,
  isMixedSession: false,
  explicitDomain: null,
  isStrandPickEntry: false,
  domain: "probability",
  standing: probabilityStanding,
};

describe("standingExcludedStrands", () => {
  it("keeps a teacher's exclusions on a strand-tile Start into the standing's own domain", () => {
    // Review finding on the strand-pick fix: every pick now carries
    // `?domain=`, and the page used to drop the standing row (and so these
    // exclusions) for any explicit domain.
    expect(
      standingExcludedStrands({
        ...base,
        explicitDomain: "probability",
        isStrandPickEntry: true,
      }),
    ).toEqual(["compound"]);
  });

  it("keeps the exclusions on the ordinary no-domain entry", () => {
    expect(standingExcludedStrands(base)).toEqual(["compound"]);
  });

  it("does not apply them to a pick in another domain (exclusions are not domain-qualified)", () => {
    expect(
      standingExcludedStrands({
        ...base,
        explicitDomain: "fraction-arithmetic",
        isStrandPickEntry: true,
        domain: "fraction-arithmetic",
      }),
    ).toBeUndefined();
  });

  it("does not apply a multi-domain standing's exclusions to a single-domain pick", () => {
    expect(
      standingExcludedStrands({
        ...base,
        explicitDomain: "probability",
        isStrandPickEntry: true,
        standing: { ...probabilityStanding, domains: ["whole-number-arithmetic", "probability"] },
      }),
    ).toBeUndefined();
  });

  it("leaves a bare deep-link `?domain=` without exclusions, as before", () => {
    expect(
      standingExcludedStrands({ ...base, explicitDomain: "probability" }),
    ).toBeUndefined();
  });

  it("never applies to a problem set, a mixed playlist, or no standing", () => {
    expect(standingExcludedStrands({ ...base, isProblemSet: true })).toBeUndefined();
    expect(standingExcludedStrands({ ...base, isMixedSession: true })).toBeUndefined();
    expect(standingExcludedStrands({ ...base, standing: null })).toBeUndefined();
  });
});
