import { describe, expect, it } from "vitest";
import { factGridCellValid } from "./factHeatmapGrid";

describe("factGridCellValid", () => {
  it("keeps one canonical half of each commutative grid", () => {
    for (const op of ["add", "mul"] as const) {
      expect(factGridCellValid(op, 3, 7)).toBe(true);
      expect(factGridCellValid(op, 7, 3)).toBe(false);
      expect(factGridCellValid(op, 5, 5)).toBe(true);
    }
  });

  it("keeps subtraction cells where minuend ≥ subtrahend, INCLUDING n − n", () => {
    // The sub generators emit `b === a` (e.g. 5 − 5), so the diagonal is a real
    // practiced fact — the old `row > col` rule rendered it blank.
    expect(factGridCellValid("sub", 5, 5)).toBe(true);
    expect(factGridCellValid("sub", 12, 4)).toBe(true);
  });

  it("drops subtraction cells where the minuend is smaller (impossible)", () => {
    expect(factGridCellValid("sub", 4, 9)).toBe(false);
    expect(factGridCellValid("sub", 0, 1)).toBe(false);
  });
});
