import { describe, it, expect } from "vitest";
import { computeStrandColumns, leadingFrontierPerStrand, computeFrontierLines, laneStrand, splitLaneStrand } from "../treeMapLayout";
import {
  WHOLE_NUMBER_ARITHMETIC_SKILLS,
  WHOLE_NUMBER_ARITHMETIC_EDGES,
} from "@/convex/seed/wholeNumberArithmeticGraph";

const nodes = WHOLE_NUMBER_ARITHMETIC_SKILLS.map((s) => ({
  skillKey: s.skillKey,
  strand: s.strand,
}));
const edges = WHOLE_NUMBER_ARITHMETIC_EDGES;

describe("computeStrandColumns (real whole-number-arithmetic graph)", () => {
  const { columnByKey, strands, laneByKey, maxColumn } = computeStrandColumns(nodes, edges);

  it("assigns a column to every node", () => {
    expect(columnByKey.size).toBe(nodes.length);
    expect(maxColumn).toBeGreaterThan(0);
  });

  it("has ZERO backwards edges — every prerequisite is strictly left", () => {
    const backwards = edges.filter(
      (e) => !((columnByKey.get(e.fromKey) ?? 0) < (columnByKey.get(e.toKey) ?? 0)),
    );
    expect(backwards).toEqual([]);
  });

  it("places counting leftmost and number-theory rightmost (basic → advanced)", () => {
    const minCol: Record<string, number> = {};
    for (const n of nodes) {
      const c = columnByKey.get(n.skillKey)!;
      minCol[n.strand] = minCol[n.strand] === undefined ? c : Math.min(minCol[n.strand], c);
    }
    // counting is the foundation → starts at column 0.
    expect(minCol["counting"]).toBe(0);
    // number-theory depends deep in mult-divide → starts furthest right.
    const others = Object.entries(minCol).filter(([s]) => s !== "number-theory");
    for (const [, c] of others) {
      expect(minCol["number-theory"]).toBeGreaterThan(c);
    }
    // strands are ordered basic → advanced, counting first.
    expect(strands[0]).toBe("counting");
    expect(strands[strands.length - 1]).toBe("number-theory");
  });

  it("keeps one node per column within a strand (no pile-up)", () => {
    const seen = new Map<string, Set<number>>(); // strand → columns used
    const strandOf = new Map(nodes.map((n) => [n.skillKey, n.strand]));
    for (const [key, col] of columnByKey) {
      const s = strandOf.get(key)!;
      const cols = seen.get(s) ?? new Set<number>();
      expect(cols.has(col)).toBe(false); // no two same-strand nodes share a column
      cols.add(col);
      seen.set(s, cols);
    }
  });

  it("assigns a lane index per strand, 0-based and contiguous", () => {
    const lanes = new Set([...laneByKey.values()]);
    expect(lanes.size).toBe(strands.length);
    expect(Math.min(...lanes)).toBe(0);
    expect(Math.max(...lanes)).toBe(strands.length - 1);
  });
});

describe("leadingFrontierPerStrand", () => {
  const { columnByKey } = computeStrandColumns(nodes, edges);

  it("returns at most one node per strand — the earliest frontier one", () => {
    // Mark a couple of nodes per strand as 'frontier'; expect the lower-column one.
    const frontier = new Set(nodes.map((n) => n.skillKey)); // pretend all are frontier
    const leading = leadingFrontierPerStrand(nodes, columnByKey, (k) => frontier.has(k));
    const strandOf = new Map(nodes.map((n) => [n.skillKey, n.strand]));
    const perStrand = new Map<string, string>();
    for (const k of leading) {
      const s = strandOf.get(k)!;
      expect(perStrand.has(s)).toBe(false); // at most one per strand
      perStrand.set(s, k);
    }
    // each leading key is the min-column node of its strand
    for (const [s, k] of perStrand) {
      const strandCols = nodes
        .filter((n) => n.strand === s)
        .map((n) => columnByKey.get(n.skillKey)!);
      expect(columnByKey.get(k)!).toBe(Math.min(...strandCols));
    }
  });

  it("a strand with no frontier node contributes nothing", () => {
    const leading = leadingFrontierPerStrand(nodes, columnByKey, () => false);
    expect(leading.size).toBe(0);
  });
});

describe("computeFrontierLines", () => {
  const DAY = 86_400_000;
  const NOW = 1_000 * DAY;
  // A single strand chain a1 → a2 → a3 (columns 0,1,2; one lane).
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

  it("falls back to lastPracticedAt for unstamped placement/accelerated fluency", () => {
    // Everything credited long ago without a transition stamp:
    // current == yesterday == weekAgo.
    const master = chain.map((n) => ({ ...n, repetition: 3, lastPracticedAt: NOW - 30 * DAY }));
    const lines = computeFrontierLines(master, columnByKey, strands, maxColumn, NOW, 3);
    expect(lines.map((l) => l.key)).toEqual(["current"]);
  });

  it("ghosts a past line when the frontier advanced, to the LEFT of current", () => {
    const rows = [
      { skillKey: "a1", strand: "sA", repetition: 3, lastPracticedAt: NOW - 10 * DAY }, // mastered long ago
      { skillKey: "a2", strand: "sA", repetition: 3, lastPracticedAt: NOW },             // mastered TODAY
      { skillKey: "a3", strand: "sA", repetition: 0, lastPracticedAt: null },            // not yet
    ];
    const lines = computeFrontierLines(rows, columnByKey, strands, maxColumn, NOW, 3);
    const current = lines.find((l) => l.key === "current")!;
    const weekAgo = lines.find((l) => l.key === "weekAgo")!;
    expect(current).toBeDefined();
    expect(weekAgo).toBeDefined();
    // The frontier moved RIGHT over the week → the week-ago ghost sits to the LEFT.
    expect(current.points[0].xPct).toBeGreaterThan(weekAgo.points[0].xPct);
  });

  it("uses becameFluentAt so a recent review does not erase historical fluency", () => {
    const rows = [
      {
        skillKey: "a1",
        strand: "sA",
        repetition: 3,
        becameFluentAt: NOW - 10 * DAY,
        lastPracticedAt: NOW,
      },
      { skillKey: "a2", strand: "sA", repetition: 0, lastPracticedAt: null },
      { skillKey: "a3", strand: "sA", repetition: 0, lastPracticedAt: null },
    ];
    const lines = computeFrontierLines(rows, columnByKey, strands, maxColumn, NOW, 3);
    expect(lines.map((line) => line.key)).toEqual(["current"]);
  });

  it("keeps the live current line on repetition even without a history timestamp", () => {
    const rows = [
      { skillKey: "a1", strand: "sA", repetition: 3, lastPracticedAt: null },
      { skillKey: "a2", strand: "sA", repetition: 0, lastPracticedAt: null },
      { skillKey: "a3", strand: "sA", repetition: 0, lastPracticedAt: null },
    ];
    const lines = computeFrontierLines(rows, columnByKey, strands, maxColumn, NOW, 3);
    const current = lines.find((line) => line.key === "current")!;
    const weekAgo = lines.find((line) => line.key === "weekAgo")!;
    expect(current.points[0].xPct).toBeGreaterThan(weekAgo.points[0].xPct);
  });

  it("returns one point per non-empty lane, ordered top→bottom", () => {
    const twoLane = [
      { skillKey: "a1", strand: "sA", repetition: 3, lastPracticedAt: NOW - 30 * DAY },
      { skillKey: "a2", strand: "sA", repetition: 0, lastPracticedAt: null },
      { skillKey: "b1", strand: "sB", repetition: 0, lastPracticedAt: null },
    ];
    const layout = computeStrandColumns(
      twoLane.map((n) => ({ skillKey: n.skillKey, strand: n.strand })),
      [{ fromKey: "a1", toKey: "a2" }],
    );
    const lines = computeFrontierLines(twoLane, layout.columnByKey, layout.strands, layout.maxColumn, NOW, 3);
    const current = lines.find((l) => l.key === "current")!;
    expect(current.points).toHaveLength(2); // one per lane
    // ordered by lane → ascending yPct
    expect(current.points[0].yPct).toBeLessThan(current.points[1].yPct);
  });

  it("draws a clean vertical when NO lane is partial (advanced strand doesn't yank it right)", () => {
    // Both lanes fully un-mastered; lane B is an "advanced" strand whose columns
    // are pushed far right by the layout. The frontier should be ONE vertical near
    // the left, not a jump to B's far-right start.
    const rows = [
      { skillKey: "a1", strand: "sA", repetition: 0, lastPracticedAt: null },
      { skillKey: "a2", strand: "sA", repetition: 0, lastPracticedAt: null },
      { skillKey: "b1", strand: "sB", repetition: 0, lastPracticedAt: null },
      { skillKey: "b2", strand: "sB", repetition: 0, lastPracticedAt: null },
    ];
    const layout = computeStrandColumns(
      rows.map((n) => ({ skillKey: n.skillKey, strand: n.strand })),
      [
        { fromKey: "a1", toKey: "a2" },
        { fromKey: "a2", toKey: "b1" }, // sB starts after all of sA → far right
        { fromKey: "b1", toKey: "b2" },
      ],
    );
    const lines = computeFrontierLines(rows, layout.columnByKey, layout.strands, layout.maxColumn, NOW, 3);
    const current = lines.find((l) => l.key === "current")!;
    expect(current.points).toHaveLength(2);
    // one clean vertical: both lanes share an x (no jump to the advanced strand)
    expect(Math.abs(current.points[0].xPct - current.points[1].xPct)).toBeLessThan(0.01);
  });

  it("does NOT bend to hug a fully-green lane — it runs straight past it", () => {
    // Lane A (top): short + fully mastered. Lane B (bottom): a long partial lane
    // whose frontier is far to the right. The line should run VERTICALLY (A's x
    // ≈ B's frontier x), not detour left to hug A's right edge.
    const rows = [
      { skillKey: "a1", strand: "sA", repetition: 3, lastPracticedAt: NOW - 30 * DAY },
      { skillKey: "a2", strand: "sA", repetition: 3, lastPracticedAt: NOW - 30 * DAY },
      ...["b1", "b2", "b3", "b4", "b5", "b6"].map((k) => ({ skillKey: k, strand: "sB", repetition: 3, lastPracticedAt: NOW - 30 * DAY })),
      { skillKey: "b7", strand: "sB", repetition: 0, lastPracticedAt: null },
    ];
    const layout = computeStrandColumns(
      rows.map((n) => ({ skillKey: n.skillKey, strand: n.strand })),
      [
        { fromKey: "a1", toKey: "a2" },
        { fromKey: "b1", toKey: "b2" }, { fromKey: "b2", toKey: "b3" }, { fromKey: "b3", toKey: "b4" },
        { fromKey: "b4", toKey: "b5" }, { fromKey: "b5", toKey: "b6" }, { fromKey: "b6", toKey: "b7" },
      ],
    );
    const lines = computeFrontierLines(rows, layout.columnByKey, layout.strands, layout.maxColumn, NOW, 3);
    const current = lines.find((l) => l.key === "current")!;
    // two lanes → two points; the fully-green lane's x tracks the partial lane's
    // frontier (near-vertical), rather than sitting at A's own right edge.
    expect(Math.abs(current.points[0].xPct - current.points[1].xPct)).toBeLessThan(1);
  });
});

describe("computeStrandColumns — unified multi-domain lane grouping", () => {
  // Two domains, each with two strands; domain B's strand names COLLIDE with A's
  // ("concept"/"ops" in both) to prove lanes are keyed by (domain, strand), not
  // by the display strand alone.
  const mk = (domain: string, strand: string, key: string) => ({
    skillKey: key,
    strand: laneStrand(domain, strand),
  });
  const nodes = [
    mk("A", "concept", "a1"), mk("A", "ops", "a2"),
    mk("B", "concept", "b1"), mk("B", "ops", "b2"),
  ];
  const edges = [
    { fromKey: "a1", toKey: "a2" },
    { fromKey: "b1", toKey: "b2" },
  ];
  const opts = {
    groupKeyOf: (s: string) => splitLaneStrand(s).domain,
    groupOrder: ["A", "B"],
  };

  it("gives each (domain, strand) its own lane even when strand names collide", () => {
    const { strands } = computeStrandColumns(nodes, edges, opts);
    expect(strands.length).toBe(4); // A/concept, A/ops, B/concept, B/ops
  });

  it("groups lanes by domain into contiguous bands, in groupOrder (A above B)", () => {
    const { laneByKey } = computeStrandColumns(nodes, edges, opts);
    const lane = (k: string) => laneByKey.get(k)!;
    // Every A-lane sits strictly above every B-lane → one A band, then a B band.
    expect(Math.max(lane("a1"), lane("a2"))).toBeLessThan(Math.min(lane("b1"), lane("b2")));
  });

  it("honors groupOrder — reversing it puts B's band first", () => {
    const { laneByKey } = computeStrandColumns(nodes, edges, {
      ...opts,
      groupOrder: ["B", "A"],
    });
    const lane = (k: string) => laneByKey.get(k)!;
    expect(Math.max(lane("b1"), lane("b2"))).toBeLessThan(Math.min(lane("a1"), lane("a2")));
  });
});
