/**
 * Pure, framework-free snap-crossing detection — the countable "which discrete
 * step am I in?" math that every draggable manipulative shares (a number-line
 * tick, a grid column/cell, an array row/col, a partition boundary). Kept out of
 * `kit.tsx` (and free of Reanimated/RN imports) so the exact rule that decides
 * "did we cross into a NEW increment?" — the thing a selection haptic fires on —
 * is unit-testable without a device or a worklet. `useMovableHandle` mirrors
 * this same rounding inline inside its UI-thread worklet (a worklet can't call
 * an imported JS function), and seeds/reads it here on the JS thread.
 */

/**
 * Which discrete snap increment `value` currently sits in — the integer index
 * of the nearest multiple of `increment`. `snapIndex(0.72, 0.25) === 3`
 * (three-quarters), `snapIndex(-0.6, 0.25) === -2`. `increment` must be > 0;
 * a non-positive increment means "no snapping", reported as NaN so it never
 * compares equal to any real index.
 */
export function snapIndex(value: number, increment: number): number {
  if (!(increment > 0)) return Number.NaN;
  return Math.round(value / increment);
}

/**
 * True when a drag has moved from snap index `prev` into a DIFFERENT index
 * `next` — i.e. it just crossed a boundary and a single selection haptic should
 * fire. A NaN `prev` (no prior index yet, e.g. the very first frame before the
 * grab seeds it) is treated as "no crossing" so a grab doesn't double-fire on
 * top of its own grab tick.
 */
export function crossedSnap(prev: number, next: number): boolean {
  if (Number.isNaN(prev) || Number.isNaN(next)) return false;
  return prev !== next;
}
