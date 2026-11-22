import { describe, expect, it } from "vitest";
import { factGridAxes, factGridCellValid } from "./factHeatmapGrid";

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

describe("factGridAxes", () => {
  // Addition facts within 20, stored canonically (a ≤ b), as fastMath emits them.
  const addWithin20 = [] as { a: number; b: number }[];
  for (let a = 0; a <= 20; a++) for (let b = a; a + b <= 20; b++) addWithin20.push({ a, b });

  it("drops addition rows that can never hold a drawn cell", () => {
    const { rows, cols } = factGridAxes("add", addWithin20);
    expect(rows).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(cols[cols.length - 1]).toBe(20); // 0 + 20 still has its column
  });

  it("keeps every subtraction row and column that holds a fact", () => {
    const facts = [
      { a: 5, b: 5 },
      { a: 12, b: 4 },
    ];
    expect(factGridAxes("sub", facts)).toEqual({ rows: [5, 12], cols: [4, 5] });
  });
});
