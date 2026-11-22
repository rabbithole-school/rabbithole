/**
 * Pure grid geometry for the fact-automaticity heatmap (`FactHeatmap.tsx`).
 * Framework-free (no React / Chakra) so the cell-validity rule is unit-testable
 * on its own — the component just renders whatever this says is a real cell.
 */

import type { FactOp } from "@/shared/factKey";

/**
 * Whether an (row, col) intersection is a REAL fact for this operation — i.e.
 * one the scholar could actually be served, so the grid paints a cell there
 * rather than leaving it blank.
 *
 * Commutative ops (add / mul) use only the canonical LO≤HI half of the grid so
 * each fact appears exactly once. Subtraction keeps order (row = minuend, col =
 * subtrahend) and uses the opposite triangle, including `n − n`. Whether a
 * coordinate belongs to the generator space is checked by the caller's
 * canonical fact map; this helper only chooses the non-duplicated triangle.
 */
export function factGridCellValid(op: FactOp, row: number, col: number): boolean {
  return op === "sub" ? row >= col : row <= col;
}

/**
 * The row and column operands the grid draws for one operation: only operands
 * that hold at least one drawn cell. Taking the union of both operands instead
 * draws addition rows 11–20 empty, because a fact like 0 + 20 puts 20 among the
 * operands while the drawn a ≤ b half (with a + b ≤ 20) never reaches past row
 * 10. That was ten labelled, blank rows under the triangle.
 */
export function factGridAxes(
  op: FactOp,
  facts: readonly { a: number; b: number }[],
): { rows: number[]; cols: number[] } {
  const rows = new Set<number>();
  const cols = new Set<number>();
  for (const { a, b } of facts) {
    // Commutative facts are drawn on the lo ≤ hi half; subtraction keeps order.
    const r = op === "sub" ? a : Math.min(a, b);
    const c = op === "sub" ? b : Math.max(a, b);
    if (!factGridCellValid(op, r, c)) continue;
    rows.add(r);
    cols.add(c);
  }
  const sorted = (values: Set<number>) => [...values].sort((x, y) => x - y);
  return { rows: sorted(rows), cols: sorted(cols) };
}
