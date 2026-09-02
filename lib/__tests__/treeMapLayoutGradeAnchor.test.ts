import { describe, it, expect } from "vitest";
import {
  computeStrandColumns,
  computeGradeRuler,
  gradeRank,
  GRADE_ORDER,
  GRADE_COLUMN_WIDTH,
  laneStrand,
  splitLaneStrand,
  type TreeNode,
  type TreeEdgeVM,
} from "../treeMapLayout";
import {
  WHOLE_NUMBER_ARITHMETIC_DOMAIN,
  WHOLE_NUMBER_ARITHMETIC_SKILLS,
  WHOLE_NUMBER_ARITHMETIC_EDGES,
} from "@/convex/seed/wholeNumberArithmeticGraph";
import {
  EARLY_ALGEBRA_DOMAIN,
  EARLY_ALGEBRA_SKILLS,
  EARLY_ALGEBRA_EDGES,
} from "@/convex/seed/earlyAlgebraGraph";

/**
 * Grade-anchored x-axis (Andy, 2026-07-13): the Tree Map presented every
 * domain's roots at column 0 regardless of authored grade, so "Count to 10 by
 * ones" (K) sat directly under "Generate terms from a stated number pattern
 * rule" (early-algebra, grade 4). These tests cover the fix in
 * `../treeMapLayout` — computeStrandColumns' grade-floor term, the missing-
 * grade fallback, within-band topological ordering, and the new
 * `computeGradeRuler` derivation — using a NEW file (this branch doesn't own
 * `treeMapLayout.test.ts`).
 */

describe("gradeRank / GRADE_ORDER", () => {
  it("ranks K..9 in order, 0-based", () => {
    expect(GRADE_ORDER).toEqual(["K", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    expect(gradeRank("K")).toBe(0);
    expect(gradeRank("1")).toBe(1);
    expect(gradeRank("4")).toBe(4);
    expect(gradeRank("8")).toBe(8);
    expect(gradeRank("9")).toBe(9);
  });

  it("returns -1 for missing or unrecognized grades (no anchor)", () => {
    expect(gradeRank(undefined)).toBe(-1);
    expect(gradeRank(null)).toBe(-1);
    expect(gradeRank("")).toBe(-1);
    expect(gradeRank("10")).toBe(-1);
    expect(gradeRank("kindergarten")).toBe(-1);
  });
});

describe("computeStrandColumns — grade anchoring (synthetic)", () => {
  it("anchors a grade-4 root's column to the grade-4 floor, strictly right of a grade-K root", () => {
    // Two independent single-node strands — no shared edges, so without grade
    // anchoring BOTH roots would land at column 0 (the exact bug).
    const nodes = [
      { skillKey: "k_root", strand: "sK", grade: "K" },
      { skillKey: "g4_root", strand: "sG4", grade: "4" },
    ];
    const { columnByKey } = computeStrandColumns(nodes, []);
    expect(columnByKey.get("k_root")).toBe(0);
    expect(columnByKey.get("g4_root")).toBe(4 * GRADE_COLUMN_WIDTH);
    expect(columnByKey.get("g4_root")!).toBeGreaterThan(columnByKey.get("k_root")!);
  });

  it("is a FLOOR only — never pulls a node's column back below what topology already requires", () => {
    // A long grade-K chain whose natural (topological) length already exceeds
    // the grade-1 floor; the next grade-1 node must NOT be pulled backward.
    const chainLen = GRADE_COLUMN_WIDTH + 5; // organically longer than one grade band
    const nodes: { skillKey: string; strand: string; grade: string }[] = [];
    const edges: { fromKey: string; toKey: string }[] = [];
    for (let i = 0; i < chainLen; i++) {
      nodes.push({ skillKey: `k${i}`, strand: "sK", grade: "K" });
      if (i > 0) edges.push({ fromKey: `k${i - 1}`, toKey: `k${i}` });
    }
    nodes.push({ skillKey: "g1_after", strand: "sK", grade: "1" });
    edges.push({ fromKey: `k${chainLen - 1}`, toKey: "g1_after" });
    const { columnByKey } = computeStrandColumns(nodes, edges);
    // The grade-1 node's prerequisite chain already put it past the grade-1
    // floor — its column must be exactly prereq+1, not clamped down to the floor.
    expect(columnByKey.get("g1_after")).toBe(chainLen);
    expect(columnByKey.get("g1_after")!).toBeGreaterThan(1 * GRADE_COLUMN_WIDTH);
  });

  it("fallback: an ungraded node's OWN column contribution is a no-op regardless of what tag it's given", () => {
    // a1/a3 keep REAL grades in both variants (so their columns are identical
    // across variants); only a2's own grade tag varies — its resulting column
    // must be unaffected either way, since a missing/unrecognized grade never
    // contributes an anchor (falls back to pure prerequisite/strand chaining).
    const edges = [
      { fromKey: "a1", toKey: "a2" },
      { fromKey: "a2", toKey: "a3" },
    ];
    const noGradeField = [
      { skillKey: "a1", strand: "s", grade: "3" },
      { skillKey: "a2", strand: "s" }, // grade omitted entirely
      { skillKey: "a3", strand: "s", grade: "5" },
    ];
    const unrecognizedGrade = [
      { skillKey: "a1", strand: "s", grade: "3" },
      { skillKey: "a2", strand: "s", grade: "not-a-real-grade" },
      { skillKey: "a3", strand: "s", grade: "5" },
    ];
    const a = computeStrandColumns(noGradeField, edges);
    const b = computeStrandColumns(unrecognizedGrade, edges);
    expect(a.columnByKey.get("a2")).toBe(b.columnByKey.get("a2"));
    // And it's exactly the pure topological requirement — one past its
    // prerequisite (a1, anchored at the grade-3 floor) — no extra anchor bump.
    expect(a.columnByKey.get("a2")).toBe(3 * GRADE_COLUMN_WIDTH + 1);
  });

  it("does not crash on an empty node set", () => {
    expect(() => computeStrandColumns([], [])).not.toThrow();
    const { columnByKey, maxColumn } = computeStrandColumns([], []);
    expect(columnByKey.size).toBe(0);
    expect(maxColumn).toBe(0);
  });

  it("within-band ordering: same-grade chain nodes keep their topological order, offset by the floor", () => {
    // Three grade-"2" nodes chained a1→a2→a3 in one strand.
    const nodes = [
      { skillKey: "a1", strand: "s", grade: "2" },
      { skillKey: "a2", strand: "s", grade: "2" },
      { skillKey: "a3", strand: "s", grade: "2" },
    ];
    const edges = [
      { fromKey: "a1", toKey: "a2" },
      { fromKey: "a2", toKey: "a3" },
    ];
    const { columnByKey } = computeStrandColumns(nodes, edges);
    const floor = 2 * GRADE_COLUMN_WIDTH;
    expect(columnByKey.get("a1")).toBe(floor);
    expect(columnByKey.get("a2")).toBe(floor + 1);
    expect(columnByKey.get("a3")).toBe(floor + 2);
  });

  it("zero backwards edges holds even when grade tags are inconsistent with topology", () => {
    // A deliberately "wrong" grade (b1 tagged grade K despite depending on a
    // grade-6 prerequisite) must never let the anchor pull b1 LEFT of a1.
    const nodes = [
      { skillKey: "a1", strand: "sA", grade: "6" },
      { skillKey: "b1", strand: "sB", grade: "K" },
    ];
    const edges = [{ fromKey: "a1", toKey: "b1" }];
    const { columnByKey } = computeStrandColumns(nodes, edges);
    expect(columnByKey.get("b1")!).toBeGreaterThan(columnByKey.get("a1")!);
  });
});

describe("computeStrandColumns — grade anchoring (real graphs, the regression case)", () => {
  const domainOrder = [WHOLE_NUMBER_ARITHMETIC_DOMAIN, EARLY_ALGEBRA_DOMAIN];
  const skills = [
    ...WHOLE_NUMBER_ARITHMETIC_SKILLS.map((s) => ({ ...s, domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN })),
    ...EARLY_ALGEBRA_SKILLS.map((s) => ({ ...s, domain: EARLY_ALGEBRA_DOMAIN })),
  ];
  const edges = [...WHOLE_NUMBER_ARITHMETIC_EDGES, ...EARLY_ALGEBRA_EDGES];
  const layoutNodes = skills.map((s) => ({
    skillKey: s.skillKey,
    strand: laneStrand(s.domain, s.strand),
    grade: s.grade,
  }));
  const { columnByKey } = computeStrandColumns(layoutNodes, edges, {
    groupKeyOf: (s) => splitLaneStrand(s).domain,
    groupOrder: domainOrder,
  });

  it('"Count to 10 by ones" (K) no longer aligns with the grade-4 early-algebra root', () => {
    const countTo10 = columnByKey.get("count_to_10")!;
    const patternRule = columnByKey.get("pattern_rule_sequence")!; // early-algebra's grade-4 root
    expect(countTo10).toBe(0);
    // A full grade band of runway must separate them (was: both at column 0).
    expect(patternRule - countTo10).toBeGreaterThanOrEqual(GRADE_COLUMN_WIDTH);
  });

  it("has ZERO backwards edges across the unified two-domain graph", () => {
    const backwards = edges.filter(
      (e) => !((columnByKey.get(e.fromKey) ?? 0) < (columnByKey.get(e.toKey) ?? 0)),
    );
    expect(backwards).toEqual([]);
  });
});

describe("computeGradeRuler", () => {
  const mkNode = (skillKey: string, grade: string | null, strand = "s"): TreeNode => ({
    skillKey,
    label: skillKey,
    domain: "d",
    strand,
    grade,
    repetition: 0,
    proficiency: "not_started",
    retention: "none",
    frontier: false,
  });

  it("emits one tick per grade PRESENT, in K..9 order, with strictly increasing xPct", () => {
    const tree = {
      nodes: [mkNode("a", "4", "sA"), mkNode("b", "K", "sB"), mkNode("c", "2", "sC")],
      edges: [] as TreeEdgeVM[],
    };
    const ruler = computeGradeRuler(tree);
    expect(ruler.map((t) => t.grade)).toEqual(["K", "2", "4"]);
    for (let i = 1; i < ruler.length; i++) {
      expect(ruler[i].xPct).toBeGreaterThan(ruler[i - 1].xPct);
    }
  });

  it("omits grades with no nodes and skips ungraded nodes entirely", () => {
    const tree = {
      nodes: [mkNode("a", "3"), mkNode("b", null), mkNode("c", "3")],
      edges: [] as TreeEdgeVM[],
    };
    const ruler = computeGradeRuler(tree);
    expect(ruler.map((t) => t.grade)).toEqual(["3"]);
  });

  it("returns an empty ruler (no crash) when no node has a grade", () => {
    const tree = { nodes: [mkNode("a", null), mkNode("b", undefined as unknown as null)], edges: [] as TreeEdgeVM[] };
    expect(() => computeGradeRuler(tree)).not.toThrow();
    expect(computeGradeRuler(tree)).toEqual([]);
  });

  it("returns an empty ruler (no crash) for an empty tree", () => {
    expect(computeGradeRuler({ nodes: [], edges: [] })).toEqual([]);
  });

  it("anchors each tick to its grade band's leading (minimum) column", () => {
    // sA: aK(K) → a1(1) → a2(2); sB: a4(4) alone. a4 should anchor at the
    // grade-4 floor since it has no prerequisite pushing it further.
    const tree = {
      nodes: [mkNode("aK", "K", "sA"), mkNode("a1", "1", "sA"), mkNode("a2", "2", "sA"), mkNode("a4", "4", "sB")],
      edges: [
        { fromKey: "aK", toKey: "a1" },
        { fromKey: "a1", toKey: "a2" },
      ],
    };
    const ruler = computeGradeRuler(tree);
    const byGrade = new Map(ruler.map((t) => [t.grade, t.xPct]));
    expect(byGrade.get("K")).toBeLessThan(byGrade.get("1")!);
    expect(byGrade.get("1")).toBeLessThan(byGrade.get("2")!);
    expect(byGrade.get("2")).toBeLessThan(byGrade.get("4")!);
  });
});
