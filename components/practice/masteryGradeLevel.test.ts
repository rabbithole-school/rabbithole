import { describe, expect, it } from "vitest";
import {
  averageDomainMasteryLevel,
  formatMasteryGradeLevel,
  gradeLabelForRank,
  levelFromGradeBuckets,
  masteryGradeLevel,
  type GradeLevelNode,
} from "./masteryGradeLevel";

// Mirrors GRADE_RANK in MathSkillsMasteryView.tsx (K=0, 1=1, …, 8=8; unknown/
// ungraded → -1). Kept local so this test doesn't import the (heavy, "use
// client") component file — the module under test is dependency-free and
// should be tested that way.
const GRADE_RANK: Record<string, number> = {
  K: 0, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8,
};
function gradeRank(grade: string | null): number {
  if (grade == null) return -1;
  return GRADE_RANK[grade] ?? -1;
}

function nodesOf(spec: Record<string, [green: number, total: number]>): {
  nodes: GradeLevelNode[];
  isGreen: (nodeKey: string) => boolean;
} {
  const nodes: GradeLevelNode[] = [];
  const greenKeys = new Set<string>();
  for (const [grade, [green, total]] of Object.entries(spec)) {
    for (let i = 0; i < total; i++) {
      const nodeKey = `${grade}-${i}`;
      nodes.push({ nodeKey, grade });
      if (i < green) greenKeys.add(nodeKey);
    }
  }
  return { nodes, isGreen: (nodeKey) => greenKeys.has(nodeKey) };
}

describe("masteryGradeLevel", () => {
  it("returns null when nothing is green", () => {
    const { nodes, isGreen } = nodesOf({ K: [0, 3], "1": [0, 2] });
    expect(masteryGradeLevel(nodes, isGreen, gradeRank)).toBeNull();
    expect(formatMasteryGradeLevel(null)).toBe("—");
  });

  it("returns null when there are no graded nodes at all (only ungraded)", () => {
    const nodes: GradeLevelNode[] = [
      { nodeKey: "a", grade: null },
      { nodeKey: "b", grade: undefined },
    ];
    expect(masteryGradeLevel(nodes, () => true, gradeRank)).toBeNull();
  });

  it("caps at the top grade when every present grade is fully green", () => {
    const { nodes, isGreen } = nodesOf({ K: [3, 3], "1": [2, 2], "2": [4, 4] });
    const level = masteryGradeLevel(nodes, isGreen, gradeRank);
    expect(level).toBe(2);
    // An exact cap still shows one decimal (never a bare "2"), and no "Grade "
    // prefix — the readout is a mastery level, not a chronological grade.
    expect(formatMasteryGradeLevel(level)).toBe("2.0");
  });

  it("computes the canonical 3.6 case: fully green through grade 3, 60% of grade 4", () => {
    const { nodes, isGreen } = nodesOf({
      K: [2, 2],
      "1": [3, 3],
      "2": [4, 4],
      "3": [5, 5],
      "4": [3, 5], // 60% green
      "5": [1, 4], // beyond the frontier — must not leak in
    });
    const level = masteryGradeLevel(nodes, isGreen, gradeRank);
    expect(level).toBeCloseTo(3.6, 10);
    expect(formatMasteryGradeLevel(level)).toBe("3.6");
  });

  it("holds the level at the earliest incomplete grade even if a later grade is fully green", () => {
    // Grade 2 has a gap; grade 5 is fully green. The floor must stay anchored
    // at grade 1 (the last fully-green grade) plus grade 2's fraction — it
    // must NOT leap to a higher grade off the later island of full mastery.
    const { nodes, isGreen } = nodesOf({
      K: [2, 2],
      "1": [2, 2],
      "2": [3, 5], // 60% — the frontier
      "5": [4, 4], // fully green but irrelevant — later, and not contiguous
    });
    const level = masteryGradeLevel(nodes, isGreen, gradeRank);
    expect(level).toBeCloseTo(1.6, 10);
  });

  it("interpolates within grade K alone when K itself is not fully green", () => {
    const { nodes, isGreen } = nodesOf({ K: [2, 5] }); // 40% green
    const level = masteryGradeLevel(nodes, isGreen, gradeRank);
    expect(level).toBeCloseTo(0.4, 10);
    // K is level 0.x — rendered as a bare one-decimal number like every other
    // rung (no "Grade K" special case), so the readout column stays uniform.
    expect(formatMasteryGradeLevel(level)).toBe("0.4");
  });

  it("excludes ungraded/foundational nodes from the level", () => {
    const { nodes, isGreen } = nodesOf({ K: [2, 2], "1": [3, 5] });
    nodes.push({ nodeKey: "foundational-1", grade: null });
    const withUngraded = masteryGradeLevel(
      nodes,
      (key) => isGreen(key) || key === "foundational-1",
      gradeRank,
    );
    const withoutUngraded = masteryGradeLevel(
      nodes.filter((n) => n.grade != null),
      isGreen,
      gradeRank,
    );
    expect(withUngraded).toBe(withoutUngraded);
    expect(withUngraded).toBeCloseTo(0.6, 10);
  });

  it("is monotonic: turning one more skill green never lowers the level", () => {
    const before = nodesOf({ K: [2, 2], "1": [2, 5] });
    const beforeLevel = masteryGradeLevel(before.nodes, before.isGreen, gradeRank)!;
    const after = nodesOf({ K: [2, 2], "1": [3, 5] });
    const afterLevel = masteryGradeLevel(after.nodes, after.isGreen, gradeRank)!;
    expect(afterLevel).toBeGreaterThan(beforeLevel);
  });

  it("levelFromGradeBuckets powers the same formula from pre-aggregated counts (e.g. a cross-domain rollup)", () => {
    const level = levelFromGradeBuckets(
      [
        { grade: "K", total: 2, green: 2 },
        { grade: "1", total: 3, green: 3 },
        { grade: "2", total: 5, green: 3 },
      ],
      gradeRank,
    );
    expect(level).toBeCloseTo(1.6, 10);
  });

  it("gradeLabelForRank maps rank 0 to the letter K and every other rank to its own number", () => {
    expect(gradeLabelForRank(0)).toBe("K");
    expect(gradeLabelForRank(3)).toBe("3");
    expect(gradeLabelForRank(8)).toBe("8");
  });
});

describe("averageDomainMasteryLevel (the 'All domains' readout)", () => {
  it("averages each domain's own frontier level", () => {
    // Domain A: K & 1 fully green, 60% of grade 2 → base 1 + 0.6 = 1.6.
    // Domain B: K fully green, 90% of grade 1 → base 0 + 0.9 = 0.9.
    const level = averageDomainMasteryLevel(
      [
        {
          domain: "a",
          gradeCounts: [
            { grade: "K", total: 2, green: 2 },
            { grade: "1", total: 3, green: 3 },
            { grade: "2", total: 5, green: 3 },
          ],
        },
        {
          domain: "b",
          gradeCounts: [
            { grade: "K", total: 4, green: 4 },
            { grade: "1", total: 10, green: 9 },
          ],
        },
      ],
      gradeRank,
    );
    expect(level).toBeCloseTo((1.6 + 0.9) / 2, 10);
  });

  it("ignores domains the scholar hasn't started (no green), so breadth never drags the level toward zero", () => {
    const level = averageDomainMasteryLevel(
      [
        {
          domain: "started",
          gradeCounts: [
            { grade: "K", total: 2, green: 2 },
            { grade: "1", total: 4, green: 2 }, // K green + half of grade 1 → 0.5
          ],
        },
        // Untouched domains: real curriculum, zero green → null, excluded.
        { domain: "untouched-a", gradeCounts: [{ grade: "K", total: 6, green: 0 }] },
        { domain: "untouched-b", gradeCounts: [{ grade: "3", total: 8, green: 0 }] },
      ],
      gradeRank,
    );
    // Only the started domain counts — not diluted toward 0 by the two blanks.
    expect(level).toBeCloseTo(0.5, 10);
  });

  it("returns null when no domain has any green skill", () => {
    const level = averageDomainMasteryLevel(
      [
        { domain: "a", gradeCounts: [{ grade: "K", total: 3, green: 0 }] },
        { domain: "b", gradeCounts: [{ grade: "1", total: 5, green: 0 }] },
      ],
      gradeRank,
    );
    expect(level).toBeNull();
  });

  it("stays with the domain a scholar actually works in — pooling every domain into one bucket set collapses far below it (the reported bug)", () => {
    // Strong through grade 3 in one domain, and blank in another that still has
    // a full K–3 curriculum — exactly the shape that produced "< 1.0 for All
    // domains even though the scholar is grade 3 in a domain".
    const strong = {
      domain: "strong",
      gradeCounts: [
        { grade: "K", total: 2, green: 2 },
        { grade: "1", total: 2, green: 2 },
        { grade: "2", total: 2, green: 2 },
        { grade: "3", total: 2, green: 2 },
      ],
    };
    const blank = {
      domain: "blank",
      gradeCounts: [
        { grade: "K", total: 5, green: 0 },
        { grade: "1", total: 5, green: 0 },
        { grade: "2", total: 5, green: 0 },
        { grade: "3", total: 5, green: 0 },
      ],
    };
    const strongLevel = levelFromGradeBuckets(strong.gradeCounts, gradeRank)!;
    expect(strongLevel).toBeCloseTo(3, 10); // fully green through grade 3

    // "All domains" reflects the domain the scholar actually works in (the
    // blank one is null, so it's left out of the mean).
    const averaged = averageDomainMasteryLevel([strong, blank], gradeRank)!;
    expect(averaged).toBeCloseTo(3, 10);

    // The OLD pooled approach: one bucket set across BOTH domains. The blank
    // domain's hole at grade K pins the floor at K forever, so the number
    // collapses below 1.0 — far under the scholar's real 3.0.
    const pooled = levelFromGradeBuckets(
      [
        { grade: "K", total: 7, green: 2 },
        { grade: "1", total: 7, green: 2 },
        { grade: "2", total: 7, green: 2 },
        { grade: "3", total: 7, green: 2 },
      ],
      gradeRank,
    )!;
    expect(pooled).toBeLessThan(1);
    expect(averaged).toBeGreaterThan(pooled);
  });
});
