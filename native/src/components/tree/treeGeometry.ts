// Pure geometry for the native Tree map — NO react-native-svg / React imports, so
// it stays node-testable (native/vitest.config.ts, `src/**/*.test.ts`). The JSX
// element builders that consume these live in treeGlyphs.tsx.
//
// `components/map/MapTreeCanvas.tsx` (+ `components/KnowledgeNodeDial.tsx`) are the
// SOURCE OF TRUTH for the tree's visual language; the edge-arc, gap, and dial-arc
// math below is a faithful port of their screen-space math into content space.

// ── Dial arc geometry (ported from KnowledgeNodeDial.tsx) ─────────────────────
// A ~3° angular gap at top AND bottom keeps the two side flanks legible.
const GAP_DEG = 3;
export const GAP_RAD = (GAP_DEG * Math.PI) / 180;
const GAP_SIN = Math.sin(GAP_RAD); // ≈ 0.0523
const GAP_COS = Math.cos(GAP_RAD); // ≈ 0.9986

/**
 * The REAL length of one flank arc of radius `r`. react-native-svg does NOT
 * support `pathLength`, so we can't normalise to 100 like the web dial — we dash
 * by the true arc length instead. Each flank sweeps (π − 2·GAP_RAD) radians.
 */
export function dialArcLength(r: number): number {
  return r * (Math.PI - 2 * GAP_RAD);
}

/**
 * `strokeDasharray` for a flank filled to `fill` (0..1): draw `fill·L` then a gap
 * of `L`, so a single dash shows the filled fraction. The native stand-in for the
 * web dial's `pathLength=100 + dasharray="fill*100 100"`.
 */
export function arcDashArray(fill: number, r: number): [number, number] {
  const L = dialArcLength(r);
  return [Math.max(0, Math.min(1, fill)) * L, L];
}

/** SVG path for a side flank (bottom→top), gapped GAP_DEG° at each pole. Ported
 *  verbatim from KnowledgeNodeDial.arcPath. */
export function arcPathD(
  cx: number,
  cy: number,
  r: number,
  side: "left" | "right",
): string {
  const xOff = r * GAP_SIN * (side === "left" ? -1 : 1);
  const topY = cy - r * GAP_COS;
  const botY = cy + r * GAP_COS;
  const x = cx + xOff;
  const sweep = side === "left" ? 1 : 0;
  return `M ${x} ${botY} A ${r} ${r} 0 0 ${sweep} ${x} ${topY}`;
}

// ── Edge geometry (ported from MapTreeCanvas.onFrame) ─────────────────────────
// All coordinates here are CONTENT-space; the caller precomputes `arcH` and
// `back` as content-space lengths (screen-px quantities ÷ camera scale).

export type Vec = { x: number; y: number };
export type EdgeGeom = {
  /** gapped start point */
  sx: number;
  sy: number;
  /** gapped end point (arrowhead tip sits here) */
  ex: number;
  ey: number;
  /** unit tangent AT the end, pointing toward the target (for the arrowhead) */
  tanX: number;
  tanY: number;
};
export type ArcGeom = EdgeGeom & { cx: number; cy: number };

/**
 * The web's same-strand "airline arc": a quadratic curve whose control point is
 * the chord midpoint raised perpendicular (bowed toward screen-up), with both
 * ends pulled back by `back` along their local tangents so the head/foot clear
 * the dials. Mirrors MapTreeCanvas.onFrame's `sameStrand` branch exactly.
 */
export function airlineArc(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  arcH: number,
  back: number,
): ArcGeom {
  const vx = bx - ax;
  const vy = by - ay;
  const len = Math.hypot(vx, vy) || 1;
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  let nx = -vy / len;
  let ny = vx / len;
  if (ny > 0) {
    nx = -nx;
    ny = -ny;
  } // bow up (screen −y)
  const cx = mx + nx * arcH;
  const cy = my + ny * arcH;
  // start: pull back along centre→control
  const s0x = cx - ax;
  const s0y = cy - ay;
  const s0l = Math.hypot(s0x, s0y) || 1;
  const sx = ax + (s0x / s0l) * back;
  const sy = ay + (s0y / s0l) * back;
  // end: pull back along control→end (so the head aims at the target centre)
  const tX = bx - cx;
  const tY = by - cy;
  const tl = Math.hypot(tX, tY) || 1;
  const ex = bx - (tX / tl) * back;
  const ey = by - (tY / tl) * back;
  return { cx, cy, sx, sy, ex, ey, tanX: tX / tl, tanY: tY / tl };
}

/** The web's cross-strand straight edge: a line gapped `back` at both ends. */
export function straightEdge(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  back: number,
): EdgeGeom {
  const vx = bx - ax;
  const vy = by - ay;
  const len = Math.hypot(vx, vy) || 1;
  const ux = vx / len;
  const uy = vy / len;
  return {
    sx: ax + ux * back,
    sy: ay + uy * back,
    ex: bx - ux * back,
    ey: by - uy * back,
    tanX: ux,
    tanY: uy,
  };
}

/**
 * The three points of a manual arrowhead triangle (there are no SVG markers in
 * the crisp layer). Tip at (tipX,tipY), aimed along the unit tangent (dirX,dirY);
 * base `size` behind the tip, `size` wide. Mirrors sky.tsx's LatticeArrow polygon.
 */
export function arrowheadPoints(
  tipX: number,
  tipY: number,
  dirX: number,
  dirY: number,
  size: number,
): Vec[] {
  const bx = tipX - dirX * size;
  const by = tipY - dirY * size;
  const px = -dirY * (size * 0.5);
  const py = dirX * (size * 0.5);
  return [
    { x: tipX, y: tipY },
    { x: bx + px, y: by + py },
    { x: bx - px, y: by - py },
  ];
}

/** react-native-svg wants a "x,y x,y x,y" points string for <Polygon>. */
export function pointsAttr(pts: Vec[]): string {
  return pts.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
}
