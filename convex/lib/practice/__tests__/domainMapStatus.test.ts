import { describe, expect, test } from "vitest";
import {
  summarizeDomainMap,
  domainMayServe,
  type DomainMapInput,
} from "../domainMapStatus";

// The PURE half of the map derivation (finish-the-check-in, founder 2026-08-18).
// It replaces the open-run cap's pure policy (isOpenPlacementRun /
// pickHeldPlacementRun), which is deleted along with the cap: breadth-first
// serving means a scholar may hold several in-progress runs, and what matters is
// no longer "which ONE run holds the cap" but "which domains are on the map, and
// which of them may serve now". The server-side half is covered in
// convex/__tests__/placementBreadthServing.test.ts.

const WHOLE = "whole-number-arithmetic";
const FRAC = "fraction-arithmetic";
const GEO = "geometry-measurement";

function domain(over: Partial<DomainMapInput> & { domain: string }): DomainMapInput {
  return {
    prereqDomains: [],
    gradeEligible: true,
    placementStatus: null,
    answeredProbes: 0,
    hasMastery: false,
    ...over,
  };
}

const statuses = (inputs: DomainMapInput[]) =>
  Object.fromEntries(
    summarizeDomainMap(inputs, { gradeOnFile: true }).perDomain.map((e) => [e.domain, e.status]),
  );

describe("summarizeDomainMap — mapped means a CONVERGED run, never mastery", () => {
  test("a completed placement run is the ONLY mapped state", () => {
    expect(statuses([domain({ domain: WHOLE, placementStatus: "complete" })])).toEqual({
      [WHOLE]: "converged",
    });
  });

  test("SHADOW PLACEMENT: mastery rows with no converged run are UNMAPPED and counted in M", () => {
    // The hole this derivation closes. `readMixedDomainRuntime` used to call this
    // domain done because `mastery.size > 0`, so it was never searched.
    const summary = summarizeDomainMap(
      [domain({ domain: WHOLE, hasMastery: true })],
      { gradeOnFile: true },
    );
    expect(summary.perDomain[0].status).toBe("shadow_placed");
    expect(summary.perDomain[0].mapped).toBe(false);
    expect(summary.eligibleCount).toBe(1);
    expect(summary.mappedCount).toBe(0);
    expect(summary.allMapped).toBe(false);
    // …and it is servable: a shadow-placed domain gets probes.
    expect(domainMayServe(summary.perDomain[0])).toBe(true);
  });

  test("an in-progress row with answered probes is in_flight; a merely primed one is not", () => {
    expect(
      statuses([
        domain({ domain: WHOLE, placementStatus: "in_progress", answeredProbes: 1 }),
        domain({ domain: FRAC, placementStatus: "in_progress", answeredProbes: 0 }),
      ]),
    ).toEqual({ [WHOLE]: "in_flight", [FRAC]: "available" });
  });

  test("MULTIPLE simultaneously in-flight runs are a legal shape, not a violation", () => {
    // Prod already holds a scholar with two open rows, and breadth-first serving
    // creates them deliberately. Both are unmapped, both count in M, both serve.
    const summary = summarizeDomainMap(
      [
        domain({ domain: WHOLE, placementStatus: "in_progress", answeredProbes: 3 }),
        domain({ domain: GEO, placementStatus: "in_progress", answeredProbes: 5 }),
      ],
      { gradeOnFile: true },
    );
    expect(summary.perDomain.every((e) => e.status === "in_flight")).toBe(true);
    expect(summary.perDomain.every(domainMayServe)).toBe(true);
    expect(summary.eligibleCount).toBe(2);
  });
});

describe("summarizeDomainMap — the denominator is grade eligibility, not the prereq DAG", () => {
  test("a prereq-gated domain is QUEUED and still counted in M", () => {
    // M must not treadmill upward mid-check-in: "2 of 7" grows to "7 of 7", it
    // never becomes "2 of 3" then "3 of 5".
    const summary = summarizeDomainMap(
      [
        domain({ domain: WHOLE }),
        domain({ domain: FRAC, prereqDomains: [WHOLE] }),
        domain({ domain: GEO, prereqDomains: [WHOLE, FRAC] }),
      ],
      { gradeOnFile: true },
    );
    expect(summary.eligibleCount).toBe(3);
    expect(summary.perDomain.map((e) => e.status)).toEqual(["available", "queued", "queued"]);
    // Only the one whose prereqs are satisfied may open.
    expect(summary.perDomain.map(domainMayServe)).toEqual([true, false, false]);
  });

  test("a prereq counts as satisfied only once it CONVERGES — mastery in it is not enough", () => {
    const withMasteryOnly = summarizeDomainMap(
      [domain({ domain: WHOLE, hasMastery: true }), domain({ domain: FRAC, prereqDomains: [WHOLE] })],
      { gradeOnFile: true },
    );
    expect(withMasteryOnly.perDomain[1].status).toBe("queued");

    const withConvergedPrereq = summarizeDomainMap(
      [
        domain({ domain: WHOLE, placementStatus: "complete" }),
        domain({ domain: FRAC, prereqDomains: [WHOLE] }),
      ],
      { gradeOnFile: true },
    );
    expect(withConvergedPrereq.perDomain[1].status).toBe("available");
  });

  test("a queued domain NAMES its unconverged blocker(s)", () => {
    const summary = summarizeDomainMap(
      [
        domain({ domain: WHOLE }),
        domain({ domain: FRAC }),
        domain({ domain: GEO, prereqDomains: [WHOLE, FRAC] }),
      ],
      { gradeOnFile: true },
    );
    expect(summary.perDomain[2].status).toBe("queued");
    expect(summary.perDomain[2].blockedBy).toEqual([WHOLE, FRAC]);
    // Non-queued entries never carry a blocker list.
    expect(summary.perDomain[0].blockedBy).toEqual([]);
    expect(summary.perDomain[1].blockedBy).toEqual([]);
  });

  test("a converged prereq drops out of blockedBy, and empties it once all converge", () => {
    const partial = summarizeDomainMap(
      [
        domain({ domain: WHOLE, placementStatus: "complete" }),
        domain({ domain: FRAC }),
        domain({ domain: GEO, prereqDomains: [WHOLE, FRAC] }),
      ],
      { gradeOnFile: true },
    );
    expect(partial.perDomain[2].status).toBe("queued");
    expect(partial.perDomain[2].blockedBy).toEqual([FRAC]);

    const converged = summarizeDomainMap(
      [
        domain({ domain: WHOLE, placementStatus: "complete" }),
        domain({ domain: FRAC, placementStatus: "complete" }),
        domain({ domain: GEO, prereqDomains: [WHOLE, FRAC] }),
      ],
      { gradeOnFile: true },
    );
    expect(converged.perDomain[2].status).toBe("available");
    expect(converged.perDomain[2].blockedBy).toEqual([]);
  });

  test("a prereq absent from the input set never appears in blockedBy (it can't gate)", () => {
    const summary = summarizeDomainMap(
      [domain({ domain: FRAC, prereqDomains: ["not-seeded-here", WHOLE] })],
      { gradeOnFile: true },
    );
    // WHOLE is absent too, so this is `available`, not `queued` — blockedBy is empty.
    expect(summary.perDomain[0].status).toBe("available");
    expect(summary.perDomain[0].blockedBy).toEqual([]);
  });

  test("a prereq that isn't seeded on this deployment can't gate anything", () => {
    const summary = summarizeDomainMap(
      [domain({ domain: FRAC, prereqDomains: ["not-seeded-here"] })],
      { gradeOnFile: true },
    );
    expect(summary.perDomain[0].prereqsReady).toBe(true);
    expect(summary.perDomain[0].status).toBe("available");
  });

  test("a grade-ineligible domain is excluded from M entirely and never serves", () => {
    const summary = summarizeDomainMap(
      [domain({ domain: WHOLE }), domain({ domain: GEO, gradeEligible: false })],
      { gradeOnFile: false },
    );
    expect(summary.eligibleCount).toBe(1);
    expect(summary.perDomain[1].status).toBe("ineligible");
    expect(domainMayServe(summary.perDomain[1])).toBe(false);
    expect(summary.gradeOnFile).toBe(false);
  });

  test("an OPEN run outranks the grade gate — a deliberate pick above the ring keeps serving", () => {
    // The gate governs which domain opens AUTOMATICALLY. Once a scholar has
    // deliberately opened one above their ring and answered a probe, dropping it
    // back to `ineligible` would strand their own choice mid-search.
    const summary = summarizeDomainMap(
      [
        domain({ domain: GEO, gradeEligible: false, placementStatus: "in_progress", answeredProbes: 1 }),
      ],
      { gradeOnFile: true },
    );
    expect(summary.perDomain[0].status).toBe("in_flight");
    expect(summary.eligibleCount).toBe(1);
    expect(domainMayServe(summary.perDomain[0])).toBe(true);

    // Merely PRIMING it (a served probe, nothing answered) does not admit it.
    const primedOnly = summarizeDomainMap(
      [domain({ domain: GEO, gradeEligible: false, placementStatus: "in_progress", answeredProbes: 0 })],
      { gradeOnFile: true },
    );
    expect(primedOnly.perDomain[0].status).toBe("ineligible");
    expect(primedOnly.eligibleCount).toBe(0);
  });

  test("CONVERGED outranks the grade gate, so N can never exceed M", () => {
    // A deliberate pick may map a domain outside the ring; it is still mapped.
    const summary = summarizeDomainMap(
      [domain({ domain: GEO, gradeEligible: false, placementStatus: "complete" })],
      { gradeOnFile: true },
    );
    expect(summary.perDomain[0].status).toBe("converged");
    expect(summary.mappedCount).toBe(1);
    expect(summary.eligibleCount).toBe(1);
    expect(summary.allMapped).toBe(true);
  });
});

describe("summarizeDomainMap — `reachable` (raise-the-ceiling offer surface)", () => {
  test("prereqs converged + grade-ineligible + unanswered → ineligible/!eligible/!domainMayServe/reachable:true", () => {
    const summary = summarizeDomainMap(
      [
        domain({ domain: WHOLE, placementStatus: "complete" }),
        domain({
          domain: GEO,
          gradeEligible: false,
          prereqDomains: [WHOLE],
        }),
      ],
      { gradeOnFile: true },
    );
    const geo = summary.perDomain[1];
    expect(geo.status).toBe("ineligible");
    expect(geo.eligible).toBe(false);
    expect(geo.gradeEligible).toBe(false);
    expect(domainMayServe(geo)).toBe(false);
    expect(geo.reachable).toBe(true);
    // The CRITICAL invariant (review finding 3a): reachable must NEVER join M or
    // become automatically servable — only the deliberate offer surface reads it.
    expect(summary.eligibleCount).toBe(1);
  });

  test("prereqs unconverged → reachable:false, even though grade-ineligible", () => {
    const summary = summarizeDomainMap(
      [
        domain({ domain: WHOLE }), // not converged
        domain({
          domain: GEO,
          gradeEligible: false,
          prereqDomains: [WHOLE],
        }),
      ],
      { gradeOnFile: true },
    );
    const geo = summary.perDomain[1];
    expect(geo.status).toBe("ineligible");
    expect(geo.reachable).toBe(false);
  });

  test("answeredProbes>0 still classifies in_flight, and is no longer reachable (precedence untouched)", () => {
    const summary = summarizeDomainMap(
      [
        domain({ domain: WHOLE, placementStatus: "complete" }),
        domain({
          domain: GEO,
          gradeEligible: false,
          prereqDomains: [WHOLE],
          placementStatus: "in_progress",
          answeredProbes: 1,
        }),
      ],
      { gradeOnFile: true },
    );
    const geo = summary.perDomain[1];
    expect(geo.status).toBe("in_flight");
    expect(geo.eligible).toBe(true);
    expect(geo.reachable).toBe(false);
    expect(domainMayServe(geo)).toBe(true);
  });

  test("a grade-eligible domain is never `reachable` (reachable is above-ring only)", () => {
    const summary = summarizeDomainMap([domain({ domain: WHOLE })], { gradeOnFile: true });
    expect(summary.perDomain[0].status).toBe("available");
    expect(summary.perDomain[0].reachable).toBe(false);
  });
});

describe("summarizeDomainMap — the N-of-M counts the CTA reads", () => {
  test("counts converged among eligible, and allMapped only at N === M", () => {
    const inputs = [
      domain({ domain: WHOLE, placementStatus: "complete" }),
      domain({ domain: FRAC, prereqDomains: [WHOLE], placementStatus: "in_progress", answeredProbes: 2 }),
      domain({ domain: GEO, prereqDomains: [WHOLE], gradeEligible: false }),
    ];
    const summary = summarizeDomainMap(inputs, { gradeOnFile: true });
    expect(summary.mappedCount).toBe(1);
    expect(summary.eligibleCount).toBe(2);
    expect(summary.allMapped).toBe(false);

    const finished = summarizeDomainMap(
      inputs.map((d) => (d.domain === FRAC ? { ...d, placementStatus: "complete" } : d)),
      { gradeOnFile: true },
    );
    expect(finished.mappedCount).toBe(2);
    expect(finished.eligibleCount).toBe(2);
    expect(finished.allMapped).toBe(true);
  });

  test("no eligible domain at all is NOT 'all mapped' (0 of 0 must never read as done)", () => {
    const summary = summarizeDomainMap(
      [domain({ domain: GEO, gradeEligible: false })],
      { gradeOnFile: false },
    );
    expect(summary.eligibleCount).toBe(0);
    expect(summary.allMapped).toBe(false);
  });

  test("an in-flight domain keeps serving even while its prerequisites are unmet", () => {
    // A deliberate pick can open a prereq-gated domain. The gate orders which
    // domain opens NEXT; it must not un-open one that is already underway.
    const summary = summarizeDomainMap(
      [
        domain({ domain: WHOLE }),
        domain({ domain: GEO, prereqDomains: [WHOLE], placementStatus: "in_progress", answeredProbes: 4 }),
      ],
      { gradeOnFile: true },
    );
    expect(summary.perDomain[1].prereqsReady).toBe(false);
    expect(summary.perDomain[1].status).toBe("in_flight");
    expect(domainMayServe(summary.perDomain[1])).toBe(true);
  });
});
