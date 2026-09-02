/**
 * Authoring-time gradability guard for the Manipulative primitive.
 *
 * Known gap (flagged in lane 2's review): `isSolved` (`./logic.ts`) grades a
 * manipulative purely off its `goal` — it NEVER reads `spec.answer`. A
 * manipulative practiceItem whose spec has no usable `goal` is therefore
 * UNGRADABLE: `isSolved` returns `false` unconditionally (see every
 * `*Solved` predicate's `if (!g) return false;` guard in `logic.ts`), so the
 * scholar can never be marked correct no matter what they build.
 *
 * `functionMachine` is the one kind that's the exception BY DESIGN: its type
 * declares `goal?: never` (`./types.ts`) and is graded instead off
 * `rule` + `queryInput` (see `functionMachineSolved`) — a functionMachine spec
 * is always gradable as long as it has a rule and a query input, which its
 * type makes mandatory. Every other kind is gradable iff its `goal` is
 * present and shaped correctly for that kind's `*Solved` predicate.
 *
 * Use `assertGradableManipulative` on any path that WRITES a manipulative
 * spec into a `practiceItems` row (seeding, authoring, import) so an
 * ungradable manipulative can never be persisted in the first place.
 */

import type {
  ArraySpec,
  AreaPerimeterSpec,
  BalanceSpec,
  ClockSpec,
  CoordinatePlaneSpec,
  DiceSpec,
  DistributeSpec,
  DistributorSpec,
  LiquidSpec,
  RekenrekSpec,
  ManipulativeSpec,
  MoneySpec,
  NumberLineSpec,
  PartitionSpec,
  PlaceValueGoal,
  PlaceValueSpec,
  ProtractorSpec,
  RiemannSpec,
  RulerSpec,
} from "./types";
import { isMoneyDenomination } from "./currency";
import {
  clockSnapMinutes,
  clockSolved,
  clockTargetMinutes,
  initialArray,
  initialAreaPerimeter,
  initialBalance,
  initialClock,
  initialCoordinatePlane,
  initialDice,
  initialDistribute,
  initialDistributor,
  initialLiquid,
  initialMoney,
  initialRekenrek,
  initialFunctionMachine,
  initialGeoLocate,
  initialNumberLine,
  leastCommonMultiple,
  numberLineSolved,
  initialPartition,
  initialPlaceValue,
  initialProtractor,
  initialRiemann,
  initialRuler,
  coordinatePlaneSolved,
  assertNoUnhandledGoal,
  isSolved,
  liquidSolved,
  liquidStep,
  moneyAmountReachableWithCount,
  moneyFewestPieces,
  moneyMaxPerDenomination,
  moneySolved,
  MONEY_MAX_CENTS,
  MONEY_MAX_PIECES,
  placeValueMaxPerPlace,
  placeValueShift,
  placeValueSolved,
  placeValueTotal,
  protractorSolved,
  pointOnGrid,
  rectangleMissingCorner,
  rulerPrecision,
  rulerSolved,
  rulerStart,
} from "./logic";

function partitionGoalIsUsable(spec: PartitionSpec): boolean {
  const g = spec.goal;
  if (!g) return false;
  if (g.type === "shadedFractionEquals") {
    return Number.isInteger(g.disc) && g.disc >= 0 && g.disc < spec.discs.length;
  }
  if (g.type === "partsEqual") {
    return (
      g.parts.length > 0 &&
      g.parts.every((p) => Number.isInteger(p.disc) && p.disc >= 0 && p.disc < spec.discs.length)
    );
  }
  return true; // discsEqualShadedArea — no extra fields to validate
}

function numberLineGoalIsUsable(spec: NumberLineSpec): boolean {
  const g = spec.goal;
  if (!g) return false;
  if (g.type === "placeAt") return Number.isFinite(g.value);
  if (g.type === "placeFraction")
    return Number.isFinite(g.num) && Number.isFinite(g.den) && g.den !== 0;
  if (g.type === "firstCommonMultiple") {
    const tracks = spec.multipleTracks;
    const target = tracks && leastCommonMultiple(tracks[0], tracks[1]);
    return target != null && target >= spec.min && target <= spec.max && !numberLineSolved(spec, initialNumberLine(spec));
  }
  return assertNoUnhandledGoal(g, false);
}

function arrayGoalIsUsable(spec: ArraySpec): boolean {
  const g = spec.goal;
  if (!g) return false;
  if (g.type === "productEquals" || g.type === "areaEquals") return Number.isFinite(g.value);
  if (g.type === "sideEqualsWithProduct") {
    return (
      Number.isFinite(g.side) &&
      g.side > 0 &&
      Number.isFinite(g.product) &&
      g.product > 0 &&
      Number.isInteger(g.product / g.side)
    );
  }
  if (g.type === "squareEquals") {
    const root = Math.sqrt(g.value);
    return Number.isFinite(g.value) && g.value > 0 && Number.isInteger(root);
  }
  return Number.isFinite(g.product) && Number.isFinite(g.count); // factorPairCountEquals
}

function balanceGoalIsUsable(spec: BalanceSpec): boolean {
  return spec.goal?.type === "balance";
}

function areaPerimeterGoalIsUsable(spec: AreaPerimeterSpec): boolean {
  const g = spec.goal;
  if (!g) return false;
  if (g.type === "areaEquals") return Number.isFinite(g.value);
  return g.type === "maxArea";
}

function distributeGoalIsUsable(spec: DistributeSpec): boolean {
  const g = spec.goal;
  return g != null && g.type === "splitAt" && Number.isFinite(g.column);
}

function rekenrekGoalIsUsable(spec: RekenrekSpec): boolean {
  const g = spec.goal;
  return (
    g != null &&
    g.type === "groupOf" &&
    Number.isFinite(g.value) &&
    // The target must be reachable by SOME split of the beads.
    g.value >= 0 &&
    g.value <= spec.total
  );
}

function distributorGoalIsUsable(spec: DistributorSpec): boolean {
  const g = spec.goal;
  return (
    g != null &&
    g.type === "shareEqually" &&
    Number.isInteger(spec.total) &&
    Number.isInteger(spec.groups) &&
    spec.groups >= 1 &&
    spec.total >= 0
  );
}

function riemannGoalIsUsable(spec: RiemannSpec): boolean {
  const g = spec.goal;
  return g != null && g.type === "approximateWithin" && Number.isFinite(g.tolerance);
}

/**
 * A dice manipulative is gradable iff it carries a well-formed `prediction`
 * (its committed answer is the verdict — see `diceSolved`). A sandbox dice (no
 * `prediction`) is a free explorer, never a graded practiceItem, so it is
 * intentionally reported ungradable here.
 */
function diceIsGradable(spec: DiceSpec): boolean {
  const p = spec.prediction;
  if (!p) return false;
  if (p.type === "favorableCount" || p.type === "probability") {
    const e = p.event;
    if (e.type === "face" || e.type === "atLeast" || e.type === "greaterThan") {
      return Number.isFinite(e.value);
    }
    return e.type === "even" || e.type === "odd";
  }
  return p.type === "mostLikelyTotal";
}

/**
 * A protractor is gradable iff its goal is the (only) `constructAngle` mode
 * with a finite target degree in 0..180 AND the spec's starting angle does
 * NOT already read as solved — a manipulative must never hand the scholar a
 * puzzle that's already done. Reuses the exact `protractorSolved`/
 * `initialProtractor` predicates the renderer runs, so authoring and runtime
 * can never disagree about "already solved".
 *
 * The explicit `g.type !== "constructAngle"` check REJECTS a stale
 * `measureAngle`-shaped spec loudly (that goal mode was removed 2026-07 for
 * being gameable — see the doc comment on `ProtractorGoal` in types.ts) — a
 * pre-existing DB row shaped `{type: "measureAngle", drawnDeg: ...}` has no
 * `targetDeg`, so without this guard it would fail QUIETLY (`target` reads
 * `undefined`, `Number.isFinite` returns false) rather than being flagged as
 * the deliberately-killed mode it is.
 */
function protractorGoalIsUsable(spec: ProtractorSpec): boolean {
  const g = spec.goal;
  if (!g || g.type !== "constructAngle") return false;
  const target = g.targetDeg;
  if (!Number.isFinite(target) || target < 0 || target > 180) return false;
  if (!Number.isFinite(spec.startDeg) || spec.startDeg < 0 || spec.startDeg > 180) return false;
  return !protractorSolved(spec, initialProtractor(spec));
}

/**
 * A coordinatePlane is gradable iff: the axis ranges + grid step are
 * well-formed, there are 1-3 draggable points, the goal is shaped correctly
 * for its type with every target landing exactly on a grid line, AND the
 * SNAPPED initial state does not already satisfy the goal (a draggable must
 * not start on its target — see `CoordinatePlaneSpec.draggable` in types.ts).
 */
function coordinatePlaneGoalIsUsable(spec: CoordinatePlaneSpec): boolean {
  const g = spec.goal;
  if (!g) return false;
  if (!(spec.xMax > spec.xMin) || !(spec.yMax > spec.yMin) || !(spec.gridStep > 0)) return false;
  if (!Array.isArray(spec.draggable) || spec.draggable.length < 1 || spec.draggable.length > 3) return false;

  const onGrid = (p: { x: number; y: number }) =>
    pointOnGrid(p, spec.xMin, spec.xMax, spec.yMin, spec.yMax, spec.gridStep);

  if (g.type === "placePoint") {
    if (spec.draggable.length !== 1) return false;
    if (!Number.isFinite(g.x) || !Number.isFinite(g.y) || !onGrid({ x: g.x, y: g.y })) return false;
  } else if (g.type === "placePoints") {
    if (!Array.isArray(g.points) || g.points.length !== spec.draggable.length) return false;
    if (!g.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && onGrid(p))) return false;
  } else if (g.type === "completeRectangle") {
    if (spec.draggable.length !== 1) return false;
    const missing = rectangleMissingCorner((spec.fixedPoints ?? []).slice(0, 3));
    if (missing == null || !onGrid(missing)) return false;
  } else if (g.type === "reflectPoint") {
    if (spec.draggable.length !== 1) return false;
    if (g.across !== "x" && g.across !== "y") return false;
    if (!Number.isFinite(g.point.x) || !Number.isFinite(g.point.y)) return false;
    const target = g.across === "x" ? { x: g.point.x, y: -g.point.y } : { x: -g.point.x, y: g.point.y };
    if (!onGrid(target)) return false;
  }

  return !coordinatePlaneSolved(spec, initialCoordinatePlane(spec));
}

/**
 * A placeValue is gradable iff its columns are consecutive descending powers of
 * ten down to 1, its goal is shaped for its type, the target number is exactly
 * representable in those columns (canonical single-digit per place for
 * buildValue), a placeShift target is actually REACHABLE from the start by
 * legal ×10/÷10 shifts, AND the initial state does not already read as solved
 * (a manipulative must never hand out a puzzle that's already done). Reuses the
 * exact `placeValueSolved` / `initialPlaceValue` / `placeValueShift` the
 * renderer runs, so authoring and runtime can't disagree.
 */
function placesAreConsecutivePowersOfTen(places: number[]): boolean {
  if (!Array.isArray(places) || places.length < 1) return false;
  return places.every((p, i) => p === Math.pow(10, places.length - 1 - i));
}

function placeValueCanonicalFits(spec: PlaceValueSpec, value: number): boolean {
  const max = placeValueMaxPerPlace(spec);
  const counts = spec.places.map((place) => Math.floor(value / place) % 10);
  if (!counts.every((c) => c >= 0 && c <= max)) return false;
  // Reconstruct so a value too big for the columns (a lost high digit) fails.
  return placeValueTotal(spec, counts) === value;
}

function placeValueReachableByShifts(spec: PlaceValueSpec, target: number): boolean {
  const start = initialPlaceValue(spec).counts;
  for (const dir of ["up", "down"] as const) {
    let cur: number[] | null = start;
    // At most one full sweep across the columns in each direction reaches any
    // target = start · 10^k that fits.
    for (let k = 0; k <= spec.places.length && cur; k++) {
      if (placeValueTotal(spec, cur) === target) return true;
      cur = placeValueShift(spec, cur, dir);
    }
  }
  return false;
}

/**
 * The legal (mode, goal.type) pairings — enumerated explicitly, because a
 * mode's on-screen controls determine which goal is even REACHABLE:
 *   • buildNumber / expandedForm — per-column steppers assemble a value, so the
 *     only reachable goal is `buildValue`.
 *   • placeShift — ×10/÷10 buttons slide digits (no steppers), so the only
 *     reachable goal is `shiftTo`.
 * A mismatched combo (e.g. placeShift + buildValue) is gradable on paper but
 * UNSOLVABLE with the mode's controls, so it must be rejected at authoring time
 * rather than shipped as an impossible puzzle.
 */
const PLACE_VALUE_LEGAL_GOAL: Record<PlaceValueSpec["mode"], PlaceValueGoal["type"]> = {
  buildNumber: "buildValue",
  expandedForm: "buildValue",
  placeShift: "shiftTo",
};

/**
 * The most place columns the renderers can lay out. The chart is deliberately
 * NON-wrapping on both surfaces (left-to-right order across the columns IS the
 * base-ten idea), so the columns share the stage width instead of dropping to a
 * second row — and the narrowest real stage is the 460px web practice column
 * (~420px inside the card). At six places each column is ~63px, which still
 * leaves the compact stepper's two buttons above their 24px minimum; at seven
 * they no longer fit and the row would clip rather than wrap. A spec past this
 * is therefore not renderable, so it is not authorable.
 */
const PLACE_VALUE_MAX_PLACES = 6;

function placeValueGoalIsUsable(spec: PlaceValueSpec): boolean {
  if (!placesAreConsecutivePowersOfTen(spec.places)) return false;
  if (spec.places.length > PLACE_VALUE_MAX_PLACES) return false;
  const g = spec.goal;
  if (!g) return false;
  // The mode's controls must be able to reach the goal (see the table above).
  if (PLACE_VALUE_LEGAL_GOAL[spec.mode] !== g.type) return false;
  if (!Number.isInteger(g.value) || g.value < 0) return false;
  if (!placeValueCanonicalFits(spec, g.value)) return false;
  // shiftTo additionally requires the target be reachable from the start.
  if (g.type === "shiftTo" && !placeValueReachableByShifts(spec, g.value)) return false;
  return !placeValueSolved(spec, initialPlaceValue(spec));
}

/** True when `value` sits exactly on a `step` gradation from 0 (within FP dust). */
function onGradation(value: number, step: number): boolean {
  if (!Number.isFinite(value) || !(step > 0)) return false;
  const k = value / step;
  return Math.abs(k - Math.round(k)) < 1e-6;
}

/**
 * A ruler is gradable iff the printed scale is well-formed (a positive length
 * that is a whole number of gradations), the bar's pinned start and the target
 * length both land on gradations, the target length actually FITS to the right
 * of the start (`startAt + value <= length` — a 9 cm bar cannot be built on a
 * 12 cm ruler starting at 5), and the starting bar does not already measure the
 * target. Reuses the same `rulerSolved`/`initialRuler` the renderers run.
 */
function rulerGoalIsUsable(spec: RulerSpec): boolean {
  const precision = rulerPrecision(spec);
  if (!Number.isFinite(spec.length) || spec.length <= 0) return false;
  if (!onGradation(spec.length, precision)) return false;
  const start = rulerStart(spec);
  if (!onGradation(start, precision) || start >= spec.length) return false;
  if (!Number.isFinite(spec.startEnd) || spec.startEnd < start || spec.startEnd > spec.length) return false;
  const g = spec.goal;
  if (!g || g.type !== "lengthEquals") return false;
  if (!Number.isFinite(g.value) || g.value <= 0) return false;
  if (!onGradation(g.value, precision)) return false;
  if (start + g.value > spec.length + 1e-9) return false;
  return !rulerSolved(spec, initialRuler(spec));
}

/**
 * A clock is gradable iff the start reading is a real 12-hour time, the snap
 * divides an hour (so the gradations line up with the dial's five-minute
 * marks), the goal's target lands ON a snap gradation (otherwise the hands can
 * never reach it — the "impossible puzzle" failure the protractor guard also
 * prevents), and the face does not already read the answer.
 */
function clockGoalIsUsable(spec: ClockSpec): boolean {
  if (!Number.isInteger(spec.startHour) || spec.startHour < 1 || spec.startHour > 12) return false;
  if (!Number.isInteger(spec.startMinute) || spec.startMinute < 0 || spec.startMinute > 59) return false;
  const snap = clockSnapMinutes(spec);
  if (60 % snap !== 0) return false;
  // The start position must itself sit on a gradation, or the very first drag
  // silently jumps the face somewhere the author never intended.
  if (spec.startMinute % snap !== 0) return false;
  const g = spec.goal;
  if (!g) return false;
  if (g.type === "showTime") {
    if (!Number.isInteger(g.hour) || g.hour < 1 || g.hour > 12) return false;
    if (!Number.isInteger(g.minute) || g.minute < 0 || g.minute > 59) return false;
    if (g.minute % snap !== 0) return false;
  } else if (g.type === "advanceBy") {
    if (!Number.isInteger(g.minutes) || g.minutes <= 0) return false;
    if (g.minutes % snap !== 0) return false;
    // A full turn of the dial lands back where it started, which would read as
    // "already solved" and teaches nothing about elapsed time.
    if (g.minutes % 720 === 0) return false;
  } else {
    return false;
  }
  if (clockTargetMinutes(spec) == null) return false;
  return !clockSolved(spec, initialClock(spec));
}

/**
 * A liquid spec is gradable iff it has 1-3 jars of positive capacity that are a
 * whole number of gradations, its goal targets a real jar / a reachable total
 * on a gradation, and it does not start solved.
 *
 * The load-bearing extra check is on `totalEquals`: the target MUST exceed
 * every single jar's capacity. Without it a "make 3 cups altogether" goal over
 * a 4-cup jar is satisfied by pouring that one jar to 3 — which is `fillTo`
 * wearing a costume, and the composing-measures idea the goal exists for never
 * happens (the calibration discipline in `rabbithole-product-taste.md` T6:
 * a goal ships with the constraint that makes it real, or not at all).
 */
function liquidGoalIsUsable(spec: LiquidSpec): boolean {
  if (!Array.isArray(spec.vessels) || spec.vessels.length < 1 || spec.vessels.length > 3) return false;
  const step = liquidStep(spec);
  if (!spec.vessels.every((v) => Number.isFinite(v.capacity) && v.capacity > 0 && onGradation(v.capacity, step)))
    return false;
  if (!spec.vessels.every((v) => v.start == null || (Number.isFinite(v.start) && v.start >= 0 && v.start <= v.capacity)))
    return false;
  const g = spec.goal;
  if (!g) return false;
  if (g.type === "fillTo") {
    const vessel = spec.vessels[g.vessel];
    if (!Number.isInteger(g.vessel) || vessel == null) return false;
    if (!Number.isFinite(g.value) || g.value <= 0 || g.value > vessel.capacity) return false;
    if (!onGradation(g.value, step)) return false;
  } else if (g.type === "totalEquals") {
    const capacities = spec.vessels.map((v) => v.capacity);
    const totalCapacity = capacities.reduce((a, b) => a + b, 0);
    if (!Number.isFinite(g.value) || g.value <= 0 || g.value > totalCapacity) return false;
    if (!onGradation(g.value, step)) return false;
    // Must genuinely need more than one jar — see the doc comment above.
    if (g.value <= Math.max(...capacities)) return false;
  } else {
    return false;
  }
  return !liquidSolved(spec, initialLiquid(spec));
}

/**
 * A money spec is gradable iff its bank is a non-empty, duplicate-free list of
 * real denominations, its target amount is positive, within the search bound,
 * and actually MAKEABLE out of that bank **under the tray's own
 * per-denomination cap**, any exact piece count is itself achievable under that
 * cap, and the tray does not start solved.
 *
 * The cap is the subtle part, and getting it wrong ships permanently
 * unsolvable challenges. Reachability must be computed with the SAME bound the
 * runtime enforces (`moneySolved` rejects any count above `maxPerDenomination`,
 * and both renderers refuse to increment past it). An unbounded check, or an
 * aggregate `count <= cap × kinds` approximation, accepts specs the tray can
 * never satisfy:
 *   • bank {half dollar}, cap 20, target $20.00 — the unbounded answer is 40
 *     coins, but the tray tops out at $10.00;
 *   • bank {quarter, dime}, cap 3, `fewestPieces` 90¢ — the true optimum is
 *     2 quarters + 4 dimes, and 4 dimes is over the cap, yet the aggregate
 *     bound (6 ≤ 3×2) waves it through. No (q,d) pair within the cap makes 90¢.
 * Both were live bugs caught in review; `moneyFewestPieces` /
 * `moneyAmountReachableWithCount` now take the cap as a required argument so a
 * caller cannot forget it.
 */
function moneyGoalIsUsable(spec: MoneySpec): boolean {
  const available = spec.available;
  if (!Array.isArray(available) || available.length === 0) return false;
  if (!available.every((d) => isMoneyDenomination(d))) return false;
  if (new Set(available).size !== available.length) return false;
  if (spec.start != null && (!Array.isArray(spec.start) || spec.start.length !== available.length)) return false;
  const g = spec.goal;
  if (!g) return false;
  if (!Number.isInteger(g.cents) || g.cents <= 0 || g.cents > MONEY_MAX_CENTS) return false;
  const max = moneyMaxPerDenomination(spec);
  // Unreachable UNDER THE CAP ⇒ no tray the scholar can build is ever correct.
  const fewest = moneyFewestPieces(available, g.cents, max);
  if (fewest == null) return false;
  if (g.type === "amountEqualsWithCount") {
    if (!Number.isInteger(g.count) || g.count < 1 || g.count > MONEY_MAX_PIECES) return false;
    if (!moneyAmountReachableWithCount(available, g.cents, g.count, max)) return false;
  } else if (g.type === "fewestPieces") {
    // Only interesting when the bank offers a real choice — with one
    // denomination every correct total is already the minimum, so "use the
    // fewest" is a claim with no work behind it.
    if (available.length < 2) return false;
  } else if (g.type !== "amountEquals") {
    return false;
  }
  return !moneySolved(spec, initialMoney(spec));
}

/**
 * True iff `isSolved` can ever return true for this spec — i.e. the spec
 * carries a `goal` (kind-shaped correctly) that its `*Solved` predicate in
 * `logic.ts` will actually read, or (functionMachine only) the kind is
 * inherently gradable off `rule` + `queryInput` with no `goal` at all.
 */
export function isGradableManipulative(spec: ManipulativeSpec): boolean {
  switch (spec.kind) {
    case "partition":
      return partitionGoalIsUsable(spec);
    case "numberline":
      return numberLineGoalIsUsable(spec);
    case "array":
      return arrayGoalIsUsable(spec);
    case "balance":
      return balanceGoalIsUsable(spec);
    case "areaPerimeter":
      return areaPerimeterGoalIsUsable(spec);
    case "distribute":
      return distributeGoalIsUsable(spec);
    case "rekenrek":
      return rekenrekGoalIsUsable(spec);
    case "distributor":
      return distributorGoalIsUsable(spec);
    case "riemann":
      return riemannGoalIsUsable(spec);
    case "functionMachine":
      // No `goal` field exists on this kind (see types.ts) — always gradable
      // via `rule` + `queryInput`, both required by the type.
      return true;
    case "placeValue":
      return placeValueGoalIsUsable(spec);
    case "dice":
      // Model C: gradable iff it carries a well-formed prediction (a sandbox
      // dice is a free explorer, never a graded practiceItem).
      return diceIsGradable(spec);
    case "protractor":
      return protractorGoalIsUsable(spec);
    case "coordinatePlane":
      return coordinatePlaneGoalIsUsable(spec);
    case "geoLocate":
      // A geoLocate is gradable off its REQUIRED `map.task` (the type demands
      // it) — always gradable, like functionMachine's rule/queryInput.
      return true;
    case "ruler":
      return rulerGoalIsUsable(spec);
    case "clock":
      return clockGoalIsUsable(spec);
    case "liquid":
      return liquidGoalIsUsable(spec);
    case "money":
      return moneyGoalIsUsable(spec);
  }
}

/**
 * Throws a clear, actionable error when a spec would be ungradable if
 * persisted — the guard rail for any authoring/seeding insert path. Never
 * silently drops or mutates the spec; the caller decides what to do next
 * (fix the author input, reject the request, …).
 */
export function assertGradableManipulative(spec: ManipulativeSpec): void {
  if (!isGradableManipulative(spec)) {
    throw new Error(
      `Ungradable manipulative: kind "${spec.kind}" (id "${spec.id}") has no usable goal — ` +
        `isSolved() would always return false for this spec. Add a goal (see the ` +
        `*Goal union for "${spec.kind}" in lib/manipulative/types.ts) before saving it ` +
        `as a practiceItem.`,
    );
  }
}

/** Kind-dispatched initial-state build — the same builders the renderers call
 *  on mount, so a spec that would crash a scholar's screen crashes HERE
 *  instead (inside assertRenderableManipulative's try). Exhaustive switch: a
 *  `default` branch assigns `spec` to a `never`-typed binding, so a new kind
 *  added to `ManipulativeSpec` fails typecheck here until it's covered —
 *  unlike a switch with no default (which silently returns `undefined` for
 *  an uncovered kind, the bug that let `rekenrek`/`distributor` regress). */
function initialStateFor(spec: ManipulativeSpec): unknown {
  switch (spec.kind) {
    case "partition":
      return initialPartition(spec);
    case "numberline":
      return initialNumberLine(spec);
    case "array":
      return initialArray(spec);
    case "balance":
      return initialBalance(spec);
    case "areaPerimeter":
      return initialAreaPerimeter(spec);
    case "distribute":
      return initialDistribute(spec);
    case "rekenrek":
      return initialRekenrek(spec);
    case "distributor":
      return initialDistributor(spec);
    case "riemann":
      return initialRiemann(spec);
    case "functionMachine":
      return initialFunctionMachine();
    case "placeValue":
      return initialPlaceValue(spec);
    case "dice":
      return initialDice();
    case "protractor":
      return initialProtractor(spec);
    case "coordinatePlane":
      return initialCoordinatePlane(spec);
    case "geoLocate":
      return initialGeoLocate();
    case "ruler":
      return initialRuler(spec);
    case "clock":
      return initialClock(spec);
    case "liquid":
      return initialLiquid(spec);
    case "money":
      return initialMoney(spec);
    default: {
      const exhaustive: never = spec;
      throw new Error(`initialStateFor: unhandled manipulative kind "${(exhaustive as ManipulativeSpec).kind}".`);
    }
  }
}

/**
 * Renderability guard — the companion to `assertGradableManipulative` for
 * paths that accept a spec as RAW JSON (teacher/bot authoring), where the
 * goal can be well-shaped while the kind's structural fields are missing
 * (`{"kind":"partition","goal":{...}}` with no `discs` passes the gradability
 * check, persists, and then throws inside the scholar renderer's
 * `initialPartition(spec).discs.map`). Smoke-tests the spec through the SAME
 * pure builders + solved-check the renderers use, and requires the non-empty
 * `prompt` every surface displays as the item stem.
 */
export function assertRenderableManipulative(spec: ManipulativeSpec): void {
  if (typeof spec.prompt !== "string" || !spec.prompt.trim()) {
    throw new Error(
      `Manipulative spec (kind "${spec.kind}") needs a non-empty "prompt" — it is the item stem the scholar reads.`,
    );
  }
  if (spec.kind === "numberline" && spec.scene) {
    if (spec.orientation !== "vertical") {
      throw new Error(
        `Number-line scene "${spec.scene.type}" requires orientation "vertical".`,
      );
    }
    if (spec.min > 0 || spec.max < 0) {
      throw new Error(
        `Number-line scene "${spec.scene.type}" requires zero inside the visible range.`,
      );
    }
    if (
      spec.scene.type === "building" &&
      (!Number.isInteger(spec.min) ||
        !Number.isInteger(spec.max) ||
        !Number.isInteger(spec.tickStep))
    ) {
      throw new Error(
        "A building number-line scene requires integer bounds and integer floor spacing.",
      );
    }
  }
  try {
    isSolved(spec, initialStateFor(spec));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Manipulative spec (kind "${spec.kind}") is missing structural fields its renderer needs — ` +
        `it would crash the scholar's practice screen. Compare against the "${spec.kind}" spec ` +
        `shape in lib/manipulative/types.ts. (${msg})`,
    );
  }
}

/**
 * The generative charm seam. A spec (from a curriculum author OR a future
 * spec-authoring model) themes its fill by setting an OPTIONAL short noun on
 * `theme.fill.label` — any noun, not a closed enum. No extra wiring is needed to
 * make it "happen on its own": the renderer's `useThemeIcon` hook resolves the
 * label to a generated, chroma-keyed, cached icon the first time the manipulative
 * is shown (`convex/manipulativeThemeIcons.ts`), so authoring a label is the
 * whole job. This helper just documents/normalizes that authoring intent — an
 * authoring model should emit a concrete, kid-friendly, wordless object noun
 * fitting the activity's subject ("rocket", "acorn", "beaker"), never a scene
 * or an image URL. Returns a ready-to-attach `theme`, or undefined for a blank
 * label so callers can spread it safely.
 *
 * WHEN TO SET A LABEL AT ALL (Andy's ruling, 2026-08-06 — the full version with
 * the worked examples lives in `.claude/rules/visual-design.md` § "The
 * exception: a DECLARED charm layer may just be fun"):
 *
 *  1. NEVER overwrite a channel that already carries data. Rekenrek beads are
 *     coloured IN FIVES and that colouring is the subitizing pedagogy;
 *     placeValue bundles encode place. Leave those unthemed.
 *  2. NEVER imply a false referent — the CICADA TEST. The icon must be a thing
 *     it is sane to have N of, where N is the quantity actually on screen. A
 *     lesson about cicadas emerging on a prime-number YEAR cadence must not
 *     theme a group of 7 cells with cicadas: primeness belongs to the years,
 *     not to a pile of insects, so the art asserts a referent that does not
 *     exist and confuses the very concept it decorates. This is exactly why the
 *     label is AUTHORED per spec and never auto-derived from an adjacent story
 *     hook — derivation cannot tell "12 cookies" from "7 years".
 *  3. Otherwise it may simply be FUN. Charm is a declared decorative layer; it
 *     owes no encoded variable ("an exercise about enclosing capybaras in a
 *     perimeter fence is more fun because there are capybaras involved").
 *
 * Only three kinds render a fill today: `array`, `balance`, `areaPerimeter`.
 */
export function themeForLabel(
  label: string | null | undefined,
): { fill: { label: string } } | undefined {
  const trimmed = label?.trim();
  return trimmed ? { fill: { label: trimmed } } : undefined;
}
