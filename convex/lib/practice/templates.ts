/**
 * Parameterized problem templates for whole-number arithmetic — the homegrown
 * practice engine's drill core.
 *
 * Why templates (vs. LLM generation) for arithmetic: these skills are
 * MECHANICAL, so a template produces infinite variants with answers that are
 * correct BY CONSTRUCTION (the code computes them), at zero model cost and with
 * zero generation-error risk. The plan reserves LLM generation (behind the
 * Spike-A verification gate) for the contextual/word-problem layer; the
 * fluency drill is templates. See review/practice/index.html §5.
 *
 * `skillKey`s match the knowledge-graph node ids. Not every node has a template:
 * most fluency nodes are direct symbolic drills, while a growing set of concept
 * nodes use deterministic prompt visuals instead of model-generated context.
 *
 * Pure + deterministic given a seed (a mulberry32 PRNG), so a set is
 * reproducible and unit-testable.
 *
 * ── Stem style (mathematical precision + concision) ──────────────────────
 * These are for gifted learners; the wording has to be exactly right and
 * never padded. When you author or edit a stem:
 *   1. NO COLLOQUIAL SHORTCUTS. Never apply an integer concept to a fraction
 *      object. Multiples/factors — and therefore LCM/GCF/LCD — are properties
 *      of INTEGERS, not fractions. So never "the LCD of 1/11 and 1/5", "a
 *      multiple of 2/3", "the GCF of 3/4 and 1/2", etc.
 *   2. BE EXPLICIT. Say the LCD is the LCM of the *denominators* (the integers
 *      themselves) — e.g. "the LCM of the denominators 11 and 5" — OR frame it
 *      contextually around the operation, e.g. "To add 1/11 + 1/5, what's the
 *      least common denominator you could use?" (an LCD earns its name only in
 *      the context of adding/subtracting/comparing the fractions).
 *   3. BE CONCISE. Minimal, punchy, scannable. A step-by-step or a single tight
 *      line beats a paragraph of explanation. No fluff.
 * (Same rules govern the LLM word-problem generator — see convex/practiceGen.ts.)
 */

import {
  type AnswerType,
  type TypedAnswer,
  type UnitKey,
  choiceAns,
  decAns,
  formatAnswer,
  fracAns,
  intAns,
} from "./answers";
import type { WorkedStep } from "./fadedSteps";
import {
  columnAddSteps,
  columnSubtractSteps,
  complementProbabilitySteps,
  decimalAddSubtractSteps,
  decimalDivideSteps,
  decimalMultiplySteps,
  decimalNotationSteps,
  expectedFrequencySteps,
  fractionAddSubtractLikeSteps,
  fractionAddSubtractUnlikeSteps,
  fractionDivideSteps,
  fractionMultiplySteps,
  fractionTimesWholeSteps,
  longDivisionSteps,
  meanSteps,
  medianSteps,
  orderOfOperationsSteps,
  partialProductsSteps,
  probabilityFractionSteps,
  rangeSteps,
  sampleSpaceSteps,
  unitFractionDividedByWholeSteps,
  wholeDividedByUnitFractionSteps,
} from "./workedStepGen";
import {
  makeAngleFigurePromptVisual,
  makeAreaModelPromptVisual,
  makeArrayPromptVisual,
  makeBarGraphPromptVisual,
  makeClockfacePromptVisual,
  makeCompositeRectilinearPromptVisual,
  makeCountablesPromptVisual,
  makeCoordinatePlanePromptVisual,
  makeFractionPartPromptVisual,
  makeGroupsPromptVisual,
  makeLabeledRectanglePromptVisual,
  makeLinePlotPromptVisual,
  makeNumberLinePromptVisual,
  makePictographPromptVisual,
  makeRectangularPrismPromptVisual,
  type CountablesLayout,
  type NumberLineInterval,
  type NumberLinePoint,
  type PracticePromptVisual,
} from "../../../shared/practicePromptVisual";

export type PracticeItem = {
  skillKey: string;
  stem: string;
  answer: TypedAnswer;
  answerType: AnswerType;
  /** For a `multipleChoice` item: the option labels, in the order the answer's
   *  `choiceIndex` refers to. The surface renders these as tappable buttons (a
   *  scholar has no way to type `<`/`=`/`>` on the number pad), and the grader
   *  is unchanged — it still compares the submitted index. Absent for every
   *  other answerType. */
  choices?: string[];
  /** Display-only structured prompt visual. The answer/grading path is unchanged. */
  promptVisual?: PracticePromptVisual;
  /** Deterministic worked steps (text + blankText per step) for the
   *  teach-as-action moment — see workedStepGen.ts. Present only for families
   *  whose solution procedure is mechanical/canonical; absent otherwise (the
   *  teaching moment degrades to reveal-only). Never sent raw to the client on
   *  the serving path — only `teachingStep` reads it, forcing a single-blank fade. */
  workedSteps?: WorkedStep[];
  /** The binary operand structure of a DIRECT arithmetic item (a op b), when the
   *  template exposes one. Consumed by the placement warmth floor
   *  (lib/practice/revealLine.ts) to build a correct-by-construction strategy
   *  line from the item's own operands — never sent to the client on the
   *  answering path. Absent for the missing-operand form + non-arithmetic items. */
  variant?: ItemVariant;
  /** The measurement unit this item's answer MUST carry ("112 cm³", not "112").
   *  Set only on templates whose stem names a concrete unit; the answer is then
   *  incomplete without it, so the grader requires it and the reveal shows it.
   *  Absent on abstract "units"/"square units" stems, on multiple-choice items,
   *  and on any stem that explicitly asks for the number alone.
   *
   *  NOT carried onto a FORM variant: the missing-operand form's answer is a
   *  hidden operand of an arithmetic fact ("? × 13 = 26"), which is a bare
   *  number no matter what the direct item measured. */
  answerUnit?: UnitKey;
  source: "template";
  /** The FORM actually applied (C1, §6). Absent = the direct item. Encoded into
   *  the itemId so grading re-derives the same variant. */
  form?: ItemForm;
};

/**
 * The fixed option set for every fraction-comparison template, in `choiceIndex`
 * order: 0 = less than, 1 = equal, 2 = greater than (matching each template's
 * `choiceAns(a<b?0 : a===b?1 : 2)`). Shared so the labels can't drift out of
 * sync with the index the grader compares.
 */
export const COMPARE_CHOICES = ["less than (<)", "equal (=)", "greater than (>)"];

/** Yes/No option set for the number-theory decision templates (is_factor /
 *  is_multiple / common_multiples), in `choiceIndex` order: 0 = No, 1 = Yes. */
export const YES_NO_CHOICES = ["No", "Yes"];

/** Prime-vs-composite option set (prime_or_composite), in `choiceIndex` order:
 *  0 = Prime, 1 = Composite. Items never use n = 1 (which is neither). */
export const PRIME_COMPOSITE_CHOICES = ["Prime", "Composite"];

/** Relational FORM variants a template can be served in (C1, §6). v1: the
 *  missing-operand form ("? × 8 = 56") — inverse thinking on the same fact. */
export type ItemForm = "missing";

/**
 * Templates that explicitly supported the missing-operand form before
 * `PracticeItem.variant` also became structured fact metadata. Operand metadata
 * must not opt a template into a new scholar-facing form.
 */
const MISSING_OPERAND_FORM_SKILLS: ReadonlySet<string> = new Set([
  "add_within_20_regroup",
  "add_integers",
  "add_integers_opposite_signs",
  "add_integers_same_sign",
  "angle_additivity",
  "area_distributive",
  "area_parallelogram",
  "area_rectangle",
  "area_rectilinear_decompose",
  "area_unit_squares",
  "area_word_problems",
  "coordinate_distance",
  "coordinate_perimeter_area",
  "eq_one_step_add_sub",
  "eq_one_step_mult_div",
  "mult_2digit_by_1digit",
  "mult_facts_3_4_6",
  "mult_facts_7_8_9",
  "multiply_integers",
  "partition_rectangles_rows_cols",
  "percent_decrease",
  "percent_find_whole",
  "percent_increase",
  "percent_of_quantity",
  "perimeter_polygons",
  "prop_missing_value",
  "prop_table_from_rule",
  "rate_constant_speed",
  "rate_measurement_conversion",
  "ratio_double_number_line",
  "ratio_equivalent_scale",
  "ratio_table_complete",
  "subtract_within_20",
  "subtract_integers_add_opposite",
  "two_step_expressions",
  "volume_by_layers",
  "volume_composite_prisms",
  "volume_rectangular_prism",
  "volume_unit_cubes",
]);

/** A template opts into form variants by returning this alongside its direct
 *  item — the binary structure (a `op` b) the form transforms reshape. */
export type ItemVariant = { a: number; op: "+" | "−" | "×"; b: number };

// ── Seedable PRNG (mulberry32) ────────────────────────────────────────────
export type Rng = { int: (min: number, max: number) => number; pick: <T>(xs: T[]) => T };

export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (xs) => xs[Math.floor(next() * xs.length)],
  };
}

type Template = {
  skillKey: string;
  answerType: AnswerType;
  /** The unit every item of this family must be answered in (see
   *  `PracticeItem.answerUnit`). A family-level constant, not a per-draw one —
   *  a template's stem names one unit for all its variants. */
  answerUnit?: UnitKey;
  gen: (rng: Rng) => {
    stem: string;
    answer: TypedAnswer;
    variant?: ItemVariant;
    /** Option labels for a `multipleChoice` item (see PracticeItem.choices). */
    choices?: string[];
    /** Optional display-only prompt visual (no grading state, no verifier). */
    promptVisual?: PracticePromptVisual;
    /** Optional deterministic worked steps for the teach-as-action moment
     *  (see PracticeItem.workedSteps / workedStepGen.ts). */
    workedSteps?: WorkedStep[];
  };
};

// ── Helpers that guarantee the named property (no-regroup, etc.) ──────────

/** Attach worked steps only when the generator produced some. An empty array is
 *  the generators' "no honest scaffold — reveal-only" signal (workedStepGen.ts);
 *  omitting the field entirely keeps that a first-class outcome (the teaching
 *  moment and the scaffold-progress sweep both treat "no steps" as reveal-only,
 *  whereas an empty `workedSteps: []` would look like a broken zero-step scaffold). */
function withWorkedSteps(steps: WorkedStep[]): { workedSteps?: WorkedStep[] } {
  return steps.length > 0 ? { workedSteps: steps } : {};
}

/** Add two numbers whose columns never carry (digit-wise sum ≤ 9). */
function addNoRegroup(rng: Rng, digits: number): { a: number; b: number } {
  let a = 0;
  let b = 0;
  for (let i = 0; i < digits; i++) {
    const place = Math.pow(10, i);
    // leading digit ≥1; each column pair sums to ≤9
    const da = rng.int(i === digits - 1 ? 1 : 0, 9);
    const db = rng.int(0, 9 - da);
    a += da * place;
    b += db * place;
  }
  return { a, b };
}

/** Add two d-digit numbers that force at least one carry. */
function addWithRegroup(rng: Rng, digits: number): { a: number; b: number } {
  const lo = Math.pow(10, digits - 1);
  const hi = Math.pow(10, digits) - 1;
  for (let tries = 0; tries < 50; tries++) {
    const a = rng.int(lo, hi);
    const b = rng.int(lo, hi);
    // detect a carry in any column
    let carry = false;
    for (let i = 0; i < digits; i++) {
      const p = Math.pow(10, i);
      if ((Math.floor(a / p) % 10) + (Math.floor(b / p) % 10) > 9) carry = true;
    }
    if (carry) return { a, b };
  }
  return { a: hi, b: hi };
}

/** Subtraction with a non-negative result; `borrow` forces regrouping. */
function subtract(rng: Rng, digits: number, borrow: boolean): { a: number; b: number } {
  const lo = Math.pow(10, digits - 1);
  const hi = Math.pow(10, digits) - 1;
  for (let tries = 0; tries < 80; tries++) {
    const a = rng.int(lo, hi);
    const b = rng.int(lo, a);
    let needsBorrow = false;
    for (let i = 0; i < digits; i++) {
      const p = Math.pow(10, i);
      if ((Math.floor(a / p) % 10) < (Math.floor(b / p) % 10)) needsBorrow = true;
    }
    if (needsBorrow === borrow) return { a, b };
  }
  return { a: hi, b: lo };
}

const PLACE_NAMES = ["ones", "tens", "hundreds", "thousands", "ten-thousands"] as const;

// ── Hard-fact weighting (B4, raise-the-ceiling plan §5) ───────────────────
// Coverage honesty: a fact band spans ~33 facts, but a handful are the ones
// kids actually stall on. Rather than per-fact bitmask bookkeeping (deferred as
// FSRS-era machinery), we OVER-SAMPLE the historically hard facts in the band
// generators, so "the reps that count are the reps that matter". Commutativity-
// aware: the pair is stored unordered, so 7×8 and 8×7 both count as {7,8}.
// Source list: §5 (6×7, 7×8, 8×8, 9×6, 9×7).
const HARD_FACT_PAIRS: ReadonlySet<string> = new Set(
  [
    [6, 7],
    [7, 8],
    [8, 8],
    [9, 6],
    [9, 7],
  ].map(([x, y]) => (x <= y ? `${x}x${y}` : `${y}x${x}`)),
);

/** ~3× weight for a hard fact (§5). One extra copy per weight unit above 1. */
const HARD_FACT_WEIGHT = 3;

function isHardFact(a: number, b: number): boolean {
  return HARD_FACT_PAIRS.has(a <= b ? `${a}x${b}` : `${b}x${a}`);
}

/**
 * Deterministically pick an (f, b) product pair from a fact band — `factors` ×
 * [0..10] — with the historically hard facts weighted HARD_FACT_WEIGHT×. Builds
 * a weighted pool and draws with the seeded rng, so a set stays reproducible and
 * every pair is still a valid in-band fact (weighting only shifts the
 * distribution, never the domain). Bands with no hard facts reachable (e.g.
 * 0·1·2·5·10) degrade to a uniform draw — correct, those are the easy facts.
 */
function pickBandFact(rng: Rng, factors: number[]): { f: number; b: number } {
  const pool: Array<{ f: number; b: number }> = [];
  for (const f of factors) {
    for (let b = 0; b <= 10; b++) {
      const copies = isHardFact(f, b) ? HARD_FACT_WEIGHT : 1;
      for (let k = 0; k < copies; k++) pool.push({ f, b });
    }
  }
  return rng.pick(pool);
}

function digitAt(n: number, placeIndex: number): number {
  return Math.floor(n / Math.pow(10, placeIndex)) % 10;
}

function numberFromDigits(digits: number[]): number {
  return digits.reduce((n, d) => n * 10 + d, 0);
}

function expandedTerms(n: number, digitCount: number): number[] {
  const terms: number[] = [];
  for (let i = digitCount - 1; i >= 0; i--) {
    terms.push(digitAt(n, i) * Math.pow(10, i));
  }
  return terms;
}

function expandedStem(n: number, digitCount: number, missingTermIndex: number): { stem: string; answer: number } {
  const terms = expandedTerms(n, digitCount);
  const parts = terms.map((term, i) => (i === missingTermIndex ? "___" : String(term)));
  return { stem: `${n} = ${parts.join(" + ")}`, answer: terms[missingTermIndex] };
}

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b !== 0) {
    [a, b] = [b, a % b];
  }
  return a;
}

function lcm(a: number, b: number): number {
  return Math.abs(a * b) / gcd(a, b);
}

function factorCount(n: number): number {
  let count = 0;
  for (let d = 1; d * d <= n; d++) {
    if (n % d === 0) count += d * d === n ? 1 : 2;
  }
  return count;
}

export function formatOrdinal(n: number): string {
  const lastTwo = Math.abs(n) % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`;
  switch (Math.abs(n) % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** Count of distinct FACTOR PAIRS of n (factorCount/2, rounding up for a perfect
 *  square whose middle factor pairs with itself). e.g. 24 → 4 pairs, 36 → 5. */
function factorPairCount(n: number): number {
  let pairs = 0;
  for (let d = 1; d * d <= n; d++) if (n % d === 0) pairs++;
  return pairs;
}

/** Count of common factors shared by a and b (= number of divisors of gcd). */
function commonFactorCount(a: number, b: number): number {
  return factorCount(gcd(a, b));
}

// English number names for number_name_to_standard (whole numbers 1..9999).
const ONES_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen",
] as const;
const TENS_WORDS = [
  "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
] as const;

/** Spell a two-digit number 0..99 in words (no leading "zero"). */
function spellUnder100(n: number): string {
  if (n < 20) return ONES_WORDS[n];
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return ones === 0 ? TENS_WORDS[tens] : `${TENS_WORDS[tens]}-${ONES_WORDS[ones]}`;
}

/** Spell a whole number 1..9999 in words (e.g. 437 → "four hundred thirty-seven",
 *  2050 → "two thousand fifty"). Deterministic; used to pose number_name_to_standard.
 *  Exported so a hardcoded-table test can pin the spelling of known values — the
 *  round-trip test alone can't catch a spellNumber regression (it grades whatever
 *  the stem spells against itself, and recompute has no reverse-parse for words). */
export function spellNumber(n: number): string {
  const parts: string[] = [];
  const thousands = Math.floor(n / 1000);
  const rest = n % 1000;
  if (thousands > 0) parts.push(`${spellUnder100(thousands)} thousand`);
  const hundreds = Math.floor(rest / 100);
  const under100 = rest % 100;
  if (hundreds > 0) parts.push(`${ONES_WORDS[hundreds]} hundred`);
  if (under100 > 0) parts.push(spellUnder100(under100));
  return parts.join(" ") || "zero";
}

const NEW_COVERAGE_SKILL_KEYS = new Set([
  // measurement-data (2026-08-06) — dedicated coverage in
  // geometryMeasurementTemplates.test.ts, like the rest of this domain.
  "length_iterate_units",
  "measure_with_ruler",
  "measure_from_nonzero",
  "compare_lengths_difference",
  "measure_half_quarter_inch",
  "tell_time_hour_half_hour",
  "tell_time_five_minutes",
  "tell_time_to_minute",
  "elapsed_time_minutes",
  "coin_values",
  "count_mixed_coins",
  "make_amount_with_coins",
  "liquid_volume_measure",
  "liquid_volume_combine",
  "add_subtract_fluency_within_20",
  "add_3digit_no_regroup",
  "place_value_to_1000",
  "place_value_multidigit",
  "expanded_form_3digit",
  "expanded_form_multidigit",
  "make_ten_strategy",
  "write_numerals_to_20",
  "long_division_1digit_divisor",
  "long_division_2digit_divisor",
  "factors_and_multiples",
  "prime_composite",
  "add_subtract_properties",
  "mult_commutative_associative",
  "mult_distributive",
  "divisibility_rules_2_5_10",
  "divisibility_rules_3_9",
  "prime_factorization",
  "gcf",
  "lcm",
  "exponents_repeated_mult",
  "square_cube_numbers",
  "remainder_cycles",
  // Repo-baseline serveability holes (dedicated coverage in templatesCoverage.test.ts).
  "add_subtract_word_problems_within_10",
  "add_subtract_word_problems_multidigit",
  "add_subtract_like",
  "add_subtract_unlike",
  "add_subtract_mixed_like",
  "multiply_fraction_by_whole",
  "multiply_fractions",
  "divide_unit_fractions",
  "divide_fractions",
  "equivalent_fractions_general",
  "simplify_fractions",
  "common_denominators",
  "whole_as_fraction",
  "mixed_improper",
  "decompose_fraction",
  "fraction_scaling",
  "compare_same_denominator",
  "compare_same_numerator",
  "compare_benchmarks",
  "compare_unlike",
  "order_fractions",
  // Decimals strand (dedicated coverage — incl. an independent stem-recompute
  // sweep — in decimalTemplates.test.ts).
  "decimal_notation_fractions",
  "compare_decimals",
  "decimal_place_value_round",
  "add_subtract_decimals",
  "multiply_decimals",
  "divide_decimals",
  "theoretical_probability_simple",
  "probability_as_fraction",
  "complement_probability",
  "expected_frequency",
  "compound_two_dice",
  "sample_space",
  "likelihood_scale",
  "experimental_probability",
  "law_of_large_numbers",
  // Statistics extension (dedicated coverage in statisticsTemplates.test.ts).
  "read_picture_graph",
  "read_bar_graph",
  "read_line_plot",
  "collect_measurement_data",
  "compare_graph_categories",
  "read_scaled_picture_bar_graph",
  "read_fractional_line_plot",
  "statistical_question",
  "ordering",
  "mean",
  "mode",
  "median",
  "range",
  "mean_balance_point",
  "compare_same_center_different_spread",
  "typical_distance_from_fair_share",
  "outlier_effect_on_mean_median",
  // PR4 — 4th-grade-edge densification (dedicated coverage in placementV2Templates.test.ts)
  "place_value_relationships",
  "compare_multidigit",
  "expanded_to_standard_form",
  "number_name_to_standard",
  "powers_of_ten",
  "factor_pairs",
  "is_factor",
  "is_multiple",
  "prime_or_composite",
  "common_factors",
  "common_multiples",
  "two_step_expressions",
  // Prompt-visual concept templates.
  "equal_groups_concept",
  "arrays_concept",
  "division_as_sharing",
  "division_as_grouping",
  "area_model_multiplication",
  "unit_fraction",
  // Geometry & measurement (dedicated coverage in geometryMeasurementTemplates.test.ts).
  "partition_rectangles_rows_cols",
  "area_unit_squares",
  "perimeter_polygons",
  "area_rectangle",
  "area_distributive",
  "area_rectilinear_decompose",
  "area_perimeter_relationship",
  "perimeter_composite",
  "area_perimeter_unknown_side",
  "area_word_problems",
  "same_perimeter_optimize",
  "area_fraction_side",
  "area_parallelogram",
  "area_triangle",
  "area_trapezoid",
  "area_composite_polygons",
  "volume_unit_cubes",
  "volume_by_layers",
  "volume_conservation",
  "volume_rectangular_prism",
  "volume_composite_prisms",
  "volume_unknown_dimension",
  "volume_fractional_edges",
  "nets_of_solids",
  "surface_area_nets",
  "angle_concept",
  "angle_turns_circle",
  "angle_measure_protractor",
  "benchmark_angles",
  "angle_classification",
  "parallel_perpendicular_lines",
  "angle_additivity",
  "classify_triangles_sides",
  "classify_triangles_angles",
  "classify_quadrilaterals",
  "quadrilateral_hierarchy",
  "angle_sum_triangle",
  "ordered_pair_meaning",
  "coordinate_plane_first_quadrant",
  "line_symmetry",
  "four_quadrant_plane",
  "reflect_across_axis",
  "coordinate_distance",
  "coordinate_missing_vertex",
  "polygons_on_coordinate_plane",
  "coordinate_perimeter_area",
  // Ratios, rates, percent, and proportional reasoning.
  "ratio_concept_language",
  "ratio_forms",
  "ratio_order_matters",
  "ratio_part_part_to_whole",
  "ratio_equivalent_scale",
  "ratio_reduce",
  "ratio_table_complete",
  "ratio_double_number_line",
  "ratio_compare",
  "rate_unit_whole_numbers",
  "rate_unit_price",
  "rate_constant_speed",
  "rate_measurement_conversion",
  "rate_unit_fractional_quantities",
  "percent_rate_per_hundred",
  "percent_fraction_decimal",
  "percent_benchmark_reasoning",
  "percent_of_quantity",
  "percent_find_rate",
  "percent_find_whole",
  "percent_increase",
  "percent_decrease",
  "percent_change",
  "percent_error",
  "percent_sales_tax",
  "percent_discount_price",
  "percent_simple_interest",
  "prop_multiplicative_vs_additive",
  "prop_table_from_rule",
  "prop_plot_equivalent_pairs",
  "prop_decide_table",
  "prop_decide_graph",
  "prop_constant_table",
  "prop_constant_graph",
  "prop_write_equation",
  "prop_missing_value",
  "prop_interpret_point",
  "prop_interpret_unit_point",
  "prop_match_representations",
  // Integers & the coordinate plane.
  "positive_negative_contexts",
  "opposite_numbers",
  "integers_on_number_line",
  "compare_integers",
  "absolute_value_distance_zero",
  "absolute_value_contexts",
  "compare_absolute_values",
  "additive_inverses_make_zero",
  "add_integers_same_sign",
  "add_integers_opposite_signs",
  "add_integers",
  "subtract_integers_add_opposite",
  "add_subtract_integers",
  "multiply_integers",
  "divide_integers",
  "integer_sign_rules",
  "integer_expressions",
  "integer_context_problems",
  "add_subtract_signed_rationals",
  "multiply_signed_rationals",
  "divide_signed_rationals",
  "four_operations_signed_rationals",
  "signed_rational_numbers",
  "signed_rationals_on_number_line",
  "compare_signed_rationals",
  "rational_inequalities_contexts",
  "order_signed_rationals",
  "absolute_value_rationals",
  "rational_coordinate_pairs",
  "rational_between_numbers",
  "signed_fraction_decimal_equivalence",
  // Early algebra.
  "expr_grouping_symbols",
  "expr_evaluate_numerical",
  "expr_variable_meaning",
  "expr_terms_factors_coefficients",
  "expr_translate_words",
  "expr_evaluate_one_variable",
  "expr_evaluate_two_variables",
  "expr_evaluate_exponents",
  "expr_evaluate_fractions",
  "expr_distributive_numeric",
  "expr_evaluate_formulas",
  "expr_multi_step_signed",
  "eq_unknown_in_arithmetic",
  "eq_solution_meaning",
  "eq_test_solution",
  "eq_one_step_add_sub",
  "eq_one_step_mult_div",
  "eq_one_step_fraction",
  "eq_one_step_context",
  "eq_two_step_positive",
  "eq_two_step_integers",
  "eq_two_step_fraction_decimal",
  "eq_parentheses",
  "eq_context_multi_step",
  "eq_both_sides",
  "eq_identity_contradiction",
  "pattern_rule_sequence",
  "pattern_additive_next",
  "pattern_multiplicative_next",
  "pattern_corresponding_sequences",
  "pattern_function_machine_one_step",
  "pattern_function_machine_two_step",
  "pattern_table_missing_value",
  "pattern_arithmetic_sequence",
  "pattern_linear_table_rule",
  "pattern_graph_rate_change",
  "ineq_symbol_meaning",
  "ineq_test_solution",
  "ineq_one_step_add_sub",
  "ineq_one_step_mult_div_positive",
  "ineq_context_one_step",
  "ineq_boundary_direction",
  "ineq_negative_coefficient",
  "ineq_two_step",
  "ineq_context_two_step",
  // Algebra 1 (dedicated coverage in algebra1Templates.test.ts).
  // linear-equations strand.
  "lin_eq_combine_terms",
  "lin_eq_distribute",
  "lin_eq_clear_fractions",
  "lin_eq_justify_steps",
  "lin_eq_literal",
  "lin_eq_abs_value",
  "lin_ineq_multi_step",
  "lin_ineq_compound",
  "lin_eq_model_context",
  // linear-functions strand.
  "fn_identify_function",
  "fn_notation_evaluate",
  "slope_two_points",
  "slope_from_graph",
  "slope_intercept_form",
  "lin_fn_from_two_points",
  "lin_fn_point_slope",
  "lin_fn_standard_form",
  "lin_fn_interpret_context",
  "lin_fn_parallel_perpendicular",
  "fn_compare_representations",
  // systems strand.
  "sys_solution_meaning",
  "sys_solve_graphing",
  "sys_substitution",
  "sys_elimination",
  "sys_special_cases",
  "sys_model_context",
  "sys_linear_inequalities",
  // exponents-exponential strand.
  "exp_product_quotient",
  "exp_power_rule",
  "exp_zero_negative",
  "roots_square_cube",
  "roots_simplify_radicals",
  "sci_notation_convert",
  "sci_notation_operations",
  "exp_fn_evaluate",
  "exp_growth_decay",
  "lin_vs_exp",
  // polynomials-factoring strand.
  "poly_classify",
  "poly_add_subtract",
  "poly_multiply_monomial",
  "poly_multiply_binomials",
  "poly_special_products",
  "factor_gcf",
  "factor_trinomial_simple",
  "factor_trinomial_general",
  "factor_special_forms",
  // quadratics strand.
  "quad_graph_features",
  "quad_solve_sqrt",
  "quad_zero_product",
  "quad_solve_factoring",
  "quad_complete_square",
  "quad_formula",
  "quad_discriminant",
  "quad_vertex_form",
  "quad_model_context",
  // discrete-math (dedicated coverage in discreteMathTemplates.test.ts).
  // counting strand.
  "count_list_outcomes",
  "count_organized_count",
  "addition_principle",
  "multiplication_principle",
  "factorial_arrangements",
  "permutations_r_from_n",
  "combinations_r_from_n",
  "permutation_vs_combination",
  "count_with_restriction",
  "count_complementary",
  "pigeonhole_basic",
  "pigeonhole_generalized",
  // graph-theory strand.
  "gt_vertices_edges",
  "gt_vertex_degree",
  "gt_degree_sequence",
  "gt_handshake_sum",
  "gt_connected",
  "gt_path_vs_circuit",
  "gt_euler_path",
  "gt_complete_edges",
  "gt_tree_definition",
  "gt_tree_edges",
  "gt_bipartite",
  "gt_coloring",
  // number-theory strand.
  "nt_parity_classify",
  "nt_parity_argument",
  "nt_parity_proof",
  "nt_modular_clock",
  "nt_mod_cycle",
  "nt_modular_arithmetic",
  "nt_last_digit",
  "nt_divisibility_proof",
  "nt_prime_test_deeper",
  "nt_twin_primes",
  "nt_prime_gaps",
  "nt_gcd_euclid",
  "nt_linear_congruence",
  // logic strand.
  "lg_truth_value",
  "lg_and",
  "lg_or",
  "lg_not",
  "lg_compound_truth",
  "lg_negate",
  "lg_if_then",
  "lg_converse",
  "lg_counterexample",
  "lg_knights_knaves",
  "lg_deduce_clues",
]);

const T = (
  skillKey: string,
  answerType: AnswerType,
  gen: Template["gen"],
  /** The unit this family's answers must carry — pass it whenever the stem
   *  names a concrete unit ("…in cubic centimeters", sides labeled cm). */
  answerUnit?: UnitKey,
): Template => ({ skillKey, answerType, gen, ...(answerUnit ? { answerUnit } : {}) });

function countablesItem(k: number, layout: CountablesLayout, rng: Rng) {
  return {
    stem: "How many dots?",
    answer: intAns(k),
    promptVisual: makeCountablesPromptVisual({
      n: k,
      motif: "dot",
      layout,
      seed: rng.int(1, 2_000_000_000),
    }),
  };
}

function decomposeTensOnes(n: number): number[] {
  const tens = Math.floor(n / 10) * 10;
  const ones = n % 10;
  return ones === 0 ? [tens] : [tens, ones];
}

function choiceItem(
  rng: Rng,
  stem: string,
  correct: string,
  distractors: string[],
  promptVisual?: PracticePromptVisual,
) {
  const options = [...new Set([correct, ...distractors])].slice(0, 4);
  if (options.length < 3) throw new Error(`Multiple-choice template needs at least 3 options: ${stem}`);
  const offset = rng.int(0, options.length - 1);
  const choices = options.map((_, index) => options[(index + offset) % options.length]);
  return {
    stem,
    answer: choiceAns(choices.indexOf(correct)),
    choices,
    promptVisual,
  };
}

function numericChoiceLabels(value: number): string[] {
  return [...new Set([-value, value - 1, value + 1, value - 2, value + 2, 0])]
    .filter((candidate) => candidate !== value)
    .slice(0, 3)
    .map(String);
}

/**
 * Build a signed-integer item. Both touch pads now expose a `±` sign-toggle
 * key (shared/practiceLoop.ts's `applyKey`), so a negative answer is typed
 * practice like any other — this always returns the typed integer item (no
 * multiple-choice fallback).
 */
function signedIntegerItem(
  rng: Rng,
  stem: string,
  value: number,
  promptVisual?: PracticePromptVisual,
  variant?: ItemVariant,
) {
  return { stem, answer: intAns(value), promptVisual, variant };
}

/**
 * Build a signed-fraction item. Both touch pads now expose a `±` sign-toggle
 * key, so a negative answer is typed practice like any other — this always
 * returns the typed fraction item (no multiple-choice fallback).
 */
function signedFractionItem(
  rng: Rng,
  stem: string,
  numerator: number,
  denominator: number,
  promptVisual?: PracticePromptVisual,
) {
  return { stem, answer: fracAns(numerator, denominator), promptVisual };
}

function signedOperand(value: number): string {
  return value < 0 ? `(${value})` : String(value);
}

function signedFractionLabel(numerator: number, denominator: number): string {
  return formatAnswer(fracAns(numerator, denominator));
}

function comparisonIndex(a: number, b: number): number {
  return a < b ? 0 : a === b ? 1 : 2;
}

function lShapePromptVisual(
  fullWidth: number,
  fullHeight: number,
  leftWidth: number,
  topHeight: number,
  unit: string,
) {
  return makeCompositeRectilinearPromptVisual({
    rects: [
      { x: 0, y: 0, width: fullWidth, height: topHeight },
      { x: 0, y: topHeight, width: leftWidth, height: fullHeight - topHeight },
    ],
    sideLabels: [
      { x1: 0, y1: 0, x2: fullWidth, y2: 0, label: `${fullWidth} ${unit}` },
      { x1: 0, y1: fullHeight, x2: 0, y2: 0, label: `${fullHeight} ${unit}` },
      { x1: fullWidth, y1: 0, x2: fullWidth, y2: topHeight, label: `${topHeight} ${unit}` },
      { x1: 0, y1: fullHeight, x2: leftWidth, y2: fullHeight, label: `${leftWidth} ${unit}` },
      { x1: fullWidth, y1: topHeight, x2: leftWidth, y2: topHeight },
      { x1: leftWidth, y1: topHeight, x2: leftWidth, y2: fullHeight },
    ],
  });
}

function coordinatePromptVisual(
  points: { x: number; y: number; label: string }[],
  connect?: "segments" | "polygon",
  firstQuadrant = false,
) {
  const values = points.flatMap((point) => [point.x, point.y, 0]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding = Math.max(1, Math.ceil((max - min) / 8));
  return makeCoordinatePlanePromptVisual({
    xMin: firstQuadrant ? 0 : Math.max(-20, Math.floor(min - padding)),
    xMax: Math.min(20, Math.ceil(max + padding)),
    yMin: firstQuadrant ? 0 : Math.max(-20, Math.floor(min - padding)),
    yMax: Math.min(20, Math.ceil(max + padding)),
    gridStep: 1,
    points,
    connect,
  });
}

function integerLinePlot(
  values: number[],
  marker?: { value: number; label: string },
  valuesB?: number[],
) {
  const observations = [...values, ...(valuesB ?? [])];
  const min = Math.min(...observations, marker?.value ?? Infinity);
  const max = Math.max(...observations, marker?.value ?? -Infinity);
  const padding = max - min >= 10 ? 0 : 1;
  return makeLinePlotPromptVisual({
    values,
    valuesB,
    axisMin: Math.max(0, min - padding),
    axisMax: max + padding,
    axisStep: 1,
    axisLabel: "Value",
    marker,
  });
}

function shuffledNumbers(values: number[], rng: Rng): number[] {
  const remaining = [...values];
  const shuffled: number[] = [];
  while (remaining.length > 0) {
    shuffled.push(remaining.splice(rng.int(0, remaining.length - 1), 1)[0]);
  }
  return shuffled;
}

function formatMeasurement(numerator: number, denominator: 2 | 4): string {
  const whole = Math.floor(numerator / denominator);
  const remainder = numerator % denominator;
  if (remainder === 0) return String(whole);
  const divisor = remainder % 2 === 0 ? 2 : 1;
  const fraction = `${remainder / divisor}/${denominator / divisor}`;
  return whole === 0 ? fraction : `${whole} ${fraction}`;
}

function numberLinePromptVisual(
  values: number[],
  {
    step = 1,
    fractionDenominator,
    points,
    interval,
    unlabeledTicks,
    axisLabel,
  }: {
    step?: number;
    fractionDenominator?: 2 | 4;
    points?: NumberLinePoint[];
    interval?: NumberLineInterval;
    unlabeledTicks?: number[];
    axisLabel?: string;
  } = {},
) {
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  return makeNumberLinePromptVisual({
    min: Math.floor(minValue) - 1,
    max: Math.ceil(maxValue) + 1,
    step,
    fractionDenominator,
    points,
    interval,
    unlabeledTicks,
    axisLabel,
  });
}

function inequalityPromptVisual(
  boundary: number,
  direction: "less" | "greater",
  inclusive: boolean,
) {
  const min = boundary - 5;
  const max = boundary + 5;
  return makeNumberLinePromptVisual({
    min,
    max,
    step: 1,
    interval: direction === "less"
      ? {
          from: min,
          to: boundary,
          includeFrom: false,
          includeTo: inclusive,
          label: "solutions",
        }
      : {
          from: boundary,
          to: max,
          includeFrom: inclusive,
          includeTo: false,
          label: "solutions",
        },
    axisLabel: direction === "less" ? "Solutions continue left" : "Solutions continue right",
  });
}

function linearExpression(coefficient: number, constant: number): string {
  if (constant === 0) return `${coefficient}x`;
  return `${coefficient}x ${constant < 0 ? "-" : "+"} ${Math.abs(constant)}`;
}

/** The `mx` term of a line, dropping the redundant unit coefficient (x, -x). */
function slopeTerm(slope: number): string {
  if (slope === 1) return "x";
  if (slope === -1) return "-x";
  return `${slope}x`;
}

/** Render a line `mx + b` in slope-intercept form (m ≠ 0 assumed). */
function slopeInterceptExpr(slope: number, intercept: number): string {
  const term = slopeTerm(slope);
  if (intercept === 0) return term;
  return `${term} ${intercept < 0 ? "-" : "+"} ${Math.abs(intercept)}`;
}

/** A signed trailing constant: "+ 3" or "- 3". */
function signedConstant(value: number): string {
  return `${value < 0 ? "-" : "+"} ${Math.abs(value)}`;
}

/** A linear factor `x + c` / `x - c` (bare "x" when c = 0). */
function xTerm(constant: number): string {
  if (constant === 0) return "x";
  return `x ${constant < 0 ? "-" : "+"} ${Math.abs(constant)}`;
}

/** Render a quadratic ax² + bx + c, dropping unit coefficients and zero terms. */
function quadExpr(a: number, b: number, c: number): string {
  const lead = a === 1 ? "x²" : a === -1 ? "-x²" : `${a}x²`;
  let out = lead;
  if (b !== 0) {
    const mag = Math.abs(b) === 1 ? "x" : `${Math.abs(b)}x`;
    out += ` ${b < 0 ? "-" : "+"} ${mag}`;
  }
  if (c !== 0) out += ` ${c < 0 ? "-" : "+"} ${Math.abs(c)}`;
  return out;
}

// ── discrete-math domain helpers (counting / graph-theory / number-theory /
// logic) — see scratch-critiques/discrete-math-design.md for the per-node
// spec each generator in the "discrete-math" section of TEMPLATES implements.

function factorial(n: number): number {
  let result = 1;
  for (let i = 2; i <= n; i++) result *= i;
  return result;
}

function permCount(n: number, r: number): number {
  let result = 1;
  for (let i = 0; i < r; i++) result *= n - i;
  return result;
}

function combCount(n: number, r: number): number {
  return permCount(n, r) / factorial(r);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Join phrases with a serial ("Oxford") comma before "and": ["a"] → "a";
 *  ["a","b"] → "a and b"; ["a","b","c"] → "a, b, and c". */
function joinWithAnd(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

function isPrime(n: number): boolean {
  if (n < 2) return false;
  for (let d = 2; d * d <= n; d++) {
    if (n % d === 0) return false;
  }
  return true;
}

function primesUpTo(limit: number): number[] {
  const out: number[] = [];
  for (let n = 2; n <= limit; n++) {
    if (isPrime(n)) out.push(n);
  }
  return out;
}

function countTwinPrimesBelow(u: number): number {
  let count = 0;
  for (let p = 2; p + 2 < u; p++) {
    if (isPrime(p) && isPrime(p + 2)) count++;
  }
  return count;
}

/** Digit sum of a positive integer (base 10). */
function digitSum(n: number): number {
  let sum = 0;
  let rest = Math.abs(n);
  while (rest > 0) {
    sum += rest % 10;
    rest = Math.floor(rest / 10);
  }
  return sum;
}

/** Alternating digit sum from the ones place (+ − + − …) — the digit-sum rule
 *  for divisibility by 11. */
function altDigitSum(n: number): number {
  const digits = String(Math.abs(n))
    .split("")
    .reverse()
    .map(Number);
  return digits.reduce((sum, d, i) => sum + (i % 2 === 0 ? d : -d), 0);
}

/** base^exp mod `mod`, by repeated multiplication (exponents here are always
 *  small, so no need for fast exponentiation). */
function modPow(base: number, exp: number, mod: number): number {
  let result = 1 % mod;
  const b = ((base % mod) + mod) % mod;
  for (let i = 0; i < exp; i++) result = (result * b) % mod;
  return result;
}

/** A small checkable arithmetic/comparison fact with a known truth value — the
 *  shared building block for every logic template that evaluates AND / OR /
 *  NOT / IF-THEN over concrete statements (rather than abstract True/False
 *  literals, which lg_compound_truth alone varies over). */
function randomFact(rng: Rng): { text: string; truth: boolean } {
  const kind = rng.int(0, 2);
  if (kind === 0) {
    const a = rng.int(2, 20);
    const b = rng.int(2, 20);
    const trueSum = a + b;
    const shown = rng.int(0, 1) === 0 ? trueSum : trueSum + rng.pick([-2, -1, 1, 2]);
    return { text: `${a} + ${b} = ${shown}`, truth: shown === trueSum };
  }
  if (kind === 1) {
    const n = rng.int(2, 30);
    const claimEven = rng.int(0, 1) === 0;
    return { text: `${n} is ${claimEven ? "even" : "odd"}`, truth: claimEven === (n % 2 === 0) };
  }
  const a = rng.int(1, 30);
  const b = rng.int(1, 30);
  const rel = rng.pick(["greater than", "less than"] as const);
  const actual = a > b ? "greater than" : a < b ? "less than" : "equal";
  return { text: `${a} is ${rel} ${b}`, truth: (rel as string) === actual };
}

// ── Graph-theory helpers. There is no adjacency-list/node-link `promptVisual`
// maker (see the design doc's renderability constraint), so every graph-theory
// item is rendered as a TEXT edge list — a small labeled undirected graph is
// just an index-pair edge list plus a letter per vertex.
const VERTEX_LETTERS = "ABCDEFGHIJKL";

function vertexLabel(i: number): string {
  return VERTEX_LETTERS[i];
}

function vertexListString(n: number): string {
  return Array.from({ length: n }, (_, i) => vertexLabel(i)).join(", ");
}

function edgeListString(edges: readonly (readonly [number, number])[]): string {
  return `{${edges.map(([a, b]) => `${vertexLabel(a)}–${vertexLabel(b)}`).join(", ")}}`;
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

function degreesOf(n: number, edges: readonly (readonly [number, number])[]): number[] {
  const deg = new Array(n).fill(0) as number[];
  for (const [a, b] of edges) {
    deg[a]++;
    deg[b]++;
  }
  return deg;
}

function isConnectedGraph(n: number, edges: readonly (readonly [number, number])[]): boolean {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (const [a, b] of edges) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }
  const root = find(0);
  for (let i = 1; i < n; i++) {
    if (find(i) !== root) return false;
  }
  return true;
}

/** A random labeled tree on vertices `0..n-1` (n ≥ 1): each vertex, in a
 *  random order, attaches to a random earlier vertex in that order.
 *  Connected and acyclic by construction (n - 1 edges). */
function randomTree(n: number, rng: Rng): [number, number][] {
  const order = shuffledNumbers(
    Array.from({ length: n }, (_, i) => i),
    rng,
  );
  const edges: [number, number][] = [];
  for (let i = 1; i < n; i++) {
    edges.push([order[i], order[rng.int(0, i - 1)]]);
  }
  return edges;
}

/** Add up to `extra` random NEW edges to a graph on `n` vertices (no repeats,
 *  no self-loops); returns fewer than `extra` only if the graph is already
 *  near-complete (never loops forever). */
function addExtraEdges(
  n: number,
  edges: readonly (readonly [number, number])[],
  extra: number,
  rng: Rng,
): [number, number][] {
  const seen = new Set(edges.map(([a, b]) => edgeKey(a, b)));
  const result: [number, number][] = edges.map(([a, b]) => [a, b]);
  let guard = 0;
  while (result.length < edges.length + extra && guard < 500) {
    guard++;
    const a = rng.int(0, n - 1);
    const b = rng.int(0, n - 1);
    if (a === b) continue;
    const key = edgeKey(a, b);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push([a, b]);
  }
  return result;
}

// ── discrete-math content pools (scenario/statement libraries the counting
// and logic templates draw from for stem variety). ─────────────────────────

const REPEATABLE_ACTIONS: { verb: string; label: string; n: number }[] = [
  { verb: "flip", label: "a coin (heads or tails)", n: 2 },
  { verb: "spin", label: "a 3-color spinner (red, blue, or green)", n: 3 },
  { verb: "pick", label: "a card from a 3-letter set (A, B, or C)", n: 3 },
  { verb: "flip", label: "a 2-sided token (sun or moon)", n: 2 },
];

const ATTRIBUTE_SCENARIOS: {
  object: string;
  attrPlural1: string;
  attrPlural2: string;
  attrSingular1: string;
  attrSingular2: string;
}[] = [
  { object: "shirt", attrPlural1: "colors", attrPlural2: "sizes", attrSingular1: "color", attrSingular2: "size" },
  {
    object: "ice cream cup",
    attrPlural1: "flavors",
    attrPlural2: "toppings",
    attrSingular1: "flavor",
    attrSingular2: "topping",
  },
  {
    object: "phone case",
    attrPlural1: "colors",
    attrPlural2: "patterns",
    attrSingular1: "color",
    attrSingular2: "pattern",
  },
  {
    object: "notebook",
    attrPlural1: "cover colors",
    attrPlural2: "paper types",
    attrSingular1: "cover color",
    attrSingular2: "paper type",
  },
];

const DISJOINT_CASE_SCENARIOS: { intro: string; categories: string[] }[] = [
  { intro: "A menu has", categories: ["sandwiches", "salads"] },
  { intro: "A library shelf has", categories: ["graphic novels", "picture books", "chapter books"] },
  { intro: "A streaming service offers", categories: ["action movies", "comedies"] },
  { intro: "A game closet has", categories: ["board games", "card games", "puzzles"] },
];

const STAGE_SCENARIOS: { noun: string; stages: string[] }[] = [
  { noun: "meal", stages: ["drink", "side", "main", "dessert"] },
  { noun: "outfit", stages: ["shirt", "pants", "shoe"] },
  { noun: "smoothie", stages: ["fruit", "liquid"] },
];

const ORDERING_SCENARIOS: string[] = [
  "runners finish a race (no ties)",
  "students line up for lunch",
  "books are placed on a shelf",
  "friends sit in a row",
];

const PERM_NOUN_POOL = ["books", "toys", "photos", "trophies", "stickers"];
const GROUP_NOUN_POOL = ["students", "players", "volunteers", "candidates", "friends"];

const COUNT_SCENARIOS: { template: (n: number, r: number) => string; order: boolean }[] = [
  { template: (n, r) => `You choose ${r} pizza toppings from ${n}. Does order matter?`, order: false },
  {
    template: (n, r) => `You arrange ${r} books in order on a shelf, chosen from ${n} books. Does order matter?`,
    order: true,
  },
  { template: (n, r) => `A committee of ${r} people is chosen from ${n} candidates. Does order matter?`, order: false },
  {
    template: (n, r) => `The top ${r} finishers (1st, 2nd, …) are recorded in a race with ${n} runners. Does order matter?`,
    order: true,
  },
  { template: (n, r) => `You pick ${r} lottery numbers from ${n} balls (no order recorded). Does order matter?`, order: false },
  { template: (n, r) => `A password uses ${r} of ${n} distinct symbols in sequence. Does order matter?`, order: true },
];

const PEOPLE_NAME_POOL = ["Ana", "Ben", "Cara", "Deja", "Evan"];
const PIGEONHOLE_NOUN_POOL = ["Socks", "Marbles", "Hats", "Gloves", "Buttons"];

const NEGATION_ITEMS: { statement: string; correct: string; distractors: string[] }[] = [
  {
    statement: "All cats are black",
    correct: "Some cat is not black",
    distractors: ["No cats are black", "All cats are not black", "Some cat is black"],
  },
  {
    statement: "No dogs can fly",
    correct: "Some dog can fly",
    distractors: ["All dogs can fly", "No dogs cannot fly", "Some dog cannot fly"],
  },
  {
    statement: "Some birds cannot swim",
    correct: "All birds can swim",
    distractors: ["No birds can swim", "Some birds can swim", "All birds cannot swim"],
  },
  {
    statement: "Every square is a rectangle",
    correct: "Some square is not a rectangle",
    distractors: ["No square is a rectangle", "Every rectangle is a square", "Some rectangle is not a square"],
  },
  {
    statement: "It is raining",
    correct: "It is not raining",
    distractors: ["It is sunny", "It might rain", "It was raining"],
  },
  {
    statement: "The number is even",
    correct: "The number is not even",
    distractors: ["The number is odd", "The number is prime", "The number is zero"],
  },
];

const CYCLE_PATTERNS: { noun: string; singular: string; items: string[] }[] = [
  { noun: "beads", singular: "bead", items: ["red", "blue", "green"] },
  { noun: "tiles", singular: "tile", items: ["star", "moon", "sun", "cloud"] },
  { noun: "flags", singular: "flag", items: ["A", "B", "C", "D", "E"] },
  { noun: "lights", singular: "light", items: ["on", "off", "blink"] },
];

/** 1st/2nd/3rd/nth for the cycle stems (k is always ≥ 40 here, but the rule is
 *  general: 11/12/13 take "th", otherwise by last digit). */
function ordinal(k: number): string {
  const mod100 = k % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${k}th`;
  const mod10 = k % 10;
  return `${k}${mod10 === 1 ? "st" : mod10 === 2 ? "nd" : mod10 === 3 ? "rd" : "th"}`;
}

const CONVERSE_ITEMS: { statement: string; correct: string; converseTrue: boolean; distractors: string[] }[] = [
  {
    statement: "If it is a square, then it is a rectangle",
    correct: "If it is a rectangle, then it is a square",
    converseTrue: false,
    distractors: [
      "If it is not a square, then it is not a rectangle",
      "If it is a rectangle, then it is not a square",
      "It is a square and a rectangle",
    ],
  },
  {
    statement: "If a number is divisible by 4, then it is divisible by 2",
    correct: "If a number is divisible by 2, then it is divisible by 4",
    converseTrue: false,
    distractors: [
      "If a number is not divisible by 4, then it is not divisible by 2",
      "If a number is divisible by 2, then it is not divisible by 4",
      "A number divisible by 4 is also divisible by 2",
    ],
  },
  {
    statement: "If today is Saturday, then school is closed",
    correct: "If school is closed, then today is Saturday",
    converseTrue: false,
    distractors: [
      "If today is not Saturday, then school is not closed",
      "If school is closed, then today is not Saturday",
      "Today is Saturday and school is closed",
    ],
  },
  {
    statement: "If a shape is a triangle, then it has three sides",
    correct: "If a shape has three sides, then it is a triangle",
    converseTrue: true,
    distractors: [
      "If a shape is not a triangle, then it does not have three sides",
      "If a shape has three sides, then it is not a triangle",
      "A triangle has three sides",
    ],
  },
  {
    statement: "If it rains, then the ground is wet",
    correct: "If the ground is wet, then it rains",
    converseTrue: false,
    distractors: [
      "If it does not rain, then the ground is not wet",
      "If the ground is wet, then it does not rain",
      "It rains and the ground is wet",
    ],
  },
];

const COUNTEREXAMPLE_ITEMS: { claim: string; correct: string; distractors: string[] }[] = [
  { claim: "every prime is odd", correct: "2", distractors: ["3", "5", "7"] },
  { claim: "every multiple of 4 is a multiple of 8", correct: "4", distractors: ["8", "16", "24"] },
  { claim: "every even number is a multiple of 4", correct: "2", distractors: ["4", "8", "12"] },
  { claim: "every square number is even", correct: "9", distractors: ["4", "16", "36"] },
  { claim: "every number divisible by 3 is divisible by 9", correct: "6", distractors: ["9", "18", "27"] },
  {
    claim: "every rectangle is a square",
    correct: "a 2-by-4 rectangle",
    distractors: ["a 3-by-3 square", "a 5-by-5 square", "a 1-by-1 square"],
  },
];

const KNIGHT_NAMES = ["Ann", "Ben", "Cara", "Dev", "Elle", "Finn", "Gia", "Hugo"];
const FRIEND_NAMES = ["Ana", "Ben", "Cara", "Dee", "Evan", "Fay"];
const PRIMES_TO_97 = primesUpTo(97);

// ── The registry ──────────────────────────────────────────────────────────

const TEMPLATES: Template[] = [
  // ── Counting & cardinality ──────────────────────────────────────────────
  T("count_to_10", "integer", (r) => {
    const n = r.int(0, 9);
    return { stem: `What number comes right after ${n}?`, answer: intAns(n + 1) };
  }),
  T("count_to_20", "integer", (r) => {
    const n = r.int(0, 19);
    return { stem: `What number comes right after ${n}?`, answer: intAns(n + 1) };
  }),
  T("write_numerals_to_20", "integer", (r) => {
    const words = [
      "zero",
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "eight",
      "nine",
      "ten",
      "eleven",
      "twelve",
      "thirteen",
      "fourteen",
      "fifteen",
      "sixteen",
      "seventeen",
      "eighteen",
      "nineteen",
      "twenty",
    ];
    if (r.int(0, 1) === 0) {
      const n = r.int(0, 20);
      return { stem: `Write the numeral for ${words[n]}.`, answer: intAns(n) };
    }
    const n = r.int(0, 19);
    return { stem: `Write the numeral for the number after ${words[n]}.`, answer: intAns(n + 1) };
  }),
  T("count_to_100_ones", "integer", (r) => {
    const n = r.int(0, 99);
    return { stem: `What number comes right after ${n}?`, answer: intAns(n + 1) };
  }),
  T("count_to_100_tens", "integer", (r) => {
    const n = r.int(0, 9) * 10;
    return { stem: `Count by tens: what comes after ${n}?`, answer: intAns(n + 10) };
  }),
  T("count_on", "integer", (r) => {
    const n = r.int(0, 19);
    return { stem: `What number comes after ${n}?`, answer: intAns(n + 1) };
  }),
  T("cardinality_within_10", "integer", (r) => {
    const k = r.int(1, 10);
    return countablesItem(k, "tenframe", r);
  }),
  T("count_objects_within_10", "integer", (r) => {
    const k = r.int(1, 10);
    return countablesItem(k, "scatter", r);
  }),
  T("count_objects_within_20", "integer", (r) => {
    const k = r.int(1, 20);
    return countablesItem(k, "tenframe", r);
  }),
  T("equal_groups_concept", "integer", (r) => {
    const groups = r.int(2, 5);
    const perGroup = r.int(2, 6);
    return {
      stem: `There are ${groups} equal groups with ${perGroup} in each group. How many in all?`,
      answer: intAns(groups * perGroup),
      promptVisual: makeGroupsPromptVisual({
        groups,
        perGroup,
        motif: "dot",
        seed: r.int(1, 2_000_000_000),
      }),
    };
  }),
  T("arrays_concept", "integer", (r) => {
    const rows = r.int(2, 6);
    const cols = r.int(2, 8);
    return {
      stem: `How many dots are in this ${rows} × ${cols} array?`,
      answer: intAns(rows * cols),
      promptVisual: makeArrayPromptVisual({ rows, cols, motif: "dot" }),
    };
  }),
  T("division_as_sharing", "integer", (r) => {
    const groups = r.int(2, 5);
    const perGroup = r.int(2, 8);
    const total = groups * perGroup;
    return {
      stem: `${total} dots are shared equally into ${groups} groups. How many are in each group?`,
      answer: intAns(perGroup),
      promptVisual: makeGroupsPromptVisual({
        groups,
        perGroup,
        motif: "dot",
        seed: r.int(1, 2_000_000_000),
      }),
    };
  }),
  T("division_as_grouping", "integer", (r) => {
    const groups = r.int(2, 6);
    const perGroup = r.int(2, 5);
    const total = groups * perGroup;
    return {
      stem: `${total} dots are sorted into groups of ${perGroup}. How many groups are there?`,
      answer: intAns(groups),
      promptVisual: makeGroupsPromptVisual({
        groups,
        perGroup,
        motif: "dot",
        seed: r.int(1, 2_000_000_000),
      }),
    };
  }),
  T("area_model_multiplication", "integer", (r) => {
    const a = r.int(2, 9) * 10 + r.int(1, 9);
    const b = r.int(1, 6) * 10 + r.int(1, 9);
    return {
      stem: `What is ${a} × ${b}? Use the area model.`,
      answer: intAns(a * b),
      promptVisual: makeAreaModelPromptVisual({
        widthParts: decomposeTensOnes(a),
        heightParts: decomposeTensOnes(b),
      }),
    };
  }),
  T("compare_within_10", "integer", (r) => {
    const a = r.int(0, 10);
    let b = r.int(0, 10);
    if (a === b) b = (b + 1) % 11;
    return { stem: `Which is greater, ${a} or ${b}? (type the larger number)`, answer: intAns(Math.max(a, b)) };
  }),
  T("compose_ten", "integer", (r) => {
    const n = r.int(1, 9);
    return { stem: `${n} + ? = 10`, answer: intAns(10 - n) };
  }),

  // ── Place value ─────────────────────────────────────────────────────────
  T("tens_ones_to_99", "integer", (r) => {
    const n = r.int(10, 99);
    return { stem: `How many tens are in ${n}?`, answer: intAns(Math.floor(n / 10)) };
  }),
  T("compare_2digit", "integer", (r) => {
    const a = r.int(10, 99);
    let b = r.int(10, 99);
    if (a === b) b = b === 99 ? 98 : b + 1;
    return { stem: `Which is greater, ${a} or ${b}? (type the larger number)`, answer: intAns(Math.max(a, b)) };
  }),
  T("ten_more_ten_less", "integer", (r) => {
    const n = r.int(10, 89);
    const more = r.int(0, 1) === 1;
    return { stem: `What is 10 ${more ? "more" : "less"} than ${n}?`, answer: intAns(more ? n + 10 : n - 10) };
  }),
  T("hundreds_tens_ones", "integer", (r) => {
    const n = r.int(100, 999);
    return { stem: `How many hundreds are in ${n}?`, answer: intAns(Math.floor(n / 100)) };
  }),
  T("compare_3digit", "integer", (r) => {
    const a = r.int(100, 999);
    let b = r.int(100, 999);
    if (a === b) b = b === 999 ? 998 : b + 1;
    return { stem: `Which is greater, ${a} or ${b}? (type the larger number)`, answer: intAns(Math.max(a, b)) };
  }),
  T("place_value_to_1000", "integer", (r) => {
    const digits = [r.int(1, 9), r.int(1, 9), r.int(1, 9)];
    const n = numberFromDigits(digits);
    const placeIndex = r.int(0, 2);
    const digit = digitAt(n, placeIndex);
    return {
      stem: `In ${n}, what is the value of the ${PLACE_NAMES[placeIndex]} digit (${digit})?`,
      answer: intAns(digit * Math.pow(10, placeIndex)),
    };
  }),
  T("place_value_multidigit", "integer", (r) => {
    const digitCount = r.pick([4, 5]);
    const digits = Array.from({ length: digitCount }, (_, i) => r.int(i === 0 ? 1 : 0, 9));
    let placeIndex = r.int(0, digitCount - 1);
    for (let tries = 0; digitAt(numberFromDigits(digits), placeIndex) === 0 && tries < 10; tries++) {
      placeIndex = r.int(0, digitCount - 1);
    }
    if (digitAt(numberFromDigits(digits), placeIndex) === 0) digits[digitCount - 1 - placeIndex] = 1;
    const n = numberFromDigits(digits);
    const digit = digitAt(n, placeIndex);
    return {
      stem: `In ${n}, what is the value of the ${PLACE_NAMES[placeIndex]} digit (${digit})?`,
      answer: intAns(digit * Math.pow(10, placeIndex)),
    };
  }),
  T("expanded_form_3digit", "integer", (r) => {
    const n = numberFromDigits([r.int(1, 9), r.int(1, 9), r.int(1, 9)]);
    const item = expandedStem(n, 3, r.int(0, 2));
    return { stem: `${item.stem}; what is the missing addend?`, answer: intAns(item.answer) };
  }),
  T("expanded_form_multidigit", "integer", (r) => {
    const digitCount = r.pick([4, 5]);
    const n = numberFromDigits(Array.from({ length: digitCount }, () => r.int(1, 9)));
    const item = expandedStem(n, digitCount, r.int(0, digitCount - 1));
    return { stem: `${item.stem}; what is the missing addend?`, answer: intAns(item.answer) };
  }),

  // ── Skip counting ───────────────────────────────────────────────────────
  T("skip_count_2s_5s_10s", "integer", (r) => {
    const k = r.pick([2, 5, 10]);
    const a = k * r.int(1, 5);
    return { stem: `Skip count by ${k}: ${a}, ${a + k}, ${a + 2 * k}, ?`, answer: intAns(a + 3 * k) };
  }),
  T("skip_count_3s_4s", "integer", (r) => {
    const k = r.pick([3, 4]);
    const a = k * r.int(1, 6);
    return { stem: `Skip count by ${k}: ${a}, ${a + k}, ${a + 2 * k}, ?`, answer: intAns(a + 3 * k) };
  }),
  T("skip_count_6s_7s_8s_9s", "integer", (r) => {
    const k = r.pick([6, 7, 8, 9]);
    const a = k * r.int(1, 6);
    return { stem: `Skip count by ${k}: ${a}, ${a + k}, ${a + 2 * k}, ?`, answer: intAns(a + 3 * k) };
  }),

  // Addition / subtraction fluency
  T("add_within_5", "integer", (r) => {
    const a = r.int(0, 5);
    const b = r.int(0, 5 - a);
    return { stem: `${a} + ${b} = ?`, answer: intAns(a + b), variant: { a, op: "+", b } };
  }),
  T("subtract_within_5", "integer", (r) => {
    const a = r.int(0, 5);
    const b = r.int(0, a);
    return { stem: `${a} − ${b} = ?`, answer: intAns(a - b), variant: { a, op: "−", b } };
  }),
  T("add_within_10", "integer", (r) => {
    const a = r.int(0, 10);
    const b = r.int(0, 10 - a);
    return { stem: `${a} + ${b} = ?`, answer: intAns(a + b), variant: { a, op: "+", b } };
  }),
  T("subtract_within_10", "integer", (r) => {
    const a = r.int(0, 10);
    const b = r.int(0, a);
    return { stem: `${a} − ${b} = ?`, answer: intAns(a - b), variant: { a, op: "−", b } };
  }),
  T("add_subtract_word_problems_within_10", "integer", (r) => {
    const shape = r.int(0, 2);
    if (shape === 0) {
      const start = r.int(1, 8);
      const joined = r.int(1, 10 - start);
      return {
        stem: `${start} ducks are in a pond. ${joined} more ducks join them. How many ducks are in the pond now?`,
        answer: intAns(start + joined),
      };
    }
    if (shape === 1) {
      const start = r.int(2, 10);
      const left = r.int(1, start);
      return {
        stem: `A basket holds ${start} apples. ${left} apples are taken out. How many apples remain?`,
        answer: intAns(start - left),
      };
    }
    const larger = r.int(2, 10);
    const difference = r.int(1, larger);
    return {
      stem: `Nia has ${larger} shells. Bo has ${difference} fewer shells than Nia. How many shells does Bo have?`,
      answer: intAns(larger - difference),
    };
  }),
  T("add_within_20_no_regroup", "integer", (r) => {
    // ones columns sum ≤ 9, total ≤ 20
    const ao = r.int(0, 9);
    const bo = r.int(0, 9 - ao);
    const a = ao + (r.int(0, 1) ? 10 : 0);
    return {
      stem: `${a} + ${bo} = ?`,
      answer: intAns(a + bo),
      variant: { a, op: "+", b: bo },
    };
  }),
  T("add_within_20_regroup", "integer", (r) => {
    const a = r.int(5, 9);
    const b = r.int(11 - a > 2 ? 11 - a : 2, 9); // force ones carry past 10
    return { stem: `${a} + ${b} = ?`, answer: intAns(a + b), variant: { a, op: "+", b } };
  }),
  T("subtract_within_20", "integer", (r) => {
    const a = r.int(10, 20);
    const b = r.int(0, a);
    return { stem: `${a} − ${b} = ?`, answer: intAns(a - b), variant: { a, op: "−", b } };
  }),
  T("add_subtract_fluency_within_20", "integer", (r) => {
    if (r.int(0, 1) === 0) {
      const a = r.int(0, 20);
      const b = r.int(0, 20 - a);
      return { stem: `${a} + ${b} = ?`, answer: intAns(a + b), variant: { a, op: "+", b } };
    }
    const a = r.int(0, 20);
    const b = r.int(0, a);
    return { stem: `${a} − ${b} = ?`, answer: intAns(a - b), variant: { a, op: "−", b } };
  }),
  T("make_ten_strategy", "integer", (r) => {
    if (r.int(0, 1) === 0) {
      const a = r.int(19, 49) * 10 + r.int(7, 9);
      const b = r.int(10 - (a % 10), 9);
      return { stem: `${a} + ${b} = ?`, answer: intAns(a + b) };
    }
    // Two 2-digit addends — the "make ten" strategy only applies when the
    // ones columns cross a ten, so force that carry here too (previously
    // this branch drew both addends uniformly and often produced a pair
    // needing no regrouping at all, mismatching the named strategy).
    const { a, b } = addWithRegroup(r, 2);
    return { stem: `${a} + ${b} = ?`, answer: intAns(a + b) };
  }),

  // Multi-digit addition / subtraction
  T("add_2digit_no_regroup", "integer", (r) => {
    const { a, b } = addNoRegroup(r, 2);
    return { stem: `${a} + ${b} = ?`, answer: intAns(a + b) };
  }),
  T("add_3digit_no_regroup", "integer", (r) => {
    const { a, b } = addNoRegroup(r, 3);
    return { stem: `${a} + ${b} = ?`, answer: intAns(a + b) };
  }),
  T("subtract_2digit_no_regroup", "integer", (r) => {
    const { a, b } = subtract(r, 2, false);
    return { stem: `${a} − ${b} = ?`, answer: intAns(a - b) };
  }),
  T("add_2digit_regroup", "integer", (r) => {
    const { a, b } = addWithRegroup(r, 2);
    return { stem: `${a} + ${b} = ?`, answer: intAns(a + b) };
  }),
  T("subtract_2digit_regroup", "integer", (r) => {
    const { a, b } = subtract(r, 2, true);
    return { stem: `${a} − ${b} = ?`, answer: intAns(a - b) };
  }),
  T("add_3digit_regroup", "integer", (r) => {
    const { a, b } = addWithRegroup(r, 3);
    return { stem: `${a} + ${b} = ?`, answer: intAns(a + b) };
  }),
  T("subtract_3digit_regroup", "integer", (r) => {
    const { a, b } = subtract(r, 3, true);
    return { stem: `${a} − ${b} = ?`, answer: intAns(a - b) };
  }),
  T("add_multidigit_algorithm", "integer", (r) => {
    const a = r.int(1000, 9999);
    const b = r.int(1000, 9999);
    const answer = intAns(a + b);
    return { stem: `${a} + ${b} = ?`, answer, ...withWorkedSteps(columnAddSteps(a, b, answer)) };
  }),
  T("subtract_multidigit_algorithm", "integer", (r) => {
    const a = r.int(1000, 9999);
    const b = r.int(100, a);
    const answer = intAns(a - b);
    return { stem: `${a} − ${b} = ?`, answer, ...withWorkedSteps(columnSubtractSteps(a, b, answer)) };
  }),
  T("add_subtract_word_problems_multidigit", "integer", (r) => {
    if (r.int(0, 1) === 0) {
      const starting = r.int(1_000, 8_000);
      const delivered = r.int(500, 4_000);
      const distributed = r.int(200, starting + delivered - 100);
      return {
        stem: `A warehouse started with ${starting} notebooks, received ${delivered} more, then distributed ${distributed}. How many notebooks remain?`,
        answer: intAns(starting + delivered - distributed),
      };
    }
    const morning = r.int(1_000, 9_000);
    const afternoon = r.int(1_000, 9_000);
    const cancelled = r.int(100, morning + afternoon - 100);
    return {
      stem: `${morning} people reserved morning tickets and ${afternoon} reserved afternoon tickets. Then ${cancelled} reservations were cancelled. How many reservations remain?`,
      answer: intAns(morning + afternoon - cancelled),
    };
  }),

  // Multiplication facts (banded to match the graph's fact nodes). Hard facts
  // are over-sampled (§5 — see pickBandFact) so the reps that count are the
  // reps that matter.
  T("mult_facts_0_1_2_5_10", "integer", (r) => {
    const { f, b } = pickBandFact(r, [0, 1, 2, 5, 10]);
    return { stem: `${f} × ${b} = ?`, answer: intAns(f * b), variant: { a: f, op: "×", b } };
  }),
  T("mult_facts_3_4_6", "integer", (r) => {
    const { f, b } = pickBandFact(r, [3, 4, 6]);
    return { stem: `${f} × ${b} = ?`, answer: intAns(f * b), variant: { a: f, op: "×", b } };
  }),
  T("mult_facts_7_8_9", "integer", (r) => {
    const { f, b } = pickBandFact(r, [7, 8, 9]);
    return { stem: `${f} × ${b} = ?`, answer: intAns(f * b), variant: { a: f, op: "×", b } };
  }),

  // Multi-digit multiplication
  T("mult_2digit_by_1digit", "integer", (r) => {
    const a = r.int(10, 99);
    const b = r.int(2, 9);
    const answer = intAns(a * b);
    return { stem: `${a} × ${b} = ?`, answer, variant: { a, op: "×", b }, ...withWorkedSteps(partialProductsSteps(a, b, answer)) };
  }),
  T("mult_3digit_by_1digit", "integer", (r) => {
    const a = r.int(100, 999);
    const b = r.int(2, 9);
    const answer = intAns(a * b);
    return { stem: `${a} × ${b} = ?`, answer, ...withWorkedSteps(partialProductsSteps(a, b, answer)) };
  }),
  T("mult_2digit_by_2digit", "integer", (r) => {
    const a = r.int(10, 99);
    const b = r.int(10, 99);
    const answer = intAns(a * b);
    return { stem: `${a} × ${b} = ?`, answer, ...withWorkedSteps(partialProductsSteps(a, b, answer)) };
  }),
  T("add_subtract_properties", "integer", (r) => {
    const shape = r.int(0, 2);
    const a = r.int(2, 40);
    const b = r.int(2, 40);
    const c = r.int(2, 40);
    if (shape === 0) return { stem: `(${a} + ${b}) + ${c} = ${a} + (${b} + ___)`, answer: intAns(c) };
    if (shape === 1) return { stem: `${a} + 0 = ___`, answer: intAns(a) };
    return { stem: `${a} − 0 = ___`, answer: intAns(a) };
  }),
  T("mult_commutative_associative", "integer", (r) => {
    const a = r.int(2, 12);
    const b = r.int(2, 12);
    const c = r.int(2, 12);
    if (r.int(0, 1) === 0) return { stem: `${a} × ${b} = ${b} × ___`, answer: intAns(a) };
    return { stem: `(${a} × ${b}) × ${c} = ${a} × (${b} × ___)`, answer: intAns(c) };
  }),
  T("mult_distributive", "integer", (r) => {
    const a = r.int(2, 12);
    const b = r.int(2, 12);
    const c = r.int(2, 12);
    return { stem: `${a} × (${b} + ${c}) = ${a * b} + ___`, answer: intAns(a * c) };
  }),

  // Division
  T("division_facts_0_5", "integer", (r) => {
    const d = r.pick([1, 2, 3, 4, 5]);
    const q = r.int(0, 10);
    return { stem: `${d * q} ÷ ${d} = ?`, answer: intAns(q) };
  }),
  T("division_facts_6_9", "integer", (r) => {
    const d = r.pick([6, 7, 8, 9]);
    let q = r.int(0, 10);
    // Quotients 0 and 1 make the item degenerate (0 ÷ 6, 6 ÷ 6) — the identity
    // facts belong in the 0–5 band, where they are the teaching point, not in
    // the harder-facts band. Nudge (don't re-draw) so only the two degenerate
    // draws change and every other seed re-derives the same stem/answer.
    if (q < 2) q += 5;
    return { stem: `${d * q} ÷ ${d} = ?`, answer: intAns(q) };
  }),
  T("division_with_remainders", "expression", (r) => {
    const d = r.int(2, 9);
    const q = r.int(2, 12);
    const rem = r.int(1, d - 1);
    const dividend = d * q + rem;
    return {
      stem: `${dividend} ÷ ${d} = ? (give quotient and remainder, e.g. "7 R 2")`,
      answer: { type: "expression", canonical: `${q}r${rem}` },
    };
  }),
  T("long_division_1digit_divisor", "integer", (r) => {
    const divisor = r.int(2, 9);
    const quotient = r.int(50, 999);
    const dividend = divisor * quotient;
    const answer = intAns(quotient);
    return { stem: `${dividend} ÷ ${divisor} = ?`, answer, ...withWorkedSteps(longDivisionSteps(dividend, divisor, answer)) };
  }),
  T("long_division_2digit_divisor", "integer", (r) => {
    const divisor = r.int(11, 35);
    const maxQuotient = Math.floor(9999 / divisor);
    const quotient = r.int(Math.ceil(100 / divisor), maxQuotient);
    const dividend = divisor * quotient;
    const answer = intAns(quotient);
    return { stem: `${dividend} ÷ ${divisor} = ?`, answer, ...withWorkedSteps(longDivisionSteps(dividend, divisor, answer)) };
  }),

  // Number theory
  T("factors_and_multiples", "integer", (r) => {
    if (r.int(0, 1) === 0) {
      const n = r.pick([12, 16, 18, 20, 24, 28, 30, 36, 42, 48, 60, 72]);
      return { stem: `How many positive factors does ${n} have?`, answer: intAns(factorCount(n)) };
    }
    const base = r.int(2, 12);
    const k = r.int(2, 10);
    return { stem: `What is the ${formatOrdinal(k)} positive multiple of ${base}?`, answer: intAns(base * k) };
  }),
  T("prime_composite", "integer", (r) => {
    const n = r.pick([2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 4, 6, 8, 9, 12, 15, 21, 25, 27, 33, 35, 49]);
    return { stem: `How many positive factors does ${n} have? (A prime has exactly 2.)`, answer: intAns(factorCount(n)) };
  }),
  T("divisibility_rules_2_5_10", "integer", (r) => {
    const divisor = r.pick([2, 5, 10]);
    const n = r.int(20, 999);
    return { stem: `What is the remainder when ${n} is divided by ${divisor}? (0 means divisible.)`, answer: intAns(n % divisor) };
  }),
  T("divisibility_rules_3_9", "integer", (r) => {
    const divisor = r.pick([3, 9]);
    const n = r.int(100, 9999);
    const digitSum = String(n).split("").reduce((sum, d) => sum + Number(d), 0);
    return {
      stem: `The digit sum of ${n} is ${digitSum}. What is the remainder when ${n} is divided by ${divisor}?`,
      answer: intAns(n % divisor),
    };
  }),
  T("prime_factorization", "integer", (r) => {
    const cases = [
      { n: 12, text: "2^2 · 3", asks: [{ prime: 2, exponent: 2 }, { prime: 3, exponent: 1 }] },
      { n: 18, text: "2 · 3^2", asks: [{ prime: 2, exponent: 1 }, { prime: 3, exponent: 2 }] },
      { n: 24, text: "2^3 · 3", asks: [{ prime: 2, exponent: 3 }, { prime: 3, exponent: 1 }] },
      { n: 40, text: "2^3 · 5", asks: [{ prime: 2, exponent: 3 }, { prime: 5, exponent: 1 }] },
      { n: 72, text: "2^3 · 3^2", asks: [{ prime: 2, exponent: 3 }, { prime: 3, exponent: 2 }] },
      { n: 90, text: "2 · 3^2 · 5", asks: [{ prime: 2, exponent: 1 }, { prime: 3, exponent: 2 }, { prime: 5, exponent: 1 }] },
      { n: 120, text: "2^3 · 3 · 5", asks: [{ prime: 2, exponent: 3 }, { prime: 3, exponent: 1 }, { prime: 5, exponent: 1 }] },
      { n: 720, text: "2^4 · 3^2 · 5", asks: [{ prime: 2, exponent: 4 }, { prime: 3, exponent: 2 }, { prime: 5, exponent: 1 }] },
    ];
    const item = r.pick(cases);
    const ask = r.pick(item.asks);
    return {
      stem: `The prime factorization of ${item.n} is ${item.text}. What is the exponent of ${ask.prime}?`,
      answer: intAns(ask.exponent),
    };
  }),
  T("gcf", "integer", (r) => {
    const pair = r.pick([[2, 3], [3, 4], [4, 5], [5, 7], [7, 8], [3, 5], [5, 6]]);
    const g = r.int(2, 12);
    const a = g * pair[0];
    const b = g * pair[1];
    return { stem: `GCF(${a}, ${b}) = ?`, answer: intAns(g) };
  }),
  T("lcm", "integer", (r) => {
    const pair = r.pick([[2, 3], [3, 4], [4, 5], [5, 7], [7, 8], [3, 5], [5, 6]]);
    const g = r.int(1, 8);
    const a = g * pair[0];
    const b = g * pair[1];
    return { stem: `LCM(${a}, ${b}) = ?`, answer: intAns(lcm(a, b)) };
  }),
  T("exponents_repeated_mult", "integer", (r) => {
    const base = r.int(2, 5);
    let exponent = r.int(2, 5);
    // Cap the result at 256 (= 4^4): above it, every chained product needs
    // 3-digit × 1-digit multiplication (5^4 = 125 × 5, 4^5 = 256 × 4, 5^5 =
    // 625 × 5) — the grade-4 mult_3digit_by_1digit algorithm, which is NOT a
    // prerequisite of this node. Within the cap the largest step is 2-digit ×
    // 1-digit (81 × 3, 64 × 4), covered by the node's own fact prereqs, so the
    // item tests the exponent concept rather than multiplication stamina.
    // Walking the exponent down (not re-drawing) keeps the RNG draw sequence
    // identical, so every seed outside the three capped cells re-derives the
    // same stem/answer as before.
    while (Math.pow(base, exponent) > 256) exponent -= 1;
    return { stem: `${base}^${exponent} = ?`, answer: intAns(Math.pow(base, exponent)) };
  }),
  T("square_cube_numbers", "integer", (r) => {
    if (r.int(0, 1) === 0) {
      const n = r.int(2, 12);
      return { stem: `What is ${n} squared?`, answer: intAns(n * n) };
    }
    const n = r.int(2, 5);
    return { stem: `What is ${n} cubed?`, answer: intAns(n * n * n) };
  }),
  T("remainder_cycles", "integer", (r) => {
    // Two variants, RNG-order-preserved from the pre-visual template (the
    // leading branch draw keeps `start`/`hours` in their original positions, so
    // an item served just before a deploy still re-derives the same answer at
    // grade time). The clock variant gets a clockface visual; the day-of-week
    // variant stays text-only (a calendar picture adds nothing — see the
    // curriculum prompt-visual audit).
    if (r.int(0, 1) === 0) {
      const start = r.int(1, 12);
      const hours = r.int(5, 100);
      const answer = ((start + hours - 1) % 12) + 1;
      return {
        stem: `On a 12-hour clock, ${start} o'clock + ${hours} hours = ? o'clock`,
        answer: intAns(answer),
        promptVisual: makeClockfacePromptVisual({ highlightHour: start }),
      };
    }
    const day = r.int(0, 6);
    const daysLater = r.int(20, 200);
    return {
      stem: `Today is day ${day} (0=Sun…6=Sat). What day number is it ${daysLater} days later?`,
      answer: intAns((day + daysLater) % 7),
    };
  }),

  // Rounding
  T("round_to_nearest_10_100", "integer", (r) => {
    const to = r.pick([10, 100]);
    const n = r.int(to === 10 ? 11 : 101, to === 10 ? 199 : 999);
    return { stem: `Round ${n} to the nearest ${to}.`, answer: intAns(Math.round(n / to) * to) };
  }),
  T("round_multidigit", "integer", (r) => {
    const to = r.pick([10, 100, 1000]);
    const n = r.int(1000, 99999);
    return { stem: `Round ${n} to the nearest ${to}.`, answer: intAns(Math.round(n / to) * to) };
  }),

  // Order of operations
  T("order_of_operations", "integer", (r) => {
    const a = r.int(2, 9);
    const b = r.int(2, 9);
    const c = r.int(2, 9);
    const divisor = r.int(2, 9);
    const quotient = r.int(2, 9);
    const product = divisor * quotient;
    const shape = r.int(0, 4);
    if (shape === 0) {
      const answer = intAns(a + b * c);
      return {
        stem: `${a} + ${b} × ${c} = ?`,
        answer,
        workedSteps: orderOfOperationsSteps(
          `Multiplication comes before addition, so do ${b} × ${c} = ${b * c} first.`,
          "Do the multiplication first: ?",
          `Then add: ${a} + ${b * c} = ${a + b * c}.`,
          `Now add ${a} + ${b * c}: ?`,
        ),
      };
    }
    if (shape === 1) {
      const answer = intAns((a + b) * c);
      return {
        stem: `(${a} + ${b}) × ${c} = ?`,
        answer,
        workedSteps: orderOfOperationsSteps(
          `Parentheses first, so do ${a} + ${b} = ${a + b}.`,
          "Do what's in the parentheses first: ?",
          `Then multiply: ${a + b} × ${c} = ${(a + b) * c}.`,
          `Now multiply ${a + b} × ${c}: ?`,
        ),
      };
    }
    if (shape === 2) {
      const subtrahend = r.int(2, Math.min(9, a * b - 1));
      const answer = intAns(a * b - subtrahend);
      return {
        stem: `${a} × ${b} − ${subtrahend} = ?`,
        answer,
        workedSteps: orderOfOperationsSteps(
          `Multiplication comes before subtraction, so do ${a} × ${b} = ${a * b} first.`,
          "Do the multiplication first: ?",
          `Then subtract: ${a * b} − ${subtrahend} = ${a * b - subtrahend}.`,
          `Now subtract ${a * b} − ${subtrahend}: ?`,
        ),
      };
    }
    if (shape === 3) {
      const answer = intAns(quotient + c);
      return {
        stem: `${product} ÷ ${divisor} + ${c} = ?`,
        answer,
        workedSteps: orderOfOperationsSteps(
          `Division comes before addition, so do ${product} ÷ ${divisor} = ${quotient} first.`,
          "Do the division first: ?",
          `Then add: ${quotient} + ${c} = ${quotient + c}.`,
          `Now add ${quotient} + ${c}: ?`,
        ),
      };
    }
    // The subtrahend must not equal `a`: that makes the answer exactly b × c,
    // which the FIRST (revealed) worked step already prints — so the teaching
    // moment's blank would be a copy. Nudge it off `a` when it collides.
    let subtrahend = r.int(2, Math.min(9, a + b * c - 1));
    if (subtrahend === a) subtrahend = subtrahend > 2 ? subtrahend - 1 : subtrahend + 1;
    const answer = intAns(a + b * c - subtrahend);
    return {
      stem: `(${a} + (${b} × ${c})) − ${subtrahend} = ?`,
      answer,
      workedSteps: orderOfOperationsSteps(
        `Work the innermost parentheses first: ${b} × ${c} = ${b * c}, then ${a} + ${b * c} = ${a + b * c}.`,
        "Work inside the parentheses first: ?",
        `Then subtract: ${a + b * c} − ${subtrahend} = ${a + b * c - subtrahend}.`,
        `Now subtract ${a + b * c} − ${subtrahend}: ?`,
      ),
    };
  }),

  // Fraction arithmetic (Wave D / P4b)
  T("unit_fraction", "fraction", (r) => {
    const parts = r.int(2, 8);
    const shape = r.pick(["bar", "circle"] as const);
    return {
      stem: "What fraction of the whole is shaded?",
      answer: fracAns(1, parts),
      promptVisual: makeFractionPartPromptVisual({ parts, shaded: 1, shape }),
    };
  }),
  T("add_subtract_like", "fraction", (r) => {
    const d = r.int(2, 12);
    let a = r.int(1, d - 1);
    let b = r.int(1, d - 1);
    let subtract = r.int(0, 1) === 1;
    if (subtract && a < b) [a, b] = [b, a];
    // a/d − a/d is a degenerate item: the answer is 0, and the first (revealed)
    // worked step already prints "a − a = 0", so the teaching moment's blank is
    // a copy. Shift the second numerator down, or fall back to addition when the
    // denominator leaves no room (d = 2).
    if (subtract && a === b) {
      if (a > 1) b = a - 1;
      else subtract = false;
    }
    const op = subtract ? "−" : "+";
    const num = subtract ? a - b : a + b;
    const answer = fracAns(num, d);
    return {
      stem: `${a}/${d} ${op} ${b}/${d} = ?`,
      answer,
      workedSteps: fractionAddSubtractLikeSteps(a, b, d, op, answer),
    };
  }),
  T("add_subtract_unlike", "fraction", (r) => {
    let d1 = r.int(2, 12);
    let d2 = r.int(2, 12);
    while (d2 === d1) d2 = r.int(2, 12);
    let a = r.int(1, d1 - 1);
    let b = r.int(1, d2 - 1);
    let subtract = r.int(0, 1) === 1;
    if (subtract && a * d2 < b * d1) {
      [a, b] = [b, a];
      [d1, d2] = [d2, d1];
    }
    // Equal fractions written over unlike denominators (2/4 − 1/2) make the
    // difference 0, which the first REVEALED step already prints — so the
    // teaching moment's blank would be a copy. Nudge the second numerator down,
    // or fall back to addition when there is no room.
    if (subtract && a * d2 === b * d1) {
      if (b > 1) b -= 1;
      else subtract = false;
    }
    const op = subtract ? "−" : "+";
    const num = subtract ? a * d2 - b * d1 : a * d2 + b * d1;
    const answer = fracAns(num, d1 * d2);
    return {
      stem: `${a}/${d1} ${op} ${b}/${d2} = ?`,
      answer,
      workedSteps: fractionAddSubtractUnlikeSteps(a, d1, b, d2, op, answer),
    };
  }),
  T("add_subtract_mixed_like", "fraction", (r) => {
    const d = r.int(2, 12);
    let leftWhole = r.int(1, 8);
    let leftNum = r.int(1, d - 1);
    let rightWhole = r.int(1, 8);
    let rightNum = r.int(1, d - 1);
    const subtract = r.int(0, 1) === 1;
    if (subtract) {
      const leftTotal = leftWhole * d + leftNum;
      const rightTotal = rightWhole * d + rightNum;
      if (leftTotal < rightTotal) {
        [leftWhole, rightWhole] = [rightWhole, leftWhole];
        [leftNum, rightNum] = [rightNum, leftNum];
      } else if (leftTotal === rightTotal) {
        leftWhole += 1;
      }
    }
    const leftTotal = leftWhole * d + leftNum;
    const rightTotal = rightWhole * d + rightNum;
    const op = subtract ? "−" : "+";
    const result = subtract ? leftTotal - rightTotal : leftTotal + rightTotal;
    return {
      stem: `${leftWhole} ${leftNum}/${d} ${op} ${rightWhole} ${rightNum}/${d} = ? Write the answer as a single fraction.`,
      answer: fracAns(result, d),
    };
  }),
  T("multiply_fraction_by_whole", "fraction", (r) => {
    const n = r.int(2, 12);
    const b = r.int(2, 12);
    const a = r.int(1, b - 1);
    const answer = fracAns(n * a, b);
    return {
      stem: `${n} × ${a}/${b} = ?`,
      answer,
      workedSteps: fractionTimesWholeSteps(n, a, b, answer),
    };
  }),
  T("multiply_fractions", "fraction", (r) => {
    const b = r.int(2, 12);
    const d = r.int(2, 12);
    const a = r.int(1, b - 1);
    const c = r.int(1, d - 1);
    const answer = fracAns(a * c, b * d);
    return {
      stem: `${a}/${b} × ${c}/${d} = ?`,
      answer,
      workedSteps: fractionMultiplySteps(a, b, c, d, answer),
    };
  }),
  T("divide_unit_fractions", "fraction", (r) => {
    const b = r.int(2, 12);
    const n = r.int(2, 12);
    if (r.int(0, 1) === 0) {
      const answer = fracAns(1, b * n);
      return {
        stem: `1/${b} ÷ ${n} = ?`,
        answer,
        workedSteps: unitFractionDividedByWholeSteps(b, n, answer),
      };
    }
    const answer = fracAns(n * b, 1);
    return {
      stem: `${n} ÷ 1/${b} = ?`,
      answer,
      workedSteps: wholeDividedByUnitFractionSteps(n, b, answer),
    };
  }),
  T("divide_fractions", "fraction", (r) => {
    const b = r.int(2, 12);
    const d = r.int(2, 12);
    const a = r.int(1, b - 1);
    const c = r.int(1, d - 1);
    const answer = fracAns(a * d, b * c);
    return {
      stem: `${a}/${b} ÷ ${c}/${d} = ?`,
      answer,
      workedSteps: fractionDivideSteps(a, b, c, d, answer),
    };
  }),
  T("equivalent_fractions_general", "integer", (r) => {
    const b = r.int(2, 12);
    const a = r.int(1, b - 1);
    const k = r.int(2, 9);
    return { stem: `${a}/${b} = ?/${k * b}`, answer: intAns(k * a) };
  }),
  T("simplify_fractions", "fraction", (r) => {
    const denominator = r.int(3, 12);
    let numerator = r.int(1, denominator - 1);
    while (gcd(numerator, denominator) !== 1) {
      numerator = numerator === denominator - 1 ? 1 : numerator + 1;
    }
    const scale = r.int(2, 10);
    return {
      stem: `Simplify ${numerator * scale}/${denominator * scale} to lowest terms.`,
      answer: fracAns(numerator, denominator),
    };
  }),
  T("common_denominators", "integer", (r) => {
    const x = r.int(2, 12);
    const y = r.int(2, 12);
    return { stem: `To add 1/${x} + 1/${y}, what's the least common denominator you could use?`, answer: intAns(lcm(x, y)) };
  }),
  T("whole_as_fraction", "integer", (r) => {
    const w = r.int(1, 24);
    return { stem: `Write ${w} as a fraction over 1: ${w} = ?/1`, answer: intAns(w) };
  }),
  // Bridge skill: a whole-number division a ÷ b is the fraction a/b (5.NF.B.3).
  // answerType "expression" with a genuine fraction answer → drives the native
  // 2-D box editor (answerShape "twoD"); the box builds `(a)/(b)`, graded by
  // numeric equivalence against the canonical `a/b`.
  T("fraction_as_division", "expression", (r) => {
    const b = r.int(2, 9);
    const a = r.int(1, b - 1);
    return {
      stem: `Write ${a} ÷ ${b} as a fraction.`,
      answer: { type: "expression", canonical: `${a}/${b}` },
    };
  }),
  T("mixed_improper", "integer", (r) => {
    const whole = r.int(1, 9);
    const den = r.int(2, 12);
    const num = r.int(1, den - 1);
    return { stem: `Write ${whole} ${num}/${den} as ?/${den}`, answer: intAns(whole * den + num) };
  }),
  T("decompose_fraction", "multipleChoice", (r) => {
    const denominator = r.int(4, 12);
    const numerator = r.int(4, denominator + 4);
    const firstPart = r.int(1, numerator - 2);
    const secondPart = numerator - firstPart;
    const correct = `${numerator}/${denominator} = ${firstPart}/${denominator} + ${secondPart}/${denominator}`;
    return choiceItem(r, `Which equation correctly decomposes ${numerator}/${denominator}?`, correct, [
      `${numerator}/${denominator} = ${firstPart}/${denominator} + ${secondPart + 1}/${denominator}`,
      `${numerator}/${denominator} = ${firstPart + 1}/${denominator} + ${secondPart}/${denominator}`,
      `${numerator}/${denominator} = ${firstPart}/${denominator} + ${secondPart - 1}/${denominator}`,
    ]);
  }),
  T("compare_same_denominator", "multipleChoice", (r) => {
    let d = r.int(2, 12);
    // Two distinct proper numerators need d ≥ 3.
    if (d === 2) d = 3;
    let a = r.int(1, d);
    let b = r.int(1, d);
    // Degenerate draws: a numerator equal to the denominator is a whole number
    // in fraction clothing (whole_as_fraction's job, and the sibling compare_*
    // templates already exclude it), and a == b makes the comparison trivial
    // ("How does 6/6 compare to 6/6?"). Fold the top numerator down, then
    // separate an equal pair — nudges, not re-draws, so non-degenerate seeds
    // re-derive the same stem/answer as before.
    if (a >= d) a = d - 1;
    if (b >= d) b = d - 1;
    if (b === a) b = a === 1 ? a + 1 : a - 1;
    const idx = a < b ? 0 : a === b ? 1 : 2;
    return {
      stem: `How does ${a}/${d} compare to ${b}/${d}?`,
      answer: choiceAns(idx),
      choices: COMPARE_CHOICES,
    };
  }),
  T("compare_same_numerator", "multipleChoice", (r) => {
    const n = r.int(1, 11);
    const d1 = r.int(2, 12);
    let d2 = r.int(2, 12);
    // Same-numerator comparisons need different-sized parts. Keep the draw
    // deterministic while turning a duplicate denominator into its neighbor.
    if (d2 === d1) d2 = d1 === 12 ? d1 - 1 : d1 + 1;
    const left = n * d2;
    const right = n * d1;
    const idx = left < right ? 0 : left === right ? 1 : 2;
    return {
      stem: `How does ${n}/${d1} compare to ${n}/${d2}?`,
      answer: choiceAns(idx),
      choices: COMPARE_CHOICES,
    };
  }),
  T("compare_benchmarks", "multipleChoice", (r) => {
    const den = r.int(2, 12);
    const num = r.int(1, den - 1);
    const left = num * 2;
    const right = den;
    const idx = left < right ? 0 : left === right ? 1 : 2;
    return {
      stem: `How does ${num}/${den} compare to 1/2?`,
      answer: choiceAns(idx),
      choices: COMPARE_CHOICES,
    };
  }),
  T("compare_unlike", "multipleChoice", (r) => {
    let a: number;
    let b: number;
    let c: number;
    let d: number;
    if (r.int(0, 4) === 0) {
      const q = r.int(2, 6);
      const p = r.int(1, q - 1);
      const k = r.int(2, 3);
      a = p;
      b = q;
      c = p * k;
      d = q * k;
    } else {
      b = r.int(3, 12);
      d = r.int(3, 12);
      while (d === b) d = r.int(3, 12);
      a = r.int(1, b - 1);
      c = r.int(1, d - 1);
      if (a === c) c = c === d - 1 ? c - 1 : c + 1;
    }
    const left = a * d;
    const right = c * b;
    const idx = left < right ? 0 : left === right ? 1 : 2;
    return {
      stem: `How does ${a}/${b} compare to ${c}/${d}?`,
      answer: choiceAns(idx),
      choices: COMPARE_CHOICES,
    };
  }),
  T("order_fractions", "multipleChoice", (r) => {
    const numerators = shuffledNumbers(
      Array.from({ length: 11 }, (_, index) => index + 1),
      r,
    ).slice(0, 3);
    const ascending = [...numerators].sort((a, b) => a - b);
    const labels = ascending.map((numerator) => formatAnswer(fracAns(numerator, 12)));
    const correct = labels.join(" < ");
    return choiceItem(r, "Which list orders the fractions from least to greatest?", correct, [
      [...labels].reverse().join(" < "),
      [labels[1], labels[0], labels[2]].join(" < "),
      [labels[0], labels[2], labels[1]].join(" < "),
    ]);
  }),
  T("fraction_scaling", "multipleChoice", (r) => {
    const value = r.int(2, 20);
    const denominator = r.int(2, 10);
    const relation = r.int(0, 2);
    const numerator = relation === 0
      ? r.int(1, denominator - 1)
      : relation === 1
        ? denominator
        : r.int(denominator + 1, denominator * 2);
    return {
      stem: `Without calculating the product, compare ${value} × ${numerator}/${denominator} with ${value}.`,
      answer: choiceAns(relation),
      choices: [`less than ${value}`, `equal to ${value}`, `greater than ${value}`],
    };
  }),

  // ── Decimals strand (fraction-arithmetic) ─────────────────────────────────
  // The #881 discipline, enforced by test: every TYPED decimal answer stays
  // within 2 decimal places, and each item tests ITS construct (notation,
  // comparison, place value, one operation) — never tangential fluency. All
  // values are constructed in scaled-INTEGER space (tenths/hundredths/
  // thousandths ints) so answers are exact by construction, never float dust.
  T("decimal_notation_fractions", "decimal", (r) => {
    // Write a/10 or a/100 as a decimal. Answers are 1 or 2 places by identity.
    if (r.int(0, 1) === 0) {
      const a = r.int(1, 9);
      const answer = decAns(a / 10);
      return {
        stem: `Write ${a}/10 as a decimal.`,
        answer,
        workedSteps: decimalNotationSteps(a, 10, answer),
      };
    }
    // Skip multiples of 10 so the hundredths form isn't secretly a tenths item.
    let a = r.int(1, 99);
    if (a % 10 === 0) a += r.int(1, 9);
    const answer = decAns(a / 100);
    return {
      stem: `Write ${a}/100 as a decimal.`,
      answer,
      workedSteps: decimalNotationSteps(a, 100, answer),
    };
  }),
  T("compare_decimals", "multipleChoice", (r) => {
    // Compare two decimals to hundredths. Three shapes, one per misconception:
    // plain hundredths-vs-hundredths, the "longer string looks bigger" trap
    // (tenths vs hundredths, e.g. 0.4 vs 0.35), and trailing-zero equality
    // (0.5 vs 0.50). Values are hundredths INTS; display re-derives the string.
    const asTenths = (t: number): string => `0.${t}`;
    const asHundredths = (h: number): string => `0.${String(h).padStart(2, "0")}`;
    const shape = r.int(0, 2);
    let leftLabel: string;
    let rightLabel: string;
    let leftH: number;
    let rightH: number;
    if (shape === 0) {
      leftH = r.int(1, 99);
      rightH = r.int(1, 99);
      leftLabel = asHundredths(leftH);
      rightLabel = asHundredths(rightH);
    } else if (shape === 1) {
      const t = r.int(2, 9);
      // A hundredths value near the tenths value, never equal to it.
      let h = r.int(t * 10 - 9, t * 10 + 9);
      if (h === t * 10) h += r.int(0, 1) === 0 ? -1 : 1;
      const tenthsFirst = r.int(0, 1) === 0;
      leftH = tenthsFirst ? t * 10 : h;
      rightH = tenthsFirst ? h : t * 10;
      leftLabel = tenthsFirst ? asTenths(t) : asHundredths(h);
      rightLabel = tenthsFirst ? asHundredths(h) : asTenths(t);
    } else {
      const t = r.int(1, 9);
      leftH = t * 10;
      rightH = t * 10;
      const tenthsFirst = r.int(0, 1) === 0;
      leftLabel = tenthsFirst ? asTenths(t) : asHundredths(t * 10);
      rightLabel = tenthsFirst ? asHundredths(t * 10) : asTenths(t);
    }
    const idx = leftH < rightH ? 0 : leftH === rightH ? 1 : 2;
    return {
      stem: `How does ${leftLabel} compare to ${rightLabel}?`,
      answer: choiceAns(idx),
      choices: COMPARE_CHOICES,
    };
  }),
  T("decimal_place_value_round", "decimal", (r) => {
    // A thousandths INT m in [1.001, 9.999] with a nonzero final digit, so the
    // stem is honestly a thousandths number. Integer-space half-up rounding
    // (never Math.round on a float quotient — 42.65 is 42.649999… in binary).
    const roundDiv = (m: number, k: number): number => Math.floor((m + k / 2) / k);
    let m = r.int(1001, 9999);
    if (m % 10 === 0) m += r.int(1, 9);
    const shown = `${Math.floor(m / 1000)}.${String(m % 1000).padStart(3, "0")}`;
    const shape = r.int(0, 3);
    if (shape === 0) {
      return {
        stem: `Round ${shown} to the nearest whole number.`,
        answer: decAns(roundDiv(m, 1000)),
      };
    }
    if (shape === 1) {
      return {
        stem: `Round ${shown} to the nearest tenth.`,
        answer: decAns(roundDiv(m, 100) / 10),
      };
    }
    if (shape === 2) {
      return {
        stem: `Round ${shown} to the nearest hundredth.`,
        answer: decAns(roundDiv(m, 10) / 100),
      };
    }
    // Place-value identification: the VALUE a digit contributes (5.NBT.A.1).
    const place = r.pick([
      { name: "tenths", div: 100, unit: 10 },
      { name: "hundredths", div: 10, unit: 100 },
    ] as const);
    const digit = Math.floor(m / place.div) % 10;
    return {
      stem: `In the number ${shown}, what is the VALUE of the digit in the ${place.name} place?`,
      answer: decAns(digit / place.unit),
    };
  }),
  T("add_subtract_decimals", "decimal", (r) => {
    // One tenths operand + one hundredths operand, so the item exercises the
    // point-alignment construct (7.5 − 2.34 misaligns for a scholar who
    // right-justifies digits). Hundredths-int arithmetic keeps answers exact
    // and ≤ 2 places by construction.
    let tenths = r.int(11, 99); // 1.1 – 9.9, in tenths
    if (tenths % 10 === 0) tenths += r.int(1, 9); // honestly ONE decimal place
    let hundredths = r.int(101, 899); // 1.01 – 8.99, in hundredths
    if (hundredths % 10 === 0) hundredths += r.int(1, 9); // honestly TWO places
    const tenthsOp = { valueH: tenths * 10, label: `${tenths / 10}` };
    const hundredthsOp = { valueH: hundredths, label: (hundredths / 100).toFixed(2) };
    if (r.int(0, 1) === 1) {
      // Subtraction: larger minus smaller (values can never tie — one is a
      // multiple of 10 hundredths, the other never is).
      const [big, small] =
        tenthsOp.valueH > hundredthsOp.valueH
          ? [tenthsOp, hundredthsOp]
          : [hundredthsOp, tenthsOp];
      const answer = decAns((big.valueH - small.valueH) / 100);
      return {
        stem: `${big.label} − ${small.label} = ?`,
        answer,
        workedSteps: decimalAddSubtractSteps(big.label, small.label, "−", answer),
      };
    }
    const [left, right] =
      r.int(0, 1) === 0 ? [tenthsOp, hundredthsOp] : [hundredthsOp, tenthsOp];
    const answer = decAns((left.valueH + right.valueH) / 100);
    return {
      stem: `${left.label} + ${right.label} = ?`,
      answer,
      workedSteps: decimalAddSubtractSteps(left.label, right.label, "+", answer),
    };
  }),
  T("multiply_decimals", "decimal", (r) => {
    // Total decimal places across the two factors never exceeds 2, so the
    // product is ≤ 2 places by construction (the #881 rule). Three shapes:
    // tenths × tenths, tenths × whole, hundredths × whole.
    const shape = r.int(0, 2);
    if (shape === 0) {
      const aT = r.int(2, 9);
      let bT = r.int(2, 29); // 0.2–0.9 × 0.2–2.9
      if (bT % 10 === 0) bT += r.int(1, 9); // keep the factor honestly tenths
      const answer = decAns((aT * bT) / 100);
      return {
        stem: `${aT / 10} × ${bT / 10} = ?`,
        answer,
        workedSteps: decimalMultiplySteps(`${aT / 10}`, `${bT / 10}`, aT * bT, 2, answer),
      };
    }
    if (shape === 1) {
      let aT = r.int(11, 99); // 1.1 – 9.9
      if (aT % 10 === 0) aT += r.int(1, 9);
      const b = r.int(2, 9);
      const answer = decAns((aT * b) / 10);
      return {
        stem: `${aT / 10} × ${b} = ?`,
        answer,
        workedSteps: decimalMultiplySteps(`${aT / 10}`, `${b}`, aT * b, 1, answer),
      };
    }
    let aH = r.int(11, 99); // 0.11 – 0.99
    if (aH % 10 === 0) aH += r.int(1, 9);
    const b = r.int(2, 9);
    const answer = decAns((aH * b) / 100);
    return {
      stem: `${aH / 100} × ${b} = ?`,
      answer,
      workedSteps: decimalMultiplySteps(`${aH / 100}`, `${b}`, aH * b, 2, answer),
    };
  }),
  T("divide_decimals", "decimal", (r) => {
    // Constructed FROM the quotient so the answer is exact and ≤ 2 places.
    // Three shapes: decimal ÷ whole, decimal ÷ decimal (scale-to-whole), and
    // whole-quotient ÷ decimal (6.5 ÷ 0.5 = 13 — the "answer can be bigger
    // than the dividend" moment).
    const shape = r.int(0, 2);
    if (shape === 0) {
      let qT = r.int(11, 99); // quotient 1.1 – 9.9
      if (qT % 10 === 0) qT += r.int(1, 9);
      const d = r.int(2, 9);
      const answer = decAns(qT / 10);
      return {
        stem: `${(qT * d) / 10} ÷ ${d} = ?`,
        answer,
        workedSteps: decimalDivideSteps(`${(qT * d) / 10}`, `${d}`, answer),
      };
    }
    if (shape === 1) {
      const qT = r.int(2, 9); // quotient 0.2 – 0.9
      const dT = r.pick([2, 3, 4, 5, 6, 8]); // divisor 0.2 – 0.8
      const answer = decAns(qT / 10);
      return {
        stem: `${(qT * dT) / 100} ÷ ${dT / 10} = ?`,
        answer,
        workedSteps: decimalDivideSteps(`${(qT * dT) / 100}`, `${dT / 10}`, answer),
      };
    }
    const q = r.int(3, 19); // whole quotient
    const dT = r.pick([2, 4, 5, 8]); // divisor 0.2, 0.4, 0.5, 0.8
    const answer = decAns(q);
    return {
      stem: `${(q * dT) / 10} ÷ ${dT / 10} = ?`,
      answer,
      workedSteps: decimalDivideSteps(`${(q * dT) / 10}`, `${dT / 10}`, answer),
    };
  }),

  // Probability (CCSS 7.SP enrichment preview)
  T("likelihood_scale", "multipleChoice", (r) => {
    const category = r.int(0, 4);
    const blue = r.int(2, 10);
    const red = category === 0
      ? 0
      : category === 1
        ? r.int(1, blue - 1)
        : category === 2
          ? blue
          : category === 3
            ? blue + r.int(1, 8)
            : r.int(2, 10);
    const blueCount = category === 4 ? 0 : blue;
    return {
      stem: `A bag has ${red} red marbles and ${blueCount} blue marbles. One marble is drawn at random. How likely is drawing red?`,
      answer: choiceAns(category),
      choices: ["impossible", "unlikely", "equally likely", "likely", "certain"],
    };
  }),
  T("theoretical_probability_simple", "fraction", (r) => {
    const cases = [
      {
        stem: "A fair die is rolled. What is the probability of rolling an even number?",
        num: 3,
        den: 6,
      },
      {
        stem: "A fair die is rolled. What is the probability of rolling an odd number?",
        num: 3,
        den: 6,
      },
      ...[2, 3, 4, 5].map((threshold) => ({
        stem: `A fair die is rolled. What is the probability of rolling a number greater than ${threshold}?`,
        num: 6 - threshold,
        den: 6,
      })),
      ...[2, 3, 4, 5, 6].map((threshold) => ({
        stem: `A fair die is rolled. What is the probability of rolling at least ${threshold}?`,
        num: 7 - threshold,
        den: 6,
      })),
      ...[1, 2, 3, 4, 5, 6].map((face) => ({
        stem: `A fair die is rolled. What is the probability of rolling a ${face}?`,
        num: 1,
        den: 6,
      })),
    ];
    const item = r.pick(cases);
    const answer = fracAns(item.num, item.den);
    return {
      stem: item.stem,
      answer,
      workedSteps: probabilityFractionSteps(item.num, item.den, answer),
    };
  }),
  T("complement_probability", "fraction", (r) => {
    if (r.int(0, 3) === 0) {
      const parity = r.pick([
        { name: "even number", favorable: 3 },
        { name: "odd number", favorable: 3 },
      ]);
      const answer = fracAns(6 - parity.favorable, 6);
      return {
        stem: `A fair die is rolled. What is the probability of NOT rolling an ${parity.name}?`,
        answer,
        workedSteps: complementProbabilitySteps(parity.favorable, 6, answer),
      };
    }
    const face = r.int(1, 6);
    const answer = fracAns(5, 6);
    return {
      stem: `A fair die is rolled. What is the probability of NOT rolling a ${face}?`,
      answer,
      workedSteps: complementProbabilitySteps(1, 6, answer),
    };
  }),
  T("probability_as_fraction", "fraction", (r) => {
    const cases = [
      { favorable: 3, total: 6, event: "faces are even" },
      { favorable: 3, total: 6, event: "faces are odd" },
      { favorable: 2, total: 6, event: "faces are greater than 4" },
      { favorable: 4, total: 6, event: "faces are less than 5" },
      { favorable: 1, total: 2, event: "coin sides are heads" },
    ];
    const item = r.pick(cases);
    const answer = fracAns(item.favorable, item.total);
    return {
      stem: `${item.favorable} of the ${item.total} ${item.event}. Write that probability in simplest form.`,
      answer,
      workedSteps: probabilityFractionSteps(item.favorable, item.total, answer),
    };
  }),
  T("experimental_probability", "fraction", (r) => {
    const trials = r.int(20, 120);
    const successes = r.int(1, trials - 1);
    return {
      stem: `A spinner landed on blue ${successes} times in ${trials} trials. Use the results to estimate P(blue).`,
      answer: fracAns(successes, trials),
    };
  }),
  T("law_of_large_numbers", "multipleChoice", (r) => {
    const smallTrials = r.int(10, 50);
    const largeTrials = r.int(10, 40) * 100;
    const largerIsA = r.int(0, 1) === 0;
    const aTrials = largerIsA ? largeTrials : smallTrials;
    const bTrials = largerIsA ? smallTrials : largeTrials;
    return {
      stem: `Experiment A estimates a fair coin's heads probability from ${aTrials} flips. Experiment B uses ${bTrials} flips. Which estimate would generally be more stable from run to run?`,
      answer: choiceAns(largerIsA ? 0 : 1),
      choices: ["Experiment A", "Experiment B", "They should be equally stable"],
    };
  }),
  T("expected_frequency", "integer", (r) => {
    const trials = r.pick([30, 60, 90, 120, 180, 240]);
    const face = r.int(1, 6);
    const answer = intAns(trials / 6);
    return {
      stem: `You roll a fair die ${trials} times. About how many ${face}s would you expect?`,
      answer,
      workedSteps: expectedFrequencySteps(trials, 1, 6, answer),
    };
  }),
  T("compound_two_dice", "integer", () => ({
    stem: "You roll two fair dice and add them. Which total comes up most often?",
    answer: intAns(7),
  })),
  T("sample_space", "integer", (r) => {
    const cases = [
      { stem: "You roll a die and flip a coin. How many different outcomes are possible in all?", answer: 12, factors: [6, 2] },
      { stem: "You flip two coins. How many different outcomes are possible?", answer: 4, factors: [2, 2] },
      { stem: "You flip three coins. How many different outcomes are possible?", answer: 8, factors: [2, 2, 2] },
      { stem: "You roll two dice. How many different outcomes (ordered pairs) are possible?", answer: 36, factors: [6, 6] },
      { stem: "A spinner has 4 equal-sized colors. You spin it and flip a coin. How many outcomes are possible in all?", answer: 8, factors: [4, 2] },
      { stem: "You roll a die and spin a spinner with 3 equal colors. How many outcomes are possible in all?", answer: 18, factors: [6, 3] },
    ];
    const item = r.pick(cases);
    const answer = intAns(item.answer);
    return { stem: item.stem, answer, workedSteps: sampleSpaceSteps(item.factors, answer) };
  }),

  // Statistics extension to the probability domain (grades 2–7).
  // Data-display reading.
  T("read_picture_graph", "integer", (r) => {
    const labels = ["Owls", "Hawks", "Robins"];
    const counts = labels.map(() => r.int(2, 6));
    const target = r.int(0, labels.length - 1);
    return {
      stem: `How many ${labels[target]} are shown?`,
      answer: intAns(counts[target]),
      promptVisual: makePictographPromptVisual({
        rows: labels.map((label, index) => ({ label, icons: counts[index] })),
        key: 1,
      }),
    };
  }),
  T("read_bar_graph", "multipleChoice", (r) => {
    const labels = ["Red", "Blue", "Gold", "Green"];
    const values = labels.map(() => r.int(2, 9));
    const target = r.int(0, labels.length - 1);
    const missing = r.int(0, 3) === 0;
    const visual = makeBarGraphPromptVisual({
      bars: labels.map((label, index) => ({
        label,
        value: missing && index === target ? undefined : values[index],
      })),
      scaleMax: 10,
      scaleStep: 1,
      xAxisLabel: "Color",
      yAxisLabel: "Votes",
      missingBarIndex: missing ? target : undefined,
    });
    return choiceItem(
      r,
      missing
        ? `The four categories received ${values.reduce((sum, value) => sum + value, 0)} votes altogether. Which value completes the highlighted missing bar?`
        : `How many votes did ${labels[target]} receive?`,
      String(values[target]),
      [values[target] - 1, values[target] + 1, values[target] + 2].map(String),
      visual,
    );
  }),
  T("read_line_plot", "integer", (r) => {
    const axisMin = r.int(2, 5);
    const target = axisMin + r.int(1, 3);
    const frequency = r.int(2, 5);
    const values = [
      axisMin,
      ...Array.from({ length: frequency }, () => target),
      target + 1,
      target + 2,
    ];
    return {
      stem: `How many observations are at ${target}?`,
      answer: intAns(frequency),
      promptVisual: makeLinePlotPromptVisual({
        values,
        axisMin,
        axisMax: target + 2,
        axisStep: 1,
        axisLabel: "Measurement",
      }),
    };
  }),
  T("collect_measurement_data", "multipleChoice", (r) => choiceItem(
    r,
    "Which plan creates one honest data set for comparing pencil lengths?",
    "Measure every pencil end to end in centimeters.",
    [
      "Measure some pencils in inches and others in centimeters.",
      "Measure the length of some pencils and the weight of others.",
      "Round each pencil to a different unit before recording it.",
    ],
  )),
  T("compare_graph_categories", "integer", (r) => {
    const key = r.pick([1, 2]);
    const aIcons = r.int(3, 6);
    const bIcons = r.int(1, aIcons - 1);
    return {
      stem: "How many more votes did Art receive than Music?",
      answer: intAns((aIcons - bIcons) * key),
      promptVisual: makePictographPromptVisual({
        rows: [
          { label: "Art", icons: aIcons },
          { label: "Music", icons: bIcons },
          { label: "Science", icons: r.int(2, 6) },
        ],
        key,
      }),
    };
  }),
  T("read_scaled_picture_bar_graph", "integer", (r) => {
    const key = r.pick([2, 5]);
    const target = r.int(0, 2);
    const labels = ["Cats", "Dogs", "Fish"];
    const iconCounts = labels.map(() => r.int(2, 5) + (key === 2 && r.int(0, 2) === 0 ? 0.5 : 0));
    if (r.int(0, 1) === 0) {
      return {
        stem: `How many votes does the scaled graph show for ${labels[target]}?`,
        answer: intAns(iconCounts[target] * key),
        promptVisual: makePictographPromptVisual({
          rows: labels.map((label, index) => ({ label, icons: iconCounts[index] })),
          key,
        }),
      };
    }
    const values = iconCounts.map((icons) => icons * key);
    return {
      stem: `How many votes does the scaled graph show for ${labels[target]}?`,
      answer: intAns(values[target]),
      promptVisual: makeBarGraphPromptVisual({
        bars: labels.map((label, index) => ({ label, value: values[index] })),
        scaleMax: Math.max(...values) + key,
        scaleStep: key,
        xAxisLabel: "Pet",
        yAxisLabel: "Votes",
      }),
    };
  }),
  T("read_fractional_line_plot", "integer", (r) => {
    const denominator = r.pick([2, 4] as const);
    const minNumerator = denominator * r.int(1, 3);
    const targetNumerator = minNumerator + r.int(1, denominator);
    const frequency = r.int(2, 5);
    const numerators = [
      minNumerator,
      ...Array.from({ length: frequency }, () => targetNumerator),
      targetNumerator + 1,
      targetNumerator + 2,
    ];
    const values = numerators.map((numerator) => numerator / denominator);
    return {
      stem: `How many measurements are at ${formatMeasurement(targetNumerator, denominator)}?`,
      answer: intAns(frequency),
      promptVisual: makeLinePlotPromptVisual({
        values,
        axisMin: minNumerator / denominator,
        axisMax: (targetNumerator + 2) / denominator,
        axisStep: 1 / denominator,
        fractionDenominator: denominator,
        axisLabel: "Length (inches)",
      }),
    };
  }),

  // Center and spread.
  T("statistical_question", "multipleChoice", (r) => {
    const cases = [
      {
        correct: "How many minutes do students in our class read each evening?",
        distractors: [
          "How many minutes are in one hour?",
          "What time does school begin today?",
          "How many sides does a square have?",
        ],
      },
      {
        correct: "How tall are the sunflower plants in our garden?",
        distractors: [
          "How tall is this one sunflower plant?",
          "How many centimeters are in one meter?",
          "What color is the garden gate?",
        ],
      },
    ];
    const item = r.pick(cases);
    return choiceItem(
      r,
      "Which question is statistical because it expects a range of answers?",
      item.correct,
      item.distractors,
    );
  }),
  T("ordering", "multipleChoice", (r) => {
    const values = shuffledNumbers([r.int(2, 4), 5, 5, 7, 9], r);
    const ordered = [...values].sort((a, b) => a - b);
    const correct = ordered.join(", ");
    return choiceItem(r, `Which list orders ${values.join(", ")} from least to greatest?`, correct, [
      [...ordered].reverse().join(", "),
      ordered.filter((_, index) => index !== 2).join(", "),
      [ordered[0], ordered[2], ordered[1], ...ordered.slice(3)].join(", "),
    ]);
  }),
  T("mean", "integer", (r) => {
    const center = r.int(5, 12);
    const values = shuffledNumbers([center - 3, center - 1, center, center + 1, center + 3], r);
    const answer = intAns(center);
    return {
      stem: `Find the mean of ${values.join(", ")}.`,
      answer,
      promptVisual: integerLinePlot(values),
      workedSteps: meanSteps(values, answer),
    };
  }),
  T("mode", "integer", (r) => {
    const mode = r.int(4, 10);
    const values = shuffledNumbers([mode - 2, mode, mode, mode, mode + 1, mode + 3], r);
    return {
      stem: `Find the mode of ${values.join(", ")}.`,
      answer: intAns(mode),
      promptVisual: integerLinePlot(values),
    };
  }),
  T("median", "integer", (r) => {
    const median = r.int(5, 12);
    const values = shuffledNumbers([median - 3, median - 1, median, median + 2, median + 4], r);
    const answer = intAns(median);
    return {
      stem: `Find the median of ${values.join(", ")}.`,
      answer,
      promptVisual: integerLinePlot(values),
      workedSteps: medianSteps(values, answer),
    };
  }),
  T("range", "integer", (r) => {
    const min = r.int(2, 8);
    const range = r.int(5, 10);
    const values = shuffledNumbers([min, min + 2, min + 3, min + range - 1, min + range], r);
    const answer = intAns(range);
    return {
      stem: `Find the range of ${values.join(", ")}.`,
      answer,
      promptVisual: integerLinePlot(values),
      workedSteps: rangeSteps(values, answer),
    };
  }),
  T("mean_balance_point", "integer", (r) => {
    const mean = r.int(5, 11);
    const distance = r.int(2, 4);
    const values = [mean - distance, mean - 1, mean, mean + 1, mean + distance];
    return {
      stem: "The mean is marked. What is the total distance from the mean for the dots above it?",
      answer: intAns(distance + 1),
      promptVisual: integerLinePlot(values, { value: mean, label: "Mean" }),
    };
  }),
  T("compare_same_center_different_spread", "multipleChoice", (r) => {
    const center = r.int(6, 10);
    const tight = [center - 1, center, center, center, center + 1];
    const wide = [center - 4, center - 2, center, center + 2, center + 4];
    // Both sets are plotted as labeled series on one two-series line plot.
    // Coin-flip which set is the wide one so the correct label varies across
    // seeds — without the flip, the wide set was always "Set B" and a scholar
    // seeing the item twice could learn "pick Set B" instead of reading spread.
    const aIsTight = r.int(0, 1) === 0;
    const [setA, setB] = aIsTight ? [tight, wide] : [wide, tight];
    const correct = aIsTight ? "Set B" : "Set A";
    const otherSet = aIsTight ? "Set A" : "Set B";
    return choiceItem(
      r,
      `Set A and Set B are shown. Both means are ${center}. Which set has greater spread?`,
      correct,
      [otherSet, "They have the same spread", "Spread cannot be compared when means match"],
      integerLinePlot(setA, { value: center, label: "Mean" }, setB),
    );
  }),
  T("typical_distance_from_fair_share", "integer", (r) => {
    const mean = r.int(5, 12);
    const distance = r.int(2, 4);
    const values = [mean - distance, mean - distance, mean + distance, mean + distance];
    return {
      stem: "The mean is marked. What is the mean absolute distance of the dots from the mean?",
      answer: intAns(distance),
      promptVisual: integerLinePlot(values, { value: mean, label: "Mean" }),
    };
  }),
  T("outlier_effect_on_mean_median", "integer", (r) => {
    const center = r.int(5, 10);
    const outlier = center + 10;
    const values = [center - 1, center, center, center + 1, outlier];
    const askMean = r.int(0, 1) === 0;
    return {
      stem: `The data were ${center - 1}, ${center}, ${center}, ${center + 1}. After the outlier ${outlier} is added, what is the new ${askMean ? "mean" : "median"}?`,
      answer: intAns(askMean ? center + 2 : center),
      promptVisual: integerLinePlot(values),
    };
  }),

  // Geometry & measurement (grades 1–6)
  // Measurement & data — length, time, money, liquid volume (grades 1–3).
  // Units stay in the STEM and the answers are bare numbers, except the three
  // centimetre families: `UnitKey` (lib/practice/answers.ts) covers cm/m/deg
  // and their powers, and widening that closed union for minutes, cents, cups
  // and inches would change answer PARSING for every domain (a "min" alias sits
  // uncomfortably close to the existing "m"). Not worth it to decorate a stem.
  T("length_iterate_units", "integer", (r) => {
    const first = r.int(3, 7);
    const rest = r.int(2, 5);
    const unit = r.pick(["paper clips", "cubes", "tiles"]);
    return {
      stem: `Maya measures a leaf with ${unit} laid end to end, no gaps and no overlaps. She lays down ${first} ${unit}, then ${rest} more to reach the end. How many ${unit} long is the leaf?`,
      answer: intAns(first + rest),
    };
  }),
  T("measure_with_ruler", "integer", (r) => {
    const length = r.int(3, 14);
    return {
      stem: `A pencil is lined up with the 0 mark on a centimeter ruler. Its other end reaches the ${length} mark. How long is the pencil?`,
      answer: intAns(length),
    };
  }, "cm"),
  T("measure_from_nonzero", "integer", (r) => {
    // The whole point: the end mark is NOT the length. The start is always
    // non-zero, and the two numbers are far enough apart that the difference
    // can't coincide with the end mark.
    const start = r.int(2, 6);
    const length = r.int(3, 9);
    return {
      stem: `A crayon lies on a centimeter ruler. It starts at the ${start} mark and ends at the ${start + length} mark. How long is the crayon?`,
      answer: intAns(length),
    };
  }, "cm"),
  T("compare_lengths_difference", "integer", (r) => {
    const shorter = r.int(4, 15);
    const gap = r.int(2, 9);
    return {
      stem: `A ribbon is ${shorter + gap} centimeters long and a string is ${shorter} centimeters long. How much longer is the ribbon?`,
      answer: intAns(gap),
    };
  }, "cm"),
  T("measure_half_quarter_inch", "fraction", (r) => {
    const whole = r.int(1, 5);
    // Quarter marks only — a whole number would make the sub-unit reading moot.
    const quarters = r.pick([1, 2, 3]);
    const name = quarters === 2 ? "one half" : `${quarters} quarter${quarters === 1 ? "" : "s"}`;
    // A FRACTION, not a decimal. 3.MD.B.4 is about reading halves and fourths
    // off a ruler; demanding "2.75" additionally tests decimal notation this
    // node does not claim, and marks a child who writes 2 3/4 — the
    // mathematically natural form, and correct — wrong.
    return {
      stem: `A ribbon on an inch ruler starts at 0 and ends ${name} of an inch past the ${whole} mark. How many inches long is it?`,
      answer: fracAns(whole * 4 + quarters, 4),
    };
  }),
  T("tell_time_hour_half_hour", "multipleChoice", (r) => {
    const hour = r.int(1, 12);
    // The classic error is reading the minute hand's NUMERAL as the minutes —
    // "the minute hand is on the 6" becoming 6 minutes rather than 30.
    return choiceItem(
      r,
      `The hour hand is halfway between the ${hour} and the ${hour === 12 ? 1 : hour + 1}, and the minute hand points straight at the 6. What time is it?`,
      `${hour}:30`,
      [`${hour === 12 ? 1 : hour + 1}:30`, `${hour}:06`, `${hour}:00`],
    );
  }),
  T("tell_time_five_minutes", "multipleChoice", (r) => {
    const hour = r.int(1, 12);
    // Never the same as the hour: the swapped-hands distractor below would then
    // be identical to the correct answer.
    const numeral = r.pick([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].filter((n) => n !== hour));
    const minutes = numeral * 5;
    const mm = String(minutes).padStart(2, "0");
    return choiceItem(
      r,
      `The minute hand points straight at the ${numeral}, and the hour hand is between the ${hour} and the ${hour === 12 ? 1 : hour + 1}. What time is it?`,
      `${hour}:${mm}`,
      [
        // Reading the numeral itself as the minute count.
        `${hour}:${String(numeral).padStart(2, "0")}`,
        // Rounding the hour hand up to the numeral it is approaching.
        `${hour === 12 ? 1 : hour + 1}:${mm}`,
        // Swapping the hands. `hour % 12` keeps this a REAL time: at hour 12
        // the raw `hour * 5` renders ":60", which a child eliminates on sight
        // and which teaches that impossible readings are wrong for the wrong
        // reason.
        `${numeral}:${String((hour % 12) * 5).padStart(2, "0")}`,
      ],
    );
  }),
  T("tell_time_to_minute", "multipleChoice", (r) => {
    const hour = r.int(1, 12);
    const numeral = r.int(1, 10);
    const ticks = r.int(1, 4);
    const minutes = numeral * 5 + ticks;
    const mm = String(minutes).padStart(2, "0");
    return choiceItem(
      r,
      `The hour hand is between the ${hour} and the ${hour === 12 ? 1 : hour + 1}. The minute hand is ${ticks} tick${ticks === 1 ? "" : "s"} past the ${numeral}. What time is it?`,
      `${hour}:${mm}`,
      [
        // Ignoring the extra ticks and reading only the labelled five.
        `${hour}:${String(numeral * 5).padStart(2, "0")}`,
        // Reading the minute hand as the NEXT labelled numeral.
        `${hour}:${String((numeral + 1) * 5).padStart(2, "0")}`,
        `${hour === 12 ? 1 : hour + 1}:${mm}`,
      ],
    );
  }),
  T("elapsed_time_minutes", "multipleChoice", (r) => {
    const hour = r.int(1, 11);
    const startMin = r.int(7, 11) * 5; // 35..55
    // Sized so the jump ALWAYS lands past the hour (total 65..90). Crossing is
    // the whole skill, and without it every distractor below collapses onto the
    // correct answer — 7:40 + 15 = 7:55 needs no carry at all.
    const jump = 60 - startMin + r.int(1, 6) * 5;
    const total = startMin + jump;
    const endMin = total - 60;
    const fmt = (h: number, m: number) => `${((h - 1) % 12) + 1}:${String(m).padStart(2, "0")}`;
    return choiceItem(
      r,
      `It is ${fmt(hour, startMin)}. What time will it be in ${jump} minutes?`,
      fmt(hour + 1, endMin),
      [
        // Carried the minutes but forgot to advance the hour.
        fmt(hour, endMin),
        // Advanced the hour twice.
        fmt(hour + 2, endMin),
        // Counted the jump backwards from the start instead of forwards.
        fmt(hour, startMin - jump < 0 ? startMin - jump + 60 : startMin - jump),
      ],
    );
  }),
  T("coin_values", "integer", (r) => {
    // Exactly the four coins the node's label and 2.MD.C.8 name — no half
    // dollar, which the node does not claim and a grade-2 scholar may never
    // have handled.
    const coin = r.pick([
      { name: "penny", cents: 1 },
      { name: "nickel", cents: 5 },
      { name: "dime", cents: 10 },
      { name: "quarter", cents: 25 },
    ]);
    return {
      stem: `How many cents is one ${coin.name} worth?`,
      answer: intAns(coin.cents),
    };
  }),
  T("count_mixed_coins", "integer", (r) => {
    const quarters = r.int(0, 3);
    const dimes = r.int(0, 4);
    const nickels = r.int(0, 3);
    const pennies = r.int(1, 4);
    const parts = [
      quarters ? `${quarters} quarter${quarters === 1 ? "" : "s"}` : null,
      dimes ? `${dimes} dime${dimes === 1 ? "" : "s"}` : null,
      nickels ? `${nickels} nickel${nickels === 1 ? "" : "s"}` : null,
      `${pennies} penn${pennies === 1 ? "y" : "ies"}`,
    ].filter(Boolean);
    return {
      stem: `A pocket holds ${parts.join(", ")}. How many cents is that altogether?`,
      answer: intAns(quarters * 25 + dimes * 10 + nickels * 5 + pennies),
    };
  }),
  T("make_amount_with_coins", "integer", (r) => {
    const cents = r.int(6, 99);
    // Greedy IS optimal over the full US set {1,5,10,25}, which is the bank the
    // stem names — so this stays a deterministic template rather than needing
    // the manipulative's bounded coin-change table.
    let left = cents;
    let coins = 0;
    for (const value of [25, 10, 5, 1]) {
      coins += Math.floor(left / value);
      left %= value;
    }
    return {
      stem: `Using quarters, dimes, nickels and pennies, what is the FEWEST number of coins that make ${cents}¢?`,
      answer: intAns(coins),
    };
  }),
  T("liquid_volume_measure", "integer", (r) => {
    const step = r.pick([50, 100, 200]);
    const marks = r.int(2, 8);
    return {
      stem: `A beaker is marked every ${step} milliliters, starting from 0 at the bottom. The water level sits exactly on the ${marks}${marks === 1 ? "st" : marks === 2 ? "nd" : marks === 3 ? "rd" : "th"} mark above 0. How many milliliters of water are in the beaker?`,
      answer: intAns(step * marks),
    };
  }),
  T("liquid_volume_combine", "integer", (r) => {
    const a = r.int(2, 9);
    const b = r.int(2, 9);
    return {
      stem: `One jug holds ${a} liters of water and another holds ${b} liters. How many liters is that altogether?`,
      answer: intAns(a + b),
    };
  }),

  // Area and perimeter.
  T("partition_rectangles_rows_cols", "integer", (r) => {
    const rows = r.int(2, 6);
    const cols = r.int(2, 8);
    return {
      stem: `The rectangle is partitioned into ${rows} equal rows and ${cols} equal columns. How many same-size squares does it contain?`,
      answer: intAns(rows * cols),
      variant: { a: rows, op: "×", b: cols },
      promptVisual: makeLabeledRectanglePromptVisual({
        width: cols,
        height: rows,
        unit: "",
        showUnitGrid: true,
      }),
    };
  }),
  T("area_unit_squares", "integer", (r) => {
    const width = r.int(3, 9);
    const height = r.int(2, 7);
    return {
      stem: "Each small square is 1 square unit. What is the rectangle's area?",
      answer: intAns(width * height),
      variant: { a: width, op: "×", b: height },
      promptVisual: makeLabeledRectanglePromptVisual({
        width,
        height,
        unit: "units",
        showUnitGrid: true,
      }),
    };
  }),
  T("perimeter_polygons", "integer", (r) => {
    const width = r.int(4, 14);
    const height = r.int(3, 11);
    return {
      stem: "What is the perimeter of this polygon, in centimeters?",
      answer: intAns(2 * (width + height)),
      variant: { a: 2, op: "×", b: width + height },
      promptVisual: makeLabeledRectanglePromptVisual({
        width,
        height,
        unit: "cm",
        showUnitGrid: false,
      }),
    };
  }, "cm"),
  T("area_rectangle", "integer", (r) => {
    const width = r.int(4, 12);
    const height = r.int(3, 10);
    return {
      stem: "What is the area of this rectangle, in square centimeters?",
      answer: intAns(width * height),
      variant: { a: width, op: "×", b: height },
      promptVisual: makeLabeledRectanglePromptVisual({
        width,
        height,
        unit: "cm",
        showUnitGrid: r.int(0, 1) === 0,
      }),
    };
  }, "cm^2"),
  T("area_distributive", "integer", (r) => {
    const height = r.int(3, 9);
    const leftWidth = r.int(2, 6);
    const rightWidth = r.int(2, 6);
    const width = leftWidth + rightWidth;
    return {
      stem: `The ${width} cm side is split into ${leftWidth} cm and ${rightWidth} cm. Use the two smaller rectangles to find the total area.`,
      answer: intAns(height * width),
      variant: { a: height, op: "×", b: width },
      promptVisual: makeLabeledRectanglePromptVisual({
        width,
        height,
        unit: "cm",
        showUnitGrid: true,
      }),
    };
  }, "cm^2"),
  T("area_rectilinear_decompose", "integer", (r) => {
    const fullWidth = r.int(6, 10);
    const fullHeight = r.int(5, 9);
    const leftWidth = r.int(2, fullWidth - 2);
    const topHeight = r.int(2, fullHeight - 2);
    const topArea = fullWidth * topHeight;
    const lowerArea = leftWidth * (fullHeight - topHeight);
    return {
      stem: "Decompose the L-shaped figure into two rectangles. What is its area in square centimeters?",
      answer: intAns(topArea + lowerArea),
      variant: { a: topArea, op: "+", b: lowerArea },
      promptVisual: lShapePromptVisual(fullWidth, fullHeight, leftWidth, topHeight, "cm"),
    };
  }, "cm^2"),
  T("area_perimeter_relationship", "multipleChoice", (r) => {
    const firstWidth = r.int(2, 5);
    const firstHeight = r.int(firstWidth + 3, firstWidth + 8);
    const halfPerimeter = firstWidth + firstHeight;
    const secondWidth = firstWidth + 1;
    const secondHeight = halfPerimeter - secondWidth;
    return choiceItem(
      r,
      `Rectangle A is ${firstWidth} cm by ${firstHeight} cm. Rectangle B is ${secondWidth} cm by ${secondHeight} cm. Which statement is true?`,
      "They have the same perimeter but different areas.",
      [
        "They have the same area but different perimeters.",
        "They have both the same area and the same perimeter.",
        "They have different areas and different perimeters.",
      ],
    );
  }),
  T("perimeter_composite", "integer", (r) => {
    const fullWidth = r.int(7, 12);
    const fullHeight = r.int(6, 10);
    const leftWidth = r.int(2, fullWidth - 3);
    const topHeight = r.int(2, fullHeight - 3);
    return {
      stem: "Some inner sides are unlabeled. Infer them, then find the L-shaped figure's perimeter in centimeters.",
      answer: intAns(2 * (fullWidth + fullHeight)),
      promptVisual: lShapePromptVisual(fullWidth, fullHeight, leftWidth, topHeight, "cm"),
    };
  }, "cm"),
  T("area_perimeter_unknown_side", "integer", (r) => {
    const width = r.int(4, 12);
    const height = r.int(3, 10);
    const useArea = r.int(0, 1) === 0;
    const total = useArea ? width * height : 2 * (width + height);
    return {
      stem: `The rectangle's ${useArea ? "area" : "perimeter"} is ${total} ${useArea ? "cm²" : "cm"}, and its labeled side is ${width} cm. What is the unlabeled side length?`,
      answer: intAns(height),
      promptVisual: makeCompositeRectilinearPromptVisual({
        rects: [{ x: 0, y: 0, width, height }],
        sideLabels: [
          { x1: 0, y1: 0, x2: width, y2: 0, label: `${width} cm` },
          { x1: 0, y1: height, x2: 0, y2: 0 },
        ],
      }),
    };
  }, "cm"),
  T("area_word_problems", "integer", (r) => {
    const width = r.int(8, 18);
    const height = r.int(5, 13);
    const gate = r.int(1, Math.min(4, width - 1));
    const perimeter = 2 * (width + height);
    return {
      stem: `A ${width} m by ${height} m garden needs fencing around its edge except for a ${gate} m gate. How many meters of fencing are needed?`,
      answer: intAns(perimeter - gate),
      variant: { a: perimeter, op: "−", b: gate },
      promptVisual: makeLabeledRectanglePromptVisual({
        width,
        height,
        unit: "m",
        showUnitGrid: false,
      }),
    };
  }),
  T("same_perimeter_optimize", "multipleChoice", (r) => {
    const halfPerimeter = r.int(10, 18);
    const pairs = [
      [1, halfPerimeter - 1],
      [2, halfPerimeter - 2],
      [4, halfPerimeter - 4],
      [Math.floor(halfPerimeter / 2), Math.ceil(halfPerimeter / 2)],
    ];
    const best = pairs[pairs.length - 1];
    const correct = `${best[0]} cm × ${best[1]} cm`;
    return choiceItem(
      r,
      `Each rectangle below has perimeter ${halfPerimeter * 2} cm. Which has the greatest area?`,
      correct,
      pairs.slice(0, -1).map(([width, height]) => `${width} cm × ${height} cm`),
    );
  }),
  T("area_fraction_side", "decimal", (r) => {
    // Same ≤2-decimal-place discipline as volume_fractional_edges below: the
    // old halves × quarters pairing put 3 decimal places in most answers
    // (e.g. 0.5 × 0.75 = 0.375). Quarters now only pair with whole numbers;
    // halves may pair with halves (their product is a quarter-multiple).
    const quarterSide = r.int(0, 1) === 0;
    const [width, height] = quarterSide
      ? [r.int(2, 6), r.pick([0.25, 0.75, 1.25])]
      : [r.pick([1.5, 2.5, 3.5]), r.pick([0.5, 1.5, 2.5])];
    return {
      stem: "What is the area of this rectangle, in square meters?",
      answer: decAns(width * height),
      promptVisual: makeLabeledRectanglePromptVisual({
        width,
        height,
        unit: "m",
        showUnitGrid: false,
      }),
    };
  }, "m^2"),
  T("area_parallelogram", "integer", (r) => {
    const base = r.int(6, 14);
    const height = r.int(3, 9);
    const offset = r.int(1, 4);
    return {
      stem: `The parallelogram has base ${base} units and perpendicular height ${height} units. What is its area?`,
      answer: intAns(base * height),
      variant: { a: base, op: "×", b: height },
      promptVisual: coordinatePromptVisual([
        { x: 0, y: 0, label: "A" },
        { x: base, y: 0, label: "B" },
        { x: base + offset, y: height, label: "C" },
        { x: offset, y: height, label: "D" },
      ], "polygon"),
    };
  }),
  T("area_triangle", "integer", (r) => {
    const base = r.int(4, 9) * 2;
    const height = r.int(3, 10);
    const offset = r.int(-2, 5);
    return {
      stem: `The triangle has base ${base} units and perpendicular height ${height} units. What is its area?`,
      answer: intAns((base * height) / 2),
      promptVisual: coordinatePromptVisual([
        { x: 0, y: 0, label: "A" },
        { x: base, y: 0, label: "B" },
        { x: offset, y: height, label: "C" },
      ], "polygon"),
    };
  }),
  T("area_trapezoid", "integer", (r) => {
    const topBase = r.int(3, 8);
    const bottomBase = topBase + r.pick([2, 4, 6]);
    const height = r.int(3, 9);
    const inset = r.int(1, bottomBase - topBase - 1);
    return {
      stem: `The parallel bases are ${topBase} and ${bottomBase} units, and the height is ${height} units. Find the trapezoid's area by decomposing it.`,
      answer: intAns(((topBase + bottomBase) * height) / 2),
      promptVisual: coordinatePromptVisual([
        { x: 0, y: 0, label: "A" },
        { x: bottomBase, y: 0, label: "B" },
        { x: inset + topBase, y: height, label: "C" },
        { x: inset, y: height, label: "D" },
      ], "polygon"),
    };
  }),
  T("area_composite_polygons", "integer", (r) => {
    const fullWidth = r.int(7, 12);
    const fullHeight = r.int(6, 11);
    const cutWidth = r.int(2, fullWidth - 3);
    const cutHeight = r.int(2, fullHeight - 3);
    return {
      stem: "The plotted polygon is a rectangle with a rectangular corner removed. What is its area in square units?",
      answer: intAns(fullWidth * fullHeight - cutWidth * cutHeight),
      promptVisual: coordinatePromptVisual([
        { x: 0, y: 0, label: "A" },
        { x: fullWidth, y: 0, label: "B" },
        { x: fullWidth, y: fullHeight - cutHeight, label: "C" },
        { x: fullWidth - cutWidth, y: fullHeight - cutHeight, label: "D" },
        { x: fullWidth - cutWidth, y: fullHeight, label: "E" },
        { x: 0, y: fullHeight, label: "F" },
      ], "polygon"),
    };
  }),

  // Volume, nets, and surface area.
  T("volume_unit_cubes", "integer", (r) => {
    const length = r.int(2, 6);
    const width = r.int(2, 5);
    const height = r.int(2, 5);
    return {
      stem: "The prism is completely packed with unit cubes. How many cubes fill it?",
      answer: intAns(length * width * height),
      variant: { a: length * width, op: "×", b: height },
      promptVisual: makeRectangularPrismPromptVisual({
        length,
        width,
        height,
        unit: "units",
        showUnitCubes: true,
      }),
    };
  }),
  T("volume_by_layers", "integer", (r) => {
    const length = r.int(3, 8);
    const width = r.int(2, 6);
    const height = r.int(2, 7);
    const layer = length * width;
    return {
      stem: `Each horizontal layer contains ${layer} unit cubes, and the prism has ${height} equal layers. What is its volume?`,
      answer: intAns(layer * height),
      variant: { a: layer, op: "×", b: height },
      promptVisual: makeRectangularPrismPromptVisual({
        length,
        width,
        height,
        unit: "units",
        showUnitCubes: true,
      }),
    };
  }),
  T("volume_conservation", "multipleChoice", (r) => {
    const cubes = r.int(12, 48);
    return choiceItem(
      r,
      `${cubes} unit cubes are rearranged into a different solid with no cubes added, removed, overlapped, or cut. Which statement must be true?`,
      `The new solid's volume is still ${cubes} cubic units.`,
      [
        "The new solid must have the same surface area.",
        "The new solid must have the same length and width.",
        `The new solid's volume is ${cubes * 2} cubic units.`,
      ],
    );
  }),
  T("volume_rectangular_prism", "integer", (r) => {
    const length = r.int(5, 12);
    const width = r.int(3, 9);
    const height = r.int(2, 8);
    const baseArea = length * width;
    return {
      stem: "Find the rectangular prism's volume in cubic centimeters.",
      answer: intAns(baseArea * height),
      variant: { a: baseArea, op: "×", b: height },
      promptVisual: makeRectangularPrismPromptVisual({
        length,
        width,
        height,
        unit: "cm",
        showUnitCubes: false,
      }),
    };
  }, "cm^3"),
  T("volume_composite_prisms", "integer", (r) => {
    const leftLength = r.int(3, 7);
    const rightLength = r.int(3, 7);
    const depth = r.int(2, 6);
    const leftHeight = r.int(2, 7);
    let rightHeight = r.int(2, 7);
    if (rightHeight === leftHeight) rightHeight = rightHeight === 7 ? 6 : rightHeight + 1;
    const maxHeight = Math.max(leftHeight, rightHeight);
    const firstVolume = leftLength * depth * leftHeight;
    const secondVolume = rightLength * depth * rightHeight;
    return {
      stem: `The side profile shows two joined rectangular prisms with constant depth ${depth} cm. What is the composite solid's volume?`,
      answer: intAns(firstVolume + secondVolume),
      variant: { a: firstVolume, op: "+", b: secondVolume },
      promptVisual: makeCompositeRectilinearPromptVisual({
        rects: [
          {
            x: 0,
            y: maxHeight - leftHeight,
            width: leftLength,
            height: leftHeight,
          },
          {
            x: leftLength,
            y: maxHeight - rightHeight,
            width: rightLength,
            height: rightHeight,
          },
        ],
        sideLabels: [
          {
            x1: 0,
            y1: maxHeight,
            x2: leftLength,
            y2: maxHeight,
            label: `${leftLength} cm`,
          },
          {
            x1: leftLength,
            y1: maxHeight,
            x2: leftLength + rightLength,
            y2: maxHeight,
            label: `${rightLength} cm`,
          },
          {
            x1: 0,
            y1: maxHeight,
            x2: 0,
            y2: maxHeight - leftHeight,
            label: `${leftHeight} cm`,
          },
          {
            x1: leftLength + rightLength,
            y1: maxHeight,
            x2: leftLength + rightLength,
            y2: maxHeight - rightHeight,
            label: `${rightHeight} cm`,
          },
        ],
      }),
    };
  }, "cm^3"),
  T("volume_unknown_dimension", "integer", (r) => {
    const length = r.int(4, 12);
    const width = r.int(3, 9);
    const height = r.int(2, 10);
    const volume = length * width * height;
    return {
      stem: `A rectangular prism has volume ${volume} cm³, length ${length} cm, and width ${width} cm. What is its height?`,
      answer: intAns(height),
    };
  }, "cm"),
  T("volume_fractional_edges", "decimal", (r) => {
    // Answers stay within 2 decimal places by construction. The construct is
    // extending V = l×w×h to fractional edges — NOT multi-factor decimal
    // multiplication (a skill the graph has no node for). The old all-fractional
    // dims (halves × halves × quarters) made every variant a 3–4-decimal-place
    // gauntlet (e.g. 3.5 × 2.5 × 0.75 = 6.5625), so a computation slip read as
    // a conceptual miss in placement. Two shapes, both capped at 2 places:
    //   • one fractional edge:   int × int × quarter-multiple
    //   • two fractional edges:  half × half × int (halves multiply to quarters)
    const oneFractionalEdge = r.int(0, 1) === 0;
    const [length, width, height] = oneFractionalEdge
      ? [r.int(3, 6), r.int(2, 4), r.pick([0.25, 0.5, 0.75, 1.25, 1.5])]
      : [r.pick([1.5, 2.5, 3.5]), r.pick([1.5, 2.5]), r.int(2, 5)];
    return {
      stem: "What is the rectangular prism's volume in cubic meters?",
      answer: decAns(length * width * height),
      promptVisual: makeRectangularPrismPromptVisual({
        length,
        width,
        height,
        unit: "m",
        showUnitCubes: false,
      }),
    };
  }, "m^3"),
  T("nets_of_solids", "multipleChoice", (r) => {
    const length = r.int(6, 10);
    const width = r.int(3, 5);
    let height = r.int(2, 5);
    if (height === width) height = 2;
    const correct = `Two ${length}×${width}, two ${length}×${height}, and two ${width}×${height} rectangles`;
    return choiceItem(
      r,
      "Unfold this rectangular prism into a net. Which set of rectangles is the net made of?",
      correct,
      [
        `One ${length}×${width}, one ${length}×${height}, and one ${width}×${height} rectangle`,
        `Six ${length}×${width} rectangles`,
        `Two ${length}×${width} and four ${length}×${height} rectangles`,
      ],
      makeRectangularPrismPromptVisual({
        length,
        width,
        height,
        unit: "cm",
        showUnitCubes: false,
      }),
    );
  }),
  T("surface_area_nets", "integer", (r) => {
    const length = r.int(5, 12);
    const width = r.int(3, 9);
    const height = r.int(2, 8);
    return {
      stem: "Imagine unfolding this prism into its six rectangular faces. What is its total surface area in square centimeters?",
      answer: intAns(2 * (length * width + length * height + width * height)),
      promptVisual: makeRectangularPrismPromptVisual({
        length,
        width,
        height,
        unit: "cm",
        showUnitCubes: false,
      }),
    };
  }, "cm^2"),

  // Angles and shape classification.
  T("angle_concept", "multipleChoice", (r) => {
    const degrees = r.int(25, 155);
    return choiceItem(
      r,
      "Which description best matches the figure?",
      "Two rays share an endpoint, and the opening shows an amount of turn.",
      [
        "Two unrelated line segments show a distance.",
        "One ray has two different endpoints.",
        "The marked point alone is the angle.",
      ],
      makeAngleFigurePromptVisual({
        degrees,
        orientation: r.int(185, 235),
      }),
    );
  }),
  T("angle_turns_circle", "integer", (r) => {
    const degrees = r.pick([45, 60, 90, 120, 180]);
    return {
      stem: `This angle is ${degrees}/360 of a full turn. How many degrees is it?`,
      answer: intAns(degrees),
      promptVisual: makeAngleFigurePromptVisual({
        degrees,
        orientation: r.int(180, 240),
        label: `${degrees}/360 turn`,
      }),
    };
  }, "deg"),
  T("angle_measure_protractor", "integer", (r) => {
    const degrees = r.int(2, 35) * 5;
    return {
      stem: "A protractor is centered on the vertex and aligned with the first ray. What is the angle's measure in degrees?",
      answer: intAns(degrees),
      promptVisual: makeAngleFigurePromptVisual({
        degrees,
        orientation: r.int(185, 235),
        label: "?",
        showProtractorScale: true,
      }),
    };
  }, "deg"),
  T("benchmark_angles", "multipleChoice", (r) => {
    const degrees = r.pick([25, 40, 65, 80, 105, 125, 150, 170]);
    return choiceItem(
      r,
      "Without measuring, which is the best estimate for this angle?",
      `${degrees}°`,
      [`${Math.max(5, degrees - 30)}°`, `${Math.min(180, degrees + 30)}°`, `${180 - degrees}°`],
      makeAngleFigurePromptVisual({
        degrees,
        orientation: r.int(185, 235),
      }),
    );
  }),
  T("angle_classification", "multipleChoice", (r) => {
    const item = r.pick([
      { degrees: r.int(20, 80), type: "Acute" },
      { degrees: 90, type: "Right" },
      { degrees: r.int(100, 170), type: "Obtuse" },
      { degrees: 180, type: "Straight" },
    ]);
    return choiceItem(
      r,
      "How should this angle be classified?",
      item.type,
      ["Acute", "Right", "Obtuse", "Straight"].filter((type) => type !== item.type),
      makeAngleFigurePromptVisual({
        degrees: item.degrees,
        orientation: r.int(180, 230),
      }),
    );
  }),
  T("parallel_perpendicular_lines", "multipleChoice", (r) => {
    const width = r.int(5, 10);
    const height = r.int(3, 8);
    const parallel = r.int(0, 1) === 0;
    return choiceItem(
      r,
      `In the plotted rectangle, line segments ${parallel ? "AB and CD" : "AB and BC"} are:`,
      parallel ? "Parallel" : "Perpendicular",
      parallel ? ["Perpendicular", "Neither"] : ["Parallel", "Neither"],
      coordinatePromptVisual([
        { x: 0, y: 0, label: "A" },
        { x: width, y: 0, label: "B" },
        { x: width, y: height, label: "C" },
        { x: 0, y: height, label: "D" },
      ], "polygon"),
    );
  }),
  T("angle_additivity", "integer", (r) => {
    const known = r.int(20, 90);
    const missing = r.int(15, Math.min(80, 175 - known));
    const total = known + missing;
    return {
      stem: `The whole angle is ${total}°. One adjacent part is ${known}°. What is the missing part?`,
      answer: intAns(missing),
      variant: { a: known, op: "+", b: missing },
      promptVisual: makeAngleFigurePromptVisual({
        degrees: total,
        orientation: r.int(185, 225),
        label: `${total}°`,
        parts: [
          { degrees: known, label: `${known}°` },
          { degrees: missing },
        ],
      }),
    };
  }, "deg"),
  T("classify_triangles_sides", "multipleChoice", (r) => {
    const item = r.pick([
      {
        type: "Equilateral",
        sides: "4, 4, and 4 units",
        points: [
          { x: 0, y: 0, label: "A" },
          { x: 4, y: 0, label: "B" },
          { x: 2, y: 3.464, label: "C" },
        ],
      },
      {
        type: "Isosceles",
        sides: "5, 5, and 6 units",
        points: [
          { x: 0, y: 0, label: "A" },
          { x: 6, y: 0, label: "B" },
          { x: 3, y: 4, label: "C" },
        ],
      },
      {
        type: "Scalene",
        sides: "3, 4, and 5 units",
        points: [
          { x: 0, y: 0, label: "A" },
          { x: 4, y: 0, label: "B" },
          { x: 0, y: 3, label: "C" },
        ],
      },
    ]);
    return choiceItem(
      r,
      `The plotted triangle has side lengths ${item.sides}. Classify it by side length.`,
      item.type,
      ["Equilateral", "Isosceles", "Scalene"].filter((type) => type !== item.type),
      coordinatePromptVisual(item.points, "polygon"),
    );
  }),
  T("classify_triangles_angles", "multipleChoice", (r) => {
    const item = r.pick([
      {
        type: "Acute",
        angles: "53°, 53°, and 74°",
        points: [
          { x: 0, y: 0, label: "A" },
          { x: 6, y: 0, label: "B" },
          { x: 3, y: 4, label: "C" },
        ],
      },
      {
        type: "Right",
        angles: "37°, 53°, and 90°",
        points: [
          { x: 0, y: 0, label: "A" },
          { x: 4, y: 0, label: "B" },
          { x: 0, y: 3, label: "C" },
        ],
      },
      {
        type: "Obtuse",
        angles: "22°, 63°, and 95°",
        points: [
          { x: 0, y: 0, label: "A" },
          { x: 6, y: 0, label: "B" },
          { x: 1, y: 2, label: "C" },
        ],
      },
    ]);
    return choiceItem(
      r,
      `The plotted triangle's angles are ${item.angles}. Classify it by angle.`,
      item.type,
      ["Acute", "Right", "Obtuse"].filter((type) => type !== item.type),
      coordinatePromptVisual(item.points, "polygon"),
    );
  }),
  T("classify_quadrilaterals", "multipleChoice", (r) => {
    const item = r.pick([
      {
        type: "Square",
        points: [
          { x: 0, y: 0, label: "A" },
          { x: 4, y: 0, label: "B" },
          { x: 4, y: 4, label: "C" },
          { x: 0, y: 4, label: "D" },
        ],
      },
      {
        type: "Rectangle",
        points: [
          { x: 0, y: 0, label: "A" },
          { x: 7, y: 0, label: "B" },
          { x: 7, y: 3, label: "C" },
          { x: 0, y: 3, label: "D" },
        ],
      },
      {
        type: "Parallelogram",
        points: [
          { x: 0, y: 0, label: "A" },
          { x: 6, y: 0, label: "B" },
          { x: 8, y: 3, label: "C" },
          { x: 2, y: 3, label: "D" },
        ],
      },
      {
        type: "Trapezoid",
        points: [
          { x: 0, y: 0, label: "A" },
          { x: 8, y: 0, label: "B" },
          { x: 6, y: 3, label: "C" },
          { x: 2, y: 3, label: "D" },
        ],
      },
    ]);
    return choiceItem(
      r,
      "What is the most specific name for the plotted quadrilateral?",
      item.type,
      ["Square", "Rectangle", "Parallelogram", "Trapezoid"].filter((type) => type !== item.type),
      coordinatePromptVisual(item.points, "polygon"),
    );
  }),
  T("quadrilateral_hierarchy", "multipleChoice", (r) => {
    const item = r.pick([
      {
        correct: "Every square is also a rectangle.",
        distractors: [
          "Every rectangle is also a square.",
          "No square is a rhombus.",
          "A square has no parallel sides.",
        ],
      },
      {
        correct: "Every square is also a rhombus.",
        distractors: [
          "Every rhombus is also a square.",
          "No rectangle is a parallelogram.",
          "A rhombus cannot have right angles.",
        ],
      },
      {
        correct: "Every rectangle is also a parallelogram.",
        distractors: [
          "Every parallelogram is also a rectangle.",
          "No square is a rectangle.",
          "A rectangle has exactly one pair of parallel sides.",
        ],
      },
    ]);
    return choiceItem(r, "Which statement is always true?", item.correct, item.distractors);
  }),
  T("angle_sum_triangle", "integer", (r) => {
    const item = r.pick([
      {
        first: 90,
        second: 37,
        third: 53,
        points: [
          { x: 0, y: 0, label: "A" },
          { x: 4, y: 0, label: "B" },
          { x: 0, y: 3, label: "C" },
        ],
      },
      {
        first: 90,
        second: 45,
        third: 45,
        points: [
          { x: 0, y: 0, label: "A" },
          { x: 4, y: 0, label: "B" },
          { x: 0, y: 4, label: "C" },
        ],
      },
      {
        first: 60,
        second: 60,
        third: 60,
        points: [
          { x: 0, y: 0, label: "A" },
          { x: 4, y: 0, label: "B" },
          { x: 2, y: 3.464, label: "C" },
        ],
      },
    ]);
    return {
      stem: `Two angles in the plotted triangle measure ${item.first}° and ${item.second}°. What is the third angle?`,
      answer: intAns(item.third),
      promptVisual: coordinatePromptVisual(item.points, "polygon"),
    };
  }, "deg"),

  // Coordinate geometry and symmetry.
  T("ordered_pair_meaning", "multipleChoice", (r) => {
    const x = r.int(2, 9);
    const y = r.int(2, 9);
    return choiceItem(
      r,
      `Point P is at (${x}, ${y}). Which movement from the origin reaches P?`,
      `${x} units right, then ${y} units up`,
      [
        `${y} units right, then ${x} units up`,
        `${x} units left, then ${y} units up`,
        `${x} units right, then ${y} units down`,
      ],
      coordinatePromptVisual([{ x, y, label: "P" }], undefined, true),
    );
  }),
  T("coordinate_plane_first_quadrant", "integer", (r) => {
    const x = r.int(1, 10);
    const y = r.int(1, 10);
    const askX = r.int(0, 1) === 0;
    return {
      stem: `Read point P on the coordinate plane. What is its ${askX ? "x" : "y"}-coordinate?`,
      answer: intAns(askX ? x : y),
      promptVisual: coordinatePromptVisual([{ x, y, label: "P" }], undefined, true),
    };
  }),
  T("line_symmetry", "multipleChoice", (r) => {
    const item = r.pick([
      {
        count: "4",
        points: [
          { x: 0, y: 0, label: "A" },
          { x: 4, y: 0, label: "B" },
          { x: 4, y: 4, label: "C" },
          { x: 0, y: 4, label: "D" },
        ],
      },
      {
        count: "2",
        points: [
          { x: 0, y: 0, label: "A" },
          { x: 7, y: 0, label: "B" },
          { x: 7, y: 3, label: "C" },
          { x: 0, y: 3, label: "D" },
        ],
      },
      {
        count: "1",
        points: [
          { x: 0, y: 0, label: "A" },
          { x: 6, y: 0, label: "B" },
          { x: 3, y: 4, label: "C" },
        ],
      },
      {
        count: "0",
        points: [
          { x: 0, y: 0, label: "A" },
          { x: 6, y: 0, label: "B" },
          { x: 1, y: 3, label: "C" },
        ],
      },
    ]);
    return choiceItem(
      r,
      "How many lines of symmetry does the plotted figure have?",
      item.count,
      ["0", "1", "2", "4"].filter((count) => count !== item.count),
      coordinatePromptVisual(item.points, "polygon"),
    );
  }),
  T("four_quadrant_plane", "integer", (r) => {
    const x = r.int(-9, 9) || -4;
    const y = r.int(-9, 9) || 5;
    const askX = r.int(0, 1) === 0;
    return {
      stem: `Read point Q on the four-quadrant plane. What is its ${askX ? "x" : "y"}-coordinate?`,
      answer: intAns(askX ? x : y),
      promptVisual: coordinatePromptVisual([{ x, y, label: "Q" }]),
    };
  }),
  T("reflect_across_axis", "integer", (r) => {
    const x = r.int(-9, 9) || 4;
    const y = r.int(-9, 9) || -5;
    const acrossX = r.int(0, 1) === 0;
    return {
      stem: acrossX
        ? `Point P is reflected across the x-axis. What is the reflected point's y-coordinate?`
        : `Point P is reflected across the y-axis. What is the reflected point's x-coordinate?`,
      answer: intAns(acrossX ? -y : -x),
      promptVisual: coordinatePromptVisual([{ x, y, label: "P" }]),
    };
  }),
  T("coordinate_distance", "integer", (r) => {
    const horizontal = r.int(0, 1) === 0;
    const low = r.int(-9, -1);
    const high = r.int(2, 10);
    const fixed = r.int(-7, 7);
    return {
      stem: `What is the distance between points A and B, in units?`,
      answer: intAns(high - low),
      variant: { a: high, op: "+", b: -low },
      promptVisual: coordinatePromptVisual(horizontal
        ? [
            { x: low, y: fixed, label: "A" },
            { x: high, y: fixed, label: "B" },
          ]
        : [
            { x: fixed, y: low, label: "A" },
            { x: fixed, y: high, label: "B" },
          ], "segments"),
    };
  }),
  T("coordinate_missing_vertex", "integer", (r) => {
    const left = r.int(-8, 1);
    const right = r.int(left + 3, Math.min(10, left + 10));
    const bottom = r.int(-8, 1);
    const top = r.int(bottom + 3, Math.min(10, bottom + 10));
    const askX = r.int(0, 1) === 0;
    return {
      stem: `A fourth vertex D completes the axis-aligned rectangle. What is D's ${askX ? "x" : "y"}-coordinate?`,
      answer: intAns(askX ? left : top),
      promptVisual: coordinatePromptVisual([
        { x: left, y: bottom, label: "A" },
        { x: right, y: bottom, label: "B" },
        { x: right, y: top, label: "C" },
      ], "segments"),
    };
  }),
  T("polygons_on_coordinate_plane", "integer", (r) => {
    const left = r.int(-8, 1);
    const width = r.int(4, 10);
    const bottom = r.int(-7, 2);
    const height = r.int(3, 9);
    const askHorizontal = r.int(0, 1) === 0;
    return {
      stem: `The plotted vertices form an axis-aligned rectangle. What is the length of side ${askHorizontal ? "AB" : "BC"}?`,
      answer: intAns(askHorizontal ? width : height),
      promptVisual: coordinatePromptVisual([
        { x: left, y: bottom, label: "A" },
        { x: left + width, y: bottom, label: "B" },
        { x: left + width, y: bottom + height, label: "C" },
        { x: left, y: bottom + height, label: "D" },
      ], "polygon"),
    };
  }),
  T("coordinate_perimeter_area", "integer", (r) => {
    const left = r.int(-8, 1);
    const width = r.int(4, 10);
    const bottom = r.int(-7, 2);
    const height = r.int(3, 9);
    const askArea = r.int(0, 1) === 0;
    return {
      stem: `Find the plotted rectangle's ${askArea ? "area in square units" : "perimeter in units"}.`,
      answer: intAns(askArea ? width * height : 2 * (width + height)),
      variant: askArea ? { a: width, op: "×", b: height } : undefined,
      promptVisual: coordinatePromptVisual([
        { x: left, y: bottom, label: "A" },
        { x: left + width, y: bottom, label: "B" },
        { x: left + width, y: bottom + height, label: "C" },
        { x: left, y: bottom + height, label: "D" },
      ], "polygon"),
    };
  }),

  // Ratios, rates, percent, and proportional reasoning (grades 6–7).
  T("ratio_concept_language", "multipleChoice", (r) => {
    const red = r.int(2, 9);
    let blue = r.int(2, 9);
    if (blue === red) blue = blue === 9 ? 8 : blue + 1;
    return choiceItem(
      r,
      `A mosaic uses ${red} red tiles and ${blue} blue tiles. Which statement describes the ratio of red tiles to blue tiles?`,
      `There are ${red} red tiles for every ${blue} blue tiles.`,
      [
        `There are ${blue} red tiles for every ${red} blue tiles.`,
        `There are ${red} red tiles for every ${red + blue} total tiles.`,
        `There are ${red + blue} red tiles for every ${blue} blue tiles.`,
      ],
    );
  }),
  T("ratio_forms", "multipleChoice", (r) => {
    const a = r.int(2, 9);
    let b = r.int(2, 9);
    if (b === a) b = b === 9 ? 8 : b + 1;
    return choiceItem(
      r,
      `Write the ratio "${a} to ${b}" in colon notation.`,
      `${a}:${b}`,
      [`${b}:${a}`, `${a}:${a + b}`, `${a + b}:${b}`],
    );
  }),
  T("ratio_order_matters", "multipleChoice", (r) => {
    const violins = r.int(3, 10);
    let cellos = r.int(2, 8);
    if (cellos === violins) cellos = cellos === 8 ? 7 : cellos + 1;
    return choiceItem(
      r,
      `An ensemble has ${violins} violins and ${cellos} cellos. What is the ratio of cellos to violins?`,
      `${cellos}:${violins}`,
      [`${violins}:${cellos}`, `${cellos}:${violins + cellos}`, `${violins + cellos}:${cellos}`],
    );
  }),
  T("ratio_part_part_to_whole", "multipleChoice", (r) => {
    const fiction = r.int(3, 9);
    let nonfiction = r.int(2, 8);
    if (nonfiction === fiction) nonfiction = nonfiction === 8 ? 7 : nonfiction + 1;
    const total = fiction + nonfiction;
    return choiceItem(
      r,
      `A shelf has ${fiction} fiction books and ${nonfiction} nonfiction books. What is the ratio of fiction books to all books?`,
      `${fiction}:${total}`,
      [`${fiction}:${nonfiction}`, `${nonfiction}:${total}`, `${total}:${fiction}`],
      makeAreaModelPromptVisual({ widthParts: [fiction, nonfiction], heightParts: [1] }),
    );
  }),
  T("ratio_equivalent_scale", "integer", (r) => {
    const a = r.int(2, 9);
    const b = r.int(2, 9);
    const scale = r.int(2, 8);
    return {
      stem: `${a}:${b} = ${a * scale}:?`,
      answer: intAns(b * scale),
      variant: { a: b, op: "×", b: scale },
    };
  }),
  T("ratio_reduce", "multipleChoice", (r) => {
    const [a, b] = r.pick([
      [2, 3],
      [3, 4],
      [3, 5],
      [4, 7],
      [5, 8],
      [7, 9],
    ]);
    const scale = r.int(2, 8);
    return choiceItem(
      r,
      `Reduce the ratio ${a * scale}:${b * scale} to least whole-number terms.`,
      `${a}:${b}`,
      [`${b}:${a}`, `${a}:${b * scale}`, `${a * scale}:${b}`],
    );
  }),
  T("ratio_table_complete", "integer", (r) => {
    const a = r.int(2, 8);
    const b = r.int(2, 9);
    const factor = r.int(3, 6);
    return {
      stem: `Complete the equivalent-ratio table.\nA | B\n${a} | ${b}\n${a * 2} | ${b * 2}\n${a * factor} | ?`,
      answer: intAns(b * factor),
      variant: { a: b, op: "×", b: factor },
    };
  }),
  T("ratio_double_number_line", "integer", (r) => {
    const firstStep = r.int(2, 8);
    const secondStep = r.int(2, 9);
    return {
      stem: `Two aligned scales show equivalent ratios.\nMeters: 0 | ${firstStep} | ${firstStep * 2} | ${firstStep * 3}\nSeconds: 0 | ${secondStep} | ${secondStep * 2} | ?\nWhat value belongs at the final tick?`,
      answer: intAns(secondStep * 3),
      variant: { a: secondStep, op: "×", b: 3 },
      promptVisual: makeAreaModelPromptVisual({
        widthParts: [firstStep, firstStep],
        heightParts: [secondStep, secondStep],
      }),
    };
  }),
  T("ratio_compare", "multipleChoice", (r) => {
    const firstRate = r.int(2, 8);
    let secondRate = r.int(2, 8);
    if (secondRate === firstRate) secondRate = secondRate === 8 ? 7 : secondRate + 1;
    const firstTime = r.int(2, 6);
    const secondTime = r.int(2, 6);
    const correct = firstRate > secondRate
      ? "Machine A has the greater rate."
      : "Machine B has the greater rate.";
    return choiceItem(
      r,
      `Machine A makes ${firstRate * firstTime} parts in ${firstTime} minutes. Machine B makes ${secondRate * secondTime} parts in ${secondTime} minutes. Which rate is greater?`,
      correct,
      [
        firstRate > secondRate ? "Machine B has the greater rate." : "Machine A has the greater rate.",
        "The two rates are equal.",
        "The rates cannot be compared because the times differ.",
      ],
    );
  }),
  T("rate_unit_whole_numbers", "fraction", (r) => {
    const [amount, units] = r.pick([
      [18, 12],
      [20, 8],
      [21, 6],
      [24, 10],
      [35, 14],
      [42, 12],
    ]);
    return {
      stem: `A printer produces ${amount} posters in ${units} minutes at a constant rate. How many posters does it produce per minute?`,
      answer: fracAns(amount, units),
    };
  }),
  T("rate_unit_price", "multipleChoice", (r) => {
    const unitA = r.pick([25, 30, 35, 40, 45, 50]);
    let unitB = r.pick([30, 35, 40, 45, 50, 55]);
    if (unitB === unitA) unitB += 5;
    const countA = r.int(4, 9);
    const countB = r.int(5, 10);
    const better = unitA < unitB ? "Package A" : "Package B";
    const betterUnit = Math.min(unitA, unitB);
    const worse = unitA < unitB ? "Package B" : "Package A";
    const worseUnit = Math.max(unitA, unitB);
    return choiceItem(
      r,
      `Package A has ${countA} notebooks for $${((unitA * countA) / 100).toFixed(2)}. Package B has ${countB} notebooks for $${((unitB * countB) / 100).toFixed(2)}. Which is the better buy?`,
      `${better}, at $${(betterUnit / 100).toFixed(2)} per notebook.`,
      [
        `${worse}, at $${(worseUnit / 100).toFixed(2)} per notebook.`,
        "They have the same unit price.",
        "There is not enough information because the package sizes differ.",
      ],
    );
  }),
  T("rate_constant_speed", "integer", (r) => {
    const speed = r.int(12, 45);
    const time = r.int(2, 8);
    return {
      stem: `A cyclist travels at a constant ${speed} kilometers per hour for ${time} hours. How many kilometers does the cyclist travel?`,
      answer: intAns(speed * time),
      variant: { a: speed, op: "×", b: time },
    };
  }),
  T("rate_measurement_conversion", "integer", (r) => {
    const conversion = r.pick([
      { from: "feet", fromOne: "foot", to: "inches", factor: 12 },
      { from: "minutes", fromOne: "minute", to: "seconds", factor: 60 },
      { from: "quarts", fromOne: "quart", to: "cups", factor: 4 },
      { from: "kilograms", fromOne: "kilogram", to: "grams", factor: 1000 },
    ]);
    const amount = r.int(2, 9);
    return {
      stem: `Use 1 ${conversion.fromOne} = ${conversion.factor} ${conversion.to}. Convert ${amount} ${conversion.from} to ${conversion.to}.`,
      answer: intAns(amount * conversion.factor),
      variant: { a: amount, op: "×", b: conversion.factor },
    };
  }),
  T("rate_unit_fractional_quantities", "fraction", (r) => {
    const item = r.pick([
      { amountNum: 3, amountDen: 4, timeNum: 1, timeDen: 2, unit: "mile" },
      { amountNum: 5, amountDen: 6, timeNum: 2, timeDen: 3, unit: "liter" },
      { amountNum: 7, amountDen: 8, timeNum: 1, timeDen: 4, unit: "kilogram" },
      { amountNum: 4, amountDen: 5, timeNum: 2, timeDen: 5, unit: "meter" },
    ]);
    return {
      stem: `A process uses ${item.amountNum}/${item.amountDen} ${item.unit}s in ${item.timeNum}/${item.timeDen} hour. How many ${item.unit}s does it use per hour?`,
      answer: fracAns(item.amountNum * item.timeDen, item.amountDen * item.timeNum),
    };
  }),
  T("percent_rate_per_hundred", "multipleChoice", (r) => {
    const percent = r.pick([7, 12, 18, 35, 42, 64, 85]);
    return choiceItem(
      r,
      `Which statement correctly interprets ${percent}%?`,
      `${percent} out of every 100`,
      [`${percent} out of every 10`, `100 out of every ${percent}`, `${percent} more than 100`],
      makeArrayPromptVisual({ rows: 10, cols: 10, motif: "square" }),
    );
  }),
  T("percent_fraction_decimal", "decimal", (r) => {
    const percent = r.pick([4, 8, 12, 15, 20, 25, 35, 45, 62, 75, 125]);
    return {
      stem: `Write ${percent}% as a decimal.`,
      answer: decAns(percent / 100),
    };
  }),
  T("percent_benchmark_reasoning", "multipleChoice", (r) => {
    const item = r.pick([
      { percent: 12, benchmark: 10 },
      { percent: 23, benchmark: 25 },
      { percent: 48, benchmark: 50 },
      { percent: 76, benchmark: 100 },
      { percent: 96, benchmark: 100 },
    ]);
    const quantity = r.pick([200, 400, 600, 800]);
    const estimates = [10, 25, 50, 100].map((benchmark) => `${(benchmark * quantity) / 100}`);
    return choiceItem(
      r,
      `Without calculating exactly, which is the closest benchmark estimate for ${item.percent}% of ${quantity}?`,
      `${(item.benchmark * quantity) / 100}`,
      estimates.filter((estimate) => estimate !== `${(item.benchmark * quantity) / 100}`),
    );
  }),
  T("percent_of_quantity", "integer", (r) => {
    const percent = r.pick([5, 10, 12, 15, 20, 25, 30, 40, 60, 75]);
    const hundredUnits = r.int(2, 9);
    const quantity = hundredUnits * 100;
    return {
      stem: `What is ${percent}% of ${quantity}?`,
      answer: intAns(percent * hundredUnits),
      variant: { a: percent, op: "×", b: hundredUnits },
    };
  }),
  T("percent_find_rate", "integer", (r) => {
    const percent = r.pick([5, 10, 12, 15, 20, 25, 30, 40, 60, 75]);
    const hundredUnits = r.int(2, 9);
    const whole = hundredUnits * 100;
    const part = hundredUnits * percent;
    return {
      stem: `${part} is what percent of ${whole}? Enter the numeric percent.`,
      answer: intAns(percent),
    };
  }),
  T("percent_find_whole", "integer", (r) => {
    const percent = r.pick([10, 20, 25, 50]);
    const factor = 100 / percent;
    const part = r.int(4, 30) * percent;
    return {
      stem: `${part} is ${percent}% of what number?`,
      answer: intAns(part * factor),
      variant: { a: part, op: "×", b: factor },
    };
  }),
  T("percent_increase", "integer", (r) => {
    const percent = r.pick([5, 10, 15, 20, 25, 30]);
    const original = r.int(2, 10) * 100;
    const increase = (original / 100) * percent;
    return {
      stem: `A value of ${original} increases by ${percent}%. What is the new value?`,
      answer: intAns(original + increase),
      variant: { a: original, op: "+", b: increase },
    };
  }),
  T("percent_decrease", "integer", (r) => {
    const percent = r.pick([5, 10, 15, 20, 25, 30]);
    const original = r.int(2, 10) * 100;
    const decrease = (original / 100) * percent;
    return {
      stem: `A value of ${original} decreases by ${percent}%. What is the new value?`,
      answer: intAns(original - decrease),
      variant: { a: original, op: "−", b: decrease },
    };
  }),
  T("percent_change", "integer", (r) => {
    const original = r.int(2, 10) * 100;
    const percent = r.pick([5, 10, 15, 20, 25, 30, 40]);
    const increase = r.int(0, 1) === 0;
    const change = (original / 100) * percent;
    const next = increase ? original + change : original - change;
    return {
      stem: `A quantity changes from ${original} to ${next}. What is the percent ${increase ? "increase" : "decrease"}? Enter the numeric percent.`,
      answer: intAns(percent),
    };
  }),
  T("percent_error", "integer", (r) => {
    const actual = r.int(2, 10) * 100;
    const percent = r.pick([5, 10, 15, 20, 25]);
    const error = (actual / 100) * percent;
    const estimate = r.int(0, 1) === 0 ? actual + error : actual - error;
    return {
      stem: `The actual value is ${actual}, and an estimate is ${estimate}. What is the absolute percent error? Enter the numeric percent.`,
      answer: intAns(percent),
    };
  }),
  T("percent_sales_tax", "decimal", (r) => {
    const priceCents = r.pick([2400, 3200, 4500, 5600, 7500, 8400]);
    const rate = r.pick([5, 6, 8, 10]);
    const taxCents = (priceCents * rate) / 100;
    const askTotal = r.int(0, 1) === 0;
    return {
      stem: `A purchase costs $${(priceCents / 100).toFixed(2)} before ${rate}% sales tax. What is the ${askTotal ? "total price" : "tax amount"} in dollars? Enter a number without the dollar sign.`,
      answer: decAns((askTotal ? priceCents + taxCents : taxCents) / 100),
    };
  }),
  T("percent_discount_price", "decimal", (r) => {
    const priceCents = r.pick([2400, 3200, 4500, 5600, 7500, 8400]);
    const rate = r.pick([10, 15, 20, 25, 30]);
    const discountCents = (priceCents * rate) / 100;
    const askSalePrice = r.int(0, 1) === 0;
    return {
      stem: `An item lists for $${(priceCents / 100).toFixed(2)} and is discounted ${rate}%. What is the ${askSalePrice ? "sale price" : "discount amount"} in dollars? Enter a number without the dollar sign.`,
      answer: decAns((askSalePrice ? priceCents - discountCents : discountCents) / 100),
    };
  }),
  T("percent_simple_interest", "decimal", (r) => {
    const principal = r.pick([200, 400, 500, 800, 1000, 1200]);
    const rate = r.pick([2, 3, 4, 5, 6, 8]);
    const years = r.int(2, 6);
    const interest = principal * (rate / 100) * years;
    const askBalance = r.int(0, 1) === 0;
    return {
      stem: `$${principal} earns ${rate}% simple interest per year for ${years} years. What is the ${askBalance ? "final balance" : "interest earned"} in dollars? Enter a number without the dollar sign.`,
      answer: decAns(askBalance ? principal + interest : interest),
    };
  }),
  T("prop_multiplicative_vs_additive", "multipleChoice", (r) => {
    const a = r.int(2, 8);
    let b = r.int(3, 9);
    if (b === a) b = b === 9 ? 8 : b + 1;
    const scale = r.int(2, 5);
    const add = r.int(2, 6);
    return choiceItem(
      r,
      `The pair (${a}, ${b}) describes a ratio. Which new pair preserves that ratio?`,
      `(${a * scale}, ${b * scale}), because both values were multiplied by ${scale}.`,
      [
        `(${a + add}, ${b + add}), because the same number was added to both.`,
        `(${a * scale}, ${b + scale}), because both operations used ${scale}.`,
        `(${b * scale}, ${a * scale}), because both values were multiplied by ${scale}.`,
      ],
    );
  }),
  T("prop_table_from_rule", "integer", (r) => {
    const k = r.int(2, 8);
    const x = r.int(4, 10);
    return {
      stem: `The rule is y = ${k} times x.\nx | y\n1 | ${k}\n3 | ${k * 3}\n${x} | ?\nWhat is the missing output?`,
      answer: intAns(k * x),
      variant: { a: k, op: "×", b: x },
    };
  }),
  T("prop_plot_equivalent_pairs", "multipleChoice", (r) => {
    const k = r.int(2, 5);
    const correct = { x: 3, y: 3 * k, label: "A" };
    const second = { x: 3, y: 3 * k + 1, label: "B" };
    const third = { x: 4, y: 3 * k, label: "C" };
    return choiceItem(
      r,
      `Points P and Q are equivalent-ratio pairs. Which candidate point continues the same proportional pattern?`,
      `Point A: (${correct.x}, ${correct.y})`,
      [
        `Point B: (${second.x}, ${second.y})`,
        `Point C: (${third.x}, ${third.y})`,
        "None of the candidate points",
      ],
      coordinatePromptVisual([
        { x: 0, y: 0, label: "O" },
        { x: 1, y: k, label: "P" },
        { x: 2, y: 2 * k, label: "Q" },
        correct,
        second,
        third,
      ], undefined, true),
    );
  }),
  T("prop_decide_table", "multipleChoice", (r) => {
    const k = r.int(2, 7);
    const proportional = r.int(0, 1) === 0;
    const badY = 3 * k + 1;
    const rows = [k, 2 * k, proportional ? 3 * k : badY, 4 * k];
    const correct = proportional
      ? `Yes. Every nonzero row has y/x = ${k}.`
      : `No. The row (3, ${badY}) has a different y/x ratio.`;
    return choiceItem(
      r,
      `Does this table represent a proportional relationship?\nx | y\n1 | ${rows[0]}\n2 | ${rows[1]}\n3 | ${rows[2]}\n4 | ${rows[3]}`,
      correct,
      proportional
        ? [
            "No. Proportional tables must have equal x- and y-values.",
            "No. The y-values increase from row to row.",
            "There is not enough information to decide.",
          ]
        : [
            `Yes. The y-values are close to ${k} times x.`,
            "Yes. Both columns increase from row to row.",
            "There is not enough information to decide.",
          ],
    );
  }),
  T("prop_decide_graph", "multipleChoice", (r) => {
    const k = r.int(2, 5);
    const proportional = r.int(0, 1) === 0;
    const intercept = proportional ? 0 : 1;
    const points = [0, 1, 2, 3].map((x) => ({
      x,
      y: k * x + intercept,
      label: x === 0 ? "A" : String.fromCharCode(65 + x),
    }));
    return choiceItem(
      r,
      "Does the plotted relationship represent a proportional relationship?",
      proportional
        ? "Yes. The points form a straight line through the origin."
        : "No. The straight line does not pass through the origin.",
      proportional
        ? [
            "No. A proportional graph cannot contain the origin.",
            "No. The y-values are larger than the x-values.",
            "There is not enough information to decide.",
          ]
        : [
            "Yes. Any straight line is proportional.",
            "Yes. The points rise at a constant rate.",
            "There is not enough information to decide.",
          ],
      coordinatePromptVisual(points, "segments", true),
    );
  }),
  T("prop_constant_table", "fraction", (r) => {
    const [num, den] = r.pick([
      [2, 3],
      [3, 2],
      [3, 4],
      [5, 2],
      [5, 3],
    ]);
    return {
      stem: `Find the constant of proportionality k = y/x.\nx | y\n${den} | ${num}\n${den * 2} | ${num * 2}\n${den * 4} | ${num * 4}`,
      answer: fracAns(num, den),
    };
  }),
  T("prop_constant_graph", "integer", (r) => {
    const k = r.int(2, 6);
    return {
      stem: "The plotted points lie on y = kx. What is the constant of proportionality k?",
      answer: intAns(k),
      promptVisual: coordinatePromptVisual([
        { x: 0, y: 0, label: "O" },
        { x: 1, y: k, label: "A" },
        { x: 2, y: 2 * k, label: "B" },
        { x: 3, y: 3 * k, label: "C" },
      ], "segments", true),
    };
  }),
  T("prop_write_equation", "multipleChoice", (r) => {
    const k = r.int(2, 8);
    return choiceItem(
      r,
      `A machine makes ${k} parts per minute. If x is minutes and y is parts, which equation represents the relationship?`,
      `y = ${k}x`,
      [`y = x + ${k}`, `x = ${k}y`, `y = x/${k}`],
    );
  }),
  T("prop_missing_value", "integer", (r) => {
    const k = r.int(2, 9);
    const x = r.int(3, 12);
    return {
      stem: `The relationship is y = ${k}x. What is y when x = ${x}?`,
      answer: intAns(k * x),
      variant: { a: k, op: "×", b: x },
    };
  }),
  T("prop_interpret_point", "multipleChoice", (r) => {
    const hours = r.int(2, 4);
    const speed = r.int(2, 5);
    const distance = hours * speed;
    return choiceItem(
      r,
      `The horizontal axis measures hours and the vertical axis measures kilometers. What does point P mean?`,
      `${hours} hours correspond to ${distance} kilometers.`,
      [
        `${distance} hours correspond to ${hours} kilometers.`,
        `The speed is ${distance} kilometers per hour.`,
        `The trip covers ${distance - hours} kilometers in ${hours} hours.`,
      ],
      coordinatePromptVisual([
        { x: 0, y: 0, label: "O" },
        { x: hours, y: distance, label: "P" },
      ], "segments", true),
    );
  }),
  T("prop_interpret_unit_point", "multipleChoice", (r) => {
    const rate = r.int(2, 6);
    const askUnit = r.int(0, 1) === 0;
    return choiceItem(
      r,
      `The horizontal axis measures hours and the vertical axis measures liters. What does point ${askUnit ? "U" : "O"} mean?`,
      askUnit
        ? `At the unit rate, 1 hour corresponds to ${rate} liters.`
        : "At 0 hours, the amount is 0 liters.",
      askUnit
        ? [
            `${rate} hours correspond to 1 liter.`,
            `The starting amount is ${rate} liters at 0 hours.`,
            `Every hour adds ${rate + 1} liters.`,
          ]
        : [
            `At 0 hours, the amount is ${rate} liters.`,
            "The rate is 0 liters per hour.",
            `At 1 hour, the amount is 0 liters.`,
          ],
      coordinatePromptVisual([
        { x: 0, y: 0, label: "O" },
        { x: 1, y: rate, label: "U" },
        { x: 3, y: 3 * rate, label: "P" },
      ], "segments", true),
    );
  }),
  T("prop_match_representations", "multipleChoice", (r) => {
    const k = r.int(2, 5);
    return choiceItem(
      r,
      "Which equation represents the same proportional relationship as the plotted points?",
      `y = ${k}x`,
      [`y = x + ${k}`, `y = x/${k}`, `y = ${k + 1}x`],
      coordinatePromptVisual([
        { x: 0, y: 0, label: "O" },
        { x: 2, y: 2 * k, label: "A" },
        { x: 3, y: 3 * k, label: "B" },
      ], "segments", true),
    );
  }),

  // Integers & the coordinate plane (grades 5–7).
  // Negative numeric answers are typed practice — both touch pads expose a
  // `±` sign-toggle key (shared/practiceLoop.ts's applyKey).
  T("positive_negative_contexts", "integer", (r) => {
    const magnitude = r.int(3, 18);
    const below = r.int(0, 1) === 0;
    const value = below ? -magnitude : magnitude;
    return signedIntegerItem(
      r,
      `Sea level is 0 meters. A research station is ${magnitude} meters ${below ? "below" : "above"} sea level. Which signed integer represents its elevation?`,
      value,
    );
  }),
  T("opposite_numbers", "integer", (r) => {
    const value = r.int(0, 5) === 0 ? 0 : r.int(1, 8) * (r.int(0, 1) === 0 ? -1 : 1);
    const opposite = -value;
    return signedIntegerItem(
      r,
      `What is the opposite of ${value}?`,
      opposite,
      numberLinePromptVisual([value, opposite, 0], {
        // The unknown is deliberately NOT plotted: a "?" dot at `opposite` sits
        // on a labelled tick, so the answer would be readable straight off the
        // axis (and spoken by numberLineAccessibilityLabel). Show the given
        // number only and let the scholar mirror it across zero.
        points: [{ value, label: String(value), highlighted: true }],
        axisLabel: "Equally far from zero",
      }),
    );
  }),
  T("integers_on_number_line", "integer", (r) => {
    const value = r.int(1, 8) * (r.int(0, 1) === 0 ? -1 : 1);
    return signedIntegerItem(
      r,
      "Point P is on an unlabeled tick. What integer is at P?",
      value,
      numberLinePromptVisual([value, 0], {
        points: [{ value, label: "P", highlighted: true }],
        unlabeledTicks: [value],
      }),
    );
  }),
  T("compare_integers", "multipleChoice", (r) => {
    const a = r.int(-9, 7);
    let b = r.int(-8, 9);
    if (b === a) b = a === 9 ? a - 1 : a + 1;
    return {
      stem: `How does ${a} compare to ${b}?`,
      answer: choiceAns(comparisonIndex(a, b)),
      choices: COMPARE_CHOICES,
      promptVisual: numberLinePromptVisual([a, b, 0], {
        points: [
          { value: a, label: "A", highlighted: true },
          { value: b, label: "B", highlighted: true },
        ],
      }),
    };
  }),
  T("absolute_value_distance_zero", "integer", (r) => {
    const value = r.int(2, 9) * (r.int(0, 1) === 0 ? -1 : 1);
    return {
      stem: `Point P is at ${value}. What is its distance from zero?`,
      answer: intAns(Math.abs(value)),
      promptVisual: numberLinePromptVisual([value, 0], {
        points: [{ value, label: "P", highlighted: true }],
        interval: {
          from: Math.min(0, value),
          to: Math.max(0, value),
          includeFrom: true,
          includeTo: true,
          label: "distance",
        },
      }),
    };
  }),
  T("absolute_value_contexts", "integer", (r) => {
    const magnitude = r.int(4, 12);
    const value = -magnitude;
    return {
      stem: `A cave floor is ${value} meters relative to sea level. What is |${value}|, the magnitude of its displacement from sea level?`,
      answer: intAns(magnitude),
      promptVisual: numberLinePromptVisual([value, 0], {
        points: [{ value, label: "cave", highlighted: true }],
        interval: {
          from: value,
          to: 0,
          includeFrom: true,
          includeTo: true,
          label: "magnitude",
        },
      }),
    };
  }),
  T("compare_absolute_values", "multipleChoice", (r) => {
    const aMagnitude = r.int(2, 8);
    let bMagnitude = r.int(2, 8);
    if (bMagnitude === aMagnitude) bMagnitude = bMagnitude === 8 ? 7 : bMagnitude + 1;
    const a = aMagnitude * (r.int(0, 1) === 0 ? -1 : 1);
    const b = bMagnitude * (r.int(0, 1) === 0 ? -1 : 1);
    return {
      stem: `How does |${a}| compare to |${b}|?`,
      answer: choiceAns(comparisonIndex(Math.abs(a), Math.abs(b))),
      choices: COMPARE_CHOICES,
      promptVisual: numberLinePromptVisual([a, b, 0], {
        points: [
          { value: a, label: String(a), highlighted: true },
          { value: b, label: String(b), highlighted: true },
        ],
      }),
    };
  }),
  T("additive_inverses_make_zero", "integer", (r) => {
    const value = r.int(2, 9) * (r.int(0, 1) === 0 ? -1 : 1);
    const inverse = -value;
    return signedIntegerItem(
      r,
      `${value} + ? = 0. What integer belongs in the blank?`,
      inverse,
      numberLinePromptVisual([value, inverse, 0], {
        // Only the given addend is plotted. The unknown here is a directed MOVE
        // back to zero, not a location, and marking it at `inverse` both printed
        // the answer and read like a label for the span between the two dots.
        points: [{ value, label: String(value), highlighted: true }],
      }),
    );
  }),
  T("add_integers_same_sign", "integer", (r) => {
    const sign = r.int(0, 1) === 0 ? -1 : 1;
    const a = sign * r.int(3, 14);
    const b = sign * r.int(3, 14);
    return signedIntegerItem(
      r,
      `${signedOperand(a)} + ${signedOperand(b)} = ?`,
      a + b,
      undefined,
      { a, op: "+", b },
    );
  }),
  T("add_integers_opposite_signs", "integer", (r) => {
    const positive = r.int(4, 18);
    let negativeMagnitude = r.int(3, 17);
    if (negativeMagnitude === positive) negativeMagnitude = negativeMagnitude === 17 ? 16 : negativeMagnitude + 1;
    const a = r.int(0, 1) === 0 ? positive : -negativeMagnitude;
    const b = a > 0 ? -negativeMagnitude : positive;
    return signedIntegerItem(
      r,
      `${signedOperand(a)} + ${signedOperand(b)} = ?`,
      a + b,
      undefined,
      { a, op: "+", b },
    );
  }),
  T("add_integers", "integer", (r) => {
    const a = r.int(2, 20) * (r.int(0, 1) === 0 ? -1 : 1);
    const b = r.int(2, 20) * (r.int(0, 1) === 0 ? -1 : 1);
    return signedIntegerItem(
      r,
      `${signedOperand(a)} + ${signedOperand(b)} = ?`,
      a + b,
      undefined,
      { a, op: "+", b },
    );
  }),
  T("subtract_integers_add_opposite", "integer", (r) => {
    const a = r.int(2, 18) * (r.int(0, 1) === 0 ? -1 : 1);
    const b = r.int(2, 18) * (r.int(0, 1) === 0 ? -1 : 1);
    return signedIntegerItem(
      r,
      `${signedOperand(a)} - ${signedOperand(b)} = ?`,
      a - b,
      undefined,
      { a, op: "−", b },
    );
  }),
  T("add_subtract_integers", "integer", (r) => {
    const a = r.int(3, 15) * (r.int(0, 1) === 0 ? -1 : 1);
    const b = r.int(3, 15) * (r.int(0, 1) === 0 ? -1 : 1);
    const c = r.int(3, 15) * (r.int(0, 1) === 0 ? -1 : 1);
    return signedIntegerItem(
      r,
      `${signedOperand(a)} - ${signedOperand(b)} + ${signedOperand(c)} = ?`,
      a - b + c,
    );
  }),
  T("multiply_integers", "integer", (r) => {
    const a = r.int(2, 12) * (r.int(0, 1) === 0 ? -1 : 1);
    const b = r.int(2, 12) * (r.int(0, 1) === 0 ? -1 : 1);
    return signedIntegerItem(
      r,
      `${signedOperand(a)} × ${signedOperand(b)} = ?`,
      a * b,
      undefined,
      { a, op: "×", b },
    );
  }),
  T("divide_integers", "integer", (r) => {
    const quotient = r.int(2, 12) * (r.int(0, 1) === 0 ? -1 : 1);
    const divisor = r.int(2, 10) * (r.int(0, 1) === 0 ? -1 : 1);
    const dividend = quotient * divisor;
    return signedIntegerItem(
      r,
      `${signedOperand(dividend)} ÷ ${signedOperand(divisor)} = ?`,
      quotient,
    );
  }),
  T("integer_sign_rules", "multipleChoice", (r) => {
    const factorCount = r.int(3, 5);
    const factors = Array.from({ length: factorCount }, () =>
      r.int(2, 9) * (r.int(0, 1) === 0 ? -1 : 1));
    const negativeCount = factors.filter((factor) => factor < 0).length;
    const choices = ["negative", "zero", "positive"];
    return {
      stem: `Without finding the magnitude, what is the sign of ${factors.map(signedOperand).join(" × ")}?`,
      answer: choiceAns(negativeCount % 2 === 0 ? 2 : 0),
      choices,
    };
  }),
  T("integer_expressions", "integer", (r) => {
    const a = r.int(3, 15) * (r.int(0, 1) === 0 ? -1 : 1);
    const b = r.int(2, 9) * (r.int(0, 1) === 0 ? -1 : 1);
    const c = r.int(2, 8) * (r.int(0, 1) === 0 ? -1 : 1);
    return signedIntegerItem(
      r,
      `${signedOperand(a)} + ${signedOperand(b)} × ${signedOperand(c)} = ?`,
      a + b * c,
    );
  }),
  T("integer_context_problems", "integer", (r) => {
    const start = r.int(2, 12) * (r.int(0, 1) === 0 ? -1 : 1);
    const firstChange = r.int(3, 10) * (r.int(0, 1) === 0 ? -1 : 1);
    const secondChange = r.int(3, 10) * (r.int(0, 1) === 0 ? -1 : 1);
    return signedIntegerItem(
      r,
      `At dawn the temperature was ${start}°C. It changed by ${firstChange}°C before noon and by ${secondChange}°C before sunset. What was the sunset temperature?`,
      start + firstChange + secondChange,
    );
  }),
  T("add_subtract_signed_rationals", "fraction", (r) => {
    const denominator = r.pick([2, 4]);
    const a = r.int(1, denominator * 3) * (r.int(0, 1) === 0 ? -1 : 1);
    const b = r.int(1, denominator * 3) * (r.int(0, 1) === 0 ? -1 : 1);
    const subtract = r.int(0, 1) === 0;
    const result = subtract ? a - b : a + b;
    const bLabel = signedFractionLabel(b, denominator);
    return signedFractionItem(
      r,
      `${signedFractionLabel(a, denominator)} ${subtract ? "-" : "+"} ${b < 0 ? `(${bLabel})` : bLabel} = ?`,
      result,
      denominator,
    );
  }),
  T("multiply_signed_rationals", "fraction", (r) => {
    const aNum = r.int(1, 7) * (r.int(0, 1) === 0 ? -1 : 1);
    const bNum = r.int(1, 7) * (r.int(0, 1) === 0 ? -1 : 1);
    const aDen = r.pick([2, 3, 4, 5]);
    const bDen = r.pick([2, 3, 4, 5]);
    return signedFractionItem(
      r,
      `${signedFractionLabel(aNum, aDen)} × ${signedFractionLabel(bNum, bDen)} = ?`,
      aNum * bNum,
      aDen * bDen,
    );
  }),
  T("divide_signed_rationals", "fraction", (r) => {
    const aNum = r.int(1, 7) * (r.int(0, 1) === 0 ? -1 : 1);
    const bNum = r.int(1, 7) * (r.int(0, 1) === 0 ? -1 : 1);
    const aDen = r.pick([2, 3, 4, 5]);
    const bDen = r.pick([2, 3, 4, 5]);
    const resultNum = aNum * bDen * Math.sign(bNum);
    const resultDen = aDen * Math.abs(bNum);
    return signedFractionItem(
      r,
      `${signedFractionLabel(aNum, aDen)} ÷ ${signedFractionLabel(bNum, bDen)} = ?`,
      resultNum,
      resultDen,
    );
  }),
  T("four_operations_signed_rationals", "fraction", (r) => {
    const a = r.int(2, 10) * (r.int(0, 1) === 0 ? -1 : 1);
    const b = r.int(2, 10) * (r.int(0, 1) === 0 ? -1 : 1);
    const e = r.int(2, 10) * (r.int(0, 1) === 0 ? -1 : 1);
    const multiplier = r.pick([2, 4]);
    const divisor = 2;
    const resultNumerator = ((a + b) * multiplier) / divisor - e;
    const bLabel = signedFractionLabel(b, 4);
    const eLabel = signedFractionLabel(e, 4);
    return signedFractionItem(
      r,
      `(${signedFractionLabel(a, 4)} + ${b < 0 ? `(${bLabel})` : bLabel}) × ${multiplier} ÷ ${divisor} - ${e < 0 ? `(${eLabel})` : eLabel} = ?`,
      resultNumerator,
      4,
    );
  }),
  T("signed_rational_numbers", "multipleChoice", (r) => {
    const cases = [
      {
        stem: "Which rational number is negative and lies between -1 and 0?",
        correct: "-3/4",
        distractors: ["3/4", "-4/3", "-2"],
      },
      {
        stem: "Which decimal is the opposite of 0.65?",
        correct: "-0.65",
        distractors: ["0.65", "-6.5", "0.065"],
      },
    ];
    const item = r.pick(cases);
    return choiceItem(r, item.stem, item.correct, item.distractors);
  }),
  T("signed_rationals_on_number_line", "fraction", (r) => {
    let numerator = r.int(-11, 11);
    if (numerator === 0 || numerator % 4 === 0) numerator += numerator >= 0 ? 1 : -1;
    const value = numerator / 4;
    return signedFractionItem(
      r,
      "Point P is on an unlabeled tick. What rational number is at P?",
      numerator,
      4,
      numberLinePromptVisual([value, 0], {
        step: 0.25,
        fractionDenominator: 4,
        points: [{ value, label: "P", highlighted: true }],
        unlabeledTicks: [value],
      }),
    );
  }),
  T("compare_signed_rationals", "multipleChoice", (r) => {
    const a = r.int(-11, 10);
    let b = r.int(-10, 11);
    if (b === a) b = a + 1;
    return {
      stem: `How does ${signedFractionLabel(a, 4)} compare to ${signedFractionLabel(b, 4)}?`,
      answer: choiceAns(comparisonIndex(a, b)),
      choices: COMPARE_CHOICES,
      promptVisual: numberLinePromptVisual([a / 4, b / 4, 0], {
        step: 0.25,
        fractionDenominator: 4,
        points: [
          { value: a / 4, label: "A", highlighted: true },
          { value: b / 4, label: "B", highlighted: true },
        ],
      }),
    };
  }),
  T("rational_inequalities_contexts", "multipleChoice", (r) => {
    const a = r.int(-10, 8);
    let b = r.int(-9, 10);
    if (b === a) b += 1;
    const aLabel = signedFractionLabel(a, 4);
    const bLabel = signedFractionLabel(b, 4);
    return {
      stem: `At Station A the temperature is ${aLabel}°C; at Station B it is ${bLabel}°C. How does Station A's temperature compare to Station B's?`,
      answer: choiceAns(comparisonIndex(a, b)),
      choices: COMPARE_CHOICES,
      promptVisual: numberLinePromptVisual([a / 4, b / 4, 0], {
        step: 0.25,
        fractionDenominator: 4,
        points: [
          { value: a / 4, label: "A", highlighted: true },
          { value: b / 4, label: "B", highlighted: true },
        ],
        interval: {
          from: Math.min(a, b) / 4,
          to: Math.max(a, b) / 4,
          includeFrom: true,
          includeTo: true,
          label: "temperature interval",
        },
      }),
    };
  }),
  T("order_signed_rationals", "multipleChoice", (r) => {
    const values = [
      -r.int(5, 11),
      -r.int(1, 4),
      r.int(0, 2),
      r.int(3, 8),
    ];
    const shuffled = shuffledNumbers(values, r);
    const ordered = [...values].sort((a, b) => a - b);
    const format = (numbers: number[]) => numbers.map((value) => signedFractionLabel(value, 4)).join(", ");
    return choiceItem(
      r,
      `Which list orders ${format(shuffled)} from least to greatest?`,
      format(ordered),
      [
        format([...ordered].reverse()),
        format([ordered[0], ordered[2], ordered[1], ordered[3]]),
        format([ordered[1], ordered[0], ordered[2], ordered[3]]),
      ],
      numberLinePromptVisual(values.map((value) => value / 4), {
        step: 0.25,
        fractionDenominator: 4,
        points: values.map((value) => ({ value: value / 4, highlighted: true })),
      }),
    );
  }),
  T("absolute_value_rationals", "fraction", (r) => {
    let numerator = r.int(-11, 11);
    if (numerator === 0) numerator = 3;
    const value = numerator / 4;
    return {
      stem: `What is |${signedFractionLabel(numerator, 4)}|?`,
      answer: fracAns(Math.abs(numerator), 4),
      promptVisual: numberLinePromptVisual([value, 0], {
        step: 0.25,
        fractionDenominator: 4,
        points: [{ value, label: "P", highlighted: true }],
        interval: {
          from: Math.min(value, 0),
          to: Math.max(value, 0),
          includeFrom: true,
          includeTo: true,
          label: "distance",
        },
      }),
    };
  }),
  T("rational_coordinate_pairs", "fraction", (r) => {
    const xNumerator = r.int(1, 7) * (r.int(0, 1) === 0 ? -1 : 1);
    const yNumerator = r.int(1, 7) * (r.int(0, 1) === 0 ? -1 : 1);
    const askX = r.int(0, 1) === 0;
    return signedFractionItem(
      r,
      `Point A is plotted. What is its ${askX ? "x" : "y"}-coordinate?`,
      askX ? xNumerator : yNumerator,
      2,
      makeCoordinatePlanePromptVisual({
        xMin: -5,
        xMax: 5,
        yMin: -5,
        yMax: 5,
        gridStep: 1,
        points: [{ x: xNumerator / 2, y: yNumerator / 2, label: "A" }],
      }),
    );
  }),
  T("rational_between_numbers", "fraction", (r) => {
    const left = r.int(-10, 4);
    const gap = r.pick([2, 4, 6]);
    const right = left + gap;
    const midpoint = (left + right) / 2;
    return signedFractionItem(
      r,
      `What is the midpoint between ${signedFractionLabel(left, 4)} and ${signedFractionLabel(right, 4)}?`,
      midpoint,
      4,
      numberLinePromptVisual([left / 4, right / 4, midpoint / 4, 0], {
        step: 0.25,
        fractionDenominator: 4,
        // The midpoint (the answer) is NOT plotted: a "?" dot there would land on
        // a labelled fraction tick and print the answer. The shaded interval
        // already draws circles at both given endpoints; let the scholar find
        // the middle of that span.
        interval: {
          from: left / 4,
          to: right / 4,
          includeFrom: false,
          includeTo: false,
          label: "between",
        },
      }),
    );
  }),
  T("signed_fraction_decimal_equivalence", "multipleChoice", (r) => {
    const cases = [
      { numerator: 1, denominator: 4, decimal: "0.25", wrong: ["0.4", "0.14"] },
      { numerator: 3, denominator: 8, decimal: "0.375", wrong: ["0.38", "0.83"] },
      { numerator: 1, denominator: 3, decimal: "0.333...", wrong: ["0.3", "0.13"] },
      { numerator: 2, denominator: 3, decimal: "0.666...", wrong: ["0.6", "0.23"] },
      { numerator: 5, denominator: 8, decimal: "0.625", wrong: ["0.58", "0.825"] },
    ];
    const selected = r.pick(cases);
    const negative = r.int(0, 1) === 0;
    const sign = negative ? "-" : "";
    const correct = `${sign}${selected.decimal}`;
    return choiceItem(
      r,
      `Which decimal is equal to ${sign}${selected.numerator}/${selected.denominator}?`,
      correct,
      [
        `${negative ? "" : "-"}${selected.decimal}`,
        `${sign}${selected.wrong[0]}`,
        `${sign}${selected.wrong[1]}`,
      ],
    );
  }),

  // Early algebra — expressions and variables (grades 5–7).
  T("expr_grouping_symbols", "multipleChoice", (r) => {
    const a = r.int(4, 12);
    const b = r.int(2, 8);
    const c = r.int(2, 6);
    const d = r.int(2, 5);
    const [open, close] = r.pick([
      ["(", ")"],
      ["[", "]"],
      ["{", "}"],
    ]);
    return choiceItem(
      r,
      `In ${a} + ${open}${b} + ${c} × ${d}${close}, which operation must be completed first?`,
      `${c} × ${d}`,
      [`${a} + ${b}`, `${b} + ${c}`, `${a} + ${open}${b}`],
    );
  }),
  T("expr_evaluate_numerical", "integer", (r) => {
    const a = r.int(5, 18);
    const b = r.int(2, 7);
    const c = r.int(2, 8);
    const d = r.int(2, 8);
    return {
      stem: `${a} + ${b} × (${c} + ${d}) = ?`,
      answer: intAns(a + b * (c + d)),
    };
  }),
  T("expr_variable_meaning", "multipleChoice", (r) => {
    const tickets = r.int(3, 8);
    const price = r.int(4, 12);
    const total = tickets * price;
    return choiceItem(
      r,
      `The total cost of ${tickets} equal-price tickets is $${total}. If p is the price of one ticket in this situation, what value does p have?`,
      String(price),
      [String(tickets), String(total), String(total + tickets)],
    );
  }),
  T("expr_terms_factors_coefficients", "multipleChoice", (r) => {
    const coefficient = r.int(3, 9);
    const constant = r.int(2, 12);
    const otherCoefficient = r.int(2, 8);
    return choiceItem(
      r,
      `In ${coefficient}x + ${constant} - ${otherCoefficient}y, what is the coefficient of x?`,
      String(coefficient),
      numericChoiceLabels(coefficient),
    );
  }),
  T("expr_translate_words", "multipleChoice", (r) => {
    const multiplier = r.int(3, 8);
    const difference = r.int(2, 9);
    return choiceItem(
      r,
      `Which expression means "${difference} less than ${multiplier} times a number n"?`,
      `${multiplier}n - ${difference}`,
      [
        `${difference} - ${multiplier}n`,
        `${multiplier}(n - ${difference})`,
        `${multiplier}n + ${difference}`,
      ],
    );
  }),
  T("expr_evaluate_one_variable", "integer", (r) => {
    const coefficient = r.int(3, 9);
    const x = r.int(2, 12);
    const constant = r.int(2, 15);
    return {
      stem: `If x = ${x}, what is ${linearExpression(coefficient, constant)}?`,
      answer: intAns(coefficient * x + constant),
    };
  }),
  T("expr_evaluate_two_variables", "integer", (r) => {
    const a = r.int(2, 6);
    const b = r.int(2, 6);
    const x = r.int(2, 9);
    const y = r.int(2, 9);
    return {
      stem: `If x = ${x} and y = ${y}, what is ${a}x + ${b}y?`,
      answer: intAns(a * x + b * y),
    };
  }),
  T("expr_evaluate_exponents", "integer", (r) => {
    const base = r.int(2, 6);
    const exponent = r.pick([2, 3]);
    const multiplier = r.int(2, 5);
    const constant = r.int(2, 12);
    return {
      stem: `${multiplier} × ${base}^${exponent} + ${constant} = ?`,
      answer: intAns(multiplier * Math.pow(base, exponent) + constant),
    };
  }),
  T("expr_evaluate_fractions", "fraction", (r) => {
    const denominator = r.pick([3, 4, 5, 6]);
    const numerator = r.int(1, denominator - 1);
    const multiplier = r.int(2, 5);
    const addNumerator = r.int(1, denominator - 1);
    return {
      stem: `If x = ${formatAnswer(fracAns(numerator, denominator))}, what is ${multiplier}x + ${formatAnswer(fracAns(addNumerator, denominator))}?`,
      answer: fracAns(multiplier * numerator + addNumerator, denominator),
    };
  }),
  T("expr_distributive_numeric", "integer", (r) => {
    const factor = r.int(6, 12);
    const base = r.pick([50, 100, 200]);
    const offset = r.int(3, 12);
    return {
      stem: `Use a helpful decomposition to evaluate ${factor}(${base} - ${offset}). What is its value?`,
      answer: intAns(factor * (base - offset)),
    };
  }),
  T("expr_evaluate_formulas", "integer", (r) => {
    const base = 2 * r.int(3, 10);
    const height = r.int(4, 12);
    return {
      stem: `A triangle's area is A = (b × h) ÷ 2. If b = ${base} cm and h = ${height} cm, what is A? Give only the number.`,
      answer: intAns((base * height) / 2),
    };
  }),
  T("expr_multi_step_signed", "integer", (r) => {
    const x = r.int(-7, 7);
    const a = r.int(2, 5);
    const b = r.int(2, 7);
    const c = r.int(2, 4);
    const d = r.int(2, 7);
    return signedIntegerItem(
      r,
      `If x = ${x}, evaluate ${a}(2x - ${b}) - ${c}(x + ${d}).`,
      a * (2 * x - b) - c * (x + d),
    );
  }),

  // Early algebra — equations (grades 5–8).
  T("eq_unknown_in_arithmetic", "integer", (r) => {
    const unknown = r.int(4, 18);
    const addend = r.int(3, 12);
    const factor = r.int(2, 6);
    return {
      stem: `(? + ${addend}) × ${factor} = ${(unknown + addend) * factor}. What number is ?`,
      answer: intAns(unknown),
    };
  }),
  T("eq_solution_meaning", "multipleChoice", (r) => {
    const solution = r.int(3, 12);
    const addend = r.int(2, 9);
    const total = solution + addend;
    return choiceItem(
      r,
      `Which value of x makes both sides of x + ${addend} = ${total} balance exactly?`,
      String(solution),
      numericChoiceLabels(solution),
    );
  }),
  T("eq_test_solution", "multipleChoice", (r) => {
    const solution = r.int(-8, 12);
    const coefficient = r.int(2, 6);
    const constant = r.int(-8, 8);
    return choiceItem(
      r,
      `Which value of x makes ${linearExpression(coefficient, constant)} = ${coefficient * solution + constant} true?`,
      String(solution),
      numericChoiceLabels(solution),
    );
  }),
  T("eq_one_step_add_sub", "integer", (r) => {
    const solution = r.int(4, 18);
    const amount = r.int(2, 10);
    if (r.int(0, 1) === 0) {
      return {
        stem: `x + ${amount} = ${solution + amount}. What is x?`,
        answer: intAns(solution),
        variant: { a: solution, op: "+", b: amount },
      };
    }
    return {
      stem: `x - ${amount} = ${solution - amount}. What is x?`,
      answer: intAns(solution),
      variant: { a: solution, op: "−", b: amount },
    };
  }),
  T("eq_one_step_mult_div", "integer", (r) => {
    const solution = r.int(3, 14);
    const factor = r.int(2, 9);
    if (r.int(0, 1) === 0) {
      return {
        stem: `${factor}x = ${factor * solution}. What is x?`,
        answer: intAns(solution),
        variant: { a: solution, op: "×", b: factor },
      };
    }
    return {
      stem: `x ÷ ${factor} = ${solution}. What is x?`,
      answer: intAns(solution * factor),
    };
  }),
  T("eq_one_step_fraction", "fraction", (r) => {
    const coefficientNumerator = r.int(2, 4);
    const coefficientDenominator = r.int(coefficientNumerator + 1, 6);
    const solutionNumerator = r.int(3, 10);
    const solutionDenominator = r.pick([2, 3, 4]);
    const coefficient = fracAns(coefficientNumerator, coefficientDenominator);
    const right = fracAns(
      coefficientNumerator * solutionNumerator,
      coefficientDenominator * solutionDenominator,
    );
    return {
      stem: `${formatAnswer(coefficient)}x = ${formatAnswer(right)}. What is x?`,
      answer: fracAns(solutionNumerator, solutionDenominator),
    };
  }),
  T("eq_one_step_context", "integer", (r) => {
    const notebooks = r.int(4, 12);
    const price = r.int(3, 9);
    return {
      stem: `${notebooks} identical notebooks cost $${notebooks * price}. What is the price of one notebook?`,
      answer: intAns(price),
    };
  }),
  T("eq_two_step_positive", "integer", (r) => {
    const solution = r.int(3, 15);
    const coefficient = r.int(2, 8);
    const constant = r.int(3, 14);
    return {
      stem: `${linearExpression(coefficient, constant)} = ${coefficient * solution + constant}. What is x?`,
      answer: intAns(solution),
    };
  }),
  T("eq_two_step_integers", "integer", (r) => {
    const solution = r.int(-12, 12);
    const coefficient = r.int(0, 1) === 0 ? -r.int(2, 7) : r.int(2, 7);
    const constant = r.int(-12, 12);
    return signedIntegerItem(
      r,
      `${linearExpression(coefficient, constant)} = ${coefficient * solution + constant}. What is x?`,
      solution,
    );
  }),
  T("eq_two_step_fraction_decimal", "fraction", (r) => {
    const denominator = r.pick([2, 4, 5]);
    const solutionNumerator = r.int(3, denominator * 3);
    const coefficient = r.int(2, 4);
    const constantNumerator = r.int(1, denominator * 2);
    return {
      stem: `${coefficient}x + ${formatAnswer(fracAns(constantNumerator, denominator))} = ${formatAnswer(fracAns(coefficient * solutionNumerator + constantNumerator, denominator))}. What is x?`,
      answer: fracAns(solutionNumerator, denominator),
    };
  }),
  T("eq_parentheses", "integer", (r) => {
    const solution = r.int(5, 14);
    const inside = r.int(-3, 6);
    const coefficient = r.int(2, 7);
    const grouped = inside < 0 ? `x - ${Math.abs(inside)}` : `x + ${inside}`;
    return {
      stem: `${coefficient}(${grouped}) = ${coefficient * (solution + inside)}. What is x?`,
      answer: intAns(solution),
    };
  }),
  T("eq_context_multi_step", "integer", (r) => {
    const tickets = r.int(4, 12);
    const fee = r.int(5, 15);
    const ticketPrice = r.int(6, 18);
    const total = fee + tickets * ticketPrice;
    return {
      stem: `A group pays a $${fee} booking fee plus the same price for each of ${tickets} tickets. The total is $${total}. What is the price of one ticket?`,
      answer: intAns(ticketPrice),
    };
  }),
  T("eq_both_sides", "integer", (r) => {
    const solution = r.int(-9, 9);
    const leftCoefficient = r.int(5, 9);
    const rightCoefficient = r.int(2, leftCoefficient - 1);
    const leftConstant = r.int(-15, 15);
    const rightConstant =
      (leftCoefficient - rightCoefficient) * solution + leftConstant;
    return signedIntegerItem(
      r,
      `${linearExpression(leftCoefficient, leftConstant)} = ${linearExpression(rightCoefficient, rightConstant)}. What is x?`,
      solution,
    );
  }),
  T("eq_identity_contradiction", "multipleChoice", (r) => {
    const kind = r.pick(["one solution", "no solution", "infinitely many solutions"] as const);
    const coefficient = r.int(2, 6);
    const constant = r.int(2, 9);
    const stem = kind === "infinitely many solutions"
      ? `${coefficient}(x + ${constant}) = ${linearExpression(coefficient, coefficient * constant)}`
      : kind === "no solution"
        ? `${linearExpression(coefficient, constant)} = ${linearExpression(coefficient, constant + r.int(1, 5))}`
        : `${linearExpression(coefficient + 2, constant)} = ${linearExpression(coefficient, constant + r.int(2, 10))}`;
    return choiceItem(
      r,
      `How many solutions does ${stem} have?`,
      kind,
      ["one solution", "no solution", "infinitely many solutions"].filter(
        (choice) => choice !== kind,
      ),
    );
  }),

  // Early algebra — patterns and sequences (grades 4–8).
  T("pattern_rule_sequence", "integer", (r) => {
    const start = r.int(2, 15);
    const increase = r.int(3, 9);
    const term = r.int(5, 8);
    return {
      stem: `A sequence starts at ${start} and adds ${increase} each time. What is the ${formatOrdinal(term)} term?`,
      answer: intAns(start + (term - 1) * increase),
    };
  }),
  T("pattern_additive_next", "integer", (r) => {
    const difference = r.int(0, 1) === 0 ? -r.int(3, 9) : r.int(3, 9);
    const start = difference < 0 ? r.int(12, 30) : r.int(2, 14);
    const terms = Array.from({ length: 4 }, (_, index) => start + index * difference);
    return signedIntegerItem(
      r,
      `${terms.join(", ")}, ___. What is the next term?`,
      start + 4 * difference,
    );
  }),
  T("pattern_multiplicative_next", "integer", (r) => {
    const factor = r.pick([2, 3, 4]);
    const start = r.int(1, 5);
    const terms = Array.from({ length: 4 }, (_, index) => start * Math.pow(factor, index));
    return {
      stem: `${terms.join(", ")}, ___. What is the next term?`,
      answer: intAns(start * Math.pow(factor, 4)),
    };
  }),
  T("pattern_corresponding_sequences", "integer", (r) => {
    const start = r.int(1, 8);
    const firstStep = r.int(2, 6);
    const secondStep = firstStep + r.int(2, 5);
    const term = r.int(6, 10);
    return {
      stem: `Sequence A starts at ${start} and adds ${firstStep}. Sequence B starts at ${start} and adds ${secondStep}. At the ${formatOrdinal(term)} term, how much greater is B than A?`,
      answer: intAns((term - 1) * (secondStep - firstStep)),
    };
  }),
  T("pattern_function_machine_one_step", "integer", (r) => {
    const multiply = r.int(0, 1) === 0;
    const m = multiply ? r.int(2, 6) : 1;
    const b = multiply ? 0 : r.int(3, 12);
    const inputs = [2, 5, 8];
    const queryInput = r.int(10, 18);
    return {
      stem: `A function machine shows ${inputs.map((input) => `${input} → ${m * input + b}`).join(", ")}. What output comes out when ${queryInput} goes in?`,
      answer: intAns(m * queryInput + b),
    };
  }),
  T("pattern_function_machine_two_step", "integer", (r) => {
    const m = r.int(2, 6);
    const b = r.int(-8, 9);
    const inputs = [1, 3, 6];
    const queryInput = r.int(8, 15);
    return {
      stem: `A two-step function machine shows ${inputs.map((input) => `${input} → ${m * input + b}`).join(", ")}. Predict the output when ${queryInput} goes in.`,
      answer: intAns(m * queryInput + b),
    };
  }),
  T("pattern_table_missing_value", "integer", (r) => {
    const m = r.int(2, 7);
    const b = r.int(-6, 8);
    const inputs = [1, 3, 5, 8];
    const queryIndex = r.int(1, inputs.length - 1);
    const rows = inputs.map((input, index) =>
      `${input} | ${index === queryIndex ? "?" : m * input + b}`);
    return signedIntegerItem(
      r,
      `Every row follows the same input-output rule.\ninput | output\n${rows.join("\n")}\nWhat output replaces ?`,
      m * inputs[queryIndex] + b,
    );
  }),
  T("pattern_arithmetic_sequence", "integer", (r) => {
    const first = r.int(-12, 18);
    const difference = r.int(0, 1) === 0 ? -r.int(3, 9) : r.int(3, 9);
    const term = r.int(18, 35);
    return signedIntegerItem(
      r,
      `An arithmetic sequence has first term ${first} and common difference ${difference}. What is the ${formatOrdinal(term)} term?`,
      first + (term - 1) * difference,
    );
  }),
  T("pattern_linear_table_rule", "integer", (r) => {
    const m = r.int(0, 1) === 0 ? -r.int(2, 5) : r.int(2, 6);
    const b = r.int(-7, 9);
    const inputs = [0, 2, 4];
    const queryInput = r.int(7, 11);
    return signedIntegerItem(
      r,
      `The table follows one linear rule.\nx | y\n${inputs.map((input) => `${input} | ${m * input + b}`).join("\n")}\nWhat is y when x = ${queryInput}?`,
      m * queryInput + b,
    );
  }),
  T("pattern_graph_rate_change", "integer", (r) => {
    const slope = r.int(0, 1) === 0 ? -r.int(2, 4) : r.int(2, 4);
    const intercept = r.int(-4, 4);
    const points = [-2, 0, 2].map((x, index) => ({
      x,
      y: slope * x + intercept,
      label: String.fromCharCode(65 + index),
    }));
    const askRate = r.int(0, 1) === 0;
    const queryX = 4;
    return signedIntegerItem(
      r,
      askRate
        ? "The plotted points follow a linear pattern. What is the rate of change in y for each increase of 1 in x?"
        : `The plotted points follow a linear pattern. What is y when x = ${queryX}?`,
      askRate ? slope : slope * queryX + intercept,
      coordinatePromptVisual(points, "segments"),
    );
  }),

  // Early algebra — inequalities (grades 6–7).
  T("ineq_symbol_meaning", "multipleChoice", (r) => {
    const boundary = r.int(-8, 8);
    const direction = r.pick(["less", "greater"] as const);
    const inclusive = r.int(0, 1) === 0;
    const symbol = direction === "less"
      ? inclusive ? "≤" : "<"
      : inclusive ? "≥" : ">";
    const correct = `x ${symbol} ${boundary}`;
    return choiceItem(
      r,
      "Which inequality matches the shaded solution set?",
      correct,
      [
        `x ${direction === "less" ? ">" : "<"} ${boundary}`,
        `x ${direction === "less" ? "≥" : "≤"} ${boundary}`,
        `x ${inclusive ? direction === "less" ? "<" : ">" : direction === "less" ? "≤" : "≥"} ${boundary}`,
      ],
      inequalityPromptVisual(boundary, direction, inclusive),
    );
  }),
  T("ineq_test_solution", "multipleChoice", (r) => {
    const boundary = r.int(-8, 8);
    const candidates = [boundary - 1, boundary, boundary + 1];
    return choiceItem(
      r,
      `Which value satisfies x > ${boundary}?`,
      String(boundary + 1),
      [String(candidates[0]), String(candidates[1])],
      inequalityPromptVisual(boundary, "greater", false),
    );
  }),
  T("ineq_one_step_add_sub", "integer", (r) => {
    const boundary = r.int(-8, 12);
    const amount = r.int(3, 10);
    if (r.int(0, 1) === 0) {
      return signedIntegerItem(
        r,
        `For integer x, solve x + ${amount} < ${boundary + amount}. What is the greatest possible x?`,
        boundary - 1,
        inequalityPromptVisual(boundary, "less", false),
      );
    }
    return signedIntegerItem(
      r,
      `For integer x, solve x - ${amount} ≥ ${boundary - amount}. What is the least possible x?`,
      boundary,
      inequalityPromptVisual(boundary, "greater", true),
    );
  }),
  T("ineq_one_step_mult_div_positive", "integer", (r) => {
    const boundary = r.int(-7, 10);
    const factor = r.int(2, 8);
    if (r.int(0, 1) === 0) {
      return signedIntegerItem(
        r,
        `For integer x, solve ${factor}x ≤ ${factor * boundary}. What is the greatest possible x?`,
        boundary,
        inequalityPromptVisual(boundary, "less", true),
      );
    }
    return signedIntegerItem(
      r,
      `For integer x, solve x ÷ ${factor} > ${boundary}. What is the least possible x?`,
      factor * boundary + 1,
      inequalityPromptVisual(factor * boundary, "greater", false),
    );
  }),
  T("ineq_context_one_step", "integer", (r) => {
    const fixed = r.int(4, 16);
    const each = r.int(3, 9);
    const maximum = r.int(5, 14);
    const budget = fixed + each * maximum;
    return {
      stem: `A club has $${budget}. A fixed fee costs $${fixed}, then each ticket costs $${each}. What is the greatest whole number of tickets the club can buy?`,
      answer: intAns(maximum),
      promptVisual: inequalityPromptVisual(maximum, "less", true),
    };
  }),
  T("ineq_boundary_direction", "multipleChoice", (r) => {
    const boundary = r.int(-8, 8);
    const direction = r.pick(["less", "greater"] as const);
    const inclusive = r.int(0, 1) === 0;
    const symbol = direction === "less"
      ? inclusive ? "≤" : "<"
      : inclusive ? "≥" : ">";
    const endpoint = inclusive ? "closed" : "open";
    const ray = direction === "less" ? "left" : "right";
    return choiceItem(
      r,
      `Which description matches x ${symbol} ${boundary}?`,
      `${endpoint} at ${boundary}, shaded ${ray}`,
      [
        `${inclusive ? "open" : "closed"} at ${boundary}, shaded ${ray}`,
        `${endpoint} at ${boundary}, shaded ${ray === "left" ? "right" : "left"}`,
        `${inclusive ? "open" : "closed"} at ${boundary}, shaded ${ray === "left" ? "right" : "left"}`,
      ],
      inequalityPromptVisual(boundary, direction, inclusive),
    );
  }),
  T("ineq_negative_coefficient", "integer", (r) => {
    const factor = r.int(2, 7);
    const boundary = r.int(-9, 8);
    return signedIntegerItem(
      r,
      `For integer x, solve ${-factor}x < ${-factor * boundary}. What is the least possible x?`,
      boundary + 1,
      inequalityPromptVisual(boundary, "greater", false),
    );
  }),
  T("ineq_two_step", "integer", (r) => {
    const coefficient = r.int(0, 1) === 0 ? -r.int(2, 6) : r.int(2, 6);
    const constant = r.int(-12, 12);
    const boundary = r.int(-9, 9);
    const right = coefficient * boundary + constant;
    const direction = coefficient > 0 ? "less" : "greater";
    const answer = coefficient > 0 ? boundary - 1 : boundary + 1;
    return signedIntegerItem(
      r,
      `For integer x, solve ${linearExpression(coefficient, constant)} < ${right}. What is the ${coefficient > 0 ? "greatest" : "least"} possible x?`,
      answer,
      inequalityPromptVisual(boundary, direction, false),
    );
  }),
  T("ineq_context_two_step", "integer", (r) => {
    const setupMinutes = r.int(8, 20);
    const minutesEach = r.int(4, 9);
    const maximum = r.int(6, 14);
    const totalMinutes = setupMinutes + minutesEach * maximum;
    return {
      stem: `Setup takes ${setupMinutes} minutes, then each trial takes ${minutesEach} minutes. There are at most ${totalMinutes} minutes available. What is the greatest whole number of trials possible?`,
      answer: intAns(maximum),
      promptVisual: inequalityPromptVisual(maximum, "less", true),
    };
  }),

  // ── algebra-1: linear-equations / linear-functions / systems ──────────────
  // One deterministic family per graph key; every answer correct by
  // construction (the solution is drawn first, the stem is built from it).

  // Linear equations (grades 8–9).
  T("lin_eq_combine_terms", "integer", (r) => {
    const x = r.int(-6, 9);
    const subtractTerms = r.int(0, 1) === 0;
    const a = subtractTerms ? r.int(5, 9) : r.int(2, 6);
    const b = subtractTerms ? r.int(2, a - 1) : r.int(2, 6);
    const combined = subtractTerms ? a - b : a + b;
    const c = r.int(-9, 9);
    const rhs = combined * x + c;
    const constPart = c === 0 ? "" : c < 0 ? ` - ${-c}` : ` + ${c}`;
    return signedIntegerItem(
      r,
      `Solve for x: ${a}x ${subtractTerms ? "-" : "+"} ${b}x${constPart} = ${rhs}.`,
      x,
    );
  }),
  T("lin_eq_distribute", "integer", (r) => {
    const x = r.int(-5, 8);
    const a = r.int(2, 5);
    const p = r.int(-6, 6);
    const b = r.int(1, 5);
    const rhs = (a + b) * x + a * p;
    return signedIntegerItem(
      r,
      `Solve for x: ${a}(${slopeInterceptExpr(1, p)}) + ${b}x = ${rhs}.`,
      x,
    );
  }),
  T("lin_eq_clear_fractions", "integer", (r) => {
    if (r.int(0, 1) === 0) {
      const denominators = shuffledNumbers([2, 3, 4, 5, 6], r);
      const d1 = denominators[0];
      const d2 = denominators[1];
      const x = lcm(d1, d2) * r.int(1, 3);
      return signedIntegerItem(
        r,
        `Solve for x by clearing the denominators: x/${d1} + x/${d2} = ${x / d1 + x / d2}.`,
        x,
      );
    }
    const d = r.pick([2, 3, 4, 5]);
    const x = d * r.int(2, 6);
    const c = r.int(1, 9);
    return signedIntegerItem(
      r,
      `Solve for x by clearing the denominator: x/${d} + ${c} = ${x / d + c}.`,
      x,
    );
  }),
  T("lin_eq_justify_steps", "multipleChoice", (r) => {
    const moves = [
      {
        step: "added the same number to both sides",
        property: "Addition Property of Equality",
      },
      {
        step: "subtracted the same number from both sides",
        property: "Subtraction Property of Equality",
      },
      {
        step: "multiplied both sides by the same nonzero number",
        property: "Multiplication Property of Equality",
      },
      {
        step: "divided both sides by the same nonzero number",
        property: "Division Property of Equality",
      },
      {
        step: "rewrote a(x + c) as ax + ac",
        property: "Distributive Property",
      },
    ];
    const correct = r.pick(moves);
    const distractors = moves
      .filter((move) => move.property !== correct.property)
      .map((move) => move.property)
      .slice(0, 3);
    return choiceItem(
      r,
      `While solving an equation, a student ${correct.step}. Which property justifies this step?`,
      correct.property,
      distractors,
    );
  }),
  T("lin_eq_literal", "multipleChoice", (r) => {
    const forms = [
      {
        equation: "P = 2l + 2w",
        variable: "w",
        correct: "w = (P - 2l) / 2",
        distractors: ["w = P - 2l", "w = (P - 2l) / l", "w = 2P - l"],
      },
      {
        equation: "A = (1/2)bh",
        variable: "h",
        correct: "h = 2A / b",
        distractors: ["h = A / (2b)", "h = 2A - b", "h = bA / 2"],
      },
      {
        equation: "d = rt",
        variable: "t",
        correct: "t = d / r",
        distractors: ["t = r / d", "t = dr", "t = d - r"],
      },
      {
        equation: "y = mx + b",
        variable: "x",
        correct: "x = (y - b) / m",
        distractors: ["x = (y + b) / m", "x = y / m - b", "x = m(y - b)"],
      },
      {
        equation: "C = 2πr",
        variable: "r",
        correct: "r = C / (2π)",
        distractors: ["r = 2πC", "r = C / π", "r = 2C / π"],
      },
    ];
    const form = r.pick(forms);
    return choiceItem(
      r,
      `Solve ${form.equation} for ${form.variable}.`,
      form.correct,
      form.distractors,
    );
  }),
  T("lin_eq_abs_value", "integer", (r) => {
    const b = r.int(-8, 8);
    const c = r.int(1, 9);
    return signedIntegerItem(
      r,
      `Solve |${slopeInterceptExpr(1, b)}| = ${c}. Give the greater solution.`,
      c - b,
    );
  }),
  T("lin_ineq_multi_step", "integer", (r) => {
    const a = r.int(0, 1) === 0 ? -r.int(2, 5) : r.int(2, 5);
    const p = r.int(-5, 5);
    const boundary = r.int(-7, 9);
    const rhs = a * (boundary + p);
    const solutionIsLess = a > 0;
    return signedIntegerItem(
      r,
      `For integer x, solve ${a}(${slopeInterceptExpr(1, p)}) < ${rhs}. What is the ${solutionIsLess ? "greatest" : "least"} possible x?`,
      solutionIsLess ? boundary - 1 : boundary + 1,
      inequalityPromptVisual(boundary, solutionIsLess ? "less" : "greater", false),
    );
  }),
  T("lin_ineq_compound", "multipleChoice", (r) => {
    const low = r.int(-6, 3);
    const high = low + r.int(2, 6);
    const includeLow = r.int(0, 1) === 0;
    const includeHigh = r.int(0, 1) === 0;
    const lowSym = includeLow ? "≤" : "<";
    const highSym = includeHigh ? "≤" : "<";
    const correct = `${low} ${lowSym} x ${highSym} ${high}`;
    const union = `x ${includeLow ? "<" : "≤"} ${low} or x ${includeHigh ? ">" : "≥"} ${high}`;
    const swapped = `${high} ${lowSym} x ${highSym} ${low}`;
    const flippedInclusivity = `${low} ${includeLow ? "<" : "≤"} x ${includeHigh ? "<" : "≤"} ${high}`;
    return choiceItem(
      r,
      `Which describes every number x that is ${includeLow ? "at least" : "greater than"} ${low} and ${includeHigh ? "at most" : "less than"} ${high}?`,
      correct,
      [union, swapped, flippedInclusivity],
    );
  }),
  T("lin_eq_model_context", "multipleChoice", (r) => {
    const fee = r.int(15, 60);
    let rate = r.int(5, 20);
    if (rate === fee) rate += 1;
    return choiceItem(
      r,
      `A gym charges a one-time fee of $${fee} plus $${rate} per month. Which equation gives the total cost c after x months?`,
      `c = ${rate}x + ${fee}`,
      [`c = ${fee}x + ${rate}`, `c = ${rate}x - ${fee}`, `c = ${rate + fee}x`],
    );
  }),

  // Linear functions (grades 8–9).
  T("fn_identify_function", "multipleChoice", (r) => {
    const xs = [r.int(0, 3), r.int(4, 6), r.int(7, 9)];
    const ys = shuffledNumbers([1, 2, 3, 4, 5, 6, 7, 8, 9], r).slice(0, 3);
    const pair = (x: number, y: number) => `(${x}, ${y})`;
    const correct = `{${pair(xs[0], ys[0])}, ${pair(xs[1], ys[1])}, ${pair(xs[2], ys[2])}}`;
    return choiceItem(
      r,
      "Which set of ordered pairs defines a function?",
      correct,
      [
        `{${pair(xs[0], ys[0])}, ${pair(xs[0], ys[1])}, ${pair(xs[2], ys[2])}}`,
        `{${pair(xs[1], ys[0])}, ${pair(xs[1], ys[1])}, ${pair(xs[2], ys[2])}}`,
        `{${pair(xs[0], ys[0])}, ${pair(xs[2], ys[1])}, ${pair(xs[2], ys[2])}}`,
      ],
    );
  }),
  T("fn_notation_evaluate", "integer", (r) => {
    const m = r.int(0, 1) === 0 ? -r.int(2, 6) : r.int(2, 6);
    const b = r.int(-9, 9);
    const k = r.int(-5, 8);
    return signedIntegerItem(
      r,
      `Given f(x) = ${slopeInterceptExpr(m, b)}, find f(${signedOperand(k)}).`,
      m * k + b,
    );
  }),
  T("slope_two_points", "fraction", (r) => {
    const dx = r.int(0, 1) === 0 ? -r.int(1, 6) : r.int(1, 6);
    const x1 = r.int(-6, 6);
    const x2 = x1 + dx;
    const y1 = r.int(-8, 8);
    const y2 = r.int(-8, 8);
    return {
      stem: `Find the slope of the line through (${x1}, ${y1}) and (${x2}, ${y2}).`,
      answer: fracAns(y2 - y1, dx),
    };
  }),
  T("slope_from_graph", "fraction", (r) => {
    const run = r.pick([1, 2, 3]);
    const rise = r.int(0, 1) === 0 ? -r.int(1, 6) : r.int(1, 6);
    const x1 = r.int(-5, 2);
    const y1 = r.int(-5, 3);
    const points = [
      { x: x1, y: y1, label: "A" },
      { x: x1 + run, y: y1 + rise, label: "B" },
    ];
    return {
      stem: "The line passes through the two plotted points. What is its slope?",
      answer: fracAns(rise, run),
      promptVisual: coordinatePromptVisual(points, "segments"),
    };
  }),
  T("slope_intercept_form", "integer", (r) => {
    const m = r.int(0, 1) === 0 ? -r.int(2, 5) : r.int(2, 5);
    const shift = r.int(-5, 5);
    const b = m * shift;
    return signedIntegerItem(
      r,
      `The line y = ${slopeInterceptExpr(m, b)} crosses the x-axis at (?, 0). What is that x-value?`,
      -shift,
    );
  }),
  T("lin_fn_from_two_points", "integer", (r) => {
    const m = r.int(0, 1) === 0 ? -r.int(2, 5) : r.int(2, 5);
    const b = r.int(-8, 8);
    const x1 = r.int(-5, 5);
    const dx = r.int(0, 1) === 0 ? -r.int(1, 5) : r.int(1, 5);
    const x2 = x1 + dx;
    return signedIntegerItem(
      r,
      `A line passes through (${x1}, ${m * x1 + b}) and (${x2}, ${m * x2 + b}). What is its y-intercept (the y-value where x = 0)?`,
      b,
    );
  }),
  T("lin_fn_point_slope", "integer", (r) => {
    const m = r.int(0, 1) === 0 ? -r.int(2, 5) : r.int(2, 5);
    const x1 = r.int(-5, 6);
    const y1 = r.int(-8, 8);
    const x2 = x1 + (r.int(0, 1) === 0 ? -r.int(1, 5) : r.int(1, 5));
    return signedIntegerItem(
      r,
      `A line has slope ${m} and passes through (${x1}, ${y1}). What is y when x = ${x2}?`,
      y1 + m * (x2 - x1),
    );
  }),
  T("lin_fn_standard_form", "integer", (r) => {
    const A = r.int(2, 6);
    const B = r.int(2, 6);
    if (r.int(0, 1) === 0) {
      const xIntercept = r.int(-6, 6);
      return signedIntegerItem(
        r,
        `For the line ${A}x + ${B}y = ${A * xIntercept} in standard form, what is the x-intercept (the x-value where y = 0)?`,
        xIntercept,
      );
    }
    const yIntercept = r.int(-6, 6);
    return signedIntegerItem(
      r,
      `For the line ${A}x + ${B}y = ${B * yIntercept} in standard form, what is the y-intercept (the y-value where x = 0)?`,
      yIntercept,
    );
  }),
  T("lin_fn_interpret_context", "multipleChoice", (r) => {
    const rate = r.int(15, 45);
    const base = r.int(20, 80);
    if (r.int(0, 1) === 0) {
      return choiceItem(
        r,
        `A tutoring service charges C = ${rate}h + ${base} dollars for h hours. What does ${rate} represent?`,
        "the cost per hour",
        [
          "the one-time base charge",
          "the total cost for 1 hour",
          "the number of hours",
        ],
      );
    }
    return choiceItem(
      r,
      `A tutoring service charges C = ${rate}h + ${base} dollars for h hours. What does ${base} represent?`,
      "the one-time base charge",
      ["the cost per hour", "the total cost for 1 hour", "the number of hours"],
    );
  }),
  T("lin_fn_parallel_perpendicular", "fraction", (r) => {
    const num = r.int(0, 1) === 0 ? -r.int(1, 6) : r.int(1, 6);
    const den = r.int(1, 6);
    const perpendicular = r.int(0, 1) === 0;
    return {
      stem: `A line has slope ${formatAnswer(fracAns(num, den))}. What is the slope of a line ${perpendicular ? "perpendicular" : "parallel"} to it?`,
      answer: perpendicular ? fracAns(-den, num) : fracAns(num, den),
    };
  }),
  T("fn_compare_representations", "multipleChoice", (r) => {
    const slopeA = r.int(1, 8);
    let slopeB = r.int(1, 8);
    if (slopeB === slopeA) slopeB = slopeA === 8 ? slopeA - 1 : slopeA + 1;
    const bA = r.int(-4, 6);
    const cB = r.int(-4, 6);
    return choiceItem(
      r,
      `Function A: y = ${slopeInterceptExpr(slopeA, bA)}. Function B passes through (0, ${cB}) and (1, ${cB + slopeB}). Which has the greater rate of change?`,
      slopeA > slopeB ? "Function A" : "Function B",
      [
        slopeA > slopeB ? "Function B" : "Function A",
        "The rates of change are equal",
      ],
    );
  }),

  // Systems of linear equations (grades 8–9).
  T("sys_solution_meaning", "multipleChoice", (r) => {
    const sx = r.int(-5, 6);
    const sy = r.int(-5, 6);
    return choiceItem(
      r,
      `The graphs of a two-equation system intersect at (${sx}, ${sy}). What does this point represent?`,
      "the ordered pair that satisfies both equations",
      [
        "a solution of only the first equation",
        "a point that satisfies neither equation",
        "the x-intercept shared by both lines",
      ],
    );
  }),
  T("sys_solve_graphing", "integer", (r) => {
    const sx = r.int(-4, 5);
    const sy = r.int(-4, 5);
    const slopeChoices = [-3, -2, -1, 1, 2, 3];
    const m1 = r.pick(slopeChoices);
    const m2 = r.pick(slopeChoices.filter((slope) => slope !== m1));
    const b1 = sy - m1 * sx;
    const b2 = sy - m2 * sx;
    const points = [
      { x: sx - 1, y: m1 * (sx - 1) + b1, label: "A" },
      { x: sx + 2, y: m1 * (sx + 2) + b1, label: "B" },
      { x: sx - 1, y: m2 * (sx - 1) + b2, label: "C" },
      { x: sx + 2, y: m2 * (sx + 2) + b2, label: "D" },
    ];
    return signedIntegerItem(
      r,
      `Solve by graphing: y = ${slopeInterceptExpr(m1, b1)} and y = ${slopeInterceptExpr(m2, b2)}. The graph shows both lines. Give the x-value of the solution.`,
      sx,
      coordinatePromptVisual(points),
    );
  }),
  T("sys_substitution", "integer", (r) => {
    const sx = r.int(-5, 6);
    const sy = r.int(-6, 7);
    const slopeChoices = [-4, -3, -2, -1, 1, 2, 3, 4];
    const m1 = r.pick(slopeChoices);
    const m2 = r.pick(slopeChoices.filter((slope) => slope !== m1));
    const b1 = sy - m1 * sx;
    const b2 = sy - m2 * sx;
    return signedIntegerItem(
      r,
      `Solve the system by substitution: y = ${slopeInterceptExpr(m1, b1)} and y = ${slopeInterceptExpr(m2, b2)}. Give the x-value of the solution.`,
      sx,
    );
  }),
  T("sys_elimination", "integer", (r) => {
    const sx = r.int(-5, 6);
    const sy = r.int(-5, 6);
    const a1 = r.int(1, 5);
    const b1 = r.int(1, 5);
    let a2 = r.int(1, 6);
    let b2 = r.int(1, 6);
    if (a1 * b2 - a2 * b1 === 0) {
      a2 = a1 + 1;
      b2 = b1;
    }
    return signedIntegerItem(
      r,
      `Solve by elimination: ${a1}x + ${b1}y = ${a1 * sx + b1 * sy} and ${a2}x + ${b2}y = ${a2 * sx + b2 * sy}. Give the x-value of the solution.`,
      sx,
    );
  }),
  T("sys_special_cases", "multipleChoice", (r) => {
    const kind = r.pick([
      "exactly one solution",
      "no solution",
      "infinitely many solutions",
    ] as const);
    const a = r.int(1, 4);
    const b = r.int(1, 4);
    const c = r.int(1, 9);
    const secondEquation =
      kind === "infinitely many solutions"
        ? `${2 * a}x + ${2 * b}y = ${2 * c}`
        : kind === "no solution"
          ? `${a}x + ${b}y = ${c + r.int(1, 5)}`
          : `${a + r.int(1, 3)}x + ${b}y = ${c + r.int(0, 4)}`;
    return choiceItem(
      r,
      `How many solutions does this system have?  ${a}x + ${b}y = ${c};  ${secondEquation}`,
      kind,
      [
        "exactly one solution",
        "no solution",
        "infinitely many solutions",
      ].filter((option) => option !== kind),
    );
  }),
  T("sys_model_context", "integer", (r) => {
    const adultPrice = r.int(6, 15);
    const childPrice = r.int(3, adultPrice - 1);
    const adultCount = r.int(2, 8);
    const childCount = r.int(2, 8);
    const totalTickets = adultCount + childCount;
    const totalCost = adultPrice * adultCount + childPrice * childCount;
    return {
      stem: `Adult tickets cost $${adultPrice} and child tickets cost $${childPrice}. A group buys ${totalTickets} tickets for $${totalCost} total. How many adult tickets did they buy?`,
      answer: intAns(adultCount),
    };
  }),
  T("sys_linear_inequalities", "multipleChoice", (r) => {
    const t = r.int(0, 4);
    const cy = t + r.int(0, 3);
    const cx = r.int(0, 5);
    const s = cx + cy + r.int(0, 3);
    const point = (x: number, y: number) => `(${x}, ${y})`;
    return choiceItem(
      r,
      `Which point satisfies both x + y ≤ ${s} and y ≥ ${t}?`,
      point(cx, cy),
      [point(cx, t - 1), point(cx, s - cx + 1), point(s + 2, t)],
    );
  }),

  // ── algebra-1: exponents-exponential / polynomials-factoring / quadratics ──
  // One deterministic family per graph key; every answer correct by
  // construction (the value is drawn first, the stem is built from it).

  // Exponents and exponential functions (grades 8–9).
  T("exp_product_quotient", "integer", (r) => {
    const base = r.pick([2, 3, 5, 10]);
    if (r.int(0, 1) === 0) {
      const m = r.int(2, 6);
      const n = r.int(2, 6);
      return {
        stem: `${base}^${m} · ${base}^${n} = ${base}^n. What is n?`,
        answer: intAns(m + n),
      };
    }
    const n = r.int(1, 4);
    const m = n + r.int(2, 5);
    return {
      stem: `${base}^${m} ÷ ${base}^${n} = ${base}^k. What is k?`,
      answer: intAns(m - n),
    };
  }),
  T("exp_power_rule", "integer", (r) => {
    const base = r.pick([2, 3, 5, 7]);
    const m = r.int(2, 6);
    const n = r.int(2, 5);
    return {
      stem: `(${base}^${m})^${n} = ${base}^k. What is k?`,
      answer: intAns(m * n),
    };
  }),
  T("exp_zero_negative", "fraction", (r) => {
    const base = r.int(2, 5);
    const n = r.int(1, 3);
    return {
      stem: `Evaluate ${base}^${-n}. Give your answer as a fraction.`,
      answer: fracAns(1, Math.pow(base, n)),
    };
  }),
  T("roots_square_cube", "integer", (r) => {
    if (r.int(0, 1) === 0) {
      const root = r.int(2, 15);
      return {
        stem: `Solve x² = ${root * root}. Give the positive solution.`,
        answer: intAns(root),
      };
    }
    const root = r.int(2, 6);
    return {
      stem: `Solve x³ = ${root * root * root}. What is x?`,
      answer: intAns(root),
    };
  }),
  T("roots_simplify_radicals", "expression", (r) => {
    const index = r.pick([2, 3, 4, 5]);
    const b = r.pick(
      index === 2
        ? [2, 3, 5, 6, 7]
        : index === 4
          ? [2, 3, 5, 6, 7, 10]
          : [2, 3, 4, 5, 6, 7, 9, 10],
    );
    const a = r.int(2, index === 5 ? 2 : index === 4 ? 3 : 4);
    const p = Math.pow(a, index) * b;
    const symbol = index === 2 ? "√" : index === 3 ? "∛" : `√[${index}]`;
    return {
      stem: `Simplify ${symbol}${p}.`,
      answer: { type: "expression", canonical: `${a}${symbol}${b}` },
    };
  }),
  T("sci_notation_convert", "integer", (r) => {
    const d1 = r.int(1, 9);
    const d2 = r.int(0, 9);
    const e = r.int(2, 6);
    const value = (d1 * 10 + d2) * Math.pow(10, e - 1);
    return {
      stem: `Write ${value} in scientific notation as a × 10^n with 1 ≤ a < 10. What is n?`,
      answer: intAns(e),
    };
  }),
  T("sci_notation_operations", "integer", (r) => {
    const a = r.pick([2, 3]);
    const b = a === 2 ? r.pick([2, 3, 4]) : r.pick([2, 3]);
    const m = r.int(2, 8);
    const n = r.int(2, 8);
    return {
      stem: `(${a} × 10^${m})(${b} × 10^${n}) is written as p × 10^k with 1 ≤ p < 10. What is k?`,
      answer: intAns(m + n),
    };
  }),
  T("exp_fn_evaluate", "integer", (r) => {
    const a = r.int(1, 5);
    const b = r.int(2, 4);
    const x = r.int(0, 3);
    return {
      stem: `Given f(x) = ${a === 1 ? "" : `${a}·`}${b}^x, find f(${x}).`,
      answer: intAns(a * Math.pow(b, x)),
    };
  }),
  T("exp_growth_decay", "multipleChoice", (r) => {
    const a = r.int(2, 8);
    const growth = r.int(0, 1) === 0;
    const base = growth ? r.pick(["2", "3", "4"]) : r.pick(["0.5", "0.8", "0.9"]);
    return choiceItem(
      r,
      `Does y = ${a}·${base}^x model exponential growth or exponential decay?`,
      growth ? "exponential growth" : "exponential decay",
      [
        growth ? "exponential decay" : "exponential growth",
        "constant (no change)",
      ],
    );
  }),
  T("lin_vs_exp", "multipleChoice", (r) => {
    const exponential = r.int(0, 1) === 0;
    const start = r.int(2, 4);
    let values: number[];
    if (exponential) {
      const ratio = r.pick([2, 3]);
      values = [0, 1, 2, 3].map((k) => start * Math.pow(ratio, k));
    } else {
      const step = r.int(3, 7);
      values = [0, 1, 2, 3].map((k) => start + k * step);
    }
    return choiceItem(
      r,
      `A table shows y-values ${values.join(", ")} at x = 0, 1, 2, 3. Is the pattern linear or exponential?`,
      exponential ? "exponential" : "linear",
      [exponential ? "linear" : "exponential", "neither"],
    );
  }),

  // Polynomials and factoring (grade 9).
  T("poly_classify", "multipleChoice", (r) => {
    const degree = r.pick([1, 2, 3] as const);
    const a = r.int(2, 5);
    const c = r.int(0, 1) === 0 ? -r.int(1, 9) : r.int(1, 9);
    const b = r.int(2, 6);
    const poly =
      degree === 1
        ? `${a}x ${signedConstant(c)}`
        : degree === 2
          ? quadExpr(a, b, c)
          : `${a}x³ ${signedConstant(b)}x ${signedConstant(c)}`;
    const name = degree === 1 ? "linear" : degree === 2 ? "quadratic" : "cubic";
    return choiceItem(
      r,
      `Classify ${poly} by its degree.`,
      name,
      ["constant", "linear", "quadratic", "cubic"].filter(
        (option) => option !== name,
      ),
    );
  }),
  T("poly_add_subtract", "integer", (r) => {
    const a1 = r.int(2, 6);
    const b1 = r.int(-6, 6);
    const c1 = r.int(-8, 8);
    const a2 = r.int(2, 6);
    const b2 = r.int(-6, 6);
    const c2 = r.int(-8, 8);
    const subtract = r.int(0, 1) === 0;
    const coefficient = subtract ? b1 - b2 : b1 + b2;
    return signedIntegerItem(
      r,
      `Simplify (${quadExpr(a1, b1, c1)}) ${subtract ? "-" : "+"} (${quadExpr(a2, b2, c2)}). What is the coefficient of x in the result?`,
      coefficient,
    );
  }),
  T("poly_multiply_monomial", "integer", (r) => {
    const a = r.int(2, 5);
    const p = r.int(2, 5);
    const q = r.int(0, 1) === 0 ? -r.int(2, 6) : r.int(2, 6);
    const c = r.int(-6, 6);
    return signedIntegerItem(
      r,
      `Multiply ${a}x(${quadExpr(p, q, c)}). What is the coefficient of x² in the product?`,
      a * q,
    );
  }),
  T("poly_multiply_binomials", "integer", (r) => {
    const m = r.int(1, 4);
    const n = r.int(1, 4);
    const a = r.int(0, 1) === 0 ? -r.int(2, 6) : r.int(2, 6);
    const b = r.int(0, 1) === 0 ? -r.int(2, 6) : r.int(2, 6);
    return signedIntegerItem(
      r,
      `Expand (${slopeInterceptExpr(m, a)})(${slopeInterceptExpr(n, b)}). What is the coefficient of x in the product?`,
      m * b + n * a,
    );
  }),
  T("poly_special_products", "multipleChoice", (r) => {
    const c = r.int(2, 7);
    if (r.int(0, 1) === 0) {
      const sign = r.int(0, 1) === 0 ? 1 : -1;
      const sc = sign * c;
      return choiceItem(
        r,
        `Expand (${xTerm(sc)})².`,
        quadExpr(1, 2 * sc, c * c),
        [
          quadExpr(1, 0, c * c),
          quadExpr(1, sc, c * c),
          quadExpr(1, -2 * sc, c * c),
        ],
      );
    }
    return choiceItem(
      r,
      `Expand (x + ${c})(x - ${c}).`,
      quadExpr(1, 0, -c * c),
      [
        quadExpr(1, 0, c * c),
        quadExpr(1, 2 * c, -c * c),
        quadExpr(1, -2 * c, -c * c),
      ],
    );
  }),
  T("factor_gcf", "multipleChoice", (r) => {
    const g = r.int(2, 4);
    const coprime = r.pick([
      [2, 3],
      [3, 4],
      [2, 5],
      [3, 5],
      [4, 5],
    ]);
    const a = coprime[0];
    const b = coprime[1];
    return choiceItem(
      r,
      `Factor completely: ${quadExpr(g * a, g * b, 0)}.`,
      `${g}x(${slopeInterceptExpr(a, b)})`,
      [
        `${g}(${quadExpr(a, b, 0)})`,
        `x(${slopeInterceptExpr(g * a, g * b)})`,
        `${g}x(${slopeInterceptExpr(a, b + 1)})`,
      ],
    );
  }),
  T("factor_trinomial_simple", "multipleChoice", (r) => {
    const roots = shuffledNumbers([2, 3, 4, 5, 6, 7], r);
    const r1 = roots[0];
    const r2 = roots[1];
    const b = -(r1 + r2);
    const c = r1 * r2;
    return choiceItem(
      r,
      `Factor ${quadExpr(1, b, c)}.`,
      `(${xTerm(-r1)})(${xTerm(-r2)})`,
      [
        `(${xTerm(r1)})(${xTerm(r2)})`,
        `(${xTerm(-r1)})(${xTerm(r2)})`,
        `(${xTerm(-r1)})(${xTerm(-(r2 + 1))})`,
      ],
    );
  }),
  T("factor_trinomial_general", "multipleChoice", (r) => {
    const m = r.pick([2, 3]);
    const n = m === 2 ? 3 : 2;
    const constants = shuffledNumbers([1, 2, 3, 4], r);
    const p = constants[0];
    const q = constants[1];
    const a = m * n;
    const b = m * q + n * p;
    const c = p * q;
    return choiceItem(
      r,
      `Factor ${quadExpr(a, b, c)}.`,
      `(${slopeInterceptExpr(m, p)})(${slopeInterceptExpr(n, q)})`,
      [
        `(${slopeInterceptExpr(m, q)})(${slopeInterceptExpr(n, p)})`,
        `(${slopeInterceptExpr(m, -p)})(${slopeInterceptExpr(n, -q)})`,
        `(${slopeInterceptExpr(m, p)})(${slopeInterceptExpr(n, q + 1)})`,
      ],
    );
  }),
  T("factor_special_forms", "multipleChoice", (r) => {
    const c = r.int(2, 9);
    if (r.int(0, 1) === 0) {
      return choiceItem(
        r,
        `Factor ${quadExpr(1, 0, -c * c)}.`,
        `(${xTerm(c)})(${xTerm(-c)})`,
        [
          `(${xTerm(c)})(${xTerm(c)})`,
          `(${xTerm(-c)})(${xTerm(-c)})`,
          `(x + ${c * c})(x - 1)`,
        ],
      );
    }
    return choiceItem(
      r,
      `Factor ${quadExpr(1, 2 * c, c * c)}.`,
      `(${xTerm(c)})²`,
      [
        `(${xTerm(-c)})²`,
        `(x + ${c})(x - ${c})`,
        `(${xTerm(2 * c)})²`,
      ],
    );
  }),

  // Quadratics (grade 9).
  T("quad_graph_features", "integer", (r) => {
    const h = r.int(-3, 3);
    const k = r.int(-4, 4);
    const a = r.pick([1, -1]);
    const points = [-2, -1, 0, 1, 2].map((dx) => ({
      x: h + dx,
      y: a * dx * dx + k,
      label: String.fromCharCode(65 + dx + 2),
    }));
    return signedIntegerItem(
      r,
      "The graph shows a parabola. What is the x-coordinate of its vertex?",
      h,
      coordinatePromptVisual(points, "segments"),
    );
  }),
  T("quad_solve_sqrt", "integer", (r) => {
    const a = r.pick([1, 2, 3]);
    const root = r.int(2, 9);
    const lead = a === 1 ? "x²" : `${a}x²`;
    return {
      stem: `Solve ${lead} = ${a * root * root}. Give the positive solution.`,
      answer: intAns(root),
    };
  }),
  T("quad_zero_product", "integer", (r) => {
    const roots = shuffledNumbers([-6, -4, -3, -2, 2, 3, 4, 5, 6], r);
    const r1 = roots[0];
    const r2 = roots[1];
    return signedIntegerItem(
      r,
      `Solve (${xTerm(-r1)})(${xTerm(-r2)}) = 0. Give the larger solution.`,
      Math.max(r1, r2),
    );
  }),
  T("quad_solve_factoring", "integer", (r) => {
    const roots = shuffledNumbers([-6, -5, -3, -2, 2, 3, 4, 6], r);
    const r1 = roots[0];
    const r2 = roots[1];
    const b = -(r1 + r2);
    const c = r1 * r2;
    return signedIntegerItem(
      r,
      `Solve ${quadExpr(1, b, c)} = 0 by factoring. Give the larger solution.`,
      Math.max(r1, r2),
    );
  }),
  T("quad_complete_square", "integer", (r) => {
    const half = r.int(1, 6);
    const b = 2 * half * (r.int(0, 1) === 0 ? 1 : -1);
    return {
      stem: `What number must be added to x² ${signedConstant(b)}x to complete the square?`,
      answer: intAns(half * half),
    };
  }),
  T("quad_formula", "fraction", (r) => {
    const p = r.int(1, 5);
    const q = r.pick([3, 5, 7, 9]);
    const a = 2;
    const b = -(q + 2 * p);
    const c = p * q;
    const largerIsInteger = 2 * p > q;
    return {
      stem: `Solve ${quadExpr(a, b, c)} = 0 with the quadratic formula. Give the larger solution.`,
      answer: largerIsInteger ? fracAns(p, 1) : fracAns(q, 2),
    };
  }),
  T("quad_discriminant", "integer", (r) => {
    const a = r.int(1, 3);
    const b = r.int(-6, 6);
    const c = r.int(0, 1) === 0 ? -r.int(1, 6) : r.int(1, 6);
    return signedIntegerItem(
      r,
      `For ${quadExpr(a, b, c)} = 0, what is the value of the discriminant b² - 4ac?`,
      b * b - 4 * a * c,
    );
  }),
  T("quad_vertex_form", "integer", (r) => {
    const a = r.pick([1, -1, 2, -2]);
    const h = r.int(-4, 4);
    const k = r.int(-6, 6);
    const lead = a === 1 ? "" : a === -1 ? "-" : `${a}`;
    const askX = r.int(0, 1) === 0;
    return signedIntegerItem(
      r,
      `The function y = ${lead}(${xTerm(-h)})² ${signedConstant(k)} is in vertex form. What is the ${askX ? "x" : "y"}-coordinate of its vertex?`,
      askX ? h : k,
    );
  }),
  T("quad_model_context", "integer", (r) => {
    const g = r.int(1, 5);
    const time = r.int(2, 6);
    const v = g * time;
    const lead = g === 1 ? "t²" : `${g}t²`;
    return {
      stem: `A ball's height in meters after t seconds is h = ${v}t - ${lead}. At what time t > 0 does it return to the ground (h = 0)?`,
      answer: intAns(time),
    };
  }),

  // Place value: the 10× relationship, form conversions, powers of ten.
  T("place_value_relationships", "integer", (r) => {
    const digit = r.int(1, 9);
    const lowPlace = r.int(0, 3);
    const highPlace = r.int(lowPlace + 1, 4);
    const n = digit * Math.pow(10, highPlace) + digit * Math.pow(10, lowPlace);
    return {
      stem: `In ${n}, the value of the ${digit} in the ${PLACE_NAMES[highPlace]} place is how many times the value of the ${digit} in the ${PLACE_NAMES[lowPlace]} place?`,
      answer: intAns(Math.pow(10, highPlace - lowPlace)),
    };
  }),
  T("compare_multidigit", "multipleChoice", (r) => {
    const digits = r.pick([4, 5, 6]);
    const lo = Math.pow(10, digits - 1);
    const hi = Math.pow(10, digits) - 1;
    const a = r.int(lo, hi);
    // 1-in-6 of the time pose an equal pair so the "=" option is exercised.
    const b = r.int(0, 5) === 0 ? a : r.int(lo, hi);
    const idx = a < b ? 0 : a === b ? 1 : 2;
    return { stem: `How does ${a} compare to ${b}?`, answer: choiceAns(idx), choices: COMPARE_CHOICES };
  }),
  T("expanded_to_standard_form", "integer", (r) => {
    const digitCount = r.pick([3, 4, 5]);
    // Allow zero digits in non-leading places and OMIT their terms — standard
    // expanded-form convention (407 → "400 + 7", 4007 → "4000 + 7"). The leading
    // digit stays nonzero, and we guarantee at least one more nonzero term so the
    // stem is always a genuine multi-term expansion (never a single "500 = ?").
    const digits = Array.from({ length: digitCount }, (_, i) => r.int(i === 0 ? 1 : 0, 9));
    if (digits.slice(1).every((dgt) => dgt === 0)) digits[digitCount - 1] = r.int(1, 9);
    const n = numberFromDigits(digits);
    const terms = expandedTerms(n, digitCount).filter((term) => term !== 0);
    return { stem: `${terms.join(" + ")} = ?`, answer: intAns(n) };
  }),
  T("number_name_to_standard", "integer", (r) => {
    const n = r.int(21, 9999);
    return { stem: `Write "${spellNumber(n)}" as a numeral.`, answer: intAns(n) };
  }),
  T("powers_of_ten", "integer", (r) => {
    const power = r.pick([10, 100, 1000]);
    if (r.int(0, 1) === 0) {
      const base = r.int(2, 99);
      return { stem: `${base} × ${power} = ?`, answer: intAns(base * power) };
    }
    const quotient = r.int(2, 99);
    return { stem: `${quotient * power} ÷ ${power} = ?`, answer: intAns(quotient) };
  }),

  // Number theory: factor pairs, is-factor, is-multiple, prime/composite,
  // common factors, common multiples.
  T("factor_pairs", "integer", (r) => {
    const n = r.pick([12, 16, 18, 20, 24, 28, 30, 36, 40, 42, 48, 60, 72, 80, 90, 100]);
    return { stem: `How many factor pairs does ${n} have?`, answer: intAns(factorPairCount(n)) };
  }),
  T("is_factor", "multipleChoice", (r) => {
    const k = r.int(2, 12);
    const n = r.int(20, 120);
    return { stem: `Is ${k} a factor of ${n}?`, answer: choiceAns(n % k === 0 ? 1 : 0), choices: YES_NO_CHOICES };
  }),
  T("is_multiple", "multipleChoice", (r) => {
    const k = r.int(2, 9);
    const n = r.int(20, 120);
    return { stem: `Is ${n} a multiple of ${k}?`, answer: choiceAns(n % k === 0 ? 1 : 0), choices: YES_NO_CHOICES };
  }),
  T("prime_or_composite", "multipleChoice", (r) => {
    const n = r.pick([2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 4, 6, 8, 9, 10, 12, 14, 15, 16, 18, 20, 21, 25, 27, 33, 35, 49]);
    // A prime has exactly two factors (1 and itself).
    return { stem: `Is ${n} prime or composite?`, answer: choiceAns(factorCount(n) === 2 ? 0 : 1), choices: PRIME_COMPOSITE_CHOICES };
  }),
  T("common_factors", "integer", (r) => {
    const g = r.int(2, 12);
    const a = g * r.int(1, 6);
    const b = g * r.int(1, 6);
    return { stem: `How many common factors do ${a} and ${b} have?`, answer: intAns(commonFactorCount(a, b)) };
  }),
  T("common_multiples", "multipleChoice", (r) => {
    const a = r.int(2, 9);
    let b = r.int(2, 9);
    if (b === a) b = a === 9 ? a - 1 : a + 1;
    const l = lcm(a, b);
    // Half the time pose a guaranteed common multiple; either way the answer is
    // computed from m, so it's correct regardless of which branch produced m.
    const m = r.int(0, 1) === 0 ? l * r.int(1, 6) : a * r.int(2, 14);
    return {
      stem: `Is ${m} a common multiple of ${a} and ${b}?`,
      answer: choiceAns(m % a === 0 && m % b === 0 ? 1 : 0),
      choices: YES_NO_CHOICES,
    };
  }),

  // Multi-step expression evaluation (order-of-operations on-ramp, no parentheses).
  // Every shape puts the HIGH-precedence op (× / ÷) in a position where reading
  // left-to-right gives the WRONG answer — so the item actually tests precedence,
  // not just left-to-right arithmetic. When the high-precedence op is on the RIGHT
  // of a subtraction, the leading operand is bounded ≥ the product/quotient so the
  // correct result stays non-negative.
  T("two_step_expressions", "integer", (r) => {
    const a = r.int(2, 9);
    const b = r.int(2, 9);
    const c = r.int(2, 9);
    const d = r.int(2, 9);
    const q = r.int(2, 9);
    const product = d * q;
    const shape = r.int(0, 3);
    // shape 0: X + b × c  (× second — L→R would add first)
    if (shape === 0) return { stem: `${a} + ${b} × ${c} = ?`, answer: intAns(a + b * c) };
    // shape 1: X − a × b  (× on the right — L→R would subtract first). X ≥ a×b.
    if (shape === 1) {
      const prod = a * b;
      const x = prod + r.int(0, 20);
      return { stem: `${x} − ${a} × ${b} = ?`, answer: intAns(x - prod) };
    }
    // shape 2: X + product ÷ d  (÷ second — L→R would add first). product/d = q.
    if (shape === 2) return { stem: `${a} + ${product} ÷ ${d} = ?`, answer: intAns(a + q) };
    // shape 3: X − product ÷ d  (÷ on the right — L→R would subtract first). X ≥ q.
    const x = q + r.int(0, 20);
    return { stem: `${x} − ${product} ÷ ${d} = ?`, answer: intAns(x - q) };
  }),

  // ── discrete-math: counting / graph-theory / number-theory / logic ────────
  // One deterministic family per graph key, in graph order; every answer
  // correct by construction (the solution/structure is drawn first, the stem
  // built from it). See scratch-critiques/discrete-math-design.md for the spec.

  // counting (combinatorics), grades 3–8.
  T("count_list_outcomes", "integer", (r) => {
    const first = r.pick(REPEATABLE_ACTIONS);
    const useSame = r.int(0, 1) === 0;
    const second = useSame ? first : r.pick(REPEATABLE_ACTIONS);
    const stem =
      second === first
        ? // Verb-only repeat ("then pick again"), never "pick IT again" — "it"
          // reads as the SAME card/outcome, which would make the answer 1.
          `${capitalize(first.verb)} ${first.label}, then ${first.verb} again. How many different outcomes are possible?`
        : `${capitalize(first.verb)} ${first.label}. Then ${second.verb} ${second.label}. How many different outcomes are possible in total?`;
    return { stem, answer: intAns(first.n * second.n) };
  }),
  T("count_organized_count", "integer", (r) => {
    const scenario = r.pick(ATTRIBUTE_SCENARIOS);
    const a = r.int(2, 5);
    const b = r.int(2, 4);
    return {
      stem: `A ${scenario.object} comes in ${a} ${scenario.attrPlural1} and ${b} ${scenario.attrPlural2}. How many ${scenario.attrSingular1}-and-${scenario.attrSingular2} combinations are there?`,
      answer: intAns(a * b),
    };
  }),
  T("addition_principle", "integer", (r) => {
    const scenario = r.pick(DISJOINT_CASE_SCENARIOS);
    const counts = scenario.categories.map(() => r.int(2, 9));
    const parts = scenario.categories.map((cat, i) => `${counts[i]} ${cat}`);
    return {
      stem: `${scenario.intro} ${joinWithAnd(parts)}. If you pick exactly one item, how many choices do you have?`,
      answer: intAns(counts.reduce((sum, c) => sum + c, 0)),
    };
  }),
  T("multiplication_principle", "integer", (r) => {
    if (r.int(0, 3) === 0) {
      const slots = r.int(2, 4);
      return {
        stem: `A lock code has ${slots} slots, each a digit 0-9. How many codes are possible?`,
        answer: intAns(Math.pow(10, slots)),
      };
    }
    const scenario = r.pick(STAGE_SCENARIOS);
    const stageCount = r.int(2, scenario.stages.length);
    const chosenStages = shuffledNumbers(
      scenario.stages.map((_, i) => i),
      r,
    )
      .slice(0, stageCount)
      .sort((a, b) => a - b)
      .map((i) => scenario.stages[i]);
    const counts = chosenStages.map(() => r.int(2, 6));
    const parts = chosenStages.map((stage, i) => `${counts[i]} choices of ${stage}`);
    return {
      stem: `A ${scenario.noun} has ${joinWithAnd(parts)}. How many different ${scenario.noun}s are possible?`,
      answer: intAns(counts.reduce((p, c) => p * c, 1)),
    };
  }),
  T("factorial_arrangements", "integer", (r) => {
    const n = r.int(3, 7);
    const scenario = r.pick(ORDERING_SCENARIOS);
    return { stem: `In how many different orders can ${n} ${scenario}?`, answer: intAns(factorial(n)) };
  }),
  T("permutations_r_from_n", "integer", (r) => {
    const n = r.int(4, 8);
    const rCount = r.int(2, Math.min(4, n));
    const noun = r.pick(PERM_NOUN_POOL);
    return {
      stem: `From ${n} ${noun}, how many ways can you place ${rCount} in order on a shelf?`,
      answer: intAns(permCount(n, rCount)),
    };
  }),
  T("combinations_r_from_n", "integer", (r) => {
    const n = r.int(4, 9);
    const rCount = r.int(2, Math.min(4, n));
    const noun = r.pick(GROUP_NOUN_POOL);
    return {
      stem: `From ${n} ${noun}, how many ways can you choose a team of ${rCount} (order does not matter)?`,
      answer: intAns(combCount(n, rCount)),
    };
  }),
  T("permutation_vs_combination", "multipleChoice", (r) => {
    const scenario = r.pick(COUNT_SCENARIOS);
    const n = r.int(5, 12);
    const rCount = r.int(2, Math.min(5, n - 1));
    const correct = scenario.order ? "permutation" : "combination";
    return choiceItem(r, scenario.template(n, rCount), correct, [
      scenario.order ? "combination" : "permutation",
      "neither",
    ]);
  }),
  T("count_with_restriction", "integer", (r) => {
    const n = r.int(4, 7);
    const name = r.pick(PEOPLE_NAME_POOL);
    const side = r.pick(["the left end", "the right end"]);
    const forbidden = r.int(0, 1) === 1;
    if (!forbidden) {
      return {
        stem: `How many ways can ${n} people sit in a row if ${name} must sit at ${side}?`,
        answer: intAns(factorial(n - 1)),
      };
    }
    return {
      stem: `How many ways can ${n} people sit in a row if ${name} must NOT sit at ${side}?`,
      answer: intAns(factorial(n) - factorial(n - 1)),
    };
  }),
  T("count_complementary", "integer", (r) => {
    const k = r.int(2, 4);
    const digit = r.int(0, 9);
    const total = Math.pow(10, k);
    return {
      stem: `How many ${k}-digit codes (digits 0-9, repeats allowed) have at least one digit that is not ${digit}? (Total is ${total}.)`,
      answer: intAns(total - 1),
    };
  }),
  T("pigeonhole_basic", "integer", (r) => {
    const k = r.int(3, 8);
    const noun = r.pick(PIGEONHOLE_NOUN_POOL);
    return {
      stem: `${noun} come in ${k} colors. How many ${noun.toLowerCase()} must you grab to be sure of two the same color?`,
      answer: intAns(k + 1),
    };
  }),
  T("pigeonhole_generalized", "integer", (r) => {
    const k = r.int(2, 6);
    const m = r.int(2, 7);
    const remainder = r.int(0, k - 1);
    const n = k * (m - 1) + remainder + 1;
    return {
      stem: `${n} books go on ${k} shelves. Some shelf must hold at least how many books?`,
      answer: intAns(m),
    };
  }),

  // graph-theory, grades 3–7. Every item is rendered from a TEXT edge list.
  T("gt_vertices_edges", "integer", (r) => {
    const n = r.int(3, 6);
    const maxExtra = Math.min(3, Math.max(0, (n * (n - 1)) / 2 - (n - 1)));
    const edges = addExtraEdges(n, randomTree(n, r), r.int(0, maxExtra), r);
    const askEdges = r.int(0, 1) === 0;
    return {
      stem: `A graph has vertices {${vertexListString(n)}} and edges ${edgeListString(edges)}. How many ${askEdges ? "edges" : "vertices"} does it have?`,
      answer: intAns(askEdges ? edges.length : n),
    };
  }),
  T("gt_vertex_degree", "integer", (r) => {
    const n = r.int(4, 6);
    const edges = addExtraEdges(n, randomTree(n, r), r.int(0, 2), r);
    const degrees = degreesOf(n, edges);
    const target = r.int(0, n - 1);
    return {
      stem: `Edges: ${edgeListString(edges)}. What is the degree of vertex ${vertexLabel(target)}?`,
      answer: intAns(degrees[target]),
    };
  }),
  T("gt_degree_sequence", "multipleChoice", (r) => {
    const n = r.int(3, 5);
    const edges = addExtraEdges(n, randomTree(n, r), r.int(0, 1), r);
    const sorted = [...degreesOf(n, edges)].sort((a, b) => b - a);
    const seqStr = (arr: number[]) => `(${arr.join(", ")})`;
    const correct = seqStr(sorted);
    const variantCandidates = [
      [...sorted].reverse(),
      sorted.map((d, i) => (i === 0 ? d + 1 : i === sorted.length - 1 ? Math.max(0, d - 1) : d)),
      sorted.map((d, i) => (i === 0 ? Math.max(0, d - 1) : i === 1 ? d + 1 : d)),
      [...sorted].sort((a, b) => a - b),
      sorted.map((d) => d + 1),
      sorted.map(() => 0),
    ]
      .map(seqStr)
      .filter((s) => s !== correct);
    const distractors = [...new Set(variantCandidates)].slice(0, 3);
    return choiceItem(
      r,
      `For the graph with edges ${edgeListString(edges)}, which is the degree sequence?`,
      correct,
      distractors,
    );
  }),
  T("gt_handshake_sum", "integer", (r) => {
    if (r.int(0, 1) === 0) {
      const e = r.int(3, 12);
      return { stem: `A graph has ${e} edges. What is the sum of all vertex degrees?`, answer: intAns(2 * e) };
    }
    const n = r.int(4, 6);
    const edges = addExtraEdges(n, randomTree(n, r), r.int(0, 2), r);
    const sorted = [...degreesOf(n, edges)].sort((a, b) => b - a);
    return {
      stem: `A graph has degree sequence (${sorted.join(", ")}). How many edges does it have?`,
      answer: intAns(edges.length),
    };
  }),
  T("gt_connected", "multipleChoice", (r) => {
    const n = r.int(4, 6);
    const makeConnected = r.int(0, 1) === 0;
    let edges: [number, number][];
    if (makeConnected) {
      edges = addExtraEdges(n, randomTree(n, r), r.int(0, 2), r);
    } else {
      const split = r.int(1, n - 1);
      const groupA = randomTree(split, r);
      const groupB: [number, number][] = randomTree(n - split, r).map(([a, b]) => [a + split, b + split]);
      edges = [...groupA, ...groupB];
    }
    const connected = isConnectedGraph(n, edges);
    const correct = connected ? "connected" : "not connected";
    return choiceItem(
      r,
      `Vertices {${vertexListString(n)}}; edges ${edgeListString(edges)}. Is the graph connected?`,
      correct,
      [connected ? "not connected" : "connected", "cannot be determined"],
    );
  }),
  T("gt_path_vs_circuit", "multipleChoice", (r) => {
    const k = r.int(3, 5);
    const pool = Array.from({ length: k + 1 }, (_, i) => i);
    const chosen = shuffledNumbers(pool, r).slice(0, k);
    const isCircuit = r.int(0, 1) === 0;
    const extra = pool.find((i) => !chosen.includes(i))!;
    const sequence = isCircuit ? [...chosen, chosen[0]] : [...chosen, extra];
    const walk = sequence.map(vertexLabel).join("→");
    const correct = isCircuit ? "circuit" : "path";
    return choiceItem(r, `A walk goes ${walk}. Is it a path or a circuit?`, correct, [
      isCircuit ? "path" : "circuit",
      "neither",
    ]);
  }),
  T("gt_euler_path", "multipleChoice", (r) => {
    const n = r.int(4, 6);
    const edges = addExtraEdges(n, randomTree(n, r), r.int(0, 3), r);
    const oddCount = degreesOf(n, edges).filter((d) => d % 2 === 1).length;
    const exists = oddCount === 0 || oddCount === 2;
    return choiceItem(
      r,
      `A graph has edges ${edgeListString(edges)} and is connected. Does an Euler path exist?`,
      exists ? "yes" : "no",
      [exists ? "no" : "yes", "cannot be determined"],
    );
  }),
  T("gt_complete_edges", "integer", (r) => {
    const n = r.int(3, 8);
    return { stem: `How many edges does a complete graph on ${n} vertices have?`, answer: intAns((n * (n - 1)) / 2) };
  }),
  T("gt_tree_definition", "multipleChoice", (r) => {
    const n = r.int(4, 7);
    const isTree = r.int(0, 1) === 0;
    const edgeCount = isTree ? n - 1 : n - 1 + r.int(1, 2);
    const correct = isTree ? "tree" : "not a tree";
    return choiceItem(
      r,
      `A connected graph on ${n} vertices has ${edgeCount} edges. Is it a tree?`,
      correct,
      [isTree ? "not a tree" : "tree", "cannot be determined"],
    );
  }),
  T("gt_tree_edges", "integer", (r) => {
    const n = r.int(3, 12);
    return { stem: `A tree has ${n} vertices. How many edges does it have?`, answer: intAns(n - 1) };
  }),
  T("gt_bipartite", "multipleChoice", (r) => {
    const n = r.int(3, 8);
    const bipartite = n % 2 === 0;
    const correct = bipartite ? "bipartite" : "not bipartite";
    return choiceItem(r, `A cycle graph has ${n} vertices in a ring. Is it bipartite?`, correct, [
      bipartite ? "not bipartite" : "bipartite",
      "cannot be determined",
    ]);
  }),
  T("gt_coloring", "integer", (r) => {
    const kind = r.pick(["complete", "cycle", "tree"] as const);
    if (kind === "complete") {
      const n = r.int(3, 6);
      const description = n === 3 ? "a triangle" : `a complete graph on ${n} vertices`;
      return {
        stem: `What is the fewest colors needed so no two adjacent vertices of ${description} share a color?`,
        answer: intAns(n),
      };
    }
    if (kind === "cycle") {
      const n = r.int(3, 8);
      return {
        stem: `What is the fewest colors needed so no two adjacent vertices of a cycle graph with ${n} vertices in a ring share a color?`,
        answer: intAns(n % 2 === 0 ? 2 : 3),
      };
    }
    const n = r.int(2, 8);
    return {
      stem: `What is the fewest colors needed so no two adjacent vertices of a tree with ${n} vertices share a color?`,
      answer: intAns(2),
    };
  }),

  // number-theory, grades 5–9.
  T("nt_parity_classify", "multipleChoice", (r) => {
    const flavor = r.pick(["number", "sum", "product"] as const);
    let value: number;
    let stem: string;
    if (flavor === "number") {
      value = r.int(2, 999);
      stem = `Is ${value} even or odd?`;
    } else if (flavor === "sum") {
      const a = r.int(2, 50);
      const b = r.int(2, 50);
      value = a + b;
      stem = `Is ${a} + ${b} even or odd?`;
    } else {
      const a = r.int(2, 20);
      const b = r.int(2, 20);
      value = a * b;
      stem = `Is ${a} × ${b} even or odd?`;
    }
    const correct = value % 2 === 0 ? "even" : "odd";
    return choiceItem(r, stem, correct, [correct === "even" ? "odd" : "even", "neither"]);
  }),
  T("nt_parity_argument", "multipleChoice", (r) => {
    const op = r.pick(["plus", "times"] as const);
    const p1 = r.pick(["odd", "even"] as const);
    const p2 = r.pick(["odd", "even"] as const);
    const flag = (p: "odd" | "even") => (p === "odd" ? 1 : 0);
    const resultOdd = op === "plus" ? (flag(p1) + flag(p2)) % 2 === 1 : flag(p1) === 1 && flag(p2) === 1;
    const correct = resultOdd ? "odd" : "even";
    return choiceItem(r, `An ${p1} number ${op} an ${p2} number is always…`, correct, [
      correct === "odd" ? "even" : "odd",
      "neither",
    ]);
  }),
  T("nt_parity_proof", "multipleChoice", (r) => {
    const total = r.int(2, 4);
    const p = r.int(0, total);
    const q = total - p;
    const minSum = p * 1 + q * 2;
    const shouldMatch = r.int(0, 1) === 0;
    const delta = shouldMatch ? r.int(0, 8) * 2 : r.int(0, 8) * 2 + 1;
    const target = minSum + delta;
    const parts = [...Array(p).fill("odd"), ...Array(q).fill("even")];
    const shuffledParts = shuffledNumbers(
      parts.map((_, i) => i),
      r,
    ).map((i) => parts[i]);
    const correct = shouldMatch ? "possible" : "impossible";
    return choiceItem(r, `Can ${shuffledParts.join(" + ")} equal ${target}?`, correct, [
      shouldMatch ? "impossible" : "possible",
      "cannot be determined",
    ]);
  }),
  T("nt_modular_clock", "integer", (r) => {
    const m = r.int(3, 12);
    const s = r.int(0, m - 1);
    const k = r.int(1, 40);
    const displayStart = s === 0 ? m : s;
    return {
      stem: `On a ${m}-hour clock, what hour is it ${k} hours after ${displayStart}? (Answer 0–${m - 1}.)`,
      answer: intAns((s + k) % m),
    };
  }),
  T("nt_mod_cycle", "multipleChoice", (r) => {
    // A genuine repeating-cycle item (the node's skill is "reduce a large case
    // to its position in the cycle") — the first draft asked plain division,
    // which never exercised the cycle (Sol review 2026-08-19, finding 4).
    // Position k in a repeating pattern of length m: the 1-indexed k-th item is
    // the cycle entry at (k − 1) mod m.
    const cycle = r.pick(CYCLE_PATTERNS);
    const m = cycle.items.length;
    const k = r.int(40, 400);
    const answer = cycle.items[(k - 1) % m];
    return choiceItem(
      r,
      `A row of ${cycle.noun} repeats the pattern ${cycle.items.join(", ")} over and over. What is the ${ordinal(k)} ${cycle.singular}?`,
      answer,
      cycle.items.filter((c) => c !== answer),
    );
  }),
  T("nt_modular_arithmetic", "integer", (r) => {
    const m = r.int(3, 12);
    const a = r.int(0, m * 3);
    const b = r.int(0, m * 3);
    const useMul = r.int(0, 1) === 1;
    const raw = useMul ? a * b : a + b;
    return { stem: `What is (${a} ${useMul ? "×" : "+"} ${b}) mod ${m}?`, answer: intAns(raw % m) };
  }),
  T("nt_last_digit", "integer", (r) => {
    const base = r.int(2, 9);
    const exp = r.int(2, 12);
    return { stem: `What is the last digit of ${base}^${exp}?`, answer: intAns(modPow(base, exp, 10)) };
  }),
  T("nt_divisibility_proof", "multipleChoice", (r) => {
    // Mutually exclusive, computed classification — the old "divisible by
    // WHICH of {3, 9, 11}" shape was ambiguous whenever n was a multiple of
    // more than one (every multiple of 9 is a multiple of 3; 284/500 sampled
    // items had two correct options — Sol review 2026-08-19, finding 2).
    const shape = r.pick(["digitSum", "alternating"] as const);
    if (shape === "digitSum") {
      const n = r.int(120, 9999);
      const sum = digitSum(n);
      const by9 = sum % 9 === 0;
      const by3 = sum % 3 === 0;
      const correct = by9 ? "both 3 and 9" : by3 ? "3 but not 9" : "neither";
      return choiceItem(
        r,
        `${n} has digit sum ${sum}. By the digit-sum rule, ${n} is divisible by…`,
        correct,
        ["both 3 and 9", "3 but not 9", "neither"].filter((c) => c !== correct),
      );
    }
    const n = r.int(120, 9999);
    const alt = altDigitSum(n);
    const by11 = alt % 11 === 0;
    return choiceItem(
      r,
      `${n} has alternating digit sum (right to left, + − + −…) ${alt}. By the rule for 11, is ${n} divisible by 11?`,
      by11 ? "yes" : "no",
      [by11 ? "no" : "yes", "cannot be determined"],
    );
  }),
  T("nt_prime_test_deeper", "multipleChoice", (r) => {
    const n = r.int(100, 199);
    const prime = isPrime(n);
    const rootApprox = Math.round(Math.sqrt(n));
    return choiceItem(r, `Is ${n} prime or composite? (Hint: test to √${n} ≈ ${rootApprox}.)`, prime ? "prime" : "composite", [
      prime ? "composite" : "prime",
      "neither",
    ]);
  }),
  T("nt_twin_primes", "integer", (r) => {
    const u = r.pick([20, 30, 40, 50, 60, 70, 80, 90, 100]);
    return {
      stem: `How many twin-prime pairs (p, p+2) are there with both primes below ${u}?`,
      answer: intAns(countTwinPrimesBelow(u)),
    };
  }),
  T("nt_prime_gaps", "integer", (r) => {
    const i = r.int(0, PRIMES_TO_97.length - 2);
    const p1 = PRIMES_TO_97[i];
    const p2 = PRIMES_TO_97[i + 1];
    return { stem: `What is the gap between the consecutive primes ${p1} and ${p2}?`, answer: intAns(p2 - p1) };
  }),
  T("nt_gcd_euclid", "integer", (r) => {
    const a = r.int(12, 96);
    const b = r.int(12, 96);
    return { stem: `Use the Euclidean algorithm: what is gcd(${a}, ${b})?`, answer: intAns(gcd(a, b)) };
  }),
  T("nt_linear_congruence", "integer", (r) => {
    const n = r.pick([5, 7, 11, 13]);
    // a ≥ 2: a coefficient of 1 makes the congruence a triviality ("1x ≡ b").
    const a = r.int(2, n - 1);
    const x = r.int(0, n - 1);
    const b = (a * x) % n;
    return {
      stem: `Find the whole number x with 0 ≤ x < ${n} satisfying ${a}x ≡ ${b} (mod ${n}).`,
      answer: intAns(x),
    };
  }),

  // logic, grades 3–7. Every node is a decision, so every family is multipleChoice.
  T("lg_truth_value", "multipleChoice", (r) => {
    const flavor = r.pick(["compare", "equation"] as const);
    let stem: string;
    let truth: boolean;
    if (flavor === "compare") {
      const a = r.int(1, 20);
      const b = r.int(1, 20);
      const rel = r.pick(["greater than", "less than", "equal to"] as const);
      const actual = a > b ? "greater than" : a < b ? "less than" : "equal to";
      truth = rel === actual;
      stem = `Is the statement '${a} is ${rel} ${b}' true or false?`;
    } else {
      const a = r.int(1, 20);
      const b = r.int(1, 20);
      const trueSum = a + b;
      const shown = r.int(0, 1) === 0 ? trueSum : trueSum + r.pick([-2, -1, 1, 2, 3]);
      truth = shown === trueSum;
      stem = `Is the statement '${a} + ${b} = ${shown}' true or false?`;
    }
    return choiceItem(r, stem, truth ? "true" : "false", [truth ? "false" : "true", "cannot be determined"]);
  }),
  T("lg_and", "multipleChoice", (r) => {
    const f1 = randomFact(r);
    const f2 = randomFact(r);
    const truth = f1.truth && f2.truth;
    return choiceItem(r, `'${f1.text} AND ${f2.text}.' Is the whole statement true?`, truth ? "true" : "false", [
      truth ? "false" : "true",
      "cannot be determined",
    ]);
  }),
  T("lg_or", "multipleChoice", (r) => {
    const f1 = randomFact(r);
    const f2 = randomFact(r);
    const truth = f1.truth || f2.truth;
    return choiceItem(r, `'${f1.text} OR ${f2.text}.' True or false?`, truth ? "true" : "false", [
      truth ? "false" : "true",
      "cannot be determined",
    ]);
  }),
  T("lg_not", "multipleChoice", (r) => {
    const f = randomFact(r);
    const truth = !f.truth;
    return choiceItem(r, `'It is NOT true that ${f.text}.' True or false?`, truth ? "true" : "false", [
      truth ? "false" : "true",
      "cannot be determined",
    ]);
  }),
  T("lg_compound_truth", "multipleChoice", (r) => {
    const p1 = r.int(0, 1) === 1;
    const p2 = r.int(0, 1) === 1;
    const p3 = r.int(0, 1) === 1;
    const op1 = r.pick(["AND", "OR"] as const);
    const op2 = r.pick(["AND", "OR"] as const);
    const inner = op1 === "AND" ? p1 && p2 : p1 || p2;
    const result = op2 === "AND" ? inner && !p3 : inner || !p3;
    const label = (b: boolean) => (b ? "True" : "False");
    return choiceItem(
      r,
      `'(${label(p1)} ${op1} ${label(p2)}) ${op2} NOT ${label(p3)}.' Evaluate.`,
      result ? "true" : "false",
      [result ? "false" : "true", "cannot be determined"],
    );
  }),
  T("lg_negate", "multipleChoice", (r) => {
    const item = r.pick(NEGATION_ITEMS);
    return choiceItem(r, `What is the negation of '${item.statement}'?`, item.correct, item.distractors);
  }),
  T("lg_if_then", "multipleChoice", (r) => {
    const hyp = randomFact(r);
    const con = randomFact(r);
    const truth = !hyp.truth || con.truth;
    return choiceItem(r, `'If ${hyp.text}, then ${con.text}.' Is this conditional true?`, truth ? "true" : "false", [
      truth ? "false" : "true",
      "cannot be determined",
    ]);
  }),
  T("lg_converse", "multipleChoice", (r) => {
    const item = r.pick(CONVERSE_ITEMS);
    // Two shapes per the node's label ("write the converse AND judge its truth
    // separately" — Sol review 2026-08-19, finding 5): recognize the converse,
    // or judge the converse's truth independently of the original.
    const shape = r.pick(["recognize", "judge"] as const);
    if (shape === "recognize") {
      return choiceItem(r, `What is the converse of '${item.statement}'?`, item.correct, item.distractors);
    }
    return choiceItem(
      r,
      `'${item.statement}' is true. Is its converse — '${item.correct}' — also true?`,
      item.converseTrue ? "yes" : "no, the converse is a different claim and fails",
      [item.converseTrue ? "no, the converse is a different claim and fails" : "yes", "a conditional and its converse always match"],
    );
  }),
  T("lg_counterexample", "multipleChoice", (r) => {
    const item = r.pick(COUNTEREXAMPLE_ITEMS);
    return choiceItem(r, `Which value disproves '${item.claim}'?`, item.correct, item.distractors);
  }),
  T("lg_knights_knaves", "multipleChoice", (r) => {
    const name = r.pick(KNIGHT_NAMES);
    const kind = r.pick(["selfLiar", "objTrue", "objFalse"] as const);
    let statementText: string;
    let correct: string;
    if (kind === "selfLiar") {
      // The classic liar paradox: neither assignment is consistent, so this is
      // the ONE scenario whose forced conclusion is "impossible / paradox"
      // rather than a role.
      statementText = "I am a liar";
      correct = "impossible / paradox";
    } else if (kind === "objTrue") {
      // An objectively TRUE statement is consistent only if the speaker is a
      // truth-teller (a liar could never truthfully state it).
      let fact = randomFact(r);
      let guard = 0;
      while (!fact.truth && guard < 30) {
        fact = randomFact(r);
        guard++;
      }
      statementText = fact.text;
      correct = "Truth-teller";
    } else {
      // An objectively FALSE statement is consistent only if the speaker is a
      // liar (a truth-teller could never state it).
      let fact = randomFact(r);
      let guard = 0;
      while (fact.truth && guard < 30) {
        fact = randomFact(r);
        guard++;
      }
      statementText = fact.text;
      correct = "Liar";
    }
    const stem = `${name} says '${statementText}.' Only truth-tellers and liars live here. What is ${name}?`;
    const distractors = ["Truth-teller", "Liar", "impossible / paradox"].filter((o) => o !== correct);
    return choiceItem(r, stem, correct, distractors);
  }),
  T("lg_deduce_clues", "multipleChoice", (r) => {
    const indices = shuffledNumbers(
      FRIEND_NAMES.map((_, i) => i),
      r,
    ).slice(0, 3);
    const names = indices.map((i) => FRIEND_NAMES[i]);
    // names[0] finished 1st, names[1] 2nd, names[2] 3rd — the two clues below
    // are transitive, so together they force the full order.
    const clue1 = `${names[0]} beat ${names[1]}`;
    const clue2 = `${names[1]} beat ${names[2]}`;
    const clues = r.int(0, 1) === 0 ? [clue1, clue2] : [clue2, clue1];
    const askIndex = r.int(0, 2);
    const ordinal = ["1st", "2nd", "3rd"][askIndex];
    const correct = names[askIndex];
    return choiceItem(
      r,
      `Three friends finished 1st, 2nd, 3rd. ${clues[0]}. ${clues[1]}. Who came ${ordinal}?`,
      correct,
      names.filter((n) => n !== correct),
    );
  }),
];

const BY_KEY = new Map(TEMPLATES.map((t) => [t.skillKey, t]));

/** Whether a parameterized template exists for a skill. */
export function hasTemplate(skillKey: string): boolean {
  return BY_KEY.has(skillKey);
}

/** Legacy exhaustive-regression keys; Wave A+ templates have dedicated coverage. */
export function templatedSkillKeys(): string[] {
  return [...BY_KEY.keys()].filter((key) => !NEW_COVERAGE_SKILL_KEYS.has(key) && key !== "order_of_operations");
}

/** EVERY registered template family key — the authoritative set the placement
 *  warmth-floor family-coverage test sweeps (every family must yield a non-empty
 *  reveal line, Tier 1 or Tier 2). */
export function allTemplatedSkillKeys(): string[] {
  return [...BY_KEY.keys()];
}

/** Compute a binary variant's result (the direct answer it stands for). */
function variantResult(v: ItemVariant): number {
  return v.op === "+" ? v.a + v.b : v.op === "−" ? v.a - v.b : v.a * v.b;
}

/**
 * The MISSING-OPERAND form (C1, §6): reshape a direct `a op b = result` into
 * `? op b = result` / `a op ? = result`, answer = the hidden operand. Inverse
 * thinking on the same fact — plain standards (1.OA.D.8 / 3.OA.A.4). Consumes
 * ONE rng draw (which operand to hide) so it's deterministic + re-derivable at
 * grade time from the same seed. Answer is always a typed integer (the hidden
 * operand) — both touch pads expose a `±` sign-toggle key, so a negative
 * hidden operand needs no multiple-choice fallback.
 */
function missingOperandForm(
  v: ItemVariant,
  rng: Rng,
): { stem: string; answer: TypedAnswer } {
  const result = variantResult(v);
  const hideLeft = rng.int(0, 1) === 0;
  const stem = hideLeft
    ? `? ${v.op} ${signedOperand(v.b)} = ${result}`
    : `${signedOperand(v.a)} ${v.op} ? = ${result}`;
  const hidden = hideLeft ? v.a : v.b;
  return { stem, answer: intAns(hidden) };
}

/**
 * Generate one concrete item for a skill, or null if no template exists.
 * `form` optionally serves a relational variant (C1, §6); it falls back to the
 * direct item unless the skill explicitly supports that form and exposes the
 * needed operands. The returned `form` reflects what was ACTUALLY applied (so
 * the itemId encodes it faithfully).
 */
export function generateItem(skillKey: string, seed: number, form?: string): PracticeItem | null {
  const t = BY_KEY.get(skillKey);
  if (!t) return null;
  const rng = makeRng(seed);
  const base = t.gen(rng);
  if (
    form === "missing" &&
    MISSING_OPERAND_FORM_SKILLS.has(skillKey) &&
    base.variant
  ) {
    const v = missingOperandForm(base.variant, rng);
    // No `answerUnit`: the hidden operand of "? × 13 = 26" is a bare number even
    // when the direct item measured centimetres.
    return {
      skillKey,
      stem: v.stem,
      answer: v.answer,
      answerType: "integer",
      source: "template",
      form: "missing",
    };
  }
  return {
    skillKey,
    stem: base.stem,
    answer: base.answer,
    answerType: t.answerType,
    choices: base.choices,
    promptVisual: base.promptVisual,
    workedSteps: base.workedSteps,
    ...(base.variant ? { variant: base.variant } : {}),
    ...(t.answerUnit ? { answerUnit: t.answerUnit } : {}),
    source: "template",
  };
}

/**
 * Generate a set of `count` distinct items (deduped by stem). Deterministic in
 * `seed`; if a template can't produce enough distinct variants it returns what
 * it could (never loops forever).
 */
export function generateSet(skillKey: string, count: number, seed: number): PracticeItem[] {
  if (!BY_KEY.has(skillKey)) return [];
  const out: PracticeItem[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < count * 12 && out.length < count; i++) {
    const item = generateItem(skillKey, seed + i * 2654435761);
    const identity = item ? itemIdentity(item) : null;
    if (item && identity && !seen.has(identity)) {
      seen.add(identity);
      out.push(item);
    }
  }
  return out;
}

/**
 * The canonical RENDERED identity of a generated item — stem plus its visual
 * (countables collapse to n/motif/layout, scatter also keys on its seed). Two
 * different `(skillKey, seed)` draws that render the SAME question collapse to
 * the same identity here, which is why serve-time recent-item dedupe must key
 * off this and not the itemId alone (`generateSet` already relies on it).
 */
export function itemIdentity(item: PracticeItem): string {
  const visual = item.promptVisual;
  if (visual?.kind === "countables") {
    const base = `${item.stem}::countables:${visual.n}:${visual.motif}:${visual.layout}`;
    return visual.layout === "scatter" ? `${base}:${visual.seed}` : base;
  }
  if (visual) return `${item.stem}::visual:${JSON.stringify(visual)}`;
  return item.stem;
}
