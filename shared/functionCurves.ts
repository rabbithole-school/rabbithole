/**
 * Pure function-curve math shared by the `functionGraph` manipulative (web +
 * iPad) and the display-only `functionPlot` prompt visual: the parent
 * functions, the three curve forms Algebra 2 graphs are built from, and a
 * sampler that turns any of them into clipped polylines broken at asymptotes.
 *
 * It lives in shared/ (vendored to native/vendor/shared/) and imports nothing,
 * so `practicePromptVisual.ts` can reach it with a sibling import and both
 * renderers can import it directly. The manipulative's grading
 * (`lib/manipulative/functionGraph.ts`) does NOT import it — grading never
 * samples a curve — but its handle table is pinned to these definitions by
 * a test.
 *
 * Everything is in MATH coordinates; a renderer maps points to pixels.
 */

export type FunctionParent =
  | "linear"
  | "quadratic"
  | "cubic"
  | "abs"
  | "sqrt"
  | "exp2"
  | "log2"
  | "reciprocal";

export const FUNCTION_PARENTS: readonly FunctionParent[] = [
  "linear",
  "quadratic",
  "cubic",
  "abs",
  "sqrt",
  "exp2",
  "log2",
  "reciprocal",
];

/**
 * y = a·f(b(x − h)) + k. `b` is the horizontal reflection only: 1 (default)
 * or −1 (flip left–right across x = h). There is no horizontal stretch.
 */
export interface CurveTransform {
  a: number;
  h: number;
  k: number;
  b?: number;
}

/** One real zero of a polynomial and its multiplicity (≥ 1). */
export interface CurveZero {
  x: number;
  multiplicity: number;
}

/**
 * A rational function in the one shape the Algebra 2 graphs need:
 *   y = horizontal + scale / ((x − v₁)(x − v₂)…)
 * Every (ax + b)/(cx + d) with c ≠ 0 is this with one vertical asymptote
 * (horizontal = a/c, scale = (bc − ad)/c², vertical = [−d/c]), and
 * a/(x − h) + k is it directly.
 */
export interface CurveRational {
  vertical: number[];
  horizontal: number;
  scale: number;
  /**
   * Removable discontinuities: x-values where the unsimplified rule has a
   * cancelled common factor. The curve is the simplified rule with a hole
   * (a hollow dot) at each; a hole is never an asymptote.
   */
  holes?: number[];
}

export interface CurveWindow {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export interface CurvePoint {
  x: number;
  y: number;
}

/** The parent function itself. NaN outside its domain (and at 1/0). */
export function parentValue(parent: FunctionParent, x: number): number {
  switch (parent) {
    case "linear":
      return x;
    case "quadratic":
      return x * x;
    case "cubic":
      return x * x * x;
    case "abs":
      return Math.abs(x);
    case "sqrt":
      return x >= 0 ? Math.sqrt(x) : Number.NaN;
    case "exp2":
      return Math.pow(2, x);
    case "log2":
      return x > 0 ? Math.log2(x) : Number.NaN;
    case "reciprocal":
      return x === 0 ? Number.NaN : 1 / x;
  }
}

export function transformValue(parent: FunctionParent, t: CurveTransform, x: number): number {
  return t.a * parentValue(parent, (t.b === -1 ? -1 : 1) * (x - t.h)) + t.k;
}

/** Where a transformed parent's asymptotes sit (empty lists when it has none). */
export function transformAsymptotes(
  parent: FunctionParent,
  t: CurveTransform,
): { vertical: number[]; horizontal: number[] } {
  switch (parent) {
    case "exp2":
      return { vertical: [], horizontal: [t.k] };
    case "log2":
      return { vertical: [t.h], horizontal: [] };
    case "reciprocal":
      return { vertical: [t.h], horizontal: [t.k] };
    default:
      return { vertical: [], horizontal: [] };
  }
}

export function polynomialValue(zeros: CurveZero[], leading: number, x: number): number {
  let y = leading;
  for (const z of zeros) y *= Math.pow(x - z.x, z.multiplicity);
  return y;
}

export function rationalValue(r: CurveRational, x: number): number {
  let d = 1;
  for (const v of r.vertical) d *= x - v;
  if (d === 0) return Number.NaN;
  return r.horizontal + r.scale / d;
}

/** A curve ready to sample: its rule plus the x-values where it must break. */
export interface SampleableCurve {
  f: (x: number) => number;
  /** x-values the curve must never be joined across (vertical asymptotes). */
  breaks: number[];
  /** x-values worth sampling exactly (a corner, a domain endpoint, a zero). */
  extraXs: number[];
}

export function transformCurve(parent: FunctionParent, t: CurveTransform): SampleableCurve {
  const breaks = parent === "reciprocal" || parent === "log2" ? [t.h] : [];
  return {
    f: (x) => transformValue(parent, t, x),
    breaks,
    extraXs: [t.h],
  };
}

export function polynomialCurve(zeros: CurveZero[], leading: number): SampleableCurve {
  return {
    f: (x) => polynomialValue(zeros, leading, x),
    breaks: [],
    extraXs: zeros.map((z) => z.x),
  };
}

export function rationalCurve(r: CurveRational): SampleableCurve {
  return { f: (x) => rationalValue(r, x), breaks: [...r.vertical], extraXs: [] };
}

/**
 * A polynomial SKETCH: the right zeros and multiplicities and the right sign,
 * vertically rescaled so the wiggles between the zeros are visible inside the
 * window. The y-scale is meaningless on purpose (it is a sketch, and it is never
 * graded); the tails run off the window, which is how end behaviour reads.
 *
 * The scale fits the largest |p| over [lowest zero − 1, highest zero + 1] (clipped
 * to the window) to 80% of the smaller half-height of the window.
 */
export function polynomialSketchCurve(
  zeros: CurveZero[],
  leading: number,
  window: CurveWindow,
): SampleableCurve {
  const sign = leading < 0 ? -1 : 1;
  if (zeros.length === 0) {
    const level = sign * 0.6 * Math.max(1, Math.min(window.yMax, -window.yMin));
    return { f: () => level, breaks: [], extraXs: [] };
  }
  const xs = zeros.map((z) => z.x);
  const lo = Math.max(window.xMin, Math.min(...xs) - 1);
  const hi = Math.min(window.xMax, Math.max(...xs) + 1);
  let peak = 0;
  const steps = 200;
  for (let i = 0; i <= steps; i++) {
    const x = lo + ((hi - lo) * i) / steps;
    const y = Math.abs(polynomialValue(zeros, 1, x));
    if (Number.isFinite(y) && y > peak) peak = y;
  }
  const half = Math.max(1, Math.min(window.yMax, -window.yMin));
  const scale = peak > 0 ? (0.8 * half) / peak : 1;
  return {
    f: (x) => sign * scale * polynomialValue(zeros, 1, x),
    breaks: [],
    extraXs: xs,
  };
}

const DEFAULT_SAMPLES = 360;
/** Offsets either side of a break/extra x, so a curve reaches the window edge
 *  next to an asymptote instead of stopping one coarse sample short. */
const NEAR_OFFSETS = [1e-4, 1e-3, 4e-3, 0.01, 0.025, 0.05];

/**
 * Sample a curve over the window into polylines (math coordinates), clipped to
 * the window's y-band and broken at every `breaks` x and wherever the rule is
 * not finite. Never returns a NaN coordinate; a polyline always has ≥ 2 points.
 */
export function sampleCurve(
  curve: SampleableCurve,
  window: CurveWindow,
  samples = DEFAULT_SAMPLES,
): CurvePoint[][] {
  const { xMin, xMax, yMin, yMax } = window;
  if (!(xMax > xMin) || !(yMax > yMin)) return [];
  const xsSet = new Set<number>();
  for (let i = 0; i <= samples; i++) xsSet.add(xMin + ((xMax - xMin) * i) / samples);
  const breaks = curve.breaks.filter((b) => Number.isFinite(b));
  for (const anchor of [...breaks, ...curve.extraXs]) {
    if (!Number.isFinite(anchor)) continue;
    xsSet.add(anchor);
    for (const d of NEAR_OFFSETS) {
      xsSet.add(anchor - d);
      xsSet.add(anchor + d);
    }
  }
  const xs = [...xsSet].filter((x) => x >= xMin && x <= xMax).sort((p, q) => p - q);

  const lines: CurvePoint[][] = [];
  let current: CurvePoint[] = [];
  const flush = () => {
    if (current.length >= 2) lines.push(current);
    current = [];
  };
  const crossesBreak = (x0: number, x1: number) =>
    breaks.some((b) => (x0 < b && x1 > b) || x0 === b || x1 === b);

  let prev: CurvePoint | null = null;
  for (const x of xs) {
    if (breaks.includes(x)) {
      flush();
      prev = null;
      continue;
    }
    const y = curve.f(x);
    if (!Number.isFinite(y)) {
      flush();
      prev = null;
      continue;
    }
    const point = { x, y };
    if (prev && crossesBreak(prev.x, x)) {
      flush();
      prev = null;
    }
    if (prev) {
      const clipped = clipSegmentY(prev, point, yMin, yMax);
      if (clipped) {
        const [a, b] = clipped;
        const last = current[current.length - 1];
        if (!last || last.x !== a.x || last.y !== a.y) {
          flush();
          current.push(a);
        }
        current.push(b);
        // A segment that left the band ends the polyline at the edge.
        if (b.x !== point.x || b.y !== point.y) flush();
      } else {
        flush();
      }
    }
    prev = point;
  }
  flush();
  return lines;
}

/** Clip segment p→q to yMin ≤ y ≤ yMax. Returns null when it lies wholly outside. */
function clipSegmentY(
  p: CurvePoint,
  q: CurvePoint,
  yMin: number,
  yMax: number,
): [CurvePoint, CurvePoint] | null {
  let t0 = 0;
  let t1 = 1;
  const dy = q.y - p.y;
  for (const [edge, isMin] of [
    [yMin, true],
    [yMax, false],
  ] as const) {
    if (dy === 0) {
      const outside = isMin ? p.y < edge : p.y > edge;
      if (outside) return null;
      continue;
    }
    const t = (edge - p.y) / dy;
    // Entering the band through this edge raises t0; leaving lowers t1.
    const entering = isMin ? dy > 0 : dy < 0;
    if (entering) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
  }
  if (t0 > t1) return null;
  const at = (t: number): CurvePoint => ({ x: p.x + (q.x - p.x) * t, y: p.y + dy * t });
  return [t0 === 0 ? p : at(t0), t1 === 1 ? q : at(t1)];
}

/** Turn polylines into one SVG path `d`, given a math → pixel mapping. */
export function curvePathD(
  lines: CurvePoint[][],
  toPx: (p: CurvePoint) => { x: number; y: number },
): string {
  const round = (n: number) => Math.round(n * 100) / 100;
  return lines
    .map((line) =>
      line
        .map((p, i) => {
          const px = toPx(p);
          return `${i === 0 ? "M" : "L"}${round(px.x)} ${round(px.y)}`;
        })
        .join(" "),
    )
    .join(" ");
}
