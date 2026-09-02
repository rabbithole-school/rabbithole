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
