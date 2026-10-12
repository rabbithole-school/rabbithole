/**
 * Pure client-side table sorting, shared by every sortable table (with
 * `components/ui/SortableColumnHeader.tsx` for the header control).
 *
 * A column is a comparator for ascending order plus an optional `isMissing`:
 * rows with no value sort LAST in either direction, so flipping the order
 * never brings the blanks to the top. Ties keep their incoming order (a stable
 * tie-break on the original index), so a server's default order survives as
 * the secondary key.
 */

export type SortDir = "asc" | "desc";

export interface SortColumn<T> {
  /** Ascending comparator for rows that both have a value. */
  compare: (a: T, b: T) => number;
  /** True when the row has no value for this column (sorted last always). */
  isMissing?: (row: T) => boolean;
}

export function sortRows<T>(rows: readonly T[], column: SortColumn<T>, dir: SortDir): T[] {
  const sign = dir === "asc" ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, missing: column.isMissing?.(row) ?? false }))
    .sort((a, b) => {
      if (a.missing !== b.missing) return a.missing ? 1 : -1;
      const c = a.missing ? 0 : sign * column.compare(a.row, b.row);
      return c !== 0 ? c : a.index - b.index;
    })
    .map((x) => x.row);
}

/** Clicking a header: the active column flips; a new column starts ascending. */
export function nextSort<K extends string>(
  current: { key: K | null; dir: SortDir },
  clicked: K,
): { key: K; dir: SortDir } {
  if (current.key === clicked) return { key: clicked, dir: current.dir === "asc" ? "desc" : "asc" };
  return { key: clicked, dir: "asc" };
}

/** Compare two strings the way people read them ("Kai" before "kalani", "2" before "10"). */
export function compareText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
}
