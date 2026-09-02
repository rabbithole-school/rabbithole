import { describe, it, expect } from "vitest";
import {
  planMappingBand,
  orderMappingCandidates,
  MAPPING_BLEND_CAP,
  MAPPING_DAY1_BUDGET,
  type MappingCandidate,
} from "../mapping";

/** Terse candidate builder — defaults keep tests focused on the field under test. */
function cand(p: Partial<MappingCandidate> & { domain: string; strand: string }): MappingCandidate {
  return {
    probeKey: `${p.domain}_${p.strand}_probe`,
    pendingConfirm: false,
    domainPriority: 9,
    answeredInStrand: 0,
    domainOrder: 0,
    ...p,
  };
}

const ids = (picks: { domain: string; strand: string }[]) =>
  picks.map((p) => `${p.domain}:${p.strand}`);

describe("planMappingBand — Option D mix policy", () => {
  it("caps a BLENDED playlist at ≤2 mapping items (Q2), never allMapping", () => {
    const cands = [
      cand({ domain: "whole-number-arithmetic", strand: "add", domainPriority: 0 }),
      cand({ domain: "whole-number-arithmetic", strand: "sub", domainPriority: 0, answeredInStrand: 1 }),
      cand({ domain: "fraction-arithmetic", strand: "equiv", domainPriority: 1 }),
      cand({ domain: "geometry-measurement", strand: "area", domainPriority: 9 }),
    ];
    const plan = planMappingBand(cands, /* hasOtherServable */ true);
    expect(plan.allMapping).toBe(false);
    expect(plan.picks.length).toBe(MAPPING_BLEND_CAP);
    // Breadth: the two unprobed strands lead (pass 1 outranks deepening), and
    // among them foundational-first puts whole-number ahead of fractions. The
    // once-answered whole-number strand waits for pass 2 even though its domain
    // is the most foundational one on the board.
    expect(ids(plan.picks)).toEqual([
      "whole-number-arithmetic:add",
      "fraction-arithmetic:equiv",
    ]);
  });

  it("DAY-1 emergence: nothing else servable → allMapping, budget lifted", () => {
    const cands = Array.from({ length: 10 }, (_, i) =>
      cand({ domain: "whole-number-arithmetic", strand: `s${i}`, domainPriority: 0, domainOrder: 0 }),
    );
    const plan = planMappingBand(cands, /* hasOtherServable */ false);
    expect(plan.allMapping).toBe(true);
    // The cap lifts to the day-1 sitting budget (a longer sit), not the ≤2 blend cap.
    expect(plan.picks.length).toBe(MAPPING_DAY1_BUDGET);
    expect(plan.picks.length).toBeGreaterThan(MAPPING_BLEND_CAP);
  });

  it("no candidates → empty plan, never allMapping (a fully-mapped scholar)", () => {
    const plan = planMappingBand([], false);
    expect(plan.picks).toEqual([]);
    expect(plan.allMapping).toBe(false);
  });

  it("orders foundational-first, then least-answered, then deterministic", () => {
    const cands = [
      cand({ domain: "fraction-arithmetic", strand: "b", domainPriority: 1, answeredInStrand: 3 }),
      cand({ domain: "whole-number-arithmetic", strand: "z", domainPriority: 0, answeredInStrand: 3 }),
      cand({ domain: "whole-number-arithmetic", strand: "a", domainPriority: 0, answeredInStrand: 3 }),
    ];
    const plan = planMappingBand(cands, false, { day1Budget: 10 });
    // All three sit in pass 2 (equally answered), so the within-pass order rules:
    // whole-number (priority 0) before fractions (1); within whole-number, equal
    // answered → strand name tiebreak ("a" before "z"). Fractions is no longer
    // excluded — the band serves breadth-first across every domain it was handed.
    expect(ids(plan.picks)).toEqual([
      "whole-number-arithmetic:a",
      "whole-number-arithmetic:z",
      "fraction-arithmetic:b",
    ]);
  });

  it("leadDomain (deliberate entry Q6) sorts the picked domain's mapping first", () => {
    const cands = [
      cand({ domain: "whole-number-arithmetic", strand: "add", domainPriority: 0 }),
      cand({ domain: "geometry-measurement", strand: "area", domainPriority: 9 }),
    ];
    const plan = planMappingBand(cands, true, { leadDomain: "geometry-measurement", blendCap: 2 });
    // The picked geometry domain leads even though whole-number is foundational.
    expect(plan.picks[0]).toMatchObject({ domain: "geometry-measurement", strand: "area" });
  });

  it("leadDomain outranks the pass boundary — a deliberate pick jumps a fresh strand", () => {
    const cands = [
      cand({ domain: "whole-number-arithmetic", strand: "add", domainPriority: 0, answeredInStrand: 0 }),
      cand({ domain: "geometry-measurement", strand: "area", domainPriority: 9, answeredInStrand: 4 }),
    ];
    const plan = planMappingBand(cands, true, { leadDomain: "geometry-measurement" });
    expect(plan.picks[0]).toMatchObject({ domain: "geometry-measurement" });
  });

  it("dedups to one probe per (domain, strand)", () => {
    const cands = [
      cand({ domain: "d", strand: "s", probeKey: "first" }),
      cand({ domain: "d", strand: "s", probeKey: "second" }),
    ];
    const plan = planMappingBand(cands, false, { day1Budget: 10 });
    expect(plan.picks.length).toBe(1);
  });
});

describe("orderMappingCandidates — breadth-first (finish-the-check-in, founder 2026-08-18)", () => {
  it("PASS 1 first: every unprobed strand precedes every deepening candidate, across domains", () => {
    // The shape the old one-domain-at-a-time scoping made impossible: a scholar
    // part-way through whole-number, with fractions and geometry newly eligible.
    const cands = [
      cand({ domain: "whole-number-arithmetic", strand: "add", domainPriority: 0, answeredInStrand: 2 }),
      cand({ domain: "whole-number-arithmetic", strand: "mult", domainPriority: 0, answeredInStrand: 1 }),
      cand({ domain: "whole-number-arithmetic", strand: "place", domainPriority: 0, answeredInStrand: 0 }),
      cand({ domain: "fraction-arithmetic", strand: "equiv", domainPriority: 1, answeredInStrand: 0 }),
      cand({ domain: "geometry-measurement", strand: "area", domainPriority: 9, answeredInStrand: 0 }),
    ];
    const ordered = orderMappingCandidates(cands);
    // First coverage everywhere (foundational-first among the fresh strands)…
    expect(ids(ordered.slice(0, 3))).toEqual([
      "whole-number-arithmetic:place",
      "fraction-arithmetic:equiv",
      "geometry-measurement:area",
    ]);
    // …then deepening, least-answered first.
    expect(ids(ordered.slice(3))).toEqual([
      "whole-number-arithmetic:mult",
      "whole-number-arithmetic:add",
    ]);
  });

  it("PASS 2 deepens foundational-first, so N-of-M ticks up domain by domain", () => {
    const cands = [
      cand({ domain: "geometry-measurement", strand: "area", domainPriority: 9, answeredInStrand: 1, domainOrder: 3 }),
      cand({ domain: "fraction-arithmetic", strand: "equiv", domainPriority: 1, answeredInStrand: 1, domainOrder: 1 }),
      cand({ domain: "whole-number-arithmetic", strand: "add", domainPriority: 0, answeredInStrand: 1, domainOrder: 0 }),
    ];
    expect(ids(orderMappingCandidates(cands))).toEqual([
      "whole-number-arithmetic:add",
      "fraction-arithmetic:equiv",
      "geometry-measurement:area",
    ]);
  });

  it("is a total order — the same candidate set orders identically whatever the input order", () => {
    const cands = [
      cand({ domain: "b", strand: "y", domainPriority: 1, answeredInStrand: 0, domainOrder: 1 }),
      cand({ domain: "b", strand: "x", domainPriority: 1, answeredInStrand: 0, domainOrder: 1 }),
      cand({ domain: "a", strand: "x", domainPriority: 1, answeredInStrand: 0, domainOrder: 1 }),
      cand({ domain: "c", strand: "z", domainPriority: 1, answeredInStrand: 2, domainOrder: 1 }),
    ];
    const forward = ids(orderMappingCandidates(cands));
    const reversed = ids(orderMappingCandidates([...cands].reverse()));
    expect(forward).toEqual(reversed);
    expect(forward).toEqual(["a:x", "b:x", "b:y", "c:z"]);
  });

  it("the band spans several domains in ONE batch — the behavior the scoping filter forbade", () => {
    const cands = [
      cand({ domain: "whole-number-arithmetic", strand: "add", domainPriority: 0 }),
      cand({ domain: "whole-number-arithmetic", strand: "mult", domainPriority: 0 }),
      cand({ domain: "fraction-arithmetic", strand: "equiv", domainPriority: 1 }),
      cand({ domain: "geometry-measurement", strand: "area", domainPriority: 9 }),
      cand({ domain: "early-algebra", strand: "expr", domainPriority: 9 }),
    ];
    const plan = planMappingBand(cands, false, { day1Budget: 10 });
    expect(plan.picks.length).toBe(5);
    expect(new Set(plan.picks.map((p) => p.domain)).size).toBe(4);
  });
});
