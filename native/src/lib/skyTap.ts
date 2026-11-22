/**
 * Where a tap lands on a kid's own Sky on the BunnyPad (TRA-699). The sky is
 * one drawn canvas, so the BunnyPad hit-tests a tap itself; web gives each
 * star its own button. Everything else about the Sky is shared with web
 * (shared/yourSkyModel.ts, read here through its vendored copy).
 */

import {
  LABEL_FONT_PX,
  screenLabelBox,
  toScreen,
  type SkyCamera,
  type SkyStarLike,
} from "../../vendor/shared/yourSkyModel";

/** A star's tap target, in points from its dot: never smaller than a finger
 *  (44pt across), whatever the zoom. */
export const STAR_HIT_RADIUS_PX = 26;

/**
 * The star a tap at (sx, sy) lands on: the nearest dot within
 * `STAR_HIT_RADIUS_PX`, or a star whose shown label box holds the point.
 * Null when the tap lands on empty sky.
 */
export function starAtPoint(
  stars: readonly SkyStarLike[],
  cam: SkyCamera,
  sx: number,
  sy: number,
  shownLabels: ReadonlySet<string> = new Set(),
  fontPx = LABEL_FONT_PX,
): SkyStarLike | null {
  let best: SkyStarLike | null = null;
  let bestD = STAR_HIT_RADIUS_PX;
  for (const s of stars) {
    const at = toScreen(s, cam);
    const d = Math.hypot(at.x - sx, at.y - sy);
    if (d <= bestD) {
      bestD = d;
      best = s;
    }
  }
  if (best) return best;
  for (const s of stars) {
    if (!shownLabels.has(s.id)) continue;
    const b = screenLabelBox(s, cam, fontPx);
    if (sx >= b.left && sx <= b.right && sy >= b.top && sy <= b.bottom) return s;
  }
  return null;
}
