/**
 * crispSvg — vector crispness under a camera scale transform.
 *
 * THE PROBLEM: react-native-svg (like any UIView) rasterizes at its LAYOUT size;
 * a parent `transform: scale(k)` then stretches that raster, so stars, arrows and
 * dials pixelate at deep zoom. The web sky hit the identical problem and solved it
 * with the RASTER trick (lib/atlasEngine.ts — "build each star RASTER× larger and
 * counter-scale it down in its own transform, so the backing raster has RASTER×
 * headroom before it blurs"). This module is the native port of that idea, in two
 * flavours:
 *
 * 1. PER-ELEMENT oversample (small, fixed-size glyphs — feature stars, the hub):
 *    draw the SVG at `STAR_RASTER×` its display size and multiply the element's
 *    own transform scale by `1/STAR_RASTER`. Net display size unchanged; raster
 *    density gains STAR_RASTER× headroom. Memory cost is per-glyph and tiny.
 *
 * 2. CRISP LAYER (full-field vector layers — the prereq/thread lattice, tree
 *    edges + dials): a full-field SVG can't simply be drawn bigger (its backing
 *    store would be content-size × res² — tens/hundreds of MB). Instead, at each
 *    SETTLE (gesture end / bucket commit — the same moments these layers already
 *    re-render), lay the SVG out over just the VISIBLE content rect (+ margin),
 *    at an oversample `res` bounded by a hard layout-area budget, and counter-
 *    scale by 1/res. The layer still lives INSIDE the camera canvas at content
 *    coords, so pan + zoom remain the one continuous transform — no screen-space
 *    reprojection, no hand-off jump (the zoom-jump class sky.tsx's comments warn
 *    about). Mid-gesture the raster is GPU-stretched (slightly soft, exactly like
 *    iOS Maps mid-pinch); on settle it re-renders crisp.
 *
 * Coordinate contract for a crisp layer, given `r = crispLayerRect(...)`:
 *   • wrapper View: position absolute at (r.x, r.y), size r.w × r.h — content px.
 *   • inner <Svg width={r.w * r.res} height={r.h * r.res}
 *              style={{ transform: [{ scale: 1 / r.res }], transformOrigin: "0 0" }}>
 *   • a content-space point (x, y) is drawn at ((x − r.x) · r.res, (y − r.y) · r.res);
 *     every radius / stroke width / arrowhead size is multiplied by r.res.
 *   Net displayed geometry is IDENTICAL to drawing at content coords with res 1 —
 *   only the raster density changes.
 */

/** Per-element oversample for small fixed-size glyphs (feature stars, hub).
 * MAX_ZOOM(4) × STAR_ATTEN[3](0.55) = 2.2× worst-case net stretch today; 2.25
 * covers it with a hair of headroom. */
export const STAR_RASTER = 2.25;

/** ⚠️ MEASURED LIMIT (2026-07-06): flavour 1 does NOT work for elements INSIDE
 * an animated camera canvas. Under Fabric/Reanimated the canvas subtree
 * composites through a CONTENT-resolution buffer, so a counter-scaled oversized
 * drawing gains nothing — deep-zoom blur was IDENTICAL with 1× and 2.25×
 * oversample. Flavour 1 remains valid in STATIC contexts (e.g. the tree
 * NodeSheet's dial). For camera-canvas glyphs, render them SCREEN-SPACE instead
 * (sky.tsx FeatureStar/HubGlyph: drawn at bucket-top size, worklet-pinned,
 * only ever minified — the SkyLabel pattern). The full fix for uncapped layers
 * (lattice, territory, tree edges/dials at deep zoom) is the Skia endgame —
 * TODO.html#sky-map-vector-render. */

export type CrispRect = {
  /** Content-space origin + size of the layer (clamped to the content bounds). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Oversample factor: raster density gained before the camera stretch blurs. */
  res: number;
};

/**
 * Compute the visible-content rect (+ margin) and the largest affordable
 * oversample for a crisp layer, from a CAMERA SNAPSHOT taken at settle time.
 *
 * `maxAreaPt2` bounds the SVG's LAYOUT area (w·res × h·res, in pt²) — the raster
 * backing store is that × pixelScale². The default 1.6M pt² ≈ 25 MB at 2× retina,
 * comparable to one full-screen layer, so a crisp layer never costs meaningfully
 * more memory than the naive full-field SVG it replaces.
 */
export function crispLayerRect(opts: {
  scale: number;
  tx: number;
  ty: number;
  viewportW: number;
  viewportH: number;
  contentW: number;
  contentH: number;
  /** Fraction of the (content-space) viewport kept painted beyond each edge so a
   * fling doesn't reveal blank gutters before the settle re-render. */
  margin?: number;
  maxAreaPt2?: number;
}): CrispRect {
  const {
    scale,
    tx,
    ty,
    viewportW,
    viewportH,
    contentW,
    contentH,
    margin = 0.35,
    maxAreaPt2 = 1_600_000,
  } = opts;
  const s = Math.max(scale, 0.0001);
  // Visible content rect.
  const visX = (0 - tx) / s;
  const visY = (0 - ty) / s;
  const visW = viewportW / s;
  const visH = viewportH / s;
  // Expand by margin, clamp to content bounds (integer-rounded for stability).
  const x0 = Math.max(0, Math.floor(visX - visW * margin));
  const y0 = Math.max(0, Math.floor(visY - visH * margin));
  const x1 = Math.min(contentW, Math.ceil(visX + visW * (1 + margin)));
  const y1 = Math.min(contentH, Math.ceil(visY + visH * (1 + margin)));
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  // res: full crispness is res = scale (raster density ≥ display density even
  // before per-bucket attenuation); the area budget is the hard ceiling.
  const res = Math.max(1, Math.min(s, Math.sqrt(maxAreaPt2 / (w * h))));
  return { x: x0, y: y0, w, h, res };
}

/** True if the segment's bounding box intersects the rect (cheap edge cull). */
export function segmentIntersectsRect(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  r: CrispRect,
): boolean {
  return (
    Math.max(x1, x2) >= r.x &&
    Math.min(x1, x2) <= r.x + r.w &&
    Math.max(y1, y2) >= r.y &&
    Math.min(y1, y2) <= r.y + r.h
  );
}
