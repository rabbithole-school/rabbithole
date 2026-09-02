/**
 * Scratchpad drawer geometry + pen maths — the framework-agnostic arithmetic
 * behind the Scholar Scratchpad.
 *
 * The Scratchpad is a resizable right-side drawer (the iPadOS Split View
 * idiom): the app content reflows into what's left, so the problem stays fully
 * opaque and fully interactive while the scholar writes. Today it ships on the
 * iPad, built out of Reanimated + Skia.
 *
 * ── Why this lives in `shared/` with only one consumer ───────────────────────
 * Testability, first and foremost. The merge gate's vitest only scans
 * `convex/ lib/ shared/ components/ evals/ scripts/` (see vitest.config.ts and
 * .github/workflows/ci.yml) — it does NOT run `native/`'s own suite. So while
 * this arithmetic lived in `native/src/lib/`, the single subtlest, most
 * defect-prone part of the drawer had no coverage in the gate at all:
 * `projectFling` is the momentum projection that decides whether a flick
 * dismisses the pad, and it had to be fixed by hand (PR #1213) after a release
 * that judged position and ignored velocity shipped and was rejected on device.
 * That is precisely the kind of arithmetic that should fail a PR, not a review.
 *
 * Second: it is genuinely portable. Nothing here touches React, Reanimated,
 * Skia or the DOM, so a web scratchpad would run these exact functions rather
 * than a lookalike that drifts. (`"worklet"` is a directive Reanimated reads on
 * native and an inert string expression anywhere else.)
 *
 * Native vendors it — `native/vendor/shared/scratchpadGeometry.ts` via
 * `native/scripts/sync-vendor.js` — and re-exports it from
 * `native/src/lib/scratchpadLayout.ts`, which keeps only the Reanimated shared
 * value and the inset hook. Edit THIS file, then re-run the sync.
 */

/** Fractions of screen width the divider magnetically snaps to. */
export const DETENTS = [1 / 3, 1 / 2, 2 / 3] as const;
export const MIN_FRAC = 0.25;
export const MAX_FRAC = 0.9;
/** Released narrower than this ⇒ treat the drag as a dismiss. */
export const CLOSE_FRAC = 0.17;
/** How near a detent the divider has to land to be pulled onto it (points/px). */
export const SNAP_PX = 42;
/** The drawer's own grab rail, subtracted from the paper's width. */
export const RAIL_W = 28;

/**
 * Width of the right-edge strip the open-swipe starts in, and the leftward
 * travel that commits the open.
 *
 * On native this is applied as a gesture `hitSlop` on the content wrapper — NOT
 * as a floating strip view, which would become the hit-test target for that
 * whole column and leave the rightmost points of every screen dead to taps. Web
 * has the same hazard for the same reason, so it arms window-level pointer
 * listeners and decides on release instead of painting a strip.
 */
export const EDGE_W = 24;
export const OPEN_DX = -34;

/** Padding around the ink when cropping a capture. */
export const CROP_PAD = 28;
/** Never hand back a crop smaller than this (a lone dot shouldn't be a 4px PNG). */
export const MIN_CROP = 160;

/** Neutral width a scholar who has never dragged the divider gets. */
export const DEFAULT_FRAC = 1 / 2;

/**
 * Close-animation duration, in ms. Paired with an `Easing.out` curve on both
 * platforms — and that pairing is the point: after a fast throw at the divider,
 * a close that STARTS slowly reads as the app having stalled. The motion has to
 * leave immediately and settle gently.
 */
export const CLOSE_MS = 210;

export function clampFrac(frac: number): number {
  return Math.min(MAX_FRAC, Math.max(MIN_FRAC, frac));
}

/**
 * How far a flick would coast after the pointer lifts, in points/px.
 *
 * Every release decision — dismiss vs. snap, open vs. spring back — is made
 * against `position + projectFling(velocity)` rather than the raw position the
 * finger happened to stop at. Without this a fast throw is read as though it
 * were a slow, deliberate placement: shove the divider to 30% and let go and it
 * snaps *wider* onto ⅓, which reads as the drawer refusing to close. That was a
 * real shipped defect (native PR #1213), rejected by hand on the device.
 *
 * This is UIKit's own momentum projection (WWDC18 "Designing Fluid Interfaces"):
 * with a per-millisecond deceleration rate `d`, a body released at `v` travels
 * `v · d/(1−d)`. `UIScrollView`'s normal rate of 0.998 gives 0.998/0.002 = 499ms
 * of coast, which is why iOS sheets and scroll views feel decisive on a flick.
 * Using the same number is what makes the drawer feel like a system pane — on
 * both platforms.
 *
 * Velocity is clamped first, matching the fling cap the Sky and Tree maps
 * already use, so a stray high-velocity sample can't fling the divider across
 * the screen.
 *
 * Marked `"worklet"` for Reanimated: on native it runs on the UI thread from the
 * pan gesture; on web the directive is an inert string expression. Its constants
 * are LOCAL to the function — see `snapTarget` for the (unresolved) history
 * behind that habit.
 */
export function projectFling(velocity: number): number {
  "worklet";
  const MAX_V = 2500; // pt/s
  const COAST_MS = 499; // 0.998 / (1 - 0.998)
  const v = Math.max(-MAX_V, Math.min(MAX_V, velocity));
  return (v / 1000) * COAST_MS;
}

/** Every width the divider cares about, in points/px, for one screen width. */
export type DrawerMetrics = {
  minW: number;
  maxW: number;
  closeW: number;
  snapPx: number;
  /** Widths the divider magnetically snaps to (the detents plus both clamps). */
  targets: number[];
};

export function drawerMetrics(screenW: number): DrawerMetrics {
  const minW = screenW * MIN_FRAC;
  const maxW = screenW * MAX_FRAC;
  return {
    minW,
    maxW,
    closeW: screenW * CLOSE_FRAC,
    snapPx: SNAP_PX,
    targets: [
      screenW * DETENTS[0],
      screenW * DETENTS[1],
      screenW * DETENTS[2],
      minW,
      maxW,
    ],
  };
}

/**
 * Nearest snap target for a released divider, or the free position when it isn't
 * close to one ("magnetic", not sticky).
 *
 * Takes its numbers as an ARGUMENT rather than reading the module constants
 * above. That's worth keeping on its own merits — the caller memoises one
 * `DrawerMetrics` in component scope, so the thresholds stay defined in exactly
 * one place and (on native) are captured with the worklet.
 *
 * The habit started as a workaround and the reason for it is NOT settled. A
 * top-level `const` once crashed the native pad with
 * `ReferenceError: Property 'X' doesn't exist`, and we wrote that down as "a
 * worklet closes over enclosing *function* scopes only". That explanation is
 * doubtful — the same message is also what STALE FAST REFRESH looks like, which
 * is what it turned out to be. Cold-relaunch before you restructure anything
 * here; `/ios-sim` → `references/driving-the-app.md` is the write-up.
 */
export function snapTarget(px: number, m: DrawerMetrics): number {
  "worklet";
  let best = m.targets[0];
  for (let i = 1; i < m.targets.length; i++) {
    if (Math.abs(m.targets[i] - px) < Math.abs(best - px)) best = m.targets[i];
  }
  if (Math.abs(best - px) <= m.snapPx) return best;
  return Math.min(m.maxW, Math.max(m.minW, px));
}

/** Axis-aligned bounds of everything drawn, in sheet coordinates. */
export type InkBounds = { minX: number; minY: number; maxX: number; maxY: number };
/** A crop rectangle in sheet coordinates. */
export type CropRect = { x: number; y: number; width: number; height: number };

/**
 * The tight bounding box of everything drawn, padded and clamped to the sheet.
 *
 * Cropping matters: the sheet is as wide as the drawer can ever get, so an
 * uncropped snapshot would hand the tutor (and, downstream, the observer's
 * vision pass) mostly blank paper. Returns null when the bounds look degenerate,
 * in which case the caller falls back to a full-sheet snapshot.
 */
export function inkCropRect(
  bounds: InkBounds | null,
  sheetW: number,
  sheetH: number,
): CropRect | null {
  if (!bounds) return null;
  const { minX, minY, maxX, maxY } = bounds;
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  if (!Number.isFinite(maxX) || !Number.isFinite(maxY)) return null;

  let x = Math.max(0, minX - CROP_PAD);
  let y = Math.max(0, minY - CROP_PAD);
  let w = Math.min(sheetW - x, maxX - minX + CROP_PAD * 2);
  let h = Math.min(sheetH - y, maxY - minY + CROP_PAD * 2);

  // Grow tiny crops (a lone dot) back out toward MIN_CROP, then re-clamp.
  if (w < MIN_CROP) {
    x = Math.max(0, Math.min(x - (MIN_CROP - w) / 2, sheetW - MIN_CROP));
    w = Math.min(MIN_CROP, sheetW);
  }
  if (h < MIN_CROP) {
    y = Math.max(0, Math.min(y - (MIN_CROP - h) / 2, sheetH - MIN_CROP));
    h = Math.min(MIN_CROP, sheetH);
  }
  if (w <= 0 || h <= 0) return null;
  return { x, y, width: w, height: h };
}

/**
 * `perfect-freehand` outline points → an SVG path string (quadratic-smoothed).
 *
 * A `d` string rather than renderer-specific commands, so any surface can take
 * it as-is: Skia's `Path.MakeFromSVGString` on native, `new Path2D(d)` in a
 * browser.
 */
export function outlineToSvgPath(stroke: number[][]): string {
  if (!stroke.length) return "";
  const d = stroke.reduce<(string | number)[]>(
    (acc, [x0, y0], i, arr) => {
      const [x1, y1] = arr[(i + 1) % arr.length];
      acc.push(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
      return acc;
    },
    ["M", ...stroke[0], "Q"],
  );
  return d.join(" ") + " Z";
}
