/**
 * Scratchpad drawer geometry — the NATIVE half.
 *
 * The dormant drawer is a RIGHT-SIDE pane (the iPadOS Split View idiom), not a
 * see-through overlay: it takes its own column and the app content reflows into
 * what's left, so the problem a scholar is working on stays fully opaque and
 * fully interactive while they write. Why the horizontal axis: the practice
 * column is capped at 480pt on an 1180pt-wide landscape iPad, so a side pane can
 * take ~700pt before the problem loses a pixel — whereas the bottom edge is
 * already fully committed (confidence lane + the constant-height CTA lane).
 *
 * The occupied width lives in a module-level Reanimated shared value rather than
 * React context: there is exactly ONE global drawer, and keeping it on the UI
 * thread means the host reflows in the same frame as the drag instead of a
 * render behind it.
 *
 * ── Where the numbers live ───────────────────────────────────────────────────
 * The ARITHMETIC — detents, clamps, `projectFling`, `snapTarget`, the capture
 * crop, the perfect-freehand outline → SVG path — is framework-agnostic and
 * lives in `shared/scratchpadGeometry.ts`, vendored into `vendor/shared/` and
 * re-exported below so every existing `@/lib/scratchpadLayout` import keeps
 * working. It sits there because that is where the merge gate's vitest can
 * reach it: CI runs the ROOT `pnpm test`, which scans `shared/` and not this
 * app's own suite. `projectFling` in particular decides whether a flick
 * dismisses the pad, and it had to be corrected by hand (PR #1213) after a
 * position-only version shipped.
 *
 * This file keeps only what is genuinely native: the Reanimated shared value,
 * the inset hook, and the app-run-sticky width.
 */

import { makeMutable, useAnimatedStyle } from "react-native-reanimated";

import { DEFAULT_FRAC, clampFrac } from "../../vendor/shared/scratchpadGeometry";

export {
  CLOSE_FRAC,
  CLOSE_MS,
  CROP_PAD,
  DETENTS,
  EDGE_W,
  MAX_FRAC,
  MIN_CROP,
  MIN_FRAC,
  OPEN_DX,
  RAIL_W,
  SNAP_PX,
  clampFrac,
  drawerMetrics,
  inkCropRect,
  outlineToSvgPath,
  projectFling,
  snapTarget,
} from "../../vendor/shared/scratchpadGeometry";
export type {
  CropRect,
  DrawerMetrics,
  InkBounds,
} from "../../vendor/shared/scratchpadGeometry";

/** Points of screen width currently taken by the drawer. 0 = closed. */
export const scratchpadWidth = makeMutable(0);

// Sticky within an app run: once a scholar decides "I want half", reopening
// gives them half again. Deliberately not persisted to disk — a fresh launch
// starts from the neutral default.
let lastFrac: number = DEFAULT_FRAC;

export function getPreferredFrac(): number {
  return lastFrac;
}

export function setPreferredFrac(frac: number): void {
  lastFrac = clampFrac(frac);
}

/**
 * Pad the surface hosting `GlobalScratchpad` so the drawer never covers it.
 */
export function useScratchpadInset() {
  return useAnimatedStyle(() => ({ paddingRight: scratchpadWidth.get() }));
}
