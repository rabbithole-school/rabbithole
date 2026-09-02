import { describe, it, expect } from "vitest";
import {
  computeFrontierLines,
  computeStrandColumns,
  laneYPcts,
  DOMAIN_BAND_GAP,
} from "../treeMapLayout";

/**
 * FTUE M6 — the first Tree open had unreadable rail labels: a domain header
 * (floated above its band's first strand, in `MapTreeCanvas`) could land on
 * top of the PREVIOUS domain's last strand label on a many-domain unified map.
 * `MapTreeCanvas` now positions each header adaptively (centred in whatever
 * pixel gap actually renders), and `DOMAIN_BAND_GAP` was widened from `1` so
 * that gap has real room to work with. This file locks down the pure layout
 * math those two fixes depend on: `laneYPcts` reserving a bigger boundary gap,
 * and the frontier line's rebranded "You are here" label (replacing the
 * scholar-facing "Current frontier" — Andy's no-deficit-framing rule: the
 * ruler labels CONTENT position, never the scholar).
 */
describe("laneYPcts — domain boundary gap (FTUE M6)", () => {
  it("DOMAIN_BAND_GAP is wider than a single ordinary lane step", () => {
    // The whole point of the constant: a domain boundary must reserve
    // MORE room than an ordinary same-domain lane-to-lane step (else a
    // multi-strand domain's header has no more breathing room than any
    // other row, which is exactly the M6 regression).
    expect(DOMAIN_BAND_GAP).toBeGreaterThan(1);
  });

  it("single-domain layouts are unaffected — uniform spacing, no boundaries", () => {
    const domains = ["fractions", "fractions", "fractions", "fractions"];
    const pcts = laneYPcts(domains);
    // Reduces to the plain uniform formula: 8 + (i/(n-1))*84.
    expect(pcts[0]).toBeCloseTo(8, 5);
    expect(pcts[pcts.length - 1]).toBeCloseTo(92, 5);
    const step = pcts[1] - pcts[0];
    for (let i = 2; i < pcts.length; i++) {
      expect(pcts[i] - pcts[i - 1]).toBeCloseTo(step, 5);
    }
  });

  it("a domain boundary step is wider than an ordinary same-domain step", () => {
    // 3 domains, 3 lanes each — one boundary between each pair of domains.
    const domains = [
      "whole-number-arithmetic", "whole-number-arithmetic", "whole-number-arithmetic",
      "fraction-arithmetic", "fraction-arithmetic", "fraction-arithmetic",
      "probability", "probability", "probability",
    ];
    const pcts = laneYPcts(domains);
    const ordinaryStep = pcts[1] - pcts[0]; // within whole-number-arithmetic
    const boundaryStep = pcts[3] - pcts[2]; // whole-number-arithmetic → fraction-arithmetic
    expect(boundaryStep).toBeGreaterThan(ordinaryStep);
    // Specifically wider by the gap constant's proportional contribution —
    // a boundary step spans (1 + DOMAIN_BAND_GAP) units vs. 1 ordinary unit.
    expect(boundaryStep / ordinaryStep).toBeCloseTo(1 + DOMAIN_BAND_GAP, 5);
  });

  it("stays within the shared [6, 94] clamp regardless of gap size", () => {
    const domains = ["a", "a", "b", "b", "c", "c", "d", "d"];
    const pcts = laneYPcts(domains, 50); // an extreme gap
    for (const p of pcts) {
      expect(p).toBeGreaterThanOrEqual(6);
      expect(p).toBeLessThanOrEqual(94);
    }
  });
});

describe("computeFrontierLines — 'You are here' label (FTUE M6)", () => {
  const DAY = 86_400_000;
  const NOW = 1_000 * DAY;
  const chain = [
    { skillKey: "a1", strand: "sA" },
    { skillKey: "a2", strand: "sA" },
    { skillKey: "a3", strand: "sA" },
  ];
  const chainEdges = [
    { fromKey: "a1", toKey: "a2" },
    { fromKey: "a2", toKey: "a3" },
  ];
  const { columnByKey, strands, maxColumn } = computeStrandColumns(chain, chainEdges);

  it("labels the current boundary 'You are here', never 'Current frontier'", () => {
    const rows = chain.map((n) => ({ ...n, repetition: 3, lastPracticedAt: NOW - 30 * DAY }));
    const lines = computeFrontierLines(rows, columnByKey, strands, maxColumn, NOW, 3);
    const current = lines.find((l) => l.key === "current")!;
    expect(current).toBeDefined();
    // Andy's no-deficit-framing rule: the ruler labels CONTENT position
    // ("you are here" on the map), never a judgment about the scholar
    // ("frontier" reads as jargon-adjacent to a teacher, opaque to a kid).
    expect(current.label).toBe("You are here");
    expect(current.label).not.toMatch(/frontier/i);
  });
});
