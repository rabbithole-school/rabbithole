import { describe, expect, test } from "vitest";
import { rubricTelegraphingStats } from "../lib/rubricTelegraphingStats";

describe("rubricTelegraphingStats", () => {
  test("empty array — nothing scored", () => {
    expect(rubricTelegraphingStats([])).toEqual({
      scoredTurns: 0,
      violations: 0,
      violationRate: null,
      mean: null,
    });
  });

  test("all-null array — same as empty (nothing scored)", () => {
    expect(rubricTelegraphingStats([null, null, null])).toEqual({
      scoredTurns: 0,
      violations: 0,
      violationRate: null,
      mean: null,
    });
  });

  test("a mix of nulls and numbers", () => {
    const stats = rubricTelegraphingStats([null, 5, 2, null, 1, 4]);
    expect(stats.scoredTurns).toBe(4);
    expect(stats.violations).toBe(2); // the 2 and the 1
    expect(stats.violationRate).toBe(0.5);
    expect(stats.mean).toBeCloseTo(3); // (5 + 2 + 1 + 4) / 4
  });

  test("custom violationThreshold", () => {
    const stats = rubricTelegraphingStats([3, 4, 5], 3);
    expect(stats.scoredTurns).toBe(3);
    expect(stats.violations).toBe(1); // only the 3 qualifies as <= 3
    expect(stats.violationRate).toBeCloseTo(1 / 3);
  });
});
