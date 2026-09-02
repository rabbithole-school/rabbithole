/**
 * Pure logic for the Manipulative primitive: the runtime state shapes, the
 * self-check ("control of error") predicates, and the small geometry helpers.
 *
 * Everything here is pure and framework-free so it can be unit-tested without a
 * DOM and reused by a tutor/authoring layer. The renderer (kinds/*) owns only
 * the pixels + pointer handling; whether a challenge is *solved* is decided here.
 */

import type {
  ArraySpec,
  AreaPerimeterSpec,
  BalanceSpec,
  ClockSpec,
  CoordinatePlaneSpec,
  DiceEvent,
  DicePrediction,
  DiceSpec,
  DiceType,
  DistributeSpec,
  DistributorSpec,
  RekenrekSpec,
  FunctionMachineRule,
  FunctionMachineSpec,
  GeoLocateSpec,
  LiquidSpec,
  ManipulativeSpec,
  MoneySpec,
  MultiStepSequenceSpec,
  NumberLineSpec,
  PartitionDisc,
  PartitionSpec,
  PlaceValueSpec,
  ProtractorSpec,
  RiemannSpec,
  RulerSpec,
} from "./types";
import { formatMoney, MONEY_PIECES, moneyPieceCents, type MoneyDenomination } from "./currency";
import { isSolved as geoTaskSolved, type RegionResolver } from "../geomap/grade";
import type { GeoTaskState } from "../geomap/types";

// ── small utilities ──────────────────────────────────────────────────────────
export function approxEqual(a: number, b: number, tol = 1e-9): boolean {
  return Math.abs(a - b) <= tol;
}
export function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}
/** Snap `value` onto the nearest grid line in `[min, max]` at `step` spacing. */
export function snapToGrid(value: number, min: number, max: number, step: number): number {
  if (!(step > 0)) return clamp(value, min, max);
  const idx = Math.round((value - min) / step);
  return clamp(min + idx * step, min, max);
}
/** True when `{x,y}` both land exactly on a grid line (within FP dust). */
export function pointOnGrid(
  p: { x: number; y: number },
  xMin: number,
  xMax: number,
  yMin: number,
  yMax: number,
  step: number,
): boolean {
  if (!(step > 0)) return false;
  if (p.x < xMin - 1e-9 || p.x > xMax + 1e-9 || p.y < yMin - 1e-9 || p.y > yMax + 1e-9) return false;
  return approxEqual(snapToGrid(p.x, xMin, xMax, step), p.x, 1e-6) && approxEqual(snapToGrid(p.y, yMin, yMax, step), p.y, 1e-6);
}
/** Exact (epsilon) coordinate equality — the coordinatePlane grader's unit. */
export function pointsEqual(a: { x: number; y: number }, b: { x: number; y: number }, tol = 1e-9): boolean {
  return approxEqual(a.x, b.x, tol) && approxEqual(a.y, b.y, tol);
}
/**
 * Order-insensitive multiset match: true iff there's SOME one-to-one pairing
 * of `a` with `b` where every pair is equal. `a`/`b` are always tiny here
 * (≤3 draggable points), so brute-force permutation is plenty fast.
 */
export function pointSetsEqual(a: Array<{ x: number; y: number }>, b: Array<{ x: number; y: number }>): boolean {
  if (a.length !== b.length) return false;
  const used = new Array(b.length).fill(false);
  const tryMatch = (i: number): boolean => {
    if (i === a.length) return true;
    for (let j = 0; j < b.length; j++) {
      if (used[j] || !pointsEqual(a[i], b[j])) continue;
      used[j] = true;
      if (tryMatch(i + 1)) return true;
      used[j] = false;
    }
    return false;
  };
  return tryMatch(0);
}
/**
 * The missing 4th corner of an axis-aligned rectangle given exactly 3 of its
 * corners (in any order). A rectangle's 4 corners use exactly 2 distinct x
 * values and 2 distinct y values, 2 corners apiece — so among any 3 given
 * corners, one x value appears once (the missing corner's x) and one y value
 * appears once (the missing corner's y). Returns null if `corners` isn't
 * exactly 3 points forming a valid rectangle triple.
 */
export function rectangleMissingCorner(
  corners: Array<{ x: number; y: number }>,
): { x: number; y: number } | null {
  if (corners.length !== 3) return null;
  const lone = (values: number[]): number | null => {
    const groups: Array<{ value: number; count: number }> = [];
    for (const v of values) {
      const g = groups.find((g) => approxEqual(g.value, v, 1e-6));
      if (g) g.count++;
      else groups.push({ value: v, count: 1 });
    }
    if (groups.length !== 2) return null;
    const counts = groups.map((g) => g.count).sort((a, b) => a - b);
    if (counts[0] !== 1 || counts[1] !== 2) return null;
    return groups.find((g) => g.count === 1)!.value;
  };
  const x = lone(corners.map((c) => c.x));
  const y = lone(corners.map((c) => c.y));
  if (x == null || y == null) return null;
  return { x, y };
}
export function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a || 1;
}
/** Least positive common multiple; null for invalid periods. */
export function leastCommonMultiple(a: number, b: number): number | null {
  if (!Number.isInteger(a) || !Number.isInteger(b) || a <= 0 || b <= 0) return null;
  return (a / gcd(a, b)) * b;
}

/** Revealed positive multiples and their shared landings for a dual-track line. */
export function multipleTrackLandings(
  tracks: readonly [number, number] | undefined,
  value: number,
  max: number,
): { tracks: [number[], number[]]; common: number[] } {
  const limit = Math.min(value, max);
  if (!tracks || !Number.isFinite(limit)) return { tracks: [[], []], common: [] };
  const landings = tracks.map((period) => {
    if (!Number.isInteger(period) || period <= 0 || limit <= 0) return [];
    const multiples: number[] = [];
    for (let multiple = period; multiple <= limit; multiple += period) multiples.push(multiple);
    return multiples;
  }) as [number[], number[]];
  const second = new Set(landings[1]);
  return { tracks: landings, common: landings[0].filter((multiple) => second.has(multiple)) };
}

export function fractionValue(shaded: number, parts: number): number {
  return parts === 0 ? 0 : shaded / parts;
}
/** The integer height of a rectangle with the given perimeter and width. */
export function heightForPerimeter(perimeter: number, width: number): number {
  return perimeter / 2 - width;
}
/** The maximum integer area achievable for a rectangle of this (even) perimeter. */
export function maxAreaForPerimeter(perimeter: number): number {
  const half = perimeter / 2;
  let best = 0;
  for (let w = 1; w < half; w++) best = Math.max(best, w * (half - w));
  return best;
}
export function countFactorPairs(value: number): number {
  if (!Number.isInteger(value) || value <= 0) return 0;
  let count = 0;
  for (let factor = 1; factor * factor <= value; factor++) {
    if (value % factor === 0) count++;
  }
  return count;
}
export function answerSolved(answer: { value: number }, typedValue: string): boolean {
  if (typedValue.trim() === "") return false;
  return Number(typedValue) === answer.value;
}
/** Apply a (small, closed-set) function-machine rule to a single input. */
export function applyFunctionMachineRule(rule: FunctionMachineRule, input: number): number {
  return rule.m * input + rule.b;
}

// ── runtime state (the manipulable state, seeded from the spec) ──────────────
export interface PartitionState {
  discs: PartitionDisc[];
}
export interface NumberLineState {
  value: number;
}
export interface ArrayState {
  rows: number;
  cols: number;
}
export interface BalanceState {
  left: number;
  right: number;
}
export interface AreaPerimeterState {
  width: number;
}
export interface DistributeState {
  column: number;
}
export interface RekenrekState {
  /** How many beads are pushed to the LEFT across both rods (0..total); right = total-left. */
  left: number;
}
export interface DistributorState {
  /** Items dealt to EACH plate so far (0..floor(total/groups)). */
  perGroup: number;
}
export interface RiemannState {
  bars: number;
}
/** The scholar's live typed prediction for the query input (null = not yet typed). */
export interface FunctionMachineState {
  predicted: number | null;
}
/**
 * Base-ten counts, one per column, index-aligned to `PlaceValueSpec.places`.
 * For buildNumber/expandedForm each entry is the digit in that place; for
 * placeShift it is the current number's digit, which a ×10/÷10 slides across.
 */
export interface PlaceValueState {
  counts: number[];
}
/**
 * A committed dice prediction, always a fraction so one grader (value equality)
 * covers both an integer answer (`{num: k, den: 1}` for a count / most-likely
 * total) and a probability (`{num, den}`) — and any equivalent fraction passes.
 */
export interface DiceFraction {
  num: number;
  den: number;
}
/**
 * A single live angle in degrees, 0..180, always measured RELATIVE to the
 * spec's base ray — the free ray's placement (constructAngle, the only goal
 * mode).
 */
export interface ProtractorState {
  angleDeg: number;
}
export interface DiceState {
  /** How many throws the scholar has observed (drives the empirical chart; never graded). */
  rollCount: number;
  /** The committed prediction, or null until the scholar commits one. */
  predicted: DiceFraction | null;
}
/** Live SNAPPED positions of the draggable points, index-aligned with `spec.draggable`. */
export interface CoordinatePlaneState {
  points: Array<{ x: number; y: number }>;
}
/** Runtime state for a geoLocate item — the pins the scholar dropped. Aliased to
 *  the geomap contract's `GeoTaskState` so the map renderer, this predicate, and
 *  the server grader all speak the exact same shape. */
export type GeoLocateState = GeoTaskState;
/** The bar's free (right) end, in scale units. Its LENGTH is `end − start`. */
export interface RulerState {
  end: number;
}
/**
 * Minutes past 12 on the 12-hour dial, 0..719. ONE number, not `{hour, minute}`
 * — see the `ClockSpec` doc comment: a pair can express a face a geared clock
 * cannot make.
 */
export interface ClockState {
  minutes: number;
}
/** Live level in each jar, index-aligned to `LiquidSpec.vessels`. */
export interface LiquidState {
  levels: number[];
}
/** How many of each piece are in the tray, index-aligned to `MoneySpec.available`. */
export interface MoneyState {
  counts: number[];
}

export function initialPartition(spec: PartitionSpec): PartitionState {
  return { discs: spec.discs.map((d) => ({ ...d })) };
}
export function initialNumberLine(spec: NumberLineSpec): NumberLineState {
  return { value: spec.start };
}
/** Remove coordinate-conversion dust and return the authored snap-grid value. */
export function normalizeNumberLineValue(
  spec: NumberLineSpec,
  value: number,
): number {
  const normalized =
    spec.snap && spec.snap > 0
      ? spec.min + Math.round((value - spec.min) / spec.snap) * spec.snap
      : value;
  return Math.round(clamp(normalized, spec.min, spec.max) * 1e12) / 1e12;
}
export function initialArray(spec: ArraySpec): ArrayState {
  return { rows: spec.rows, cols: spec.cols };
}
export function initialBalance(spec: BalanceSpec): BalanceState {
  return { left: spec.left, right: spec.right };
}
export function initialAreaPerimeter(spec: AreaPerimeterSpec): AreaPerimeterState {
  return { width: spec.startWidth };
}
export function initialDistribute(spec: DistributeSpec): DistributeState {
  return { column: clamp(Math.round(spec.startColumn), 1, spec.width - 1) };
}
export function initialRekenrek(spec: RekenrekSpec): RekenrekState {
  return { left: clamp(Math.round(spec.startLeft ?? 0), 0, spec.total) };
}
/** The most items that can be dealt EQUALLY to every plate (the true quotient). */
export function distributorPerGroupMax(spec: DistributorSpec): number {
  if (spec.groups < 1) return 0;
  return Math.floor(spec.total / spec.groups);
}
export function initialDistributor(spec: DistributorSpec): DistributorState {
  return {
    perGroup: clamp(Math.round(spec.startPerGroup ?? 0), 0, distributorPerGroupMax(spec)),
  };
}
/** Items still in the leftover pile for a given per-plate deal (the remainder). */
export function distributorRemainder(spec: DistributorSpec, s: DistributorState): number {
  return spec.total - s.perGroup * spec.groups;
}
export function initialRiemann(spec: RiemannSpec): RiemannState {
  return { bars: clamp(Math.round(spec.startBars), spec.minBars ?? 1, spec.maxBars ?? 20) };
}
export function initialFunctionMachine(): FunctionMachineState {
  return { predicted: null };
}
/** Max bundles per column for a buildNumber/expandedForm placeValue (default 9,
 *  the single-digit standard form). Ignored by placeShift. */
export function placeValueMaxPerPlace(spec: PlaceValueSpec): number {
  const m = spec.maxPerPlace;
  return Number.isInteger(m) && (m as number) >= 1 ? (m as number) : 9;
}
/** The number a set of base-ten counts represents: Σ places[i] · counts[i]. */
export function placeValueTotal(spec: PlaceValueSpec, counts: number[]): number {
  return spec.places.reduce((sum, place, i) => sum + place * (counts[i] ?? 0), 0);
}
export function initialPlaceValue(spec: PlaceValueSpec): PlaceValueState {
  const max = placeValueMaxPerPlace(spec);
  // placeShift starts from the given number's digits (unclamped by max — a
  // pre-shift number can legitimately carry a digit that a later ×10 moves);
  // buildNumber/expandedForm start empty (all zero) unless a start is given.
  const cap = spec.mode === "placeShift" ? 9 : max;
  return {
    counts: spec.places.map((_, i) => clamp(Math.round(spec.start?.[i] ?? 0), 0, cap)),
  };
}
export function initialDice(): DiceState {
  return { rollCount: 0, predicted: null };
}
export function initialProtractor(spec: ProtractorSpec): ProtractorState {
  return { angleDeg: clamp(spec.startDeg, 0, 180) };
}
export function initialCoordinatePlane(spec: CoordinatePlaneSpec): CoordinatePlaneState {
  return {
    points: spec.draggable.map((d) => ({
      x: snapToGrid(d.start.x, spec.xMin, spec.xMax, spec.gridStep),
      y: snapToGrid(d.start.y, spec.yMin, spec.yMax, spec.gridStep),
    })),
  };
}
/** A fresh geoLocate board has no pins yet. */
export function initialGeoLocate(): GeoLocateState {
  return { pins: [] };
}

// ── ruler ────────────────────────────────────────────────────────────────────
/** The gradation the scale is drawn at and the free end snaps to (default 1). */
export function rulerPrecision(spec: RulerSpec): number {
  const p = spec.precision;
  return Number.isFinite(p) && (p as number) > 0 ? (p as number) : 1;
}
/** Where the bar's LEFT edge is pinned (the broken-ruler offset; default 0). */
export function rulerStart(spec: RulerSpec): number {
  return clamp(spec.startAt ?? 0, 0, spec.length);
}
/** Snap a raw scale position onto the ruler's gradations, clamped to the bar's
 *  legal range — the free end can never cross behind its own pinned start. */
export function rulerSnapEnd(spec: RulerSpec, raw: number): number {
  return snapToGrid(raw, rulerStart(spec), spec.length, rulerPrecision(spec));
}
/** The bar's LENGTH — `end − start`, which is the whole point of the kind. */
export function rulerLength(spec: RulerSpec, s: RulerState): number {
  return rulerSnapEnd(spec, s?.end ?? rulerStart(spec)) - rulerStart(spec);
}
export function initialRuler(spec: RulerSpec): RulerState {
  return { end: rulerSnapEnd(spec, spec.startEnd) };
}
/**
 * Ruler — solved when the BAR measures the target length. The comparison runs
 * on the snapped end, so a forged sub-gradation submission ("7.03 cm") is
 * pulled onto a real mark before it is judged, exactly as the on-screen drag
 * would have been.
 */
export function rulerSolved(spec: RulerSpec, s: RulerState): boolean {
  const g = spec.goal;
  if (!g) return false;
  if (!s || !Number.isFinite(s.end)) return false;
  // `RulerGoal` has ONE member today, so there is no union to narrow and no
  // exhaustiveness guard to add (TS can't produce `never` from a non-union).
  // If a second goal shape is ever added, discriminate on `g.type` here and
  // route the tail through `assertNoUnhandledGoal` like clock/liquid/money —
  // otherwise the new member is silently graded as `lengthEquals`.
  return approxEqual(rulerLength(spec, s), g.value, 1e-6);
}

// ── clock ────────────────────────────────────────────────────────────────────
/** Minutes in one turn of a 12-hour dial. */
export const CLOCK_DIAL_MINUTES = 720;
/** The minute gradation the hands snap to (default 1). */
export function clockSnapMinutes(spec: ClockSpec): number {
  const s = spec.snapMinutes;
  return Number.isInteger(s) && (s as number) >= 1 ? (s as number) : 1;
}
/** Wrap any minute count onto the dial's 0..719 range (negatives included). */
export function clockNormalize(minutes: number): number {
  const m = Math.round(minutes);
  return ((m % CLOCK_DIAL_MINUTES) + CLOCK_DIAL_MINUTES) % CLOCK_DIAL_MINUTES;
}
/**
 * Where a wind lands: the reading the drag STARTED from, carried round by the
 * rotation accumulated since. `turned` is signed fractions of a full turn, so
 * winding several times round keeps adding time and reversing unwinds it.
 *
 * `minutesPerTurn` is the GEAR RATIO of the hand being dragged, and it is the
 * only difference between the two grabs. The minute hand is direct drive — one
 * turn is one hour, 60 — while the hour hand is the same mechanism geared 12:1,
 * one turn of it being the whole dial (`CLOCK_DIAL_MINUTES`). That is why the
 * hour hand can be draggable WITHOUT a second state field: it is a coarse
 * control on the same `minutes`, so the two hands cannot contradict each other
 * and an impossible face (hour square on the 3, minute reading 45) stays
 * unrepresentable.
 *
 * Deriving the reading from ACCUMULATED rotation is what makes a coarse dial
 * work. Snapping the hand to the pointer's absolute angle instead — taking the
 * smaller signed step to preserve the hour — collapses on coarse gradations: a
 * half-hour dial only ever reads :00 or :30, both steps between them are
 * exactly ±30, and "smaller step" has no answer, so the hour can never turn
 * over; an hour dial reads :00 everywhere and cannot move at all.
 */
export function clockMinutesFromTurned(
  originMinutes: number,
  turned: number,
  snap: number,
  minutesPerTurn: number = 60,
): number {
  const raw = originMinutes + turned * minutesPerTurn;
  return clockNormalize(Math.round(raw / snap) * snap);
}
/** An {hour 1..12, minute} reading → minutes past 12 on the dial (12:xx → 0:xx). */
export function clockMinutesOf(hour: number, minute: number): number {
  return clockNormalize((Math.round(hour) % 12) * 60 + Math.round(minute));
}
/** Minutes past 12 → the {hour 1..12, minute} a clock face reads. */
export function clockReading(minutes: number): { hour: number; minute: number } {
  const m = clockNormalize(minutes);
  const h = Math.floor(m / 60);
  return { hour: h === 0 ? 12 : h, minute: m % 60 };
}
/** A dial position as kid-facing time text ("3:45"). */
export function formatClockTime(minutes: number): string {
  const { hour, minute } = clockReading(minutes);
  return `${hour}:${String(minute).padStart(2, "0")}`;
}
export function initialClock(spec: ClockSpec): ClockState {
  return { minutes: clockMinutesOf(spec.startHour, spec.startMinute) };
}
/**
 * The dial position the goal is asking for. `showTime` names it outright;
 * `advanceBy` derives it from the start time (wrapping past 12), which is
 * exactly the value the scholar has to work out — so this is a GRADER helper
 * and never appears in `goalText`.
 */
export function clockTargetMinutes(spec: ClockSpec): number | null {
  const g = spec.goal;
  if (!g) return null;
  if (g.type === "showTime") return clockMinutesOf(g.hour, g.minute);
  if (g.type === "advanceBy")
    return clockNormalize(clockMinutesOf(spec.startHour, spec.startMinute) + g.minutes);
  return assertNoUnhandledGoal(g, null);
}
/**
 * Clock — solved when the face reads the target time exactly. Both hands come
 * from the one `minutes` value, so "the hour hand is in the right place" is not
 * a separate check: it is true by construction whenever the minute count is.
 */
export function clockSolved(spec: ClockSpec, s: ClockState): boolean {
  const target = clockTargetMinutes(spec);
  if (target == null) return false;
  if (!s || !Number.isFinite(s.minutes)) return false;
  return clockNormalize(s.minutes) === target;
}

// ── liquid ───────────────────────────────────────────────────────────────────
/** The gradation printed on every jar and snapped to when pouring (default 1). */
export function liquidStep(spec: LiquidSpec): number {
  const s = spec.step;
  return Number.isFinite(s) && (s as number) > 0 ? (s as number) : 1;
}
/** Snap a raw pour level onto one jar's marks, clamped to 0..capacity. */
export function liquidSnapLevel(spec: LiquidSpec, vessel: number, raw: number): number {
  const capacity = spec.vessels[vessel]?.capacity ?? 0;
  return snapToGrid(raw, 0, capacity, liquidStep(spec));
}
export function initialLiquid(spec: LiquidSpec): LiquidState {
  return { levels: spec.vessels.map((v, i) => liquidSnapLevel(spec, i, v.start ?? 0)) };
}
/**
 * Pixels of jar height per ONE unit of capacity, shared by every jar in the
 * spec. This lives here, not in a renderer, because it is the thing that makes
 * the kind honest: a 4-cup jar must draw exactly twice a 2-cup jar, so "which
 * holds more" is answerable by looking. Sizing each jar independently (a
 * per-jar minimum height, say) silently inflates the small ones and destroys
 * the comparison — which is most of what capacity work is about.
 *
 * The scale is chosen so the LARGEST jar lands near `targetHeight`, then
 * clamped so a one-cup set isn't microscopic and a ten-litre set still fits.
 * Both frontends call this, so they can never disagree about a jar's height.
 */
export const LIQUID_MIN_PX_PER_UNIT = 12;
export const LIQUID_MAX_PX_PER_UNIT = 60;
export function liquidPxPerUnit(spec: LiquidSpec, targetHeight = 150): number {
  const maxCapacity = Math.max(...spec.vessels.map((v) => v.capacity), 1);
  return clamp(targetHeight / maxCapacity, LIQUID_MIN_PX_PER_UNIT, LIQUID_MAX_PX_PER_UNIT);
}

/** How much liquid is held across every jar right now. */
export function liquidTotal(spec: LiquidSpec, s: LiquidState): number {
  return spec.vessels.reduce((sum, _v, i) => sum + liquidSnapLevel(spec, i, s?.levels?.[i] ?? 0), 0);
}
/**
 * Liquid — solved when the named jar reads the target level (`fillTo`), or when
 * the jars TOGETHER hold the target amount (`totalEquals`). Levels are snapped
 * to the jars' marks first, so a forged between-the-marks level is judged as
 * the mark the drag could actually have reached.
 */
export function liquidSolved(spec: LiquidSpec, s: LiquidState): boolean {
  const g = spec.goal;
  if (!g) return false;
  if (!s || !Array.isArray(s.levels)) return false;
  if (g.type === "fillTo") {
    if (spec.vessels[g.vessel] == null) return false;
    return approxEqual(liquidSnapLevel(spec, g.vessel, s.levels[g.vessel] ?? 0), g.value, 1e-6);
  }
  if (g.type === "totalEquals") return approxEqual(liquidTotal(spec, s), g.value, 1e-6);
  return assertNoUnhandledGoal(g, false);
}

// ── money ────────────────────────────────────────────────────────────────────
/** Cap per denomination in the tray (default 20) — keeps the tray countable. */
export function moneyMaxPerDenomination(spec: MoneySpec): number {
  const m = spec.maxPerDenomination;
  return Number.isInteger(m) && (m as number) >= 1 ? (m as number) : 20;
}
export function initialMoney(spec: MoneySpec): MoneyState {
  const max = moneyMaxPerDenomination(spec);
  return {
    counts: spec.available.map((_d, i) => clamp(Math.round(spec.start?.[i] ?? 0), 0, max)),
  };
}
/** The tray's value in cents. Unknown denomination strings contribute 0. */
export function moneyTotalCents(spec: MoneySpec, counts: number[]): number {
  return spec.available.reduce(
    (sum, denomination, i) => sum + moneyPieceCents(denomination) * Math.max(0, Math.round(counts[i] ?? 0)),
    0,
  );
}
/** How many physical pieces are in the tray. */
export function moneyPieceTotal(counts: number[]): number {
  return counts.reduce((n, c) => n + Math.max(0, Math.round(c ?? 0)), 0);
}
/**
 * The largest cent amount `fewestPieces` / `amountEqualsWithCount` will reason
 * about. Both run a table-based search, so the bound keeps authoring cheap and
 * total; $20 covers every K-6 money task and then some.
 */
export const MONEY_MAX_CENTS = 2000;

/**
 * The FEWEST pieces that make `cents` out of `available`, **using at most
 * `maxPerDenomination` of any one piece** — a bounded coin-change DP.
 *
 * Not greedy. Greedy is optimal for the full US set, but `available` is an
 * authoring lever (see `MoneySpec.available`) and greedy fails on plenty of
 * subsets: with {1¢, 3¢, 4¢} greedy makes 6¢ as 4+1+1 (three pieces) when 3+3
 * (two) exists. Grading a "use the fewest" goal off a heuristic that is
 * sometimes wrong would mark a BETTER answer incorrect.
 *
 * The cap is REQUIRED rather than optional on purpose. The tray enforces it at
 * runtime — `moneySolved` rejects any count above it and both renderers refuse
 * to increment past it — so an UNBOUNDED minimum is a number no scholar can
 * ever reach. An optional cap would just be a footgun the authoring guard
 * forgot to pass: with only half dollars and a 20-piece cap, the unbounded
 * answer to $20.00 is 40 coins, the tray tops out at $10.00, and the challenge
 * is unsolvable forever.
 *
 * Returns null when the amount is out of bounds or unreachable UNDER THE CAP.
 */
export function moneyFewestPieces(
  available: MoneyDenomination[],
  cents: number,
  maxPerDenomination: number,
): number | null {
  if (!Number.isInteger(cents) || cents < 0 || cents > MONEY_MAX_CENTS) return null;
  if (!Number.isInteger(maxPerDenomination) || maxPerDenomination < 0) return null;
  const values = available.map(moneyPieceCents).filter((v) => v > 0);
  if (values.length === 0) return cents === 0 ? 0 : null;
  let best = new Array<number>(cents + 1).fill(Number.POSITIVE_INFINITY);
  best[0] = 0;
  // One pass per denomination, trying 0..cap of it — the bounded form. A
  // per-amount pass (the unbounded idiom) would silently allow unlimited reuse.
  for (const v of values) {
    const next = new Array<number>(cents + 1).fill(Number.POSITIVE_INFINITY);
    for (let amount = 0; amount <= cents; amount++) {
      const from = best[amount];
      if (!Number.isFinite(from)) continue;
      for (let k = 0; k <= maxPerDenomination && amount + k * v <= cents; k++) {
        const total = amount + k * v;
        if (from + k < next[total]) next[total] = from + k;
      }
    }
    best = next;
  }
  return Number.isFinite(best[cents]) ? best[cents] : null;
}

/**
 * True when `cents` is makeable out of `available` using EXACTLY `count`
 * pieces and at most `maxPerDenomination` of any one — the reachability check
 * behind the `amountEqualsWithCount` goal, so authoring can never ship "make
 * 30¢ with exactly 7 coins" when no such combination exists. Same cap
 * discipline as `moneyFewestPieces`: an aggregate `count <= cap × kinds` bound
 * is NOT sufficient, because the only combinations hitting the target may need
 * more than the cap of one specific denomination.
 */
export function moneyAmountReachableWithCount(
  available: MoneyDenomination[],
  cents: number,
  count: number,
  maxPerDenomination: number,
): boolean {
  if (!Number.isInteger(cents) || cents < 0 || cents > MONEY_MAX_CENTS) return false;
  if (!Number.isInteger(count) || count < 0 || count > MONEY_MAX_PIECES) return false;
  if (!Number.isInteger(maxPerDenomination) || maxPerDenomination < 0) return false;
  const values = available.map(moneyPieceCents).filter((v) => v > 0);
  if (values.length === 0) return cents === 0 && count === 0;
  // reach[amount][pieces], filled one denomination at a time so each is
  // independently capped.
  const width = count + 1;
  let reach = new Uint8Array((cents + 1) * width);
  reach[0] = 1;
  for (const v of values) {
    const next = new Uint8Array((cents + 1) * width);
    for (let amount = 0; amount <= cents; amount++) {
      for (let pieces = 0; pieces <= count; pieces++) {
        if (!reach[amount * width + pieces]) continue;
        for (
          let k = 0;
          k <= maxPerDenomination && amount + k * v <= cents && pieces + k <= count;
          k++
        ) {
          next[(amount + k * v) * width + (pieces + k)] = 1;
        }
      }
    }
    reach = next;
  }
  return reach[cents * width + count] === 1;
}

/**
 * Upper bound on a `amountEqualsWithCount` piece count the reachability table
 * will reason about. Keeps the (amount × pieces) table small; far above any
 * real coin task.
 */
export const MONEY_MAX_PIECES = 100;

/**
 * Money — solved when the tray's VALUE matches, plus whatever extra constraint
 * the goal adds (an exact piece count, or the provable minimum). Non-integer /
 * negative forged counts are floored to a legal reading first, so a garbage
 * submission grades as the tray it would actually have drawn.
 */
export function moneySolved(spec: MoneySpec, s: MoneyState): boolean {
  const g = spec.goal;
  if (!g) return false;
  if (!s || !Array.isArray(s.counts) || s.counts.length !== spec.available.length) return false;
  if (!s.counts.every((c) => Number.isInteger(c) && c >= 0)) return false;
  const max = moneyMaxPerDenomination(spec);
  if (!s.counts.every((c) => c <= max)) return false;
  if (moneyTotalCents(spec, s.counts) !== g.cents) return false;
  if (g.type === "amountEquals") return true;
  const pieces = moneyPieceTotal(s.counts);
  if (g.type === "amountEqualsWithCount") return pieces === g.count;
  if (g.type === "fewestPieces") {
    // The minimum is measured UNDER THE TRAY'S OWN CAP — that is the fewest a
    // scholar can actually place, so an unbounded minimum would make a correct
    // best-possible tray grade wrong.
    const fewest = moneyFewestPieces(spec.available, g.cents, max);
    return fewest != null && pieces === fewest;
  }
  return assertNoUnhandledGoal(g, false);
}

/**
 * Exhaustiveness guard for a goal UNION consumer.
 *
 * Every `*Goal` here is a discriminated union, and the tempting shape is to
 * handle the known members and let the last one fall out of an implicit `else`.
 * That is a trapdoor: add a member later and it is silently graded as whichever
 * branch the `else` happened to be. No throw, no type error — the item just
 * never solves, and the tutor describer emits `undefined` into the model's
 * context. (Diagnosed on `NumberLineGoal`, whose three consumers previously
 * shared one implicit `else = placeFraction`; see review/lcm-manipulative-redesign.html.)
 *
 * Passing the goal here instead makes the compiler the guard: `never` fails to
 * typecheck the moment a union grows, so a new member CANNOT be added without
 * visiting every consumer. At runtime it returns the caller's safe fallback
 * rather than throwing, because these predicates are total by contract — a
 * forged spec must not crash a scholar's screen.
 */
export function assertNoUnhandledGoal<T>(_goal: never, fallback: T): T {
  return fallback;
}

// ── self-check predicates (control of error) ─────────────────────────────────
export function partitionSolved(spec: PartitionSpec, s: PartitionState): boolean {
  const g = spec.goal;
  if (!g) return false;
  if (g.type === "shadedFractionEquals") {
    const d = s.discs[g.disc];
    if (d == null) return false;
    // requireParts makes the re-cut part of the goal: the ratio alone is not
    // the task when the operation being modeled IS the re-partition.
    if (g.requireParts != null && d.parts !== g.requireParts) return false;
    return approxEqual(fractionValue(d.shaded, d.parts), g.value);
  }
  if (g.type === "partsEqual") {
    // Every named disc must independently hit its own target — a
    // decomposition (or addition) genuinely requires each distinct part to be
    // built, not just SOME disc reaching the combined total.
    if (g.parts.length === 0) return false;
    return g.parts.every(({ disc, value }) => {
      const d = s.discs[disc];
      return d != null && approxEqual(fractionValue(d.shaded, d.parts), value);
    });
  }
  // discsEqualShadedArea — both must actually be shaded (non-zero) and equal
  if (s.discs.length < 2) return false;
  const a = fractionValue(s.discs[0].shaded, s.discs[0].parts);
  const b = fractionValue(s.discs[1].shaded, s.discs[1].parts);
  return a > 0 && approxEqual(a, b);
}

export function numberLineSolved(spec: NumberLineSpec, s: NumberLineState): boolean {
  const g = spec.goal;
  if (!g) return false;
  if (g.type === "placeAt") return approxEqual(s.value, g.value, g.tolerance ?? 0.03 * (spec.max - spec.min));
  if (g.type === "placeFraction") {
    const target = g.num / g.den;
    return approxEqual(s.value, target, g.tolerance ?? 0.03 * (spec.max - spec.min));
  }
  if (g.type === "firstCommonMultiple") {
    const tracks = spec.multipleTracks;
    if (!tracks) return false;
    const target = leastCommonMultiple(tracks[0], tracks[1]);
    return target != null && approxEqual(s.value, target, g.tolerance ?? 0.03 * (spec.max - spec.min));
  }
  return assertNoUnhandledGoal(g, false);
}

export function coordinatePlaneSolved(spec: CoordinatePlaneSpec, s: CoordinatePlaneState): boolean {
  const g = spec.goal;
  if (!g) return false;
  const pts = s.points;
  if (g.type === "placePoint") {
    return pts.length >= 1 && pointsEqual(pts[0], { x: g.x, y: g.y });
  }
  if (g.type === "placePoints") {
    return pointSetsEqual(pts, g.points);
  }
  if (g.type === "completeRectangle") {
    const missing = rectangleMissingCorner((spec.fixedPoints ?? []).slice(0, 3));
    return missing != null && pts.length >= 1 && pointsEqual(pts[0], missing);
  }
  // reflectPoint
  const target =
    g.across === "x" ? { x: g.point.x, y: -g.point.y } : { x: -g.point.x, y: g.point.y };
  return pts.length >= 1 && pointsEqual(pts[0], target);
}

/**
 * The solved-check for a geoLocate item — delegates to the geomap contract's
 * own authoritative grader (`lib/geomap/grade.isSolved`) on the map's task and
 * the scholar's submitted pins. `resolveRegion` is threaded in by the caller
 * (the server passes the registry resolver; a `locate`/`pinSet` task never needs
 * it, a `region` task can only green-light when it's supplied). It is NEVER
 * imported here so the vendored native copy of this module stays free of the
 * registry's dataset graph.
 */
export function geoLocateSolved(
  spec: GeoLocateSpec,
  s: GeoLocateState,
  resolveRegion?: RegionResolver,
): boolean {
  return geoTaskSolved(spec.map.task, s, resolveRegion);
}

export function arraySolved(spec: ArraySpec, s: ArrayState): boolean {
  const g = spec.goal;
  if (!g) return false;
  // productEquals and areaEquals are the same check for a filled rectangle.
  if (g.type === "productEquals" || g.type === "areaEquals") return s.rows * s.cols === g.value;
  if (g.type === "sideEqualsWithProduct") {
    return (s.rows === g.side || s.cols === g.side) && s.rows * s.cols === g.product;
  }
  if (g.type === "squareEquals") return s.rows === s.cols && s.rows * s.cols === g.value;
  return s.rows * s.cols === g.product && countFactorPairs(g.product) === g.count;
}

/** Net tilt of the balance beam: >0 left-heavy, <0 right-heavy, 0 level. */
export function balanceTilt(spec: BalanceSpec, s: BalanceState): number {
  return s.left - (s.right + (spec.mysteryRight ?? 0));
}
export function balanceSolved(spec: BalanceSpec, s: BalanceState): boolean {
  if (!spec.goal) return false;
  return balanceTilt(spec, s) === 0;
}

export function areaPerimeterArea(spec: AreaPerimeterSpec, s: AreaPerimeterState): number {
  return s.width * heightForPerimeter(spec.perimeter, s.width);
}
export function areaPerimeterSolved(spec: AreaPerimeterSpec, s: AreaPerimeterState): boolean {
  const g = spec.goal;
  if (!g) return false;
  const area = areaPerimeterArea(spec, s);
  if (g.type === "areaEquals") return area === g.value;
  return area === maxAreaForPerimeter(spec.perimeter); // maxArea
}

export function distributeSolved(spec: DistributeSpec, s: DistributeState): boolean {
  const g = spec.goal;
  if (!g) return false;
  return s.column === g.column;
}

/**
 * Rekenrek — solved when the split makes ONE group hold exactly `value`
 * beads. Either side counts (left = value ⟺ right = total − value), so both
 * valid decompositions that produce a group of the target size pass — the point
 * is the number bond, not which side it lands on.
 */
export function rekenrekSolved(spec: RekenrekSpec, s: RekenrekState): boolean {
  const g = spec.goal;
  if (!g) return false;
  const left = clamp(Math.round(s.left), 0, spec.total);
  const right = spec.total - left;
  return left === g.value || right === g.value;
}

/** Inside edge of each end stop, where a resting bead's outer edge lands. */
export const REKENREK_STOP_M = 14;
/** Rail slack, in bead widths, so a split leaves an open span of bare rail. */
const REKENREK_SLACK = 2.5;
/** Below this a bead stops reading as a bead; above it they look like balloons. */
const REKENREK_MIN_D = 24;
const REKENREK_MAX_D = 56;

export interface RekenrekGeometry {
  /** Bead diameter, uniform across both rods. */
  D: number;
  /** Center x of a bead resting flush against the left / right stop. */
  railLeft: number;
  railRight: number;
}

/**
 * Bead size + rail geometry for a rekenrek stage `width` px wide, sized off the
 * FULLER rod (rod 1, a full ten whenever a second rod exists) so beads stay
 * uniform across rods. Shared by the web and native renderers — the two used to
 * carry hand-synced copies of this arithmetic.
 *
 * The bead is as large as the rail can hold: the interior takes `sizingCount`
 * beads PLUS ~2.5 bead widths of slack, so a split leaves an open span of bare
 * rail wide enough to read as two groups. That slack is load-bearing — the
 * five-coloring is fixed to position-in-fives, so the gap is the ONLY thing
 * carrying the left/right split.
 *
 * ⚠️ There is no lower bound of 44 (the finger hit target) — only a preference
 * expressed by the formula, which reaches 44 at ~590px of stage. Forcing 44 on a
 * narrower stage is what cropped the rack: a ten-bead rod needs 468px at 44, but
 * the web practice column (`PracticeSession`'s 460px, ~420px inside the card
 * padding) is narrower, so the last beads were laid out past the right edge and
 * clipped away. A bead that shrinks is legible; a bead off-screen is not.
 */
export function rekenrekGeometry(width: number, sizingCount: number): RekenrekGeometry {
  const n = Math.max(1, sizingCount);
  const interior = Math.max(0, width - 2 * REKENREK_STOP_M);
  const d = clamp(
    Math.floor(interior / (n + REKENREK_SLACK)),
    REKENREK_MIN_D,
    REKENREK_MAX_D,
  );
  return {
    D: d,
    railLeft: REKENREK_STOP_M + d / 2,
    railRight: width - REKENREK_STOP_M - d / 2,
  };
}

/**
 * Distributor — solved when the scholar has dealt the MAXIMUM equal share to
 * every plate (perGroup = floor(total / groups)). By construction the plates
 * are then equal and the leftover pile is exactly the true remainder
 * (total mod groups), so this single check enforces "groups equal + remainder
 * correct". Under-dealing leaves too big a pile (not solved); over-dealing past
 * an equal round is disallowed by the control's own max, never reachable here.
 */
export function distributorSolved(spec: DistributorSpec, s: DistributorState): boolean {
  if (!spec.goal) return false;
  if (spec.groups < 1) return false;
  return s.perGroup === distributorPerGroupMax(spec);
}

export function speedAt(spec: RiemannSpec, t: number): number {
  return spec.slope * t + spec.intercept;
}

/**
 * placeValue — solved when the built base-ten configuration hits the target
 * AS A RENDERABLE, CANONICAL configuration — never on total alone.
 *
 *   • buildValue (buildNumber + expandedForm): the assembled number equals the
 *     target AND every column is a single canonical digit (0..maxPerPlace,
 *     ≤ 9) — so "3 hundreds, 13 tens, 7 ones" (which also totals 437) is
 *     rejected: the skill is the STANDARD decomposition, not any regrouping.
 *     The renderer's per-column cap already prevents reaching a two-digit
 *     count, so this guard is really the defense against a forged submission.
 *   • shiftTo (placeShift): the ×10/÷10 control ONLY ever produces canonical
 *     single-digit configurations (a shift slides digits and fills 0), so a
 *     total-only check would accept states the controls can never reach — e.g.
 *     "50 ones" also totals 50 for the "5 → 50" task. Grade the same canonical
 *     digit decomposition as buildValue (each place ≤ 9) so only a genuinely
 *     reachable configuration passes.
 */
export function placeValueSolved(spec: PlaceValueSpec, s: PlaceValueState): boolean {
  const g = spec.goal;
  if (!g) return false;
  if (!s || !Array.isArray(s.counts) || s.counts.length !== spec.places.length) return false;
  if (!s.counts.every((c) => Number.isInteger(c) && c >= 0)) return false;
  // Both goal shapes require a canonical single-digit-per-place configuration —
  // buildValue by its maxPerPlace cap, shiftTo by the standard digit range (9),
  // since a ×10/÷10 shift never yields a multi-digit column.
  const max = g.type === "buildValue" ? placeValueMaxPerPlace(spec) : 9;
  if (!s.counts.every((c) => c <= max)) return false;
  return placeValueTotal(spec, s.counts) === g.value;
}

/**
 * Apply a place-shift to a counts array: `"up"` is ×10 (every digit slides one
 * column toward a higher place), `"down"` is ÷10 (toward a lower place). Pure +
 * total (returns `null` for an illegal shift) so the web + native renderers
 * share ONE move and can't drift, and it's directly unit-testable:
 *   • ×10 is illegal if the highest column is non-empty (the number would
 *     overflow past the largest place available).
 *   • ÷10 is illegal if the ones column is non-empty (a digit would fall off
 *     the bottom — the number isn't a clean multiple of ten).
 * Columns are DESCENDING (index 0 = highest place), so ×10 is a left shift
 * (index i receives index i+1) with a 0 filled into the ones column, and ÷10 is
 * the mirror right shift.
 */
export function placeValueShift(
  spec: PlaceValueSpec,
  counts: number[],
  direction: "up" | "down",
): number[] | null {
  const n = spec.places.length;
  const c = spec.places.map((_, i) => Math.max(0, Math.round(counts[i] ?? 0)));
  if (direction === "up") {
    if (c[0] !== 0) return null; // would overflow the top place
    const next = c.slice(1);
    next.push(0);
    return next;
  }
  if (c[n - 1] !== 0) return null; // a ones digit would be lost
  const next = c.slice(0, n - 1);
  next.unshift(0);
  return next;
}

export function trueArea(spec: RiemannSpec): number {
  return (spec.slope * spec.tMax * spec.tMax) / 2 + spec.intercept * spec.tMax;
}
export function leftSumArea(spec: RiemannSpec, bars: number): number {
  const n = Math.max(1, Math.round(bars));
  const dt = spec.tMax / n;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += speedAt(spec, i * dt) * dt;
  return sum;
}
export function riemannSolved(spec: RiemannSpec, s: RiemannState): boolean {
  const g = spec.goal;
  if (!g) return false;
  return Math.abs(leftSumArea(spec, s.bars) - trueArea(spec)) <= g.tolerance;
}

// ── Model B (a game) — RETIRED from this file ────────────────────────────────
// The Factor Game's rules used to sit here, labelled "Model B: a game with
// internal stages + carried state", beside Model A (one shot, graded on the
// final configuration) and Model C (`dice`, an experiment tool). Three
// incompatible grading models in one closed union was the tell that a game is
// not a manipulative.
//
// They live in `native/src/games/factor-game/rules.ts` now. `factorGameSolved`
// — true iff the scholar out-scored a greedy bot, and wired straight into skill
// mastery — did not survive the move, and that is the point of the move.

// ── MultiStepSequenceSpec — Model A: pure step-advance/progress helpers ──────
/** The step at `stepIndex`, or `null` once the sequence is complete. */
export function currentSequenceStep(spec: MultiStepSequenceSpec, stepIndex: number): ManipulativeSpec | null {
  return spec.steps[stepIndex] ?? null;
}
/** A sequence is complete once `stepIndex` has advanced past the last step. */
export function isSequenceComplete(spec: MultiStepSequenceSpec, stepIndex: number): boolean {
  return stepIndex >= spec.steps.length;
}
/** The next `stepIndex` — the ONLY state a Model-A sequence carries between steps. */
export function advanceSequence(stepIndex: number): number {
  return stepIndex + 1;
}
export interface SequenceProgress {
  /** 1-based, capped at `total` — feeds `MultiStepChallenge`'s `{mode:"steps"}`. */
  current: number;
  total: number;
}
export function sequenceProgress(spec: MultiStepSequenceSpec, stepIndex: number): SequenceProgress {
  const total = spec.steps.length;
  return { current: Math.min(stepIndex + 1, total), total };
}

/**
 * Function machine — solved when the scholar's prediction matches the hidden
 * rule applied to the query input. Note the ACTUAL runtime verdict flows
 * through the shared typed-`answer` path in `Manipulative.tsx` (the frame
 * compares the typed number to `spec.answer.value`, authored to equal
 * `applyFunctionMachineRule(rule, queryInput)`); this predicate exists so the
 * same logic is directly unit-testable and dispatchable from `isSolved`.
 */
export function functionMachineSolved(spec: FunctionMachineSpec, s: FunctionMachineState): boolean {
  if (s.predicted == null) return false;
  return s.predicted === applyFunctionMachineRule(spec.rule, spec.queryInput);
}

/**
 * A functionMachine has nothing to manipulate in-canvas — its whole verdict
 * IS the frame's typed `spec.answer` field (`Manipulative.tsx`'s
 * `typedAnswer`). `FunctionMachineManipulative` calls this EXACT function to
 * turn that live string into the `{predicted}` shape `functionMachineSolved`
 * reads and echo it into `onStateChange` — the only channel practice mode's
 * Done actually submits. Kept here (not inlined in the renderer) so a test
 * can drive the SAME mapping the renderer runs, instead of hand-constructing
 * a `{predicted: ...}` object that could silently drift from what typing
 * actually produces. An empty or non-numeric string is `null` (nothing
 * committed yet), never `{predicted: null}` — that keeps practice mode's
 * `state === null` submit-gate correctly disabled until a real number lands.
 */
export function functionMachineStateFromTypedAnswer(
  typedAnswer: string | null | undefined,
): FunctionMachineState | null {
  const trimmed = typedAnswer?.trim() ?? "";
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? { predicted: parsed } : null;
}

// ── dice — Model C: a probability experiment graded by a committed prediction ─
/** The integer faces of one die (or coin: 1 = heads, 0 = tails), ascending. */
export function diceFaces(diceType: DiceType): number[] {
  if (diceType === "coin") return [0, 1];
  const sides = diceType === "d20" ? 20 : 6;
  return Array.from({ length: sides }, (_, i) => i + 1);
}

/** How many dice/coins the tray shows by default for a given prediction. */
export function diceDefaultCount(prediction?: DicePrediction): number {
  return prediction?.type === "mostLikelyTotal" ? 2 : 1;
}

/** The tray size for a spec, clamped to the SceneDice-supported 1..10. */
export function diceCount(spec: DiceSpec): number {
  const raw = spec.count ?? diceDefaultCount(spec.prediction);
  return clamp(Math.round(raw), 1, 10);
}

/** Whether a single face satisfies a (closed-set) event. */
export function diceEventMatches(event: DiceEvent, face: number): boolean {
  switch (event.type) {
    case "face":
      return face === event.value;
    case "even":
      return face % 2 === 0;
    case "odd":
      return Math.abs(face % 2) === 1;
    case "atLeast":
      return face >= event.value;
    case "greaterThan":
      return face > event.value;
  }
}

/** How many of a single die's faces satisfy the event (the numerator of P). */
export function diceFavorableCount(diceType: DiceType, event: DiceEvent): number {
  return diceFaces(diceType).filter((f) => diceEventMatches(event, f)).length;
}

/**
 * Exact distribution of the SUM of `count` independent uniform dice, as a map
 * sum→ways, built by repeated convolution (polynomial, so a d20×10 tray is
 * cheap). Deterministic — no sampling.
 */
export function diceSumDistribution(diceType: DiceType, count: number): Map<number, number> {
  const faces = diceFaces(diceType);
  let dist = new Map<number, number>([[0, 1]]);
  for (let i = 0; i < count; i++) {
    const next = new Map<number, number>();
    for (const [sum, ways] of dist) {
      for (const f of faces) {
        next.set(sum + f, (next.get(sum + f) ?? 0) + ways);
      }
    }
    dist = next;
  }
  return dist;
}

/** How many samples the "Roll ×N" batch draws in one tap. */
export const DICE_BATCH_SIZE = 10;

/**
 * Roll `count` dice once, returning the face each shows (uniform, independent).
 * Shared so the web and native trays sample identically — the "Roll ×N" batch
 * (see `DICE_BATCH_SIZE`) calls this once per roll to fill a distribution fast.
 */
export function rollDiceFaces(diceType: DiceType, count: number): number[] {
  const faces = diceFaces(diceType);
  return Array.from(
    { length: Math.max(0, count) },
    () => faces[Math.floor(Math.random() * faces.length)] ?? faces[0] ?? 0,
  );
}

/** The single most likely total of `count` dice (lowest sum wins a tie). */
export function diceMostLikelyTotal(diceType: DiceType, count: number): number {
  const dist = diceSumDistribution(diceType, count);
  let bestSum = 0;
  let bestWays = -1;
  for (const [sum, ways] of [...dist.entries()].sort((a, b) => a[0] - b[0])) {
    if (ways > bestWays) {
      bestWays = ways;
      bestSum = sum;
    }
  }
  return bestSum;
}

/** The theoretical answer to a prediction, as a fraction (den 1 for integers). */
export function diceExpectedAnswer(spec: DiceSpec): DiceFraction {
  const p = spec.prediction;
  if (!p) return { num: 0, den: 1 };
  switch (p.type) {
    case "favorableCount":
      return { num: diceFavorableCount(spec.diceType, p.event), den: 1 };
    case "probability":
      return {
        num: diceFavorableCount(spec.diceType, p.event),
        den: diceFaces(spec.diceType).length,
      };
    case "mostLikelyTotal":
      return { num: diceMostLikelyTotal(spec.diceType, diceCount(spec)), den: 1 };
  }
}

/**
 * Dice — solved when the committed prediction EQUALS the theoretical answer by
 * VALUE (cross-multiplied), so any equivalent fraction passes (3/6 ≡ 1/2). A
 * sandbox (no `prediction`) or an un-committed / malformed prediction is never
 * solved. Note the actual runtime verdict is authoritative server-side via
 * `gradeManipulativeSubmission` → this predicate; the renderer only mirrors it.
 */
export function diceSolved(spec: DiceSpec, s: DiceState): boolean {
  if (!spec.prediction) return false;
  const p = s?.predicted;
  if (!p) return false;
  const { num, den } = p;
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return false;
  const expected = diceExpectedAnswer(spec);
  return num * expected.den === expected.num * den;
}

/**
 * Parse a keypad-typed prediction into a committed fraction — the same number
 * pad ("1", "/", "2") the practice surface uses for every other fraction item.
 * A probability is typed as "num/den" (e.g. "1/2"); a count / most-likely-total
 * is a bare integer ("3" → {num:3, den:1}). Returns null for an empty or
 * malformed entry so the UI keeps Commit disabled. The value-equality grader
 * (diceSolved) then judges it, so any equivalent fraction still passes.
 */
export function parseDicePrediction(input: string): DiceFraction | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  if (trimmed.includes("/")) {
    const parts = trimmed.split("/");
    if (parts.length !== 2) return null;
    const numText = parts[0].trim();
    const denText = parts[1].trim();
    if (numText === "" || denText === "") return null;
    const num = Number(numText);
    const den = Number(denText);
    if (!Number.isInteger(num) || !Number.isInteger(den)) return null;
    if (num < 0 || den <= 0) return null;
    return { num, den };
  }
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 0) return null;
  return { num: value, den: 1 };
}

/**
 * Protractor — solved when the live angle (the free ray's placement) is
 * within the goal's tolerance band of the stated target, default ±2°.
 */
export function protractorSolved(spec: ProtractorSpec, s: ProtractorState): boolean {
  const g = spec.goal;
  if (!g) return false;
  const tolerance = g.tolerance ?? 2;
  return Math.abs(s.angleDeg - g.targetDeg) <= tolerance;
}

/**
 * Dispatch a solved-check for any manipulative given its (kind-matched) state.
 * The renderer passes the live state; a mismatched pairing returns false.
 */
export function isSolved(
  spec: ManipulativeSpec,
  state: unknown,
  resolveRegion?: RegionResolver,
): boolean {
  switch (spec.kind) {
    case "partition":
      return partitionSolved(spec, state as PartitionState);
    case "numberline":
      return numberLineSolved(spec, state as NumberLineState);
    case "array":
      return arraySolved(spec, state as ArrayState);
    case "balance":
      return balanceSolved(spec, state as BalanceState);
    case "areaPerimeter":
      return areaPerimeterSolved(spec, state as AreaPerimeterState);
    case "distribute":
      return distributeSolved(spec, state as DistributeState);
    case "rekenrek":
      return rekenrekSolved(spec, state as RekenrekState);
    case "distributor":
      return distributorSolved(spec, state as DistributorState);
    case "riemann":
      return riemannSolved(spec, state as RiemannState);
    case "functionMachine":
      return functionMachineSolved(spec, state as FunctionMachineState);
    case "placeValue":
      return placeValueSolved(spec, state as PlaceValueState);
    case "dice":
      return diceSolved(spec, state as DiceState);
    case "protractor":
      return protractorSolved(spec, state as ProtractorState);
    case "coordinatePlane":
      return coordinatePlaneSolved(spec, state as CoordinatePlaneState);
    case "geoLocate":
      return geoLocateSolved(spec, state as GeoLocateState, resolveRegion);
    case "ruler":
      return rulerSolved(spec, state as RulerState);
    case "clock":
      return clockSolved(spec, state as ClockState);
    case "liquid":
      return liquidSolved(spec, state as LiquidState);
    case "money":
      return moneySolved(spec, state as MoneyState);
  }
}

// ── live-readout policy (control of error, not a target-seeking gauge) ───────
/**
 * Whether a renderer may show a LIVE numeric readout of the quantity it is
 * graded on.
 *
 * The rule: **never display a value the goal already NAMES.** `NumberLine` set
 * this standard deliberately — it shows no number at all, because the task is
 * to locate a value by reading the scale, and a live readout turns that into
 * "drag until the widget says 7". Montessori control of error (which this
 * primitive's header invokes) is a self-check you get on Done, not a gauge you
 * steer by. A ruler that prints its own length while you drag has answered its
 * own question: the scholar never reads the scale, and for the broken ruler
 * never performs the `end − start` subtraction that is the entire point.
 *
 * The discriminator is the SAME one `goalText` already uses to decide what it
 * may say out loud — whether the scholar was asked to COMPUTE the value. So a
 * compute-style goal (`advanceBy`, `fewestPieces`) keeps its readout: the
 * number on screen is visible state, not the answer, and the scholar still has
 * to work out where to stop.
 *
 * Pure and exported so both frontends share one policy and it can be tested
 * directly, rather than eight renderers each hand-rolling a boolean.
 */
export interface LiveReadoutPolicy {
  /** Show the running quantity the goal grades (length / time / level / amount). */
  showValue: boolean;
  /** `money` only: show the running PIECE count. */
  showCount: boolean;
}

export function liveReadoutPolicy(spec: ManipulativeSpec): LiveReadoutPolicy {
  switch (spec.kind) {
    case "ruler":
      // `lengthEquals` names the length outright.
      return { showValue: spec.goal == null, showCount: true };
    case "clock":
      // `showTime` names the time; `advanceBy` does NOT name where you land, so
      // the face's current reading stays visible state.
      return { showValue: spec.goal == null || spec.goal.type === "advanceBy", showCount: true };
    case "liquid":
      // Both goal shapes name their amount (a jar level, or the total).
      return { showValue: spec.goal == null, showCount: true };
    case "money":
      // Every money goal names the cents. The piece COUNT is named only by
      // `amountEqualsWithCount`; under `fewestPieces` the count is the thing
      // being minimised and showing it is the point, not a leak.
      return {
        showValue: spec.goal == null,
        showCount: spec.goal?.type !== "amountEqualsWithCount",
      };
    default:
      // Every other kind owns its own display; this policy is not consulted.
      return { showValue: true, showCount: true };
  }
}

// ── tutor-facing describers (goalText + describeState) ───────────────────────
// A manipulative has no `answerCanonical`, so the Socratic explain/handoff can't
// be handed a {stem, correctAnswer}. Instead it's grounded in two pure, per-kind
// descriptions that live NEXT TO `isSolved` (same closed union, same never-guard
// discipline): what the kid was ASKED to do (`goalText`) and what their board
// CURRENTLY shows (`describeState`). The load-bearing rule (mirrors the spec in
// review/practice/practice-unification-choice-geometry-plan.html §U-4): a
// describer restates the TASK and the VISIBLE state, and NEVER a derived
// solution value. The discriminator is whether the kid was asked to COMPUTE it —
// a `placePoint`/`constructAngle` target IS the task (fine to name), but a
// `distributor` quotient/remainder, a `maxArea`, a `functionMachine` output, a
// `completeRectangle` corner, or a `reflectPoint` image is the answer they must
// work out (never named). Each such site is marked below. Keeping this
// pure + framework-free lets the Convex explain/handoff endpoints call it
// directly and lets it be exhaustively unit-tested.

/**
 * A number formatted for kid-facing prose: integers bare, a clean simple
 * fraction when the value is one (denominator ≤ 20), else two decimals. Used so
 * a partition target of 0.5 reads "1/2", not "0.5".
 */
export function formatManipNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return String(n);
  for (let den = 2; den <= 20; den++) {
    const num = n * den;
    if (Math.abs(num - Math.round(num)) < 1e-9) {
      const rounded = Math.round(num);
      const g = gcd(rounded, den);
      return `${rounded / g}/${den / g}`;
    }
  }
  return n.toFixed(2);
}

/** Oxford-style prose join of a short list ("a", "a and b", "a, b, and c"). */
function joinList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** Plain-words name for a die/coin ("6-sided die", "20-sided die", "coin"). */
function diceTypeLabel(diceType: DiceType): string {
  return diceType === "coin" ? "coin" : diceType === "d20" ? "20-sided die" : "6-sided die";
}

/** Plain-words phrase for a (closed-set) dice event — the TASK, never a count. */
function diceEventLabel(event: DiceEvent, diceType: DiceType): string {
  switch (event.type) {
    case "face":
      if (diceType === "coin") return event.value === 1 ? "heads" : "tails";
      return `a ${event.value}`;
    case "even":
      return "an even number";
    case "odd":
      return "an odd number";
    case "atLeast":
      return `at least ${event.value}`;
    case "greaterThan":
      return `greater than ${event.value}`;
  }
}

/**
 * Restate the TASK the scholar was set, as one plain kid-level sentence, derived
 * purely from the spec's goal. Exhaustive over all 14 kinds (never-guard). It
 * names a GIVEN target (the thing they were asked to place/build/construct) but
 * never a value they were asked to COMPUTE — every compute-style site is marked.
 */
export function goalText(spec: ManipulativeSpec): string {
  switch (spec.kind) {
    case "partition": {
      const g = spec.goal;
      if (!g) return `Shade the disc${spec.discs.length > 1 ? "s" : ""} the way the prompt asks.`;
      if (g.type === "shadedFractionEquals")
        return g.requireParts != null
          ? `Re-cut disc ${g.disc + 1} into ${g.requireParts} parts, then shade so the shaded part equals ${formatManipNumber(g.value)} of the whole.`
          : `Shade disc ${g.disc + 1} so the shaded part equals ${formatManipNumber(g.value)} of the whole — any equivalent shading counts.`;
      if (g.type === "partsEqual") {
        const parts = g.parts
          .map((p) => `disc ${p.disc + 1} equals ${formatManipNumber(p.value)}`)
          .join(" AND ");
        return `Shade each disc so ${parts} — every part must be built, not just the combined total.`;
      }
      return `Shade both discs so they cover the SAME fraction of their whole, even though the two discs are cut into different numbers of parts.`;
    }
    case "numberline": {
      const g = spec.goal;
      if (!g) return `Drag the marker where the prompt asks on the number line.`;
      const range = `the line runs from ${formatManipNumber(spec.min)} to ${formatManipNumber(spec.max)}`;
      if (g.type === "placeAt")
        return `Drag the marker to ${formatManipNumber(g.value)} on the number line (${range}).`;
      if (g.type === "placeFraction")
        return `Drag the marker to ${g.num}/${g.den} on the number line (${range}).`;
      if (g.type === "firstCommonMultiple")
        return `Reveal both skip-count tracks and stop at their first shared landing.`;
      return assertNoUnhandledGoal(g, `Drag the marker where the prompt asks on the number line.`);
    }
    case "array": {
      const g = spec.goal;
      if (!g) return `Build a rectangle of tiles the way the prompt asks.`;
      if (g.type === "productEquals")
        return `Build a rectangle of tiles whose total number of tiles is ${g.value} — you choose the rows and columns.`;
      if (g.type === "areaEquals")
        return `Build a rectangle whose area is ${g.value} square tiles.`;
      if (g.type === "sideEqualsWithProduct")
        return `Build a rectangle with ${g.side} tiles along one side, whose total is ${g.product}.`;
      if (g.type === "squareEquals")
        return `Build a SQUARE rectangle (same number of rows and columns) whose total is ${g.value}.`;
      // COMPUTE-STYLE: the factor-pair COUNT is what the kid works out — never state it.
      return `Make a rectangle for ${g.product} tiles, then work out how many different factor pairs ${g.product} has.`;
    }
    case "balance": {
      if (!spec.goal) return `Balance the two pans.`;
      // COMPUTE-STYLE (mysteryRight): the hidden block's weight is never stated.
      return spec.mysteryRight != null
        ? `Add or remove unit weights until the two pans balance — one pan hides a mystery block, so figure out how heavy it must be.`
        : `Add or remove unit weights until the two pans balance exactly.`;
    }
    case "areaPerimeter": {
      const g = spec.goal;
      if (!g) return `Reshape the rectangle — its fence length stays ${spec.perimeter}.`;
      if (g.type === "areaEquals")
        return `Reshape the rectangle — keeping its fence length at ${spec.perimeter} — so its area is exactly ${g.value} square units.`;
      // COMPUTE-STYLE (maxArea): the maximum area is what the kid discovers — never state it.
      return `Reshape the rectangle — keeping its fence length at ${spec.perimeter} — to make its area as LARGE as it possibly can be.`;
    }
    case "distribute": {
      const g = spec.goal;
      if (!g) return `Move the divider where the prompt asks.`;
      // The split column IS the given task (the prompt states the two parts to show).
      return `Move the divider so the ${spec.width}-wide rectangle is split at column ${g.column}, showing the two parts ${g.column} and ${spec.width - g.column}.`;
    }
    case "rekenrek": {
      const g = spec.goal;
      if (!g) return `Push the ${spec.total} beads into two groups on the rack.`;
      // The target group size IS the given task; the other group is not named.
      return `Push the ${spec.total} beads on the rack into two groups so that ONE group holds exactly ${g.value} beads.`;
    }
    case "distributor": {
      if (!spec.goal) return `Deal the ${spec.total} counters onto the ${spec.groups} plates.`;
      // COMPUTE-STYLE: state the dividend + divisor, NEVER the quotient/remainder.
      return `Deal all ${spec.total} counters onto ${spec.groups} equal plates, dealing as many full rounds as you can so every plate holds the same amount.`;
    }
    case "riemann": {
      if (!spec.goal) return `Add or remove left-sum bars under the speed line.`;
      // COMPUTE-STYLE: the true area / needed bar count is never stated.
      return `Add left-sum bars under the speed line until your estimate of the distance (the area under the line) is close enough to the true value.`;
    }
    case "functionMachine": {
      // COMPUTE-STYLE: examples + query input are given; the machine's rule and
      // its output for the query are what the kid works out — never stated.
      const examples = spec.examples.map((e) => `${e.in} → ${e.out}`).join(", ");
      return `Study the machine's examples (${examples}), work out its hidden rule, then predict what it puts out when the input is ${spec.queryInput}.`;
    }
    case "placeValue": {
      const g = spec.goal;
      if (!g) return `Set the base-ten columns the way the prompt asks.`;
      // Not compute-style: the target number IS the stated task (the prompt
      // gives it as a numeral, a number name, or an expanded sum).
      if (g.type === "shiftTo")
        return `Use ×10 / ÷10 to shift every digit across the place-value columns until the number reads ${formatManipNumber(g.value)}.`;
      if (spec.mode === "expandedForm")
        return `Set each place-value column so the expanded parts add up to ${formatManipNumber(g.value)}.`;
      return `Build the number ${formatManipNumber(g.value)} out of base-ten bundles — the right count of each place (hundreds, tens, ones).`;
    }
    case "dice": {
      const p = spec.prediction;
      const die = diceTypeLabel(spec.diceType);
      if (!p) return `Roll the ${die} and notice what happens.`;
      // COMPUTE-STYLE: the event is given; the count/probability/mode is not.
      if (p.type === "favorableCount")
        return `Roll the ${die} to explore, then predict how many of its faces are ${diceEventLabel(p.event, spec.diceType)}.`;
      if (p.type === "probability")
        return `Roll the ${die} to explore, then predict the probability of rolling ${diceEventLabel(p.event, spec.diceType)}.`;
      return `Roll the dice to explore, then predict the most likely TOTAL when you roll ${diceCount(spec)} of them.`;
    }
    case "protractor": {
      const g = spec.goal;
      if (!g) return `Rotate the protractor's ray.`;
      // Not compute-style: the target IS the stated task, never hidden.
      return `Rotate the ray until it reads ${g.targetDeg}° on the protractor — construct that angle.`;
    }
    case "coordinatePlane": {
      const g = spec.goal;
      if (!g) return `Drag the point on the coordinate plane.`;
      if (g.type === "placePoint")
        return `Drag the point to (${g.x}, ${g.y}) on the coordinate plane.`;
      if (g.type === "placePoints")
        return `Drag the points onto ${joinList(g.points.map((p) => `(${p.x}, ${p.y})`))}.`;
      // COMPUTE-STYLE (completeRectangle): the missing corner is derived — never named.
      if (g.type === "completeRectangle")
        return `Drag the point to the 4th corner that completes the rectangle whose other three corners are already marked on the plane.`;
      // COMPUTE-STYLE (reflectPoint): state the point + the axis, NEVER the image.
      return `Drag the point to the reflection of (${g.point.x}, ${g.point.y}) across the ${g.across}-axis.`;
    }
    case "geoLocate":
      // The task prompt IS the question ("Tap where Honolulu is.") — safe to
      // state; the target coordinate is the answer and never appears here.
      return spec.map.task.prompt;
    case "ruler": {
      const g = spec.goal;
      const unit = rulerUnitLabel(spec.unit);
      if (!g) return `Drag the end of the bar along the ${unit} ruler.`;
      // Not compute-style: the target LENGTH is the stated task. The broken-
      // ruler start is stated too — it's a visible fact of the board, and the
      // work is realising that length is end minus start, not the end alone.
      const start = rulerStart(spec);
      const from =
        start > 0
          ? ` The bar's left edge is pinned at ${formatManipNumber(start)}, so the number its end lands on is NOT its length.`
          : "";
      return `Drag the end of the bar until the bar itself measures ${formatManipNumber(g.value)} ${unit} on the ruler.${from}`;
    }
    case "clock": {
      const g = spec.goal;
      const startsAt = formatClockTime(clockMinutesOf(spec.startHour, spec.startMinute));
      if (!g) return `Drag the minute hand around the clock face.`;
      if (g.type === "showTime")
        // Not compute-style: the time IS the stated task.
        return `Move the clock's hands to show ${formatClockTime(clockMinutesOf(g.hour, g.minute))}. The hour hand moves along with the minute hand, just like a real clock.`;
      // COMPUTE-STYLE (advanceBy): state the start time and the elapsed
      // minutes, NEVER the time they land on — that is the answer.
      return `The clock starts at ${startsAt}. Move the hands forward by ${g.minutes} minute${g.minutes === 1 ? "" : "s"} to show what time it will be.`;
    }
    case "liquid": {
      const g = spec.goal;
      const unit = liquidUnitLabel(spec.unit, 2);
      if (!g) return `Pour the jars up and down and notice how much each one holds.`;
      if (g.type === "fillTo") {
        // Not compute-style: the level IS the stated task.
        const jar = liquidVesselName(spec, g.vessel);
        return `Pour the ${jar} until it holds exactly ${formatManipNumber(g.value)} ${liquidUnitLabel(spec.unit, g.value)}.`;
      }
      // Not compute-style either: the TOTAL is given. The work is splitting it
      // across jars, which authoring guarantees needs more than one of them.
      const caps = spec.vessels
        .map((v, i) => `${liquidVesselName(spec, i)} holds ${formatManipNumber(v.capacity)}`)
        .join(", ");
      return `Pour so the jars hold ${formatManipNumber(g.value)} ${unit} ALTOGETHER — more than any one jar can take, so you'll need to share it out (${caps}).`;
    }
    case "money": {
      const g = spec.goal;
      const bank = joinList(spec.available.map((d) => MONEY_PIECES[d]?.plural ?? d));
      if (!g) return `Add coins and bills to the tray and watch the total.`;
      // "coins" only when the bank really is coins — a bank with bills in it
      // must not tell a scholar to count "coins".
      const piece = spec.available.every((d) => MONEY_PIECES[d]?.shape === "coin") ? "coin" : "piece";
      if (g.type === "amountEquals")
        // Not compute-style: the amount IS the stated task.
        return `Put ${piece}s in the tray until they add up to exactly ${formatMoney(g.cents)}. You have ${bank} to choose from.`;
      if (g.type === "amountEqualsWithCount")
        // Not compute-style: both the amount and the piece count are given —
        // the WHICH pieces is the work.
        return `Make exactly ${formatMoney(g.cents)} using exactly ${g.count} ${piece}${g.count === 1 ? "" : "s"} — no more, no fewer. You have ${bank} to choose from.`;
      // COMPUTE-STYLE (fewestPieces): the minimum count is the discovery, so it
      // is never named.
      return `Make exactly ${formatMoney(g.cents)} using as FEW ${piece}s as you possibly can. You have ${bank} to choose from.`;
    }
    default: {
      const _exhaustive: never = spec;
      return _exhaustive;
    }
  }
}

/** Plain-words unit for a ruler scale ("centimetres" / "inches"). */
function rulerUnitLabel(unit: RulerSpec["unit"]): string {
  return unit === "in" ? "inches" : "centimeters";
}

/**
 * Plain-words unit for a liquid amount, singular when the amount is exactly 1.
 * Exported so the two renderers' running totals inflect the same way the tutor
 * describers do — otherwise a jar reads "5 cup altogether".
 */
export function liquidUnitLabel(unit: LiquidSpec["unit"], amount: number): string {
  if (unit === "cup") return approxEqual(amount, 1, 1e-9) ? "cup" : "cups";
  return unit; // "L" / "mL" don't inflect
}

/** A jar's authored name, or a positional fallback ("jar 2"). */
function liquidVesselName(spec: LiquidSpec, index: number): string {
  const label = spec.vessels[index]?.label?.trim();
  return label && label.length > 0 ? label : `jar ${index + 1}`;
}

/**
 * Describe what the manipulative's board CURRENTLY shows, from a submitted
 * runtime-state JSON — the visible configuration only, never the target. TOTAL
 * by contract (same as `gradeManipulativeSubmission`): malformed or
 * kind-mismatched JSON yields a neutral fallback and never throws, so a
 * forged/garbage state can't crash the describer or leak anything.
 */
export function describeState(spec: ManipulativeSpec, stateJson: string): string {
  let state: unknown;
  try {
    state = JSON.parse(stateJson);
  } catch {
    return "The board hasn't been changed yet.";
  }
  try {
    return describeStateInner(spec, state);
  } catch {
    return "The board hasn't been changed yet.";
  }
}

function describeStateInner(spec: ManipulativeSpec, state: unknown): string {
  switch (spec.kind) {
    case "partition": {
      const s = state as PartitionState;
      const discs = s.discs.map(
        (d, i) => `disc ${i + 1} is cut into ${d.parts} parts with ${d.shaded} shaded (${d.shaded}/${d.parts})`,
      );
      return `Right now, ${joinList(discs)}.`;
    }
    case "numberline": {
      const s = state as NumberLineState;
      return `The marker is sitting at ${formatManipNumber(s.value)} (the line runs from ${formatManipNumber(spec.min)} to ${formatManipNumber(spec.max)}).`;
    }
    case "array": {
      const s = state as ArrayState;
      return `The array is ${s.rows} by ${s.cols} right now — ${s.rows * s.cols} tiles in all.`;
    }
    case "balance": {
      const s = state as BalanceState;
      const tilt = balanceTilt(spec, s);
      const dir = tilt > 0 ? "tips down on the left" : tilt < 0 ? "tips down on the right" : "is level";
      // Never name the mystery block's weight — only that a pan hides one.
      const mystery = spec.mysteryRight != null ? " (the right pan also hides a mystery block)" : "";
      return `The left pan holds ${s.left} and the right pan holds ${s.right}${mystery}; the beam ${dir} right now.`;
    }
    case "areaPerimeter": {
      const s = state as AreaPerimeterState;
      const h = heightForPerimeter(spec.perimeter, s.width);
      return `The rectangle is ${s.width} wide and ${h} tall right now, so its area is ${areaPerimeterArea(spec, s)} square units.`;
    }
    case "distribute": {
      const s = state as DistributeState;
      return `The divider is at column ${s.column}, splitting the ${spec.width}-wide rectangle into ${s.column} and ${spec.width - s.column}.`;
    }
    case "rekenrek": {
      const s = state as RekenrekState;
      const left = clamp(Math.round(s.left), 0, spec.total);
      return `The rack has ${left} beads pushed to the left and ${spec.total - left} to the right.`;
    }
    case "distributor": {
      const s = state as DistributorState;
      // The leftover pile is VISIBLE state (their current, possibly wrong, deal),
      // not the true remainder — safe to report.
      const leftover = distributorRemainder(spec, s);
      return `Each of the ${spec.groups} plates holds ${s.perGroup} counter${s.perGroup === 1 ? "" : "s"} right now, and ${leftover} counter${leftover === 1 ? "" : "s"} are still in the leftover pile.`;
    }
    case "riemann": {
      const s = state as RiemannState;
      return `There ${s.bars === 1 ? "is" : "are"} ${s.bars} left-sum bar${s.bars === 1 ? "" : "s"} under the speed line right now.`;
    }
    case "functionMachine": {
      const s = state as FunctionMachineState;
      return s.predicted == null
        ? `No prediction has been entered yet for an input of ${spec.queryInput}.`
        : `The prediction entered for an input of ${spec.queryInput} is ${s.predicted}.`;
    }
    case "placeValue": {
      const s = state as PlaceValueState;
      const counts = Array.isArray(s?.counts) ? s.counts : [];
      const parts = spec.places.map(
        (place, i) => `${counts[i] ?? 0} × ${formatManipNumber(place)}`,
      );
      // Report the VISIBLE configuration + the total it currently makes (their
      // possibly-wrong build), never the target number.
      return `The columns hold ${joinList(parts)} right now, which makes ${formatManipNumber(placeValueTotal(spec, counts))}.`;
    }
    case "dice": {
      const s = state as DiceState;
      const rolls = `You've rolled ${s.rollCount} time${s.rollCount === 1 ? "" : "s"}`;
      if (!s.predicted) return `${rolls} and haven't committed a prediction yet.`;
      const { num, den } = s.predicted;
      const pred = den === 1 ? `${num}` : `${num}/${den}`;
      return `${rolls} and predicted ${pred}.`;
    }
    case "protractor": {
      const s = state as ProtractorState;
      return `The ray is reading ${formatManipNumber(s.angleDeg)}° right now.`;
    }
    case "coordinatePlane": {
      const s = state as CoordinatePlaneState;
      const pts = s.points.map((p) => `(${p.x}, ${p.y})`);
      if (pts.length === 0) return `No point has been placed yet.`;
      if (pts.length === 1) return `The point is at ${pts[0]} right now.`;
      return `The points are at ${joinList(pts)} right now.`;
    }
    case "geoLocate": {
      const s = state as GeoLocateState;
      const n = Array.isArray(s?.pins) ? s.pins.length : 0;
      // Report only HOW MANY pins are down (visible state), never where the
      // target is or whether they're close — that's the graded answer.
      if (n === 0) return `No pin has been dropped on the map yet.`;
      return `${n === 1 ? "One pin is" : `${n} pins are`} on the map right now.`;
    }
    case "ruler": {
      const s = state as RulerState;
      const start = rulerStart(spec);
      const end = rulerSnapEnd(spec, s?.end ?? start);
      const unit = rulerUnitLabel(spec.unit);
      // Report the VISIBLE board — where the bar starts, where it ends, and the
      // length that currently makes. The target length never appears.
      return `The bar runs from ${formatManipNumber(start)} to ${formatManipNumber(end)} on the ${unit} ruler, so right now it measures ${formatManipNumber(end - start)} ${unit}.`;
    }
    case "clock": {
      const s = state as ClockState;
      const minutes = Number.isFinite(s?.minutes)
        ? clockNormalize(s.minutes)
        : clockMinutesOf(spec.startHour, spec.startMinute);
      // The face's current reading is visible state. For an advanceBy goal the
      // TARGET time stays unnamed (see goalText) — this only says where the
      // hands are, which the scholar can already see.
      return `The clock's hands are showing ${formatClockTime(minutes)} right now.`;
    }
    case "liquid": {
      const s = state as LiquidState;
      const levels = spec.vessels.map((v, i) => {
        const level = liquidSnapLevel(spec, i, s?.levels?.[i] ?? 0);
        return `${liquidVesselName(spec, i)} holds ${formatManipNumber(level)} of its ${formatManipNumber(v.capacity)}`;
      });
      const total = liquidTotal(spec, s ?? { levels: [] });
      return `Right now ${joinList(levels)} — ${formatManipNumber(total)} ${liquidUnitLabel(spec.unit, total)} altogether.`;
    }
    case "money": {
      const s = state as MoneyState;
      const counts = Array.isArray(s?.counts) ? s.counts : [];
      const held = spec.available
        .map((denomination, i) => ({ denomination, n: Math.max(0, Math.round(counts[i] ?? 0)) }))
        .filter((p) => p.n > 0)
        .map(({ denomination, n }) => {
          const facts = MONEY_PIECES[denomination];
          return `${n} ${n === 1 ? (facts?.label ?? denomination) : (facts?.plural ?? denomination)}`;
        });
      if (held.length === 0) return `The tray is empty — no coins have been added yet.`;
      // The tray's own value is visible state (their possibly-wrong build); the
      // target amount and any minimum piece count never appear.
      return `The tray holds ${joinList(held)} right now, which comes to ${formatMoney(moneyTotalCents(spec, counts))}.`;
    }
    default: {
      const _exhaustive: never = spec;
      return _exhaustive;
    }
  }
}