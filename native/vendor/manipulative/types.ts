/**
 * The Manipulative primitive — a single, spec-driven interactive learning object
 * in the spirit of Montessori manipulatives (concrete, hands-on, self-correcting,
 * one concept in isolation) with a Jobs-grade surface (one obvious thing to touch,
 * beautiful, uncluttered).
 *
 * ONE primitive, TWO modes, selected by whether a `goal` or typed `answer` is present:
 *   • explainer  — no goal / no answer: free exploration ("what happens if…?")
 *   • challenge  — a goal or answer: the material self-corrects on explicit Done.
 *                  With `answer`, the manipulative is a thinking tool and the
 *                  scholar commits a number separately.
 *
 * The "juice": one union of kinds spans a wide slice of the curriculum —
 * fractions/equivalence, number sense, multiplication/factors/commutativity,
 * algebraic equality, and area-vs-perimeter — all through the same frame,
 * the same self-check contract, and the same on-brand look.
 *
 * This file is the schema. It is framework-agnostic data (no React), so a tutor
 * or curriculum author could emit a `ManipulativeSpec` as JSON (the artifact /
 * practice-activity path) and the renderer instantiates it. Pure goal logic lives
 * in `logic.ts` (unit-tested); each kind's view lives in `kinds/`.
 */

import type { GeoMapSpec, GeoTask } from "../geomap/types";
import type { MoneyDenomination } from "./currency";

export type ManipulativeKind =
  | "partition"
  | "numberline"
  | "array"
  | "balance"
  | "areaPerimeter"
  | "distribute"
  | "rekenrek"
  | "distributor"
  | "riemann"
  | "functionMachine"
  | "placeValue"
  | "dice"
  | "protractor"
  | "coordinatePlane"
  | "geoLocate"
  | "ruler"
  | "clock"
  | "liquid"
  | "money";

/**
 * The closed union as a RUNTIME array — the one place a server-side reader (with
 * no React catalog to lean on) can enumerate every kind to zero-fill a tally, so
 * a mechanic with no items still appears in the count as "never used" rather than
 * silently vanishing. The `satisfies` + totality guard below make a new
 * `ManipulativeKind` that isn't listed here a COMPILE error, the same discipline
 * `native/.../nativeManipulativeKinds.ts` uses on its own copy.
 */
export const ALL_MANIPULATIVE_KINDS = [
  "partition",
  "numberline",
  "array",
  "balance",
  "areaPerimeter",
  "distribute",
  "rekenrek",
  "distributor",
  "riemann",
  "functionMachine",
  "placeValue",
  "dice",
  "protractor",
  "coordinatePlane",
  "geoLocate",
  "ruler",
  "clock",
  "liquid",
  "money",
] as const satisfies readonly ManipulativeKind[];

// Compile-time totality: a new kind added to the union but missing from the
// array above resolves this to `never` and fails to typecheck.
type _UncoveredManipulativeKind = Exclude<
  ManipulativeKind,
  (typeof ALL_MANIPULATIVE_KINDS)[number]
>;
const _assertAllKindsListed: _UncoveredManipulativeKind extends never
  ? true
  : never = true;
void _assertAllKindsListed;

const CURRENT_MANIPULATIVE_KINDS: ReadonlySet<string> = new Set(ALL_MANIPULATIVE_KINDS);

/**
 * Is this stored `kind` string a mechanic the CURRENT binary can render?
 *
 * A stored spec outlives the union: retiring a kind (the Factor Game moving to
 * the games platform, `dotBlaster` being re-authored as `rekenrek`) leaves rows
 * behind whose `kind` no renderer, and no `isSolved` branch, still handles. Such
 * a row parses fine — `parseManipulativeSpec` only requires a string `kind` —
 * so nothing downstream notices until a scholar is looking at a blank frame that
 * can never be solved. Every surface that decides whether a stored row may be
 * SERVED must gate on this, not merely on "the JSON parsed".
 */
export function isCurrentManipulativeKind(kind: string): kind is ManipulativeKind {
  return CURRENT_MANIPULATIVE_KINDS.has(kind);
}

/**
 * The charm layer — a GENERATIVE fill texture. `fill.label` is a short noun
 * phrase ("pig", "rocket ship", "acorn") that resolves to a generated,
 * chroma-keyed, cached PNG hosted in Convex storage (see
 * `convex/manipulativeThemeIcons.ts` + the `useThemeIcon` hook). We generate
 * and host every pixel, so a spec NEVER carries an author-supplied image URL —
 * the same governance property the old closed enum had, without the closed
 * list. Any noun a curriculum author (or a future authoring model) writes
 * themes the manipulative on its own.
 *
 * `ThemedIcon` is the legacy closed enum, kept as a deprecated alias: its
 * values ("pig" | "apple" | "cauldron") ARE valid labels, so `resolveThemeLabel`
 * shims an old `fillIcon` straight onto the generative path with no migration.
 */
export type ThemedIcon = "pig" | "apple" | "cauldron";

/** A generative themed fill: any short noun phrase, resolved + cached to art. */
export interface ManipulativeThemeFill {
  /** Short noun phrase to theme the fill cells with (e.g. "pig", "rocket"). */
  label: string;
}

/** Optional decorative charm layer, shared by any kind that fills unit cells. */
export interface ManipulativeTheme {
  /** Generative themed fill (any noun) — the current path. */
  fill?: ManipulativeThemeFill;
  /**
   * @deprecated Legacy closed-enum icon. Prefer `fill.label`. Still honored via
   * `resolveThemeLabel` (the enum values are themselves valid labels).
   */
  fillIcon?: ThemedIcon;
}

/**
 * The one place that reads a theme's effective label. Prefers the generative
 * `fill.label`, falls back to the deprecated `fillIcon` enum. Returns undefined
 * for an un-themed spec. Framework-free so both frontends + the Convex resolver
 * share it (Convex imports this file, like `practiceSkills.ts` already does).
 */
export function resolveThemeLabel(theme?: ManipulativeTheme): string | undefined {
  const raw = theme?.fill?.label ?? theme?.fillIcon;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Normalized cache key for a theme label (lowercase, trimmed, whitespace
 * collapsed) — so "Rocket Ship", "rocket  ship" and "rocket ship " all share
 * one generated asset. The server keys `manipulativeThemeIcons.label` on this
 * exact function, so there is one normalizer, not a drifting pair.
 */
export function normalizeThemeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Fields every manipulative shares — the Jobs-minimal chrome. */
export interface ManipulativeMeta {
  /** Stable id (for keys / analytics / authoring). */
  id: string;
  /** The concept in a few words, shown small and muted (e.g. "Unit fractions"). */
  concept: string;
  /** The single-line invitation shown prominently (e.g. "Make one half."). */
  prompt: string;
  /** A typed numeric commitment. When present, this is the verdict source. */
  answer?: { value: number; prompt: string; unit?: string };
  /** Optional harder extension: never required, visually distinct from a normal challenge. */
  extraCredit?: boolean;
  /** Inspiration / credit line for teacher-facing catalogs. */
  source?: string;
  /** Optional decorative charm layer (default off — see `ManipulativeTheme`). */
  theme?: ManipulativeTheme;
}

// ── partition — equal parts of a whole (fractions, equivalence) ──────────────
export interface PartitionDisc {
  /** How many equal wedges the whole is cut into (the denominator). */
  parts: number;
  /** How many of those wedges are shaded (the numerator). */
  shaded: number;
}
export type PartitionGoal =
  /** Make a given disc's shaded fraction equal `value` (e.g. 0.5) — any equivalent works. */
  /** `requireParts`: when set, the disc must ALSO be cut into exactly this
   *  many parts — so an operation task (e.g. 2/3 × 3/4 via re-cutting into
   *  twelfths) can't be passed by shading the answer ratio directly without
   *  ever modeling the re-partition (the ratio-only goal was review finding
   *  "typed-answer-in-manipulative-costume", wave 3). */
  | { type: "shadedFractionEquals"; disc: number; value: number; requireParts?: number }
  /** Make both discs' shaded AREA equal (equivalent fractions, unlike denominators). */
  | { type: "discsEqualShadedArea" }
  /**
   * Make EACH named disc hit its OWN target fraction, all simultaneously
   * (e.g. disc 0 = 3/8 AND disc 1 = 2/8) — the decomposition/addition model:
   * two (or more) distinct parts must each be genuinely built, not just a
   * combined total. Unlike `shadedFractionEquals` (one disc, one value),
   * this can't be satisfied by shading a single disc to the answer's total.
   */
  | { type: "partsEqual"; parts: Array<{ disc: number; value: number }> };

export interface PartitionSpec extends ManipulativeMeta {
  kind: "partition";
  discs: PartitionDisc[];
  /** Which controls the learner may touch. */
  adjustable: Array<"parts" | "shaded">;
  /** Min/max wedges per disc (default 1..12). */
  partsRange?: [number, number];
  goal?: PartitionGoal;
}

// ── numberline — place a value on a line (number sense, fractions, decimals) ─
export type NumberLineGoal =
  | { type: "placeAt"; value: number; tolerance?: number }
  | { type: "placeFraction"; num: number; den: number; tolerance?: number }
  /** First positive value shared by both tracks. The target is derived. */
  | { type: "firstCommonMultiple"; tolerance?: number };

/** A bounded contextual treatment for a vertical number line. */
export type NumberLineScene =
  | { type: "mountain" }
  | { type: "building" };

export interface NumberLineSpec extends ManipulativeMeta {
  kind: "numberline";
  min: number;
  max: number;
  /** Major tick spacing (labels). */
  tickStep: number;
  /** Optional snap increment for the handle (0/undefined = free drag). */
  snap?: number;
  /** Fixed reference marks. */
  markers?: Array<{ value: number; label?: string }>;
  /** Two positive integer cadences revealed as separate tracks up to the knob. */
  multipleTracks?: [number, number];
  /** Starting handle value. */
  start: number;
  /** Horizontal is the established number-line presentation. */
  orientation?: "horizontal" | "vertical";
  /** The thing the scholar moves, such as a hiker or elevator. */
  handleLabel?: string;
  /** Optional contextual treatment for a vertical number line. */
  scene?: NumberLineScene;
  goal?: NumberLineGoal;
}

// ── array — a rectangle of tiles (multiplication, factors, commutativity, area)
export type ArrayGoal =
  | { type: "productEquals"; value: number }
  | { type: "areaEquals"; value: number }
  | { type: "factorPairCountEquals"; product: number; count: number }
  /**
   * Prove "N is a factor of M" (or, read the other way, "M is a multiple of
   * N") honestly: SOME side of the built array must equal `side` exactly
   * (either orientation counts — the array's own commutativity feature, "3
   * rows of 4" and "4 rows of 3" are the same fact), AND the total must equal
   * `product`. Unlike bare `productEquals`, this rejects an unrelated factor
   * pair that happens to share the same product (e.g. 3×8 does NOT prove "6
   * is a factor of 24" — neither side is 6).
   */
  | { type: "sideEqualsWithProduct"; side: number; product: number }
  /**
   * Prove a SQUARE number: both sides must be equal AND their product must
   * equal `value`. Unlike bare `productEquals`, this rejects any non-square
   * factor pair (e.g. 2×8 does NOT prove "4² = 16" — the array isn't square).
   */
  | { type: "squareEquals"; value: number };

export interface ArraySpec extends ManipulativeMeta {
  kind: "array";
  rows: number;
  cols: number;
  maxRows?: number;
  maxCols?: number;
  goal?: ArrayGoal;
}

// ── balance — a pan balance (equality, solving for an unknown) ───────────────
export type BalanceGoal = { type: "balance" };

export interface BalanceSpec extends ManipulativeMeta {
  kind: "balance";
  /** Visible unit weights initially on each pan. */
  left: number;
  right: number;
  adjustable: Array<"left" | "right">;
  /** A hidden mystery block on the right pan worth this many units (solve-for-x). */
  mysteryRight?: number;
  maxUnits?: number;
  goal?: BalanceGoal;
}

// ── areaPerimeter — reshape a fixed-perimeter rectangle on a grid ────────────
export type AreaPerimeterGoal =
  | { type: "maxArea" }
  | { type: "areaEquals"; value: number };

export interface AreaPerimeterSpec extends ManipulativeMeta {
  kind: "areaPerimeter";
  /** Fixed total fence length (even integer). w + h always = perimeter / 2. */
  perimeter: number;
  /** Starting width (height derived). */
  startWidth: number;
  goal?: AreaPerimeterGoal;
}

// ── distribute — split an area model (distributive property) ──────────────────
export type DistributeGoal = { type: "splitAt"; column: number };

export interface DistributeSpec extends ManipulativeMeta {
  kind: "distribute";
  /** Rectangle width in unit columns. */
  width: number;
  /** Rectangle height in unit rows. */
  height: number;
  /** Starting vertical split column, constrained to 1..width-1. */
  startColumn: number;
  goal?: DistributeGoal;
}

// ── rekenrek — push beads across a bead rack into two groups (number bonds) ───
// A rekenrek (arithmetic rack): up to two rods of ten beads. The child puts a
// finger on a bead and pushes a TRAIN of them across the rod; beads can't pass
// through each other, so a group is felt moving as one. Isolates compose/
// decompose of a whole (number bonds, subitizing, the make-ten strategy — 15 →
// a group of 10 and 5), the additive counterpart to the multiplicative
// `distribute` split (which cuts an AREA model, a×(b+c)). Beads are colored in
// fives (position-in-fives, not group membership), so a left group of six reads
// as "five and one". The self-check is a partition target: make ONE group hold
// exactly `value` beads.
export type RekenrekGoal = { type: "groupOf"; value: number };

export interface RekenrekSpec extends ManipulativeMeta {
  kind: "rekenrek";
  /** Beads on the rack (the number being decomposed). 1..20. */
  total: number;
  /** Starting split — how many beads begin pushed to the left (0..total). */
  startLeft?: number;
  goal?: RekenrekGoal;
}

// ── distributor — deal a quantity into equal groups (division as sharing) ─────
// A "Distributor": deal `total` items one round at a time into a
// fixed number of `groups` equal plates, watching the leftover pile shrink to
// the true remainder. Isolates partitive division (a ÷ b as "how many each")
// and the meaning of a remainder — distinct from the multiplicative area-split
// `distribute` kind despite the shared lineage/name. The self-check is
// "share equally": deal out as many full rounds as possible so every plate is
// equal AND the leftover is exactly `total mod groups`.
export type DistributorGoal = { type: "shareEqually" };

export interface DistributorSpec extends ManipulativeMeta {
  kind: "distributor";
  /** Items to deal out (the dividend). */
  total: number;
  /** Number of equal groups / plates to deal into (the divisor, ≥ 1). */
  groups: number;
  /** Starting items already dealt to each plate (default 0). */
  startPerGroup?: number;
  goal?: DistributorGoal;
}

// ── riemann — speed-time area as distance (calculus foreshadow) ───────────────
export type RiemannGoal = { type: "approximateWithin"; tolerance: number };

export interface RiemannSpec extends ManipulativeMeta {
  kind: "riemann";
  /** v(t) = slope · t + intercept. */
  slope: number;
  intercept: number;
  /** Time interval [0, tMax]. */
  tMax: number;
  /** Starting number of left-sum bars. */
  startBars: number;
  minBars?: number;
  maxBars?: number;
  goal?: RiemannGoal;
}

// ── functionMachine — infer a hidden input→output rule (functions, patterns) ─
/**
 * The rule set is deliberately a small CLOSED set (not an arbitrary formula
 * string) so every rule is representable, serializable, and easy to reason
 * about. `affine` (out = m·in + b) covers the spike's needs (×k, +k, m·in+b
 * all fall out of one shape); add more variants here only when a concrete
 * curriculum need shows up.
 */
export type FunctionMachineRule = { op: "affine"; m: number; b: number };

export interface FunctionMachineExample {
  in: number;
  out: number;
}

export interface FunctionMachineSpec extends ManipulativeMeta {
  kind: "functionMachine";
  /** The hidden rule — never shown to the scholar. */
  rule: FunctionMachineRule;
  /** Shown worked examples (in → out) the scholar studies to infer the rule. */
  examples: FunctionMachineExample[];
  /** The un-worked query input the scholar must predict the output for. */
  queryInput: number;
  /** Function machines have no `goal` shape — the typed `answer` is the verdict. */
  goal?: never;
}

// ── placeValue — decompose a number into its base-ten place parts ─────────────
/**
 * ONE kind, THREE presentational MODES, TWO self-check shapes — deliberately a
 * single mode-discriminated spec, not three separate kinds. The self-check for
 * `buildNumber` and `expandedForm` is the SAME predicate (assemble base-ten
 * counts so the total equals a target, with every column a single digit — the
 * standard decomposition); the two differ only in what the renderer emphasises
 * (concrete base-ten bundles vs. the additive `400 + 30 + 7` expansion) and in
 * how the prompt is framed (a bare numeral / a number name vs. an expanded sum).
 * `placeShift` is the one genuinely different move — ×10 / ÷10 slides every digit
 * across adjacent columns — so it gets its own goal shape. Splitting these into
 * three kinds would triple the switch-case + renderer tax for what is one idea
 * (a number IS its place parts) seen from three angles, so they ride one kind.
 *
 * `places` lists each column's place value, DESCENDING (e.g. [100, 10, 1] or
 * [1000, 100, 10, 1]); the lowest place must be 1 so every whole number is
 * representable. Runtime state is a `counts` array index-aligned to `places`
 * (see PlaceValueState in logic.ts) — for buildNumber/expandedForm it is the
 * digit in each place; for placeShift it is the current number's digits, which
 * a ×10/÷10 slides left/right.
 */
export type PlaceValueGoal =
  /** buildNumber + expandedForm: assemble the base-ten parts to total `value`. */
  | { type: "buildValue"; value: number }
  /** placeShift: reach `value` by ×10 / ÷10 shifts across adjacent columns. */
  | { type: "shiftTo"; value: number };

export interface PlaceValueSpec extends ManipulativeMeta {
  kind: "placeValue";
  mode: "buildNumber" | "expandedForm" | "placeShift";
  /** Place value of each column, DESCENDING powers of ten; lowest must be 1. */
  places: number[];
  /** Starting count per column (index-aligned to `places`). Defaults to all
   *  zero for buildNumber/expandedForm; placeShift needs a non-zero start. */
  start?: number[];
  /** Max bundles per column for buildNumber/expandedForm (default 9 → the
   *  canonical single-digit standard form). Ignored by placeShift. */
  maxPerPlace?: number;
  goal?: PlaceValueGoal;
}

// ── Model B (a game) — RETIRED from this union ───────────────────────────────
// `factorGame` used to live here, and its own comment called it "Model B: a
// game (internal stages + carried state)" sitting beside Model A (one shot,
// graded on the final configuration) and Model C (`dice`, an experiment tool).
// Three incompatible grading models in one closed union was the tell.
//
// It is a GAME now — `native/src/games/factor-game/`, on the games platform in
// `lib/games/contract.ts`. The decisive reason was not the switch-case tax: its
// `isSolved` read true iff the scholar out-scored the AI, and that boolean fed
// skill mastery. Whether a child beat a greedy heuristic is not evidence that
// they understand factors. A game emits evidence and carries no skill credit;
// ordinary practice outside the game is the transfer instrument.
//
// DO NOT re-add a game kind here. `ManipulativeKind` is closed on purpose.

// ── dice — a tactile probability experiment + a graded prediction ─────────────
// Model C: an EXPERIMENT tool, not a manipulate-to-a-goal puzzle. A dice/coin
// roll is random, so "roll a 7" would reward luck and could never be
// deterministically graded (it violates control-of-error). Instead the scholar
// rolls freely to build intuition about the empirical distribution, then commits
// a REASONED prediction that is checked against theory deterministically — the
// same "commit a number the material never reveals" contract as functionMachine.
//
//   • sandbox   — no `prediction`: free exploration ("roll and notice"), never
//                 "solved" (isChallenge false). Lives in galleries/curriculum,
//                 not as a graded practiceItem.
//   • challenge — a `prediction`: the tray is a scaffold and the committed
//                 answer (an integer, or a fraction for a probability) is the
//                 verdict, graded by VALUE so any equivalent fraction passes
//                 (3/6 ≡ 1/2 — the bridge to the fraction curriculum).
export type DiceType = "d6" | "d20" | "coin";

/**
 * A deterministic event over a SINGLE die's face (or a coin side). A coin's
 * faces are 1 = heads, 0 = tails (matching the native SceneDice results), so a
 * coin event is `{ type: "face", value: 1 }` for heads. Closed set — every
 * event is representable, serializable, and exactly countable.
 */
export type DiceEvent =
  | { type: "face"; value: number }
  | { type: "even" }
  | { type: "odd" }
  | { type: "atLeast"; value: number }
  | { type: "greaterThan"; value: number };

/**
 * What the scholar must predict. All three are graded exactly (no tolerance):
 *   • favorableCount   — how many of the die's faces satisfy the event (integer)
 *   • probability      — P(event) for one die, committed as a fraction (value-graded)
 *   • mostLikelyTotal  — the mode of the sum of `count` dice (integer)
 */
export type DicePrediction =
  | { type: "favorableCount"; event: DiceEvent }
  | { type: "probability"; event: DiceEvent }
  | { type: "mostLikelyTotal" };

export interface DiceSpec extends ManipulativeMeta {
  kind: "dice";
  /** Which polyhedron to roll — or "coin" for a heads/tails flip. */
  diceType: DiceType;
  /** How many dice/coins in the tray (1–10). Single-die events use 1; a
   *  mostLikelyTotal question needs ≥2. Defaults per prediction in logic.ts. */
  count?: number;
  /** Optional hex body color, forwarded to the native SceneDice view. */
  themeColor?: string;
  /** The graded prediction. Absent ⇒ a free-exploration sandbox. */
  prediction?: DicePrediction;
  /** Dice have no `goal` shape — the committed prediction is the verdict. */
  goal?: never;
}

// ── protractor — angle construction (geometry, iPad-first) ───────────────────
// ONE interaction, ONE goal mode — rotate a handle along a 0..180° arc scale,
// like an analog protractor laid over a page:
//   • constructAngle  — the PROMPT states a target measure in words (e.g.
//                       "Construct a 65° angle."), and the scholar drags the
//                       FREE RAY itself (hinged at the vertex, alongside the
//                       fixed base ray) until it reads the target on the
//                       scale — the ray IS the construction, not a separate
//                       pointer.
// A `measureAngle` mode (a pre-drawn angle the scholar reads with a separate
// marker) existed briefly and was REMOVED (2026-07) — it was gameable: the
// answer was literally on screen as a drawn ray, so a scholar could slide the
// marker onto it by visual matching without ever reading the scale. The
// honest way to test reading a protractor is the typed `angle_measure_protractor`
// template (`convex/lib/practice/templates.ts`, an `angleFigure` visual + a
// typed numeric answer — no draggable marker to eyeball against a drawn ray).
// A stale `measureAngle`-shaped spec must be REJECTED loudly by the authoring
// guard (`protractorGoalIsUsable` in authoring.ts), never silently rendered.
//
// Runtime shape: `ProtractorState` — a single live angle in degrees, always
// measured relative to the base ray — and one tolerance-banded self-check
// (`protractorSolved` in logic.ts, default ±2°).
export type ProtractorGoal = { type: "constructAngle"; targetDeg: number; tolerance?: number };

export interface ProtractorSpec extends ManipulativeMeta {
  kind: "protractor";
  /**
   * Orientation of the FIXED base ray, in degrees from due east (0°),
   * counterclockwise positive — a standard protractor's "0° line". Default 0.
   * Every other angle on the spec (`targetDeg`, `startDeg`, and the runtime
   * `angleDeg`) is measured RELATIVE to this base ray, in 0..180 — the same
   * convention a physical protractor uses regardless of how the page is
   * rotated. This field only rotates the whole rendered diagram; it never
   * changes what counts as solved.
   */
  baseRayDeg?: number;
  /**
   * Starting angle (degrees, 0..180, relative to the base ray) of the free
   * ray. Authoring must keep this outside the goal's tolerance band — a
   * manipulative must never start already solved (enforced by
   * `protractorGoalIsUsable` in authoring.ts).
   */
  startDeg: number;
  goal?: ProtractorGoal;
}

// ── coordinatePlane — plot/drag points on a 2D grid (geometry, coordinates) ───
// The 2D sibling of `numberline`: 1-3 draggable points snap to a grid on a
// real x/y coordinate plane (first-quadrant OR four-quadrant), with optional
// fixed decoration (labeled reference points, segments/polygon outlines).
export interface CoordinatePlanePoint {
  x: number;
  y: number;
  /** Optional short label shown next to a FIXED point (e.g. "A"). */
  label?: string;
}

export type CoordinatePlaneGoal =
  /** Drag the (single) draggable point onto {x,y}. */
  | { type: "placePoint"; x: number; y: number }
  /**
   * Drag every draggable point onto the target set, ORDER-INSENSITIVE — any
   * assignment of draggables to targets counts, so long as every target is
   * covered by exactly one draggable (a multiset match).
   */
  | { type: "placePoints"; points: Array<{ x: number; y: number }> }
  /**
   * Exactly one draggable point; the target is DERIVED from the first three
   * `fixedPoints` on the spec (the "given" corners of an axis-aligned
   * rectangle) — see `rectangleMissingCorner` in `logic.ts`. No extra goal
   * fields: the three given corners are shown as ordinary fixed decoration.
   */
  | { type: "completeRectangle" }
  /** Drag the (single) draggable point onto the reflection of `point` across
   *  the given axis (`x`: flip the y-sign; `y`: flip the x-sign). */
  | { type: "reflectPoint"; point: { x: number; y: number }; across: "x" | "y" };

export interface CoordinatePlaneSpec extends ManipulativeMeta {
  kind: "coordinatePlane";
  /** Horizontal axis range. `xMin: 0` for first-quadrant only; `xMin < 0` for
   *  a four-quadrant plane. */
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  /** Grid line / snap increment, shared by both axes. */
  gridStep: number;
  /** Fixed, non-draggable labeled points (decoration; also doubles as the
   *  three given corners for `completeRectangle`, in order). */
  fixedPoints?: CoordinatePlanePoint[];
  /** Fixed decorative line segments (e.g. a polygon outline), each a pair of
   *  math-space endpoints. Purely visual — never read by `isSolved`. */
  segments?: Array<[{ x: number; y: number }, { x: number; y: number }]>;
  /** 1-3 draggable points. Each `start` MUST NOT already sit on its goal
   *  target once snapped (see `assertGradableManipulative`/authoring.ts). */
  draggable: Array<{ start: { x: number; y: number } }>;
  goal?: CoordinatePlaneGoal;
}

// ── geoLocate — find a place on a real map (geography) ───────────────────────
// A graded geography item: a real GeoMap whose `task` is REQUIRED (the answer-
// bearing field). The scholar drops pins; grading delegates to the geomap
// contract's own `isSolved` (lib/geomap/grade.ts), re-run authoritatively
// server-side. Because the target lives in the spec, the serving path strips it
// via `redactTaskForClient` before an open attempt reaches the client (the same
// no-answer-string discipline every manipulative keeps). The map itself is
// rendered by the shared GeoMap renderer (web components/geomap; native webview
// fallback) — there is no bespoke geometry here, only the framework-free spec.
export interface GeoLocateSpec extends ManipulativeMeta {
  kind: "geoLocate";
  /** The map to render. Its `task` is REQUIRED here (unlike a free explore map),
   *  since a geoLocate item is always graded. */
  map: GeoMapSpec & { task: GeoTask };
}

// ── ruler — build a length against a printed scale (linear measurement) ──────
/**
 * ONE interaction, ONE goal mode — drag the free end of a bar along a printed
 * ruler until the BAR is the stated length. The same "construct it, don't read
 * it" contract the protractor settled on (see `ProtractorGoal`): a "measure the
 * pencil that's already drawn" mode is gameable, because the answer is on
 * screen as an object edge and a scholar can eyeball a marker onto it without
 * ever reading the scale. Here nothing on screen has the target length until
 * the scholar makes it.
 *
 * The load-bearing field is `startAt` — the BROKEN-RULER case. With the default
 * `startAt: 0` the bar's end position and its length are the same number, and
 * the task is barely more than a number line. Set `startAt` to a non-zero
 * gradation and the two come apart: the bar begins at (say) 3 cm, so making it
 * 5 cm long means dragging the end to 8. That difference — length is
 * `end − start`, not "the number the object stops on" — is the single most
 * common measurement misconception in 2.MD.A.1 / 3.MD.B.4, and it is the whole
 * reason this kind is not a `numberline` with a ruler skin.
 *
 * Runtime shape: `RulerState` — the free end's position on the scale.
 */
export type RulerUnit = "cm" | "in";
export type RulerGoal = { type: "lengthEquals"; value: number };

export interface RulerSpec extends ManipulativeMeta {
  kind: "ruler";
  /** Unit the scale is printed in, and the unit named in prose. */
  unit: RulerUnit;
  /** Whole-unit length of the printed scale (it runs 0..length). */
  length: number;
  /**
   * The smallest gradation the scale draws AND the free end snaps to. `1`
   * (whole units), `0.5` (halves), `0.25` (quarter-inch, the 3.MD.B.4 case).
   * Default 1. `length` must be a whole multiple of it.
   */
  precision?: number;
  /**
   * Where the bar's LEFT edge is pinned on the scale. Default 0. A non-zero
   * value is the broken-ruler case described above — the point of the kind.
   */
  startAt?: number;
  /**
   * The bar's starting right edge, on the scale. Authoring must keep the
   * resulting length off the target — a manipulative never starts solved
   * (enforced by `rulerGoalIsUsable` in authoring.ts).
   */
  startEnd: number;
  goal?: RulerGoal;
}

// ── clock — set the hands on an analog dial (time, elapsed time) ─────────────
/**
 * A geared 12-hour dial. The scholar drags the MINUTE hand and the hour hand
 * creeps with it, exactly as on a real clock — at 3:45 the hour hand sits
 * nearly on the 4, not on the 3. That gearing is why the runtime state is a
 * SINGLE number (`minutes` past 12 on the dial) rather than an `{hour, minute}`
 * pair: with two independent fields an impossible face (hour hand square on the
 * 3 while the minute hand reads 45) is representable, and "the hour hand moved
 * because time passed" — the thing 2.MD.C.7 and 3.MD.A.1 are actually about —
 * becomes a rendering trick instead of the model.
 *
 * Two goal shapes, and the second is the genuinely different move:
 *   • showTime  — read the stated time onto the face. The target IS the task
 *                 (safe to name in prose).
 *   • advanceBy — start from the spec's time and move the hands forward by a
 *                 stated number of minutes. COMPUTE-STYLE: the resulting time
 *                 is what the scholar works out, so it is never named.
 */
export type ClockGoal =
  | { type: "showTime"; hour: number; minute: number }
  | { type: "advanceBy"; minutes: number };

export interface ClockSpec extends ManipulativeMeta {
  kind: "clock";
  /** Hour the face starts on, 1..12 (a 12-hour dial has no 0). */
  startHour: number;
  /** Minute the face starts on, 0..59. */
  startMinute: number;
  /**
   * Minute gradation the hands snap to — `1` (to the minute, grade 3), `5`
   * (five minutes, grade 2), `15` / `30` (quarter / half hour, grade 1).
   * Default 1. Must divide 60.
   */
  snapMinutes?: number;
  /**
   * Print the minute numerals (5, 10, … 55) outside the hour numerals — the
   * scaffold an early dial needs, and the thing a scholar must eventually work
   * without. Default false.
   */
  showMinuteNumerals?: boolean;
  goal?: ClockGoal;
}

// ── liquid — pour into graduated vessels (capacity, liquid volume) ───────────
/**
 * One to three graduated jars the scholar pours into by dragging the liquid
 * level, which snaps to the marks printed on the jar. Isolates liquid volume as
 * a MEASURE you read off a scale (3.MD.A.2), the capacity sibling of the
 * ruler's length.
 *
 * Two goal shapes:
 *   • fillTo       — bring ONE named jar to a stated level. The target is the
 *                    task (safe to name).
 *   • totalEquals  — make the jars hold a stated TOTAL between them. Authoring
 *                    requires the total to exceed every single jar's capacity
 *                    (`liquidGoalIsUsable`), so it cannot be satisfied by
 *                    pouring one jar — otherwise it is `fillTo` in a costume,
 *                    and the composition-of-measures idea never happens.
 */
export type LiquidUnit = "cup" | "L" | "mL";
export type LiquidGoal =
  | { type: "fillTo"; vessel: number; value: number }
  | { type: "totalEquals"; value: number };

export interface LiquidVessel {
  /** Total capacity, in the spec's `unit`. */
  capacity: number;
  /** Starting level (default 0). */
  start?: number;
  /** Short kid-facing name shown under the jar (e.g. "Tall jar"). */
  label?: string;
}

export interface LiquidSpec extends ManipulativeMeta {
  kind: "liquid";
  unit: LiquidUnit;
  /** 1-3 jars, drawn left to right at a shared scale so capacities compare. */
  vessels: LiquidVessel[];
  /**
   * The gradation printed on every jar AND the pour snap step. Default 1; use
   * 0.5 / 0.25 for half- and quarter-cup work, 100 for a millilitre beaker.
   */
  step?: number;
  goal?: LiquidGoal;
}

// ── money — build an amount out of US coins and bills (2.MD.C.8) ─────────────
/**
 * Tap a denomination in the bank to add a piece to the tray, tap a piece in the
 * tray to take it back; the running total updates as you go. The pieces are
 * drawn from the shared `./currency` table, so a dime really is smaller than a
 * nickel on screen — the size-versus-value clash that makes coin counting hard
 * is preserved rather than flattened into equal-sized tokens.
 *
 * Three goal shapes, in ascending difficulty:
 *   • amountEquals           — make the stated amount, any way. The target IS
 *                              the task (safe to name).
 *   • amountEqualsWithCount  — make it with EXACTLY that many pieces, which
 *                              forces a specific decomposition (30¢ in 4 coins
 *                              is quarter+nickel+…, not 3 dimes). The count is
 *                              given; the combination is the work.
 *   • fewestPieces           — make it with as few pieces as possible.
 *                              COMPUTE-STYLE: the minimum is exactly what the
 *                              scholar must discover, so it is never named.
 */
export type MoneyGoal =
  | { type: "amountEquals"; cents: number }
  | { type: "amountEqualsWithCount"; cents: number; count: number }
  | { type: "fewestPieces"; cents: number };

export interface MoneySpec extends ManipulativeMeta {
  kind: "money";
  /**
   * The bank on offer, in display order. Restricting it is a real authoring
   * lever: a pennies-and-nickels bank is a different (easier) task from the
   * full set, and `fewestPieces` over an odd subset is a genuinely different
   * puzzle from the greedy-friendly full set.
   */
  available: MoneyDenomination[];
  /** Pieces already in the tray, index-aligned to `available` (default zeros). */
  start?: number[];
  /** Cap per denomination, so the tray stays countable. Default 20. */
  maxPerDenomination?: number;
  goal?: MoneyGoal;
}

export type ManipulativeSpec =
  | PartitionSpec
  | NumberLineSpec
  | ArraySpec
  | BalanceSpec
  | AreaPerimeterSpec
  | DistributeSpec
  | RekenrekSpec
  | DistributorSpec
  | RiemannSpec
  | FunctionMachineSpec
  | PlaceValueSpec
  | DiceSpec
  | ProtractorSpec
  | CoordinatePlaneSpec
  | GeoLocateSpec
  | RulerSpec
  | ClockSpec
  | LiquidSpec
  | MoneySpec;

/** True when this spec is a self-correcting challenge (vs a free explainer). */
export function isChallenge(spec: ManipulativeSpec): boolean {
  // Dice (Model C) is a challenge only when it carries a graded prediction;
  // otherwise it's a free-exploration sandbox.
  if (spec.kind === "dice") return spec.prediction != null;
  // geoLocate is always graded — its `map.task` IS the challenge.
  if (spec.kind === "geoLocate") return true;
  return spec.goal != null || spec.answer != null;
}

/**
 * Parse a stored spec JSON to a `ManipulativeSpec`, or null if unusable. Lives
 * here (framework-free, already vendored to native) so EVERY surface — the web
 * grader (`grade.ts` re-exports it), the web + native manipulative renderers, and
 * the instructional `manipulative` atom on both frontends — shares ONE parser
 * instead of forking a private JSON cast. Total: malformed / kind-less JSON is
 * `null`, never a throw.
 */
export function parseManipulativeSpec(json: string | undefined | null): ManipulativeSpec | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { kind?: unknown }).kind === "string"
    ) {
      return parsed as ManipulativeSpec;
    }
  } catch {
    /* fall through to null */
  }
  return null;
}

// ── MultiStepSequenceSpec — Model A: a linked, data-authored playlist ────────
/**
 * Model A for the standard `MultiStepChallenge` frame (see
 * `components/manipulative/MultiStepChallenge.tsx`): an ORDERED sequence of
 * ordinary, independently-graded `ManipulativeSpec` steps. Unlike Model B (one
 * manipulative whose spec carries its own internal stages/moves and CARRIED
 * state, graded only at a terminal condition — a shape no manipulative kind
 * has any more, now that the Factor Game is a game module), a sequence's state
 * does NOT carry across steps: each step is a
 * fresh manipulative, checked in isolation against its own `goal`/`answer`,
 * and advancing just moves to the next spec in `steps`.
 *
 * Authored as plain data — the same "a tutor/curriculum author could emit
 * this as JSON" property `ManipulativeSpec` itself has (see `steps`, an
 * ordinary array of specs; no bespoke per-sequence component is needed, the
 * generic `MultiStepSequenceChallenge` renders any spec that fits this shape).
 */
export interface MultiStepSequenceSpec {
  id: string;
  /** The eyebrow shown throughout — e.g. "A linked sequence (Model A)". */
  concept: string;
  /** Shown as the challenge's title once every step is complete. */
  title: string;
  /** Shown inside the "Challenge complete" banner. */
  completeSummary?: string;
  /** The linked steps, in order. Each carries its own `concept`/`prompt`,
   *  shown while it's the active step. */
  steps: ManipulativeSpec[];
  extraCredit?: boolean;
  source?: string;
}

/**
 * Parse an instructional manipulative atom's stored JSON and discriminate its
 * two accepted payloads. Total: malformed JSON or either unusable shape returns
 * null, never throws. Per-step structural/goal verification stays with the
 * canonical single-spec parser and authoring gates.
 */
export function parseInstructionManipulative(
  json: string | undefined | null,
):
  | { mode: "single"; spec: ManipulativeSpec }
  | { mode: "sequence"; spec: MultiStepSequenceSpec }
  | null {
  const single = parseManipulativeSpec(json);
  if (single) return { mode: "single", spec: single };
  if (!json) return null;

  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object") return null;

    const sequence = parsed as Partial<MultiStepSequenceSpec>;
    if (
      typeof sequence.id !== "string" ||
      typeof sequence.concept !== "string" ||
      typeof sequence.title !== "string" ||
      !Array.isArray(sequence.steps)
    ) {
      return null;
    }

    return { mode: "sequence", spec: parsed as MultiStepSequenceSpec };
  } catch {
    return null;
  }
}
