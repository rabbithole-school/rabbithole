/**
 * Pure logic for the `functionGraph` manipulative (see `FunctionGraphSpec` in
 * ./types.ts): runtime state, the self-check, the authoring guard, the tutor
 * describers, AND the interaction model + board layout both renderers share
 * (web `FunctionGraphManipulative.tsx`, iPad `FunctionGraph.native.tsx`), so the
 * two frontends cannot disagree about where a handle sits or how it snaps.
 *
 * Grading never samples a curve. Curve drawing lives in shared/functionCurves.ts
 * (also used by the `functionPlot` prompt visual); the handle table below is
 * pinned to those curve definitions by a test.
 *
 * Imports only ./types, so `logic.ts` can dispatch to it and the vendored native
 * copy resolves standalone.
 */

import type {
  FunctionGraphGoal,
  FunctionGraphParent,
  FunctionGraphRational,
  FunctionGraphSpec,
  FunctionGraphTransform,
  FunctionGraphZero,
} from "./types";

// ── runtime state ────────────────────────────────────────────────────────────
/**
 * matchTransform: the live curve's parameters, y = a·f(b(x − h)) + k. `b` is
 * 1 or −1 (the board's "Flip left–right" button); a state without `b` (older
 * clients) means 1.
 */
export interface FunctionGraphTransformState {
  a: number;
  h: number;
  k: number;
  b?: number;
}
/** placeZeros: the markers ON the axis (tray markers are not listed), and the ends. */
export interface FunctionGraphZerosState {
  zeros: Array<{ x: number; touch: boolean }>;
  leftUp: boolean;
  rightUp: boolean;
}
/** placeAsymptotes: where the dashed lines sit. */
export interface FunctionGraphAsymptotesState {
  vertical: number[];
  horizontal: number | null;
}
export type FunctionGraphState =
  | FunctionGraphTransformState
  | FunctionGraphZerosState
  | FunctionGraphAsymptotesState;

export const FUNCTION_GRAPH_PARENTS: readonly FunctionGraphParent[] = [
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
 * The vertical stretches the a-handle snaps to. Small and closed on purpose: a
 * scholar can only land on a value the prompt could name, and 0 (a flat line
 * that is no longer the parent) is not one of them.
 */
export const FUNCTION_GRAPH_A_VALUES: readonly number[] = [-3, -2, -1, -0.5, 0.5, 1, 2, 3];

/**
 * Where the two handles sit, per parent, in PARENT coordinates:
 *   • the anchor is (x0, 0) — the parent's vertex / corner / centre / start, or
 *     (for exp2) the point on its asymptote above x = 0, or (for log2) its
 *     x-intercept (1, 0). Under y = a·f(b(x − h)) + k it maps to
 *     (h + b·x0, k), so dragging it sets h and k without touching a.
 *   • the stretch handle is (u, f(u)) with f(u) ≠ 0. It maps to
 *     (h + b·u, k + a·f(u)) — to the anchor's right, or its left once flipped —
 *     so dragging it vertically sets a.
 * A test checks each `fu` against the real curve in shared/functionCurves.ts.
 */
export const FUNCTION_GRAPH_HANDLES: Record<FunctionGraphParent, { x0: number; u: number; fu: number }> = {
  linear: { x0: 0, u: 1, fu: 1 },
  quadratic: { x0: 0, u: 1, fu: 1 },
  cubic: { x0: 0, u: 1, fu: 1 },
  abs: { x0: 0, u: 1, fu: 1 },
  sqrt: { x0: 0, u: 1, fu: 1 },
  exp2: { x0: 0, u: 1, fu: 2 },
  log2: { x0: 1, u: 2, fu: 1 },
  reciprocal: { x0: 0, u: 1, fu: 1 },
};

const EPS = 1e-9;
const eq = (a: number, b: number) => Math.abs(a - b) <= EPS;
const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);
const isFiniteNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const clampNum = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n);
/** The horizontal reflection of a transform: −1 only when explicitly −1. */
export function functionGraphB(t: { b?: number }): 1 | -1 {
  return t.b === -1 ? -1 : 1;
}

export function isFunctionGraphParent(p: unknown): p is FunctionGraphParent {
  return typeof p === "string" && (FUNCTION_GRAPH_PARENTS as readonly string[]).includes(p);
}

// ── initial state ────────────────────────────────────────────────────────────
/** Every board starts unsolved: the bare parent, an empty axis, lines off target. */
export function initialFunctionGraph(spec: FunctionGraphSpec): FunctionGraphState {
  const g = spec.goal;
  if (g.type === "matchTransform") return { a: 1, h: 0, k: 0, b: 1 };
  if (g.type === "placeZeros") return { zeros: [], leftUp: true, rightUp: true };
  return initialAsymptotes(spec, g.rational);
}

function initialAsymptotes(spec: FunctionGraphSpec, r: FunctionGraphRational): FunctionGraphAsymptotesState {
  const n = Math.max(1, r.vertical.length);
  const taken = new Set(r.vertical);
  const xs: number[] = [];
  for (let d = 1; xs.length < n && d <= spec.xMax - spec.xMin; d++) {
    for (const x of [spec.xMin + d, spec.xMax - d]) {
      if (xs.length < n && x > spec.xMin && x < spec.xMax && !taken.has(x) && !xs.includes(x)) xs.push(x);
    }
  }
  let horizontal = spec.yMax - 1;
  for (let d = 1; d <= spec.yMax - spec.yMin; d++) {
    const candidates = [spec.yMax - d, spec.yMin + d];
    const pick = candidates.find((y) => y > spec.yMin && y < spec.yMax && y !== r.horizontal);
    if (pick !== undefined) {
      horizontal = pick;
      break;
    }
  }
  return { vertical: xs.sort((a, b) => a - b), horizontal };
}

// ── the self-check ───────────────────────────────────────────────────────────
/**
 * Two parameter sets draw the SAME graph. Graded on the graph, not the
 * parameters, so a scholar who builds an equivalent curve is never marked
 * wrong:
 *   • linear: only the slope a·b and the line matter, so any anchor on the
 *     target line passes and a flip is the same as negating a;
 *   • quadratic, abs (even): a flip left–right changes nothing, so it is
 *     never required and never wrong;
 *   • cubic, reciprocal (odd): f(−u) = −f(u), so a flip equals negating a;
 *   • exp2: a·2^(b(x−h)) = (a·2^(−bh))·2^(bx), so h trades for doubling a;
 *   • sqrt, log2: (a, b, h, k) is unique — the flip decides which way it runs.
 */
export function functionGraphTransformsEquivalent(
  parent: FunctionGraphParent,
  p: FunctionGraphTransform,
  q: FunctionGraphTransform,
): boolean {
  const pb = functionGraphB(p);
  const qb = functionGraphB(q);
  switch (parent) {
    case "linear":
      return eq(p.a * pb, q.a * qb) && eq(p.k - p.a * pb * p.h, q.k - q.a * qb * q.h);
    case "quadratic":
    case "abs":
      return eq(p.a, q.a) && eq(p.h, q.h) && eq(p.k, q.k);
    case "cubic":
    case "reciprocal":
      return eq(p.a * pb, q.a * qb) && eq(p.h, q.h) && eq(p.k, q.k);
    case "exp2": {
      const scale = (t: FunctionGraphTransform, b: number) => t.a * Math.pow(2, -b * t.h);
      return (
        pb === qb &&
        eq(p.k, q.k) &&
        Math.abs(scale(p, pb) - scale(q, qb)) <= 1e-9 * Math.max(1, Math.abs(scale(q, qb)))
      );
    }
    case "sqrt":
    case "log2":
      return pb === qb && eq(p.a, q.a) && eq(p.h, q.h) && eq(p.k, q.k);
  }
}


/** The end behaviour a polynomial target implies (degree parity + leading sign). */
export function functionGraphTargetEnds(zeros: FunctionGraphZero[], leading: number): {
  leftUp: boolean;
  rightUp: boolean;
} {
  const degree = zeros.reduce((s, z) => s + z.multiplicity, 0);
  const rightUp = leading > 0;
  return { rightUp, leftUp: degree % 2 === 0 ? rightUp : !rightUp };
}

export function functionGraphSolved(spec: FunctionGraphSpec, state: unknown): boolean {
  const g = spec?.goal;
  if (!g || !state || typeof state !== "object") return false;
  if (g.type === "matchTransform") {
    const s = state as Partial<FunctionGraphTransformState>;
    if (!isFiniteNum(s.a) || !isFiniteNum(s.h) || !isFiniteNum(s.k)) return false;
    if (s.b !== undefined && s.b !== 1 && s.b !== -1) return false;
    return functionGraphTransformsEquivalent(g.parent, { a: s.a, h: s.h, k: s.k, b: s.b }, g.target);
  }
  if (g.type === "placeZeros") {
    const s = state as Partial<FunctionGraphZerosState>;
    if (!Array.isArray(s.zeros) || typeof s.leftUp !== "boolean" || typeof s.rightUp !== "boolean") return false;
    if (s.zeros.length !== g.zeros.length) return false;
    const seen = new Set<number>();
    for (const z of s.zeros) {
      if (!z || !isFiniteNum(z.x) || typeof z.touch !== "boolean" || seen.has(z.x)) return false;
      seen.add(z.x);
      const target = g.zeros.find((t) => eq(t.x, z.x));
      if (!target || z.touch !== (target.multiplicity % 2 === 0)) return false;
    }
    const ends = functionGraphTargetEnds(g.zeros, g.leading);
    return s.leftUp === ends.leftUp && s.rightUp === ends.rightUp;
  }
  if (g.type === "placeAsymptotes") {
    const s = state as Partial<FunctionGraphAsymptotesState>;
    if (!Array.isArray(s.vertical) || !isFiniteNum(s.horizontal)) return false;
    if (!eq(s.horizontal, g.rational.horizontal)) return false;
    const mine = [...s.vertical].sort((a, b) => a - b);
    const want = [...g.rational.vertical].sort((a, b) => a - b);
    return mine.length === want.length && mine.every((x, i) => isFiniteNum(x) && eq(x, want[i]));
  }
  return assertNoUnhandledGoal(g);
}

function assertNoUnhandledGoal(_goal: never): false {
  return false;
}

// ── interaction model (shared by both renderers) ─────────────────────────────
export interface MathPoint {
  x: number;
  y: number;
}

/** Where the anchor and the stretch handle sit for these parameters. */
export function functionGraphHandles(
  parent: FunctionGraphParent,
  t: FunctionGraphTransform,
): { anchor: MathPoint; scale: MathPoint } {
  const hd = FUNCTION_GRAPH_HANDLES[parent];
  const b = functionGraphB(t);
  return {
    anchor: { x: t.h + b * hd.x0, y: t.k },
    scale: { x: t.h + b * hd.u, y: t.k + t.a * hd.fu },
  };
}

/** The range of h that keeps both handles' x inside the window for this flip. */
function hRange(spec: FunctionGraphSpec, parent: FunctionGraphParent, b: 1 | -1): [number, number] {
  const hd = FUNCTION_GRAPH_HANDLES[parent];
  const offsets = [b * hd.x0, b * hd.u];
  return [spec.xMin - Math.min(...offsets), spec.xMax - Math.max(...offsets)];
}

/** The a-values whose stretch handle stays inside the window at this k. */
function fittingAValues(spec: FunctionGraphSpec, parent: FunctionGraphParent, k: number): number[] {
  const fu = FUNCTION_GRAPH_HANDLES[parent].fu;
  return FUNCTION_GRAPH_A_VALUES.filter((a) => {
    const y = k + a * fu;
    return y >= spec.yMin - EPS && y <= spec.yMax + EPS;
  });
}

function nearest(values: number[], target: number): number | null {
  let best: number | null = null;
  for (const v of values) if (best === null || Math.abs(v - target) < Math.abs(best - target)) best = v;
  return best;
}

/**
 * Drag the anchor to a raw math point: h and k snap to whole units and stay in
 * the window (with room for the stretch handle to its right). If the stretch
 * handle would leave the window at the new height, `a` moves to the nearest
 * stretch that still fits, so both handles stay grabbable.
 */
export function functionGraphMoveAnchor(
  spec: FunctionGraphSpec,
  parent: FunctionGraphParent,
  t: FunctionGraphTransform,
  raw: MathPoint,
): FunctionGraphTransform {
  const hd = FUNCTION_GRAPH_HANDLES[parent];
  const b = functionGraphB(t);
  const [lo, hi] = hRange(spec, parent, b);
  const h = clampNum(Math.round(raw.x) - b * hd.x0, lo, hi);
  const k = clampNum(Math.round(raw.y), spec.yMin, spec.yMax);
  const fits = fittingAValues(spec, parent, k);
  const a = fits.some((v) => eq(v, t.a)) ? t.a : (nearest(fits, t.a) ?? t.a);
  return { a, h, k, b };
}

/**
 * The "Flip left–right" button: b → −b, keeping the anchor where it is (so a
 * flip reads as a mirror in the vertical line through it). At the window's
 * edge the anchor shifts in just far enough for the stretch handle to fit.
 */
export function functionGraphFlip(
  spec: FunctionGraphSpec,
  parent: FunctionGraphParent,
  t: FunctionGraphTransform,
): FunctionGraphTransform {
  const hd = FUNCTION_GRAPH_HANDLES[parent];
  const b = functionGraphB(t);
  const nb: 1 | -1 = b === 1 ? -1 : 1;
  const anchorX = t.h + b * hd.x0;
  const [lo, hi] = hRange(spec, parent, nb);
  return { ...t, h: clampNum(anchorX - nb * hd.x0, lo, hi), b: nb };
}

/** Drag the stretch handle to a raw height: a snaps to the nearest allowed value. */
export function functionGraphSetScale(
  spec: FunctionGraphSpec,
  parent: FunctionGraphParent,
  t: FunctionGraphTransform,
  rawY: number,
): FunctionGraphTransform {
  const fu = FUNCTION_GRAPH_HANDLES[parent].fu;
  const a = nearest(fittingAValues(spec, parent, t.k), (rawY - t.k) / fu);
  return a === null ? t : { ...t, a, b: functionGraphB(t) };
}

/** Snap a dragged x onto a whole unit strictly inside the window (a zero marker, a vertical line). */
export function functionGraphSnapX(spec: FunctionGraphSpec, rawX: number): number {
  return clampNum(Math.round(rawX), spec.xMin + 1, spec.xMax - 1);
}

/** Snap a dragged y onto a whole unit strictly inside the window (the horizontal line). */
export function functionGraphSnapY(spec: FunctionGraphSpec, rawY: number): number {
  return clampNum(Math.round(rawY), spec.yMin + 1, spec.yMax - 1);
}

/**
 * A zero marker as a renderer holds it: `x` null while it sits in the tray.
 * The touch flag survives a trip back to the tray.
 */
export interface FunctionGraphZeroSlot {
  x: number | null;
  touch: boolean;
}

export function functionGraphInitialSlots(spec: FunctionGraphSpec): FunctionGraphZeroSlot[] {
  const n = spec.goal.type === "placeZeros" ? spec.goal.zeros.length : 0;
  return Array.from({ length: n }, () => ({ x: null, touch: false }));
}

/** The graded state for a set of slots (placed markers only, left to right). */
export function functionGraphZerosState(
  slots: FunctionGraphZeroSlot[],
  leftUp: boolean,
  rightUp: boolean,
): FunctionGraphZerosState {
  const zeros = slots
    .filter((s): s is { x: number; touch: boolean } => s.x !== null)
    .map((s) => ({ x: s.x, touch: s.touch }))
    .sort((a, b) => a.x - b.x);
  return { zeros, leftUp, rightUp };
}

/**
 * Drop marker `index` at a raw x. Returns the new slots; a drop onto an x
 * another marker already holds, or outside the plot, sends it back to the tray.
 */
export function functionGraphDropZero(
  spec: FunctionGraphSpec,
  slots: FunctionGraphZeroSlot[],
  index: number,
  rawX: number | null,
): FunctionGraphZeroSlot[] {
  const x = rawX === null ? null : functionGraphSnapX(spec, rawX);
  const clash = x !== null && slots.some((s, i) => i !== index && s.x === x);
  return slots.map((s, i) => (i === index ? { ...s, x: clash ? null : x } : s));
}

/** What the sketch draws for the current choices: multiplicity 2 for a bounce, the right end sets the sign. */
export function functionGraphSketchInput(state: FunctionGraphZerosState): {
  zeros: FunctionGraphZero[];
  leading: number;
} {
  return {
    zeros: state.zeros.map((z) => ({ x: z.x, multiplicity: z.touch ? 2 : 1 })),
    leading: state.rightUp ? 1 : -1,
  };
}

// ── board layout (shared pixel geometry) ─────────────────────────────────────
export interface FunctionGraphRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FunctionGraphLayout {
  width: number;
  height: number;
  plotLeft: number;
  plotTop: number;
  plotWidth: number;
  plotHeight: number;
  /** Pixels per math unit, the same on both axes. */
  unit: number;
  /** Label every Nth whole unit, so labels never collide. */
  labelStep: number;
  /** Font size of the axis numbers. */
  tickFontSize: number;
  /** True when the controls sit in a column beside the plot (a short, wide frame). */
  sideBySide: boolean;
  /** placeZeros: where unplaced markers wait — under the plot, or the side column. */
  tray: FunctionGraphRect | null;
  /** matchTransform with a flip to offer: where the "Flip left–right" button goes. */
  controls: FunctionGraphRect | null;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

/**
 * The space a renderer can give the board. `height` is the most the board may
 * be tall (the iPad practice card in landscape — see
 * FUNCTION_GRAPH_LANDSCAPE_BOARD_HEIGHT); leave it out where the page scrolls.
 */
export interface FunctionGraphFrame {
  width: number;
  height?: number;
}

/** Room either side of the plot for the end-behaviour arrows and handle overhang. */
export const FUNCTION_GRAPH_SIDE_MARGIN = 46;
/** Width of the side column that holds the tray or the flip button. */
export const FUNCTION_GRAPH_SIDE_COLUMN = 164;
/** Height of the "Flip left–right" button (≥ the 44pt touch floor). */
export const FUNCTION_GRAPH_CONTROL_HEIGHT = 46;
/** Height of the hint line at the top of the tray. */
export const FUNCTION_GRAPH_TRAY_HINT = 44;
const TOP_MARGIN = 16;
const BOTTOM_MARGIN = 26;
const TRAY_HEIGHT = 92;
const COLUMN_GAP = 10;
const MAX_PLOT_HEIGHT = 420;

/**
 * The tallest the board may be inside the iPad practice card in landscape
 * (1180×820pt): the screen less the header (96), the "Build it" row (50), the
 * pinned Done lane and "I haven't learned this yet" (130), the card's padding
 * (36) and its concept + prompt + gap (64), and a little breathing room (12).
 */
export const FUNCTION_GRAPH_LANDSCAPE_CHROME = 96 + 50 + 130 + 36 + 64 + 12;
export const FUNCTION_GRAPH_LANDSCAPE_BOARD_HEIGHT = 820 - FUNCTION_GRAPH_LANDSCAPE_CHROME;

/**
 * Offer the "Flip left–right" button only where a flip can change the graph.
 * For an even parent (x², |x|) it would be a control that does nothing.
 */
export function functionGraphFlipOffered(parent: FunctionGraphParent): boolean {
  return parent !== "quadratic" && parent !== "abs";
}

function boardControls(spec: FunctionGraphSpec): "tray" | "flip" | null {
  const g = spec.goal;
  if (g.type === "placeZeros") return "tray";
  if (g.type === "matchTransform" && functionGraphFlipOffered(g.parent)) return "flip";
  return null;
}

function labelStepFor(unit: number): number {
  return unit >= 24 ? 1 : unit >= 12 ? 2 : 5;
}

function stackedLayout(spec: FunctionGraphSpec, frame: FunctionGraphFrame, spanX: number, spanY: number): FunctionGraphLayout {
  const controls = boardControls(spec);
  const below = controls === "tray" ? TRAY_HEIGHT + 6 : controls === "flip" ? FUNCTION_GRAPH_CONTROL_HEIGHT + 8 : 0;
  const room = Math.max(160, frame.width - 2 * FUNCTION_GRAPH_SIDE_MARGIN);
  const tallest = Math.min(MAX_PLOT_HEIGHT, (frame.height ?? Infinity) - TOP_MARGIN - BOTTOM_MARGIN - below);
  const unit = Math.max(8, Math.min(room / spanX, tallest / spanY));
  const plotWidth = unit * spanX;
  const plotHeight = unit * spanY;
  const width = plotWidth + 2 * FUNCTION_GRAPH_SIDE_MARGIN;
  const belowTop = TOP_MARGIN + plotHeight + BOTTOM_MARGIN;
  return {
    width,
    height: belowTop + below,
    plotLeft: FUNCTION_GRAPH_SIDE_MARGIN,
    plotTop: TOP_MARGIN,
    plotWidth,
    plotHeight,
    unit,
    labelStep: labelStepFor(unit),
    tickFontSize: Math.max(11, Math.min(14, unit * 0.5)),
    sideBySide: false,
    tray: controls === "tray" ? { x: FUNCTION_GRAPH_SIDE_MARGIN, y: belowTop, width: plotWidth, height: TRAY_HEIGHT } : null,
    controls:
      controls === "flip" ? { x: 0, y: belowTop + 2, width, height: FUNCTION_GRAPH_CONTROL_HEIGHT } : null,
    xMin: spec.xMin,
    xMax: spec.xMax,
    yMin: spec.yMin,
    yMax: spec.yMax,
  };
}

function sideLayout(spec: FunctionGraphSpec, frame: FunctionGraphFrame, spanX: number, spanY: number): FunctionGraphLayout {
  const controls = boardControls(spec);
  const room = Math.max(160, frame.width - 2 * FUNCTION_GRAPH_SIDE_MARGIN - COLUMN_GAP - FUNCTION_GRAPH_SIDE_COLUMN);
  const tallest = Math.min(MAX_PLOT_HEIGHT, (frame.height ?? Infinity) - TOP_MARGIN - BOTTOM_MARGIN);
  const unit = Math.max(8, Math.min(room / spanX, tallest / spanY));
  const plotWidth = unit * spanX;
  const plotHeight = unit * spanY;
  const columnX = FUNCTION_GRAPH_SIDE_MARGIN + plotWidth + FUNCTION_GRAPH_SIDE_MARGIN + COLUMN_GAP;
  const column = { x: columnX, y: TOP_MARGIN, width: FUNCTION_GRAPH_SIDE_COLUMN, height: plotHeight };
  return {
    width: columnX + FUNCTION_GRAPH_SIDE_COLUMN,
    height: TOP_MARGIN + plotHeight + BOTTOM_MARGIN,
    plotLeft: FUNCTION_GRAPH_SIDE_MARGIN,
    plotTop: TOP_MARGIN,
    plotWidth,
    plotHeight,
    unit,
    labelStep: labelStepFor(unit),
    tickFontSize: Math.max(11, Math.min(14, unit * 0.5)),
    sideBySide: true,
    tray: controls === "tray" ? column : null,
    controls: controls === "flip" ? { ...column, height: FUNCTION_GRAPH_CONTROL_HEIGHT } : null,
    xMin: spec.xMin,
    xMax: spec.xMax,
    yMin: spec.yMin,
    yMax: spec.yMax,
  };
}

/**
 * The board's pixel layout for a frame. The plot keeps square units and is
 * sized from BOTH the width and (when given) the height. With a height limit
 * and a control to place (the tray, the flip button), the controls go in a
 * column beside the plot whenever that gives the bigger plot — the landscape
 * practice card is wide and short, so they land beside it there and under it
 * in portrait or on the web.
 */
export function functionGraphLayout(spec: FunctionGraphSpec, frame: FunctionGraphFrame): FunctionGraphLayout {
  const spanX = Math.max(1, spec.xMax - spec.xMin);
  const spanY = Math.max(1, spec.yMax - spec.yMin);
  const stacked = stackedLayout(spec, frame, spanX, spanY);
  if (frame.height === undefined || boardControls(spec) === null) return stacked;
  const side = sideLayout(spec, frame, spanX, spanY);
  return side.unit > stacked.unit + 1e-9 ? side : stacked;
}

export function functionGraphToPx(l: FunctionGraphLayout, p: MathPoint): MathPoint {
  return { x: l.plotLeft + (p.x - l.xMin) * l.unit, y: l.plotTop + (l.yMax - p.y) * l.unit };
}

export function functionGraphToMath(l: FunctionGraphLayout, px: MathPoint): MathPoint {
  return { x: l.xMin + (px.x - l.plotLeft) / l.unit, y: l.yMax - (px.y - l.plotTop) / l.unit };
}

/** True when a pixel point is over the plot (where a dropped marker lands on the axis). */
export function functionGraphPxInPlot(l: FunctionGraphLayout, px: MathPoint): boolean {
  return (
    px.x >= l.plotLeft - 4 &&
    px.x <= l.plotLeft + l.plotWidth + 4 &&
    px.y >= l.plotTop - 4 &&
    px.y <= l.plotTop + l.plotHeight + 4
  );
}

/**
 * Pixel centre of tray slot `i` of `n`: a row under the hint when the tray is
 * under the plot, a column under the hint when it is beside it.
 */
export function functionGraphTraySlot(l: FunctionGraphLayout, i: number, n: number): MathPoint {
  const tray = l.tray ?? { x: l.plotLeft, y: l.plotTop + l.plotHeight, width: l.plotWidth, height: TRAY_HEIGHT };
  const top = tray.y + FUNCTION_GRAPH_TRAY_HINT;
  const free = Math.max(1, tray.height - FUNCTION_GRAPH_TRAY_HINT);
  if (l.sideBySide) {
    const step = Math.min(64, free / Math.max(1, n));
    return { x: tray.x + tray.width / 2, y: top + step * (i + 0.5) };
  }
  return { x: tray.x + (tray.width * (i + 1)) / (n + 1), y: top + free / 2 };
}

/** Where the x-axis is drawn (y = 0 when visible, else the bottom edge). */
export function functionGraphAxisY(l: FunctionGraphLayout): number {
  const y = l.yMin <= 0 && l.yMax >= 0 ? 0 : l.yMin;
  return functionGraphToPx(l, { x: l.xMin, y }).y;
}

/** Where the y-axis is drawn, or null when x = 0 is off the plot. */
export function functionGraphAxisX(l: FunctionGraphLayout): number | null {
  return l.xMin <= 0 && l.xMax >= 0 ? functionGraphToPx(l, { x: 0, y: 0 }).x : null;
}

/** Whole-unit tick values to label along one axis, skipping 0 (the origin is labelled once). */
export function functionGraphTickValues(min: number, max: number, step: number): number[] {
  const out: number[] = [];
  for (let v = Math.ceil(min); v <= max; v++) if (v !== 0 && v % step === 0) out.push(v);
  return out;
}

/** Rough advance width of board text in the product font, for collision checks. */
function textWidth(text: string, fontSize: number): number {
  return text.length * fontSize * 0.62;
}

export interface FunctionGraphTickLabel {
  text: string;
  /** Anchor point: x is the centre ("middle") or right edge ("end"); y is the baseline. */
  x: number;
  y: number;
  anchor: "middle" | "end";
  box: FunctionGraphRect;
}

/**
 * Every axis number the board prints, positioned exactly as both renderers draw
 * them — the one list the renderers draw from and the anchor label avoids.
 */
export function functionGraphTickLabels(l: FunctionGraphLayout): FunctionGraphTickLabel[] {
  const f = l.tickFontSize;
  const axisY = functionGraphAxisY(l);
  const axisX = functionGraphAxisX(l) ?? l.plotLeft;
  const box = (text: string, x: number, y: number, anchor: "middle" | "end"): FunctionGraphRect => {
    const w = textWidth(text, f);
    return { x: anchor === "middle" ? x - w / 2 : x - w, y: y - f * 0.8, width: w, height: f };
  };
  const out: FunctionGraphTickLabel[] = [];
  for (const v of functionGraphTickValues(l.xMin, l.xMax, l.labelStep)) {
    const x = functionGraphToPx(l, { x: v, y: 0 }).x;
    const y = axisY + f + 4;
    out.push({ text: String(v), x, y, anchor: "middle", box: box(String(v), x, y, "middle") });
  }
  for (const v of functionGraphTickValues(l.yMin, l.yMax, l.labelStep)) {
    const x = axisX - 5;
    const y = functionGraphToPx(l, { x: 0, y: v }).y + f * 0.35;
    out.push({ text: String(v), x, y, anchor: "end", box: box(String(v), x, y, "end") });
  }
  if (functionGraphAxisX(l) !== null && l.yMin <= 0 && l.yMax >= 0) {
    const x = axisX - 5;
    const y = axisY + f + 4;
    out.push({ text: "0", x, y, anchor: "end", box: box("0", x, y, "end") });
  }
  return out;
}

export interface FunctionGraphAnchorLabel {
  text: string;
  /** Text anchor point (left edge, baseline) for `textAnchor="start"`. */
  x: number;
  y: number;
  fontSize: number;
  /** The label's box — the renderers draw a white backing here. */
  box: FunctionGraphRect;
}

const LABEL_FONT = 15;
const LABEL_PAD = 3;

function overlaps(a: FunctionGraphRect, b: FunctionGraphRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function segmentBox(p: MathPoint, q: MathPoint, pad: number): FunctionGraphRect {
  return {
    x: Math.min(p.x, q.x) - pad,
    y: Math.min(p.y, q.y) - pad,
    width: Math.abs(p.x - q.x) + 2 * pad,
    height: Math.abs(p.y - q.y) + 2 * pad,
  };
}

/**
 * Where the anchor's "(x, y)" readout goes: tried at points in a ring around the
 * anchor (8 directions × 4 distances) and placed at the first, nearest spot that
 * clears the stretch handle, its dotted step, both knobs and every axis number,
 * stays on the plot, and crosses the curve as little as possible. The
 * renderers draw it on a white backing, so a grid or asymptote line under it
 * never hurts legibility. `curveAt` is the live curve (NaN where undefined).
 */
export function functionGraphAnchorLabel(
  l: FunctionGraphLayout,
  parent: FunctionGraphParent,
  t: FunctionGraphTransform,
  curveAt: (x: number) => number,
): FunctionGraphAnchorLabel {
  const handles = functionGraphHandles(parent, t);
  const text = `(${num(handles.anchor.x)}, ${num(handles.anchor.y)})`;
  const anchor = functionGraphToPx(l, handles.anchor);
  const scale = functionGraphToPx(l, handles.scale);
  const corner = functionGraphToPx(l, { x: handles.scale.x, y: handles.anchor.y });
  const w = textWidth(text, LABEL_FONT) + 2 * LABEL_PAD;
  const h = LABEL_FONT + 2 * LABEL_PAD;
  const avoid: FunctionGraphRect[] = [
    { x: anchor.x - 17, y: anchor.y - 17, width: 34, height: 34 },
    { x: scale.x - 15, y: scale.y - 15, width: 30, height: 30 },
    segmentBox(anchor, corner, 3),
    segmentBox(corner, scale, 3),
    ...functionGraphTickLabels(l).map((tick) => tick.box),
  ];
  const plot = { x: l.plotLeft, y: l.plotTop, width: l.plotWidth, height: l.plotHeight };
  const inside = (r: FunctionGraphRect) =>
    r.x >= plot.x && r.y >= plot.y && r.x + r.width <= plot.x + plot.width && r.y + r.height <= plot.y + plot.height;
  const curveHits = (r: FunctionGraphRect) => {
    let hits = 0;
    for (let i = 0; i <= 8; i++) {
      const px = r.x + (r.width * i) / 8;
      const y = curveAt(functionGraphToMath(l, { x: px, y: 0 }).x);
      if (!Number.isFinite(y)) continue;
      const py = functionGraphToPx(l, { x: 0, y }).y;
      if (py >= r.y - 2 && py <= r.y + r.height + 2) hits++;
    }
    return hits;
  };
  let best: { box: FunctionGraphRect; score: number } | null = null;
  const angles = [135, 225, 45, 315, 180, 90, 270, 0];
  for (const radius of [30, 44, 60, 80]) {
    for (const deg of angles) {
      const rad = (deg * Math.PI) / 180;
      const cx = anchor.x + Math.cos(rad) * (radius + w / 2 - 12);
      const cy = anchor.y - Math.sin(rad) * (radius - 6);
      const box = { x: cx - w / 2, y: cy - h / 2, width: w, height: h };
      let score = radius;
      if (!inside(box)) score += 10_000;
      if (avoid.some((r) => overlaps(box, r))) score += 5_000;
      score += curveHits(box) * 120;
      if (!best || score < best.score) best = { box, score };
    }
  }
  const box = best!.box;
  return { text, x: box.x + LABEL_PAD, y: box.y + LABEL_PAD + LABEL_FONT * 0.8, fontSize: LABEL_FONT, box };
}

// ── equation text (goalText, dev gallery, library prompts) ───────────────────
function num(n: number): string {
  if (Number.isInteger(n)) return String(n);
  for (const den of [2, 3, 4, 5, 6, 8]) {
    const top = n * den;
    if (Math.abs(top - Math.round(top)) < 1e-9) return `${Math.round(top)}/${den}`;
  }
  return String(Math.round(n * 100) / 100);
}
function signedNum(n: number): string {
  return n < 0 ? `−${num(-n)}` : num(n);
}
/** "x − 3", "x + 2", "x" */
function shifted(h: number): string {
  if (h === 0) return "x";
  return h > 0 ? `x − ${num(h)}` : `x + ${num(-h)}`;
}
/** " + 1", " − 4", "" */
function plusConst(k: number): string {
  if (k === 0) return "";
  return k > 0 ? ` + ${num(k)}` : ` − ${num(-k)}`;
}
/**
 * A stretch as written in an equation: "2", "−3", and ±½ as the single glyph
 * "½" — "1/2(x + 2)²" reads as 1/(2(x + 2)²) in tutor text.
 */
function stretchNum(a: number): string {
  if (eq(Math.abs(a), 0.5)) return a < 0 ? "−½" : "½";
  return signedNum(a);
}
/** Coefficient prefix: "" for 1, "−" for −1, "2" / "−½" otherwise. */
function coefficient(a: number): string {
  if (a === 1) return "";
  if (a === -1) return "−";
  return stretchNum(a);
}
const SUPERSCRIPT: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
};
function superscript(n: number): string {
  return String(n)
    .split("")
    .map((d) => SUPERSCRIPT[d] ?? d)
    .join("");
}

/** "3 − x", "−x − 2", "−x": the flipped inner b(x − h) with b = −1, as h − x. */
function flippedInner(h: number): string {
  if (h === 0) return "−x";
  return `${signedNum(h)} − x`;
}

/**
 * "y = −2|x − 3| + 1", "y = (x + 1)³ − 2", "y = 3 · 2^(x − 1)", "y = log₂(x − 1)";
 * flipped (b = −1): "y = √(−x)", "y = 2^(3 − x)", "y = log₂(1 − x) + 2".
 */
export function functionGraphTransformEquation(parent: FunctionGraphParent, t: FunctionGraphTransform): string {
  const c = coefficient(t.a);
  const flipped = functionGraphB(t) === -1;
  const inner = flipped ? flippedInner(t.h) : shifted(t.h);
  const group = !flipped && t.h === 0 ? "x" : `(${inner})`;
  let body: string;
  switch (parent) {
    case "linear":
      body = `${c}${group}`;
      break;
    case "quadratic":
      body = `${c}${group}²`;
      break;
    case "cubic":
      body = `${c}${group}³`;
      break;
    case "abs":
      body = `${c}|${inner}|`;
      break;
    case "sqrt":
      body = `${c}√${group}`;
      break;
    case "exp2":
      body = `${c === "" || c === "−" ? c : `${c} · `}2^${group}`;
      break;
    case "log2":
      body = `${c}log₂(${inner})`;
      break;
    case "reciprocal":
      body = `${stretchNum(t.a)}/${group}`;
      break;
  }
  return `y = ${body}${plusConst(t.k)}`;
}

/** "y = −(x − 1)²(x + 3)" */
export function functionGraphPolynomialEquation(zeros: FunctionGraphZero[], leading: number): string {
  const factors = [...zeros]
    .sort((p, q) => q.x - p.x)
    .map((z) => `${z.x === 0 ? "x" : `(${shifted(z.x)})`}${z.multiplicity === 1 ? "" : superscript(z.multiplicity)}`)
    .join("");
  return `y = ${coefficient(leading)}${factors || "1"}`;
}

/** "y = 3/(x − 2) + 1", "y = −2/((x − 1)(x + 2))" */
export function functionGraphRationalEquation(r: FunctionGraphRational): string {
  const factors = r.vertical.map((v) => (v === 0 ? "x" : `(${shifted(v)})`));
  const den = factors.length === 1 ? factors[0] : `(${factors.join("")})`;
  return `y = ${signedNum(r.scale)}/${den}${plusConst(r.horizontal)}`;
}

// ── tutor describers ─────────────────────────────────────────────────────────
const SHAPE: Record<FunctionGraphParent, string> = {
  linear: "line",
  quadratic: "parabola",
  cubic: "cubic curve",
  abs: "V",
  sqrt: "square-root curve",
  exp2: "exponential curve",
  log2: "log curve",
  reciprocal: "hyperbola",
};
const FLIPPED_WORDS = "flipped left–right";
const ANCHOR: Record<FunctionGraphParent, string> = {
  linear: "anchor point",
  quadratic: "vertex",
  cubic: "centre point",
  abs: "corner",
  sqrt: "starting point",
  exp2: "anchor on its asymptote",
  log2: "x-intercept point",
  reciprocal: "centre where its asymptotes cross",
};

function orientation(parent: FunctionGraphParent, a: number, b: 1 | -1 = 1): string {
  const up = a > 0;
  const right = b === 1;
  switch (parent) {
    case "linear":
      return `slopes ${a * b > 0 ? "upward" : "downward"} (slope ${signedNum(a * b)})`;
    case "quadratic":
    case "abs":
      return `opens ${up ? "upward" : "downward"}`;
    case "cubic":
      return a * b > 0 ? "rises from left to right" : "falls from left to right";
    case "sqrt":
      return `curves ${up ? "up" : "down"} and to the ${right ? "right" : "left"} from its start`;
    case "exp2":
      return `sits ${up ? "above" : "below"} its asymptote and grows steeper to the ${right ? "right" : "left"}`;
    case "log2":
      return `runs to the ${right ? "right" : "left"} of its asymptote and ${up === right ? "rises" : "falls"} from left to right`;
    case "reciprocal":
      return a * b > 0 ? "has its branches top-right and bottom-left" : "has its branches top-left and bottom-right";
  }
}

function stretchWords(a: number): string {
  const m = Math.abs(a);
  if (eq(m, 1)) return "with no stretch";
  return m > 1 ? `stretched by a factor of ${num(m)}` : `squashed to ${num(m)} of its height`;
}

function endWord(up: boolean): string {
  return up ? "up" : "down";
}

export function functionGraphGoalText(spec: FunctionGraphSpec): string {
  const g = spec.goal;
  if (g.type === "matchTransform") {
    const controls = `The faint curve is the parent ${functionGraphTransformEquation(g.parent, { a: 1, h: 0, k: 0 })}; drag its ${ANCHOR[g.parent]} to shift it, drag the second handle to stretch it or flip it upside down, and use the "Flip left–right" button to reflect it across a vertical line.`;
    if (g.targetUnstated) {
      // COMPUTE-STYLE: the prompt describes the graph without giving its rule
      // (an inverse, say). Working the rule out is the task, so it is never named.
      return `The prompt asks: "${spec.prompt}" It does not give the rule to build: the scholar has to work that rule out, then shape the curve to match it. ${controls}`;
    }
    // Not compute-style: the target equation IS the stated task.
    return `Shape the curve into the graph of ${functionGraphTransformEquation(g.parent, g.target)}. ${controls}`;
  }
  if (g.type === "placeZeros") {
    // COMPUTE-STYLE: the polynomial is given; its zeros, bounces and end
    // behaviour are the answer and are never listed.
    return `Sketch ${functionGraphPolynomialEquation(g.zeros, g.leading)}: drag a marker to each place the graph meets the x-axis, tap each marker to say whether the graph crosses or bounces there, and set which way each end of the graph points.`;
  }
  if (g.type === "placeAsymptotes") {
    // COMPUTE-STYLE: the rule is given; where its asymptotes sit is the answer.
    const n = g.rational.vertical.length;
    const lines = `${n === 1 ? "one vertical line" : `${n} vertical lines`} and one horizontal line`;
    if ((g.rational.holes ?? []).length > 0) {
      // The hole's location is part of the answer: say only that one exists.
      return `Drag the dashed lines onto the asymptotes of the function in the prompt, which simplifies to ${functionGraphRationalEquation(g.rational)} wherever it is defined: ${lines}. Its cancelled factor makes a hole in the graph, and a hole is not an asymptote.`;
    }
    return `Drag the dashed lines onto the asymptotes of ${functionGraphRationalEquation(g.rational)}: ${lines}.`;
  }
  return assertNoUnhandledGoalText(g);
}

function assertNoUnhandledGoalText(_goal: never): string {
  return "Shape the graph the way the prompt asks.";
}

function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/**
 * What the board shows right now, in words a tutor can use ("you moved the
 * vertex to (3, 1) and left it opening upward"). For matchTransform it also
 * compares against the GIVEN equation, which is the stated task — unless the
 * goal is `targetUnstated`, when it describes only the built curve and whether
 * it matches; for the two compute-style goals it never mentions the target.
 */
export function functionGraphDescribeState(spec: FunctionGraphSpec, state: unknown): string {
  const g: FunctionGraphGoal = spec.goal;
  if (g.type === "matchTransform") {
    const s = state as FunctionGraphTransformState;
    if (!isFiniteNum(s?.a) || !isFiniteNum(s?.h) || !isFiniteNum(s?.k)) return "The curve hasn't been moved yet.";
    const { anchor } = functionGraphHandles(g.parent, s);
    const b = functionGraphB(s);
    const tb = functionGraphB(g.target);
    const flipWords = b === -1 ? ` It is ${FLIPPED_WORDS}.` : "";
    const now = `The ${SHAPE[g.parent]}'s ${ANCHOR[g.parent]} is at (${num(anchor.x)}, ${num(anchor.y)}) and the stretch handle sets a = ${stretchNum(s.a)}, so it ${orientation(g.parent, s.a, b)}, ${stretchWords(s.a)}.${flipWords}`;
    if (g.targetUnstated) {
      // COMPUTE-STYLE: the prompt never states the target rule, so describe
      // only what was built — its rule, anchor and direction — and whether it
      // is right, never what the target looks like.
      const built = functionGraphTransformEquation(g.parent, { a: s.a, h: s.h, k: s.k, b });
      const verdict = functionGraphTransformsEquivalent(g.parent, s, g.target)
        ? "That is the graph the prompt asks for."
        : "That is not yet the graph the prompt asks for.";
      return `${now} The curve on the board is ${built}. ${verdict}`;
    }
    if (functionGraphTransformsEquivalent(g.parent, s, g.target)) {
      return `${now} That is exactly the graph of the equation in the prompt.`;
    }
    const gaps: string[] = [];
    // For sqrt, exp2 and log2 the left–right flip is its own move; for the odd
    // parents (and a line) a flip is the same as flipping upside down, so only
    // the combined sign a·b is compared; for the even parents b is irrelevant.
    const flipIsOwnMove = g.parent === "sqrt" || g.parent === "exp2" || g.parent === "log2";
    const signed = (a: number, bb: 1 | -1) =>
      g.parent === "linear" || g.parent === "cubic" || g.parent === "reciprocal" ? a * bb : a;
    const targetLooks = `the target ${orientation(g.parent, g.target.a, tb)}`;
    if (flipIsOwnMove && b !== tb) {
      gaps.push(
        b === 1
          ? `it still needs a flip left–right (${targetLooks})`
          : `it is ${FLIPPED_WORDS} but the target is not (${targetLooks})`,
      );
    }
    if (Math.sign(signed(s.a, b)) !== Math.sign(signed(g.target.a, tb))) {
      gaps.push(`the upside-down reflection doesn't match (${targetLooks})`);
    } else if (!eq(Math.abs(s.a), Math.abs(g.target.a))) {
      gaps.push(`the stretch doesn't match (the target is ${stretchWords(g.target.a)})`);
    }
    const target = functionGraphHandles(g.parent, g.target).anchor;
    if (!eq(anchor.x, target.x) || !eq(anchor.y, target.y)) {
      gaps.push(`the ${ANCHOR[g.parent]} is not where the equation puts it`);
    }
    if (gaps.length === 0) gaps.push("it is not yet the same graph");
    return `${now} Compared with the equation in the prompt, ${list(gaps)}.`;
  }
  if (g.type === "placeZeros") {
    const s = state as FunctionGraphZerosState;
    if (!Array.isArray(s?.zeros)) return "No markers have been placed yet.";
    const placed = [...s.zeros]
      .sort((a, b) => a.x - b.x)
      .map((z) => `x = ${num(z.x)} (${z.touch ? "bounces" : "crosses"})`);
    const left = Math.max(0, g.zeros.length - placed.length);
    const markers =
      placed.length === 0
        ? "No markers are on the x-axis yet"
        : `Markers sit on the x-axis at ${list(placed)}`;
    const tray = left > 0 ? `; ${left} marker${left === 1 ? " is" : "s are"} still in the tray` : "";
    return `${markers}${tray}. The left end points ${endWord(!!s.leftUp)} and the right end points ${endWord(!!s.rightUp)}.`;
  }
  if (g.type === "placeAsymptotes") {
    const s = state as FunctionGraphAsymptotesState;
    if (!Array.isArray(s?.vertical)) return "The dashed lines haven't been moved yet.";
    const v = [...s.vertical].sort((a, b) => a - b).map((x) => `x = ${num(x)}`);
    const verticals = v.length === 1 ? `The vertical dashed line is at ${v[0]}` : `The vertical dashed lines are at ${list(v)}`;
    const horizontal = isFiniteNum(s.horizontal) ? `the horizontal dashed line is at y = ${num(s.horizontal)}` : "there is no horizontal line";
    return `${verticals}, and ${horizontal}.`;
  }
  return assertNoUnhandledGoalText(g);
}

// ── authoring guard ──────────────────────────────────────────────────────────
function windowIsUsable(spec: FunctionGraphSpec): boolean {
  const { xMin, xMax, yMin, yMax } = spec;
  if (![xMin, xMax, yMin, yMax].every(isInt)) return false;
  const spanX = xMax - xMin;
  const spanY = yMax - yMin;
  return spanX >= 4 && spanX <= 24 && spanY >= 4 && spanY <= 24;
}

function handlesFit(spec: FunctionGraphSpec, parent: FunctionGraphParent, t: FunctionGraphTransform): boolean {
  const { anchor, scale } = functionGraphHandles(parent, t);
  const inX = (x: number) => x >= spec.xMin && x <= spec.xMax;
  const inY = (y: number) => y >= spec.yMin - EPS && y <= spec.yMax + EPS;
  return inX(anchor.x) && inX(scale.x) && inY(anchor.y) && inY(scale.y);
}

/**
 * Gradable iff the window is a whole-unit grid of a sensible size, the goal is
 * reachable with the board's snapping (whole-unit h, k, zeros and lines; `a`
 * from FUNCTION_GRAPH_A_VALUES), every target fits on screen, an asymptote
 * board starts with as many vertical lines as its answer, and the board does
 * not start solved.
 */
export function functionGraphGoalIsUsable(spec: FunctionGraphSpec): boolean {
  const g = spec.goal;
  if (!g || !windowIsUsable(spec)) return false;
  if (g.type === "matchTransform") {
    if (!isFunctionGraphParent(g.parent) || !g.target) return false;
    const { a, h, k } = g.target;
    if (!isFiniteNum(a) || !FUNCTION_GRAPH_A_VALUES.some((v) => eq(v, a))) return false;
    if (!isInt(h) || !isInt(k)) return false;
    if (g.target.b !== undefined && g.target.b !== 1 && g.target.b !== -1) return false;
    if (g.targetUnstated !== undefined && g.targetUnstated !== true) return false;
    if (!handlesFit(spec, g.parent, g.target)) return false;
    if (!handlesFit(spec, g.parent, { a: 1, h: 0, k: 0 })) return false;
  } else if (g.type === "placeZeros") {
    if (!Array.isArray(g.zeros) || g.zeros.length < 1 || g.zeros.length > 5) return false;
    if (!isFiniteNum(g.leading) || g.leading === 0) return false;
    if (!(spec.yMin < 0 && spec.yMax > 0)) return false;
    const xs = new Set<number>();
    for (const z of g.zeros) {
      if (!z || !isInt(z.x) || z.x <= spec.xMin || z.x >= spec.xMax || xs.has(z.x)) return false;
      if (!isInt(z.multiplicity) || z.multiplicity < 1 || z.multiplicity > 4) return false;
      xs.add(z.x);
    }
  } else if (g.type === "placeAsymptotes") {
    const r = g.rational;
    if (!r || !Array.isArray(r.vertical) || r.vertical.length < 1 || r.vertical.length > 2) return false;
    if (new Set(r.vertical).size !== r.vertical.length) return false;
    if (!r.vertical.every((v) => isInt(v) && v > spec.xMin && v < spec.xMax)) return false;
    if (!isInt(r.horizontal) || r.horizontal <= spec.yMin || r.horizontal >= spec.yMax) return false;
    if (!isFiniteNum(r.scale) || r.scale === 0) return false;
    if (r.holes !== undefined) {
      if (!Array.isArray(r.holes) || r.holes.length > 2 || new Set(r.holes).size !== r.holes.length) return false;
      if (!r.holes.every((c) => isInt(c) && c > spec.xMin && c < spec.xMax && !r.vertical.includes(c))) return false;
    }
    // The board has no control that adds a line: it must start with exactly as
    // many vertical lines as the answer needs (a narrow window can leave too
    // few free whole-unit spots off the targets to place them all).
    if (initialAsymptotes(spec, r).vertical.length !== r.vertical.length) return false;
  } else {
    return false;
  }
  return !functionGraphSolved(spec, initialFunctionGraph(spec));
}
