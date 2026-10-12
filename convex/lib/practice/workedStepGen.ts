/**
 * Deterministic worked-step generators for TEMPLATE practice items — the
 * content layer behind teach-as-action. When a scholar taps "I haven't learned
 * this yet", `teachingStep` (convex/practiceSkills.ts) hands back ONE interactive
 * faded step; that only fires when the item carries `workedSteps`. Almost every
 * DRILL item is TEMPLATE-generated (convex/lib/practice/templates.ts) and had
 * none, so the teaching moment degraded to reveal-only nearly always.
 *
 * These pure functions emit the SAME `WorkedStep[]` shape the stored fixtures use
 * (text + blankText per step — see fadedSteps.ts / the seedFadedWorkedExamples
 * fixtures), built deterministically from an item's own operands + its computed
 * answer. Discipline: the FINAL step always embeds `formatAnswer(answer)`, so the
 * answer-producing step is arithmetically consistent with the item by
 * construction (property-tested in convex/__tests__/workedStepGen.test.ts). The
 * teaching moment forces a single-blank fade (level 1), so only the final step is
 * ever blanked — the early steps are the revealed scaffold.
 *
 * Pure module (no Convex/React deps); every family here is a mechanical,
 * canonical procedure. Families whose steps would be forced or trivially
 * single-step deliberately emit none (teachingStep degrades to reveal-only).
 *
 * ── THE PROGRESS RULE (2026-07-25, the 816 ÷ 6 report) ──────────────────────
 * Because the teaching moment blanks exactly ONE step — the last — the final
 * step IS the whole instruction a stuck scholar receives. So every family here
 * must satisfy two invariants, both enforced by the scaffold-progress audit
 * (evals/scaffold-progress/):
 *
 *   1. THE TERMINAL MOVE IS SMALLER THAN THE PROBLEM. The final step's
 *      arithmetic must operate on values the earlier steps COMPUTED, never on
 *      the stem's own operands with the stem's own operation. A scaffold that
 *      ends `816 ÷ 6 = 136` has handed the scholar back the problem they just
 *      said they couldn't do. (Exception: a purely NOTATIONAL final move —
 *      "place the decimal point in 557" — is legitimate; it isn't arithmetic.)
 *   2. NO EARLIER STEP MAY ASSERT THE ANSWER. If a revealed step already prints
 *      `= <answer>`, finishing the blank is copying, not thinking. Every builder
 *      here decomposes an operand into genuinely smaller pieces (place-value
 *      parts, a fact × a power of ten) so the answer only appears in the final,
 *      blanked step. When no such honest decomposition exists (a single-place
 *      factor that is already atomic, a single-digit quotient) the builder emits
 *      NO steps — reveal-only is a first-class outcome, better than a rung that
 *      lies about the move or leaves the whole problem in the blank.
 *
 * And one copy rule: the FINAL step's `blankText` must NAME the move ("Add the
 * partial quotients: ?"), never merely point at it ("Work out the last step").
 */

import { type TypedAnswer, formatAnswer } from "./answers";
import type { WorkedStep } from "./fadedSteps";

/**
 * Generic fallback blankText for a family whose final move has no better name.
 * Prefer a SPECIFIC blank — the teaching moment blanks exactly one step, so this
 * sentence is the entire instruction the scholar reads. "Work out the last step"
 * names no operation; "Add the partial quotients: ?" does.
 */
const FINISH = "Work out the last step to get the answer: ?";

/** Split a positive integer into its non-zero place-value parts, high→low
 *  (638 → [600, 30, 8]; 605 → [600, 5]). Used by the partial-products +
 *  place-value step builders. */
function placeParts(n: number): number[] {
  const parts: number[] = [];
  const s = String(Math.abs(n));
  for (let i = 0; i < s.length; i++) {
    const digit = Number(s[i]);
    if (digit !== 0) parts.push(digit * Math.pow(10, s.length - 1 - i));
  }
  return parts.length > 0 ? parts : [0];
}

/**
 * Place-value parts, high→low, for any n ≥ 10 that has ≥2 non-zero places
 * (638 → [600, 30, 8]). A SINGLE-place number (80, 300, 1000) has only one
 * part; callers must decide what to do with it — there is no honest way to
 * "break it apart by place value" into more than one piece, so the builders
 * either factor out the power of ten (300 × n → (3 × n) × 100) or decompose the
 * OTHER operand instead, and fall back to reveal-only when neither applies.
 */

/** The number of decimal places in a generated decimal LABEL ("6.6" → 1). */
function decimalPlacesOf(label: string): number {
  const dot = label.indexOf(".");
  return dot === -1 ? 0 : label.length - dot - 1;
}

/** Scale by a power of ten and round away binary-float dust — every value these
 *  builders scale is mathematically an integer. */
function scaleToInt(value: number, places: number): number {
  return Math.round(value * Math.pow(10, places));
}

/** "1 place" / "2 places" — used by the decimal builders' final rung. */
function placeWord(n: number): string {
  return `${n} place${n === 1 ? "" : "s"}`;
}

// ── Fraction arithmetic ─────────────────────────────────────────────────────

/** a/d ± b/d (like denominators). */
export function fractionAddSubtractLikeSteps(
  a: number,
  b: number,
  d: number,
  op: "+" | "−",
  answer: TypedAnswer,
): WorkedStep[] {
  const num = op === "+" ? a + b : a - b;
  const verb = op === "+" ? "add" : "subtract";
  return [
    {
      text: `The denominators are the same (${d}), so keep it and ${verb} the numerators: ${a} ${op} ${b} = ${num}.`,
      blankText: `Keep the denominator and ${verb} the numerators: ?`,
    },
    {
      text: `Write over the denominator and simplify: ${num}/${d} = ${formatAnswer(answer)}.`,
      blankText: `Write ${num}/${d} in simplest form: ?`,
    },
  ];
}

/** a/d1 ± b/d2 (unlike denominators; the template uses d1·d2 as the common
 *  denominator, so the steps do too). */
export function fractionAddSubtractUnlikeSteps(
  a: number,
  d1: number,
  b: number,
  d2: number,
  op: "+" | "−",
  answer: TypedAnswer,
): WorkedStep[] {
  const D = d1 * d2;
  const left = a * d2;
  const right = b * d1;
  const num = op === "+" ? left + right : left - right;
  return [
    {
      text: `Find a common denominator for ${d1} and ${d2}: ${D}.`,
      blankText: "Find a common denominator: ?",
    },
    {
      text: `Rewrite both over ${D}: ${a}/${d1} = ${left}/${D} and ${b}/${d2} = ${right}/${D}.`,
      blankText: "Rewrite both fractions over the common denominator: ?",
    },
    {
      text: `${op === "+" ? "Add" : "Subtract"} the numerators and simplify: ${left} ${op} ${right} = ${num}, so ${num}/${D} = ${formatAnswer(answer)}.`,
      blankText: `${op === "+" ? "Add" : "Subtract"} the numerators over ${D}, then simplify: ?`,
    },
  ];
}

/** n × a/b (fraction times a whole number). */
export function fractionTimesWholeSteps(
  n: number,
  a: number,
  b: number,
  answer: TypedAnswer,
): WorkedStep[] {
  return [
    {
      text: `Multiply the whole number by the numerator and keep the denominator: ${n} × ${a} = ${n * a}, over ${b}.`,
      blankText: `Multiply the whole number by the numerator: ?`,
    },
    {
      text: `So ${n} × ${a}/${b} = ${n * a}/${b} = ${formatAnswer(answer)}.`,
      blankText: `Write ${n * a}/${b} in simplest form: ?`,
    },
  ];
}

/** a/b × c/d. */
export function fractionMultiplySteps(
  a: number,
  b: number,
  c: number,
  d: number,
  answer: TypedAnswer,
): WorkedStep[] {
  return [
    {
      text: `Multiply straight across: ${a} × ${c} = ${a * c} on top, ${b} × ${d} = ${b * d} on the bottom.`,
      blankText: "Multiply the numerators, then the denominators: ?",
    },
    {
      text: `So ${a}/${b} × ${c}/${d} = ${a * c}/${b * d} = ${formatAnswer(answer)}.`,
      blankText: `Write ${a * c}/${b * d} in simplest form: ?`,
    },
  ];
}

/** a/b ÷ c/d (multiply by the reciprocal). */
export function fractionDivideSteps(
  a: number,
  b: number,
  c: number,
  d: number,
  answer: TypedAnswer,
): WorkedStep[] {
  return [
    {
      text: `Dividing means multiply by the reciprocal: ${a}/${b} ÷ ${c}/${d} = ${a}/${b} × ${d}/${c}.`,
      blankText: "Flip the second fraction and multiply: ?",
    },
    {
      text: `Multiply across and simplify: ${a} × ${d} = ${a * d} over ${b} × ${c} = ${b * c}, so ${a * d}/${b * c} = ${formatAnswer(answer)}.`,
      blankText: `Multiply ${a}/${b} × ${d}/${c} across and simplify: ?`,
    },
  ];
}

/** 1/b ÷ n (unit fraction divided by a whole number). */
export function unitFractionDividedByWholeSteps(
  b: number,
  n: number,
  answer: TypedAnswer,
): WorkedStep[] {
  return [
    {
      text: `Dividing by ${n} means multiply by 1/${n}: 1/${b} × 1/${n}.`,
      blankText: `Multiply by the reciprocal of ${n}: ?`,
    },
    {
      text: `Multiply across: 1/(${b} × ${n}) = 1/${b * n} = ${formatAnswer(answer)}.`,
      blankText: `Multiply the denominators — 1/(${b} × ${n}): ?`,
    },
  ];
}

/** n ÷ 1/b (whole number divided by a unit fraction). */
export function wholeDividedByUnitFractionSteps(
  n: number,
  b: number,
  answer: TypedAnswer,
): WorkedStep[] {
  return [
    {
      text: `Dividing by 1/${b} means multiply by ${b}: ${n} × ${b}.`,
      blankText: `Multiply by the reciprocal of 1/${b}: ?`,
    },
    {
      // Lead with the ARITHMETIC, not the conclusion. The teaching moment's
      // tier-2 hint is derived by blanking result positions in this text, so a
      // conclusion-first sentence ("So 2 ÷ 1/8 = 16, which is 16.") derives a
      // hint that has thrown the actual move away.
      text: `${n} × ${b} = ${n * b}, so ${n} ÷ 1/${b} = ${formatAnswer(answer)}.`,
      blankText: `Multiply ${n} × ${b}: ?`,
    },
  ];
}

// ── Whole-number multiplication (partial products) ──────────────────────────

/** Partial products of `x × y`, decomposing `x` into its place-value `parts`
 *  (each a genuine place, so "break apart by place value" is honest). The final
 *  step adds the partial products — smaller than the original multiplication. */
function partialProductsByParts(
  x: number,
  y: number,
  parts: number[],
  answer: TypedAnswer,
): WorkedStep[] {
  const products = parts.map((p) => p * y);
  return [
    {
      text: `Break ${x} apart by place value: ${parts.join(" + ")}.`,
      blankText: `Break ${x} apart by place value: ?`,
    },
    {
      text: `Multiply each part by ${y}: ${parts.map((p, i) => `${p} × ${y} = ${products[i]}`).join(", ")}.`,
      blankText: `Multiply each part by ${y}: ?`,
    },
    {
      text: `Add the partial products: ${products.join(" + ")} = ${formatAnswer(answer)}.`,
      blankText: "Add the partial products: ?",
    },
  ];
}

/**
 * a × b, decomposing a factor by place value into partial products. Works for
 * 2-digit × 1-digit, 3-digit × 1-digit, and 2-digit × 2-digit.
 *
 * A single-place `a` (30, 80, 300) has only ONE place-value part, so it can't be
 * "broken apart by place value". How it's handled depends on the leading digit:
 *   • lead ≥ 2 (30, 800): factor out the power of ten — a × b = (lead × b) × pow,
 *     a genuine "fact then scale" move (300 × 7 → 3 × 7 = 21, then × 100).
 *   • lead = 1 (a is a pure power of ten: 10, 100): multiplying by it is a place
 *     shift, not a decomposition. If the OTHER factor has place-value structure,
 *     distribute the shift over ITS places (10 × 55 → 50 × 10 + 5 × 10). If `b`
 *     is also single-place there is no honest move smaller than the problem —
 *     "10 × 7 = 70" is a single fact — so emit nothing (reveal-only).
 */
export function partialProductsSteps(
  a: number,
  b: number,
  answer: TypedAnswer,
): WorkedStep[] {
  const partsA = placeParts(a);
  if (partsA.length >= 2 || a < 10) return partialProductsByParts(a, b, partsA, answer);

  const pow = Math.pow(10, String(a).length - 1);
  const lead = a / pow;
  if (lead >= 2) {
    return [
      {
        text: `${a} is ${lead} × ${pow}, so set the ${pow} aside for a moment.`,
        blankText: `Rewrite ${a} as a single digit times a power of ten: ?`,
      },
      {
        text: `Multiply the easy part first: ${lead} × ${b} = ${lead * b}.`,
        blankText: `Multiply ${lead} × ${b}: ?`,
      },
      {
        text: `Put the ${pow} back: ${lead * b} × ${pow} = ${formatAnswer(answer)}.`,
        blankText: `Put the ${pow} back — multiply by ${pow}: ?`,
      },
    ];
  }

  // lead === 1: `a` is a pure power of ten. Distribute the shift over `b`'s
  // places when it has more than one; otherwise there is nothing smaller to do.
  const partsB = placeParts(b);
  if (partsB.length < 2) return [];
  return partialProductsByParts(b, a, partsB, answer);
}

// ── Whole-number multi-digit addition / subtraction ─────────────────────────

/**
 * a + b (multi-digit), taught as a place-value CHAIN: break the second number
 * into its true place-value parts and add them onto a running total one at a
 * time. The blank is the last (smallest) part only. When `b` occupies a single
 * place (3000, 500) there is nothing to break apart — adding it is one
 * place-value move with no honest smaller sub-step — so emit nothing
 * (reveal-only) rather than a fabricated split.
 */
export function columnAddSteps(a: number, b: number, answer: TypedAnswer): WorkedStep[] {
  const parts = placeParts(b);
  if (parts.length < 2) return [];
  const lead = parts.slice(0, -1);
  const last = parts[parts.length - 1];
  let running = a;
  const chain: string[] = [];
  for (const p of lead) {
    const next = running + p;
    chain.push(`${running} + ${p} = ${next}`);
    running = next;
  }
  return [
    {
      text: `Break ${b} apart by place value: ${parts.join(" + ")}.`,
      blankText: `Break ${b} apart by place value: ?`,
    },
    {
      text: `Add the parts on one at a time: ${chain.join(", then ")}.`,
      blankText: `Add the parts of ${b} on one at a time: ?`,
    },
    {
      text: `Add the last part: ${running} + ${last} = ${formatAnswer(answer)}.`,
      blankText: `Add the last part — ${running} + ${last}: ?`,
    },
  ];
}

/**
 * a − b (multi-digit), taught as a place-value CHAIN: break the number being
 * taken away into its true place-value parts and subtract them one at a time.
 * Chaining also sidesteps multi-column borrowing, which is usually the thing a
 * stuck scholar is stuck on. When `b` occupies a single place (900, 3000) there
 * is nothing to break apart — taking it away is one place-value move with no
 * honest smaller sub-step — so emit nothing (reveal-only).
 */
export function columnSubtractSteps(a: number, b: number, answer: TypedAnswer): WorkedStep[] {
  const parts = placeParts(b);
  if (parts.length < 2) return [];
  const lead = parts.slice(0, -1);
  const last = parts[parts.length - 1];
  let running = a;
  const chain: string[] = [];
  for (const p of lead) {
    const next = running - p;
    chain.push(`${running} − ${p} = ${next}`);
    running = next;
  }
  return [
    {
      text: `Break ${b} apart by place value: ${parts.join(" + ")}.`,
      blankText: `Break ${b} apart by place value: ?`,
    },
    {
      text: `Take the parts away one at a time: ${chain.join(", then ")}.`,
      blankText: `Take the parts of ${b} away one at a time: ?`,
    },
    {
      text: `Take away the last part: ${running} − ${last} = ${formatAnswer(answer)}.`,
      blankText: `Take away the last part — ${running} − ${last}: ?`,
    },
  ];
}

// ── Long division (division as inverse multiplication) ──────────────────────

/**
 * dividend ÷ divisor with a whole-number quotient, taught by PARTIAL QUOTIENTS —
 * the mirror of `partialProductsSteps`. The old scaffold restated the problem
 * ("think of division as the missing factor: 6 × ? = 816") and then asked the
 * scholar to finish, which left the entire original division in the blank. Here
 * the dividend is chunked into pieces that divide cleanly, each chunk is divided
 * for the scholar, and the blank is the ADDITION of the partial quotients —
 * strictly smaller than the problem, and it honours the chunking a scholar who
 * splits 816 into friendlier pieces is already doing on their own.
 *
 * The chunks come from the quotient's place values (136 → 100 + 30 + 6, so the
 * chunks are 600 + 180 + 36), which makes every partial division a single-digit
 * fact scaled by a power of ten. When the quotient occupies a single place (700,
 * 50) there is nothing to chunk, so the scaffold peels the zeros instead —
 * divide the small part, then scale back up. When the quotient is a single DIGIT
 * (q < 10) there is neither structure to chunk nor a zero to peel, and no honest
 * middle rung exists (see below), so it degrades to reveal-only.
 */
export function longDivisionSteps(
  dividend: number,
  divisor: number,
  answer: TypedAnswer,
): WorkedStep[] {
  const quotient = dividend / divisor;
  if (!Number.isInteger(quotient) || quotient <= 0 || divisor <= 0) return [];

  const parts = placeParts(quotient);
  if (parts.length >= 2) {
    const chunks = parts.map((p) => p * divisor);
    return [
      {
        text: `Break ${dividend} into chunks that divide by ${divisor} easily: ${chunks.join(" + ")}.`,
        blankText: `Break ${dividend} into chunks that divide by ${divisor}: ?`,
      },
      {
        text: `Divide each chunk by ${divisor}: ${chunks
          .map((c, i) => `${c} ÷ ${divisor} = ${parts[i]}`)
          .join(", ")}.`,
        blankText: `Divide each chunk by ${divisor}: ?`,
      },
      {
        text: `Add the partial quotients: ${parts.join(" + ")} = ${formatAnswer(answer)}.`,
        blankText: "Add the partial quotients: ?",
      },
    ];
  }

  // Single-DIGIT quotient: there is no place-value structure to chunk and no
  // zeros to peel. The only honest frame is division-as-counting, but its answer
  // IS the count of groups — every intermediate value (the multiples 6, 12, 18…)
  // is larger than the quotient, and the only sentence that yields the quotient
  // is the bare division "dividend ÷ divisor = q", i.e. the stem itself. So there
  // is no move to leave in the blank that is both honest and smaller than the
  // problem: any middle rung either restates the division or discloses the count
  // in a revealed step. Degrade to reveal-only (as `quotient < 2` already does).
  if (quotient < 10) return [];

  // Single-place quotient (700, 50, …): peel the zeros, divide the small part,
  // then scale back up. The blank is the scale-up — a × 10 / × 100 move.
  const pow = Math.pow(10, String(quotient).length - 1);
  const lead = quotient / pow;
  const small = dividend / pow;
  return [
    {
      text: `${dividend} is ${small} × ${pow}, so set the ${pow} aside for a moment.`,
      blankText: `Rewrite ${dividend} as a smaller number times a power of ten: ?`,
    },
    {
      text: `Divide the small part: ${small} ÷ ${divisor} = ${lead}.`,
      blankText: `Divide the small part by ${divisor}: ?`,
    },
    {
      text: `Put the ${pow} back: ${lead} × ${pow} = ${formatAnswer(answer)}.`,
      blankText: `Put the ${pow} back — multiply by ${pow}: ?`,
    },
  ];
}

// ── Order of operations (a shared two-step PEMDAS frame) ────────────────────

/** A two-step "do this first, then that" frame for an order-of-operations item.
 *  `firstText` states the higher-precedence sub-step (revealed); `finalText`
 *  finishes with the answer embedded (blanked in the teaching moment), and
 *  `finalBlank` NAMES that remaining move — it is the only instruction the
 *  scholar reads in the teaching moment, so it must not be generic. */
export function orderOfOperationsSteps(
  firstText: string,
  firstBlank: string,
  finalText: string,
  finalBlank: string = FINISH,
): WorkedStep[] {
  return [
    { text: firstText, blankText: firstBlank },
    { text: finalText, blankText: finalBlank },
  ];
}

// ── Decimals ─────────────────────────────────────────────────────────────────

/** Write a/10 or a/100 as a decimal — place-value NOTATION, not arithmetic.
 *  Two steps per the S4 fix sketch: (1) name the place the denominator points to
 *  (tenths for /10, hundredths for /100), then (2) write the numerator's digits
 *  into that place — filling an empty tenths spot with a zero on the hundredths
 *  shape (so 5/100 = 0.05, not 0.5). The FINAL step embeds `formatAnswer(answer)`,
 *  so it is consistent with the item by construction (property-tested). */
export function decimalNotationSteps(
  a: number,
  d: 10 | 100,
  answer: TypedAnswer,
): WorkedStep[] {
  const isHundredths = d === 100;
  const placeName = isHundredths ? "hundredths" : "tenths";
  const spotClause = isHundredths
    ? "the second spot after the decimal point (two places)"
    : "the first spot right after the decimal point";
  const fillNote = isHundredths
    ? ", writing a 0 in the tenths spot if the top number has only one digit"
    : "";
  return [
    {
      text: `The bottom number is ${d}, so this is ${placeName} — ${spotClause}.`,
      blankText: `What place does a bottom number of ${d} mean? ?`,
    },
    {
      text: `Write ${a} into the ${placeName}${fillNote}: ${a}/${d} = ${formatAnswer(answer)}.`,
      blankText: `Write ${a} into the ${placeName}: ?`,
    },
  ];
}

/**
 * left ± right (decimals). The old scaffold said "line up the decimal points"
 * and then put `left ± right` in the blank — the original problem. Here the
 * lining-up is actually DONE (both padded to the same number of places), the
 * digits are combined as whole numbers, and the blank is the notation move:
 * put the point back. That mirrors `decimalMultiplySteps`, so the two decimal
 * families teach one consistent frame.
 */
export function decimalAddSubtractSteps(
  leftLabel: string,
  rightLabel: string,
  op: "+" | "−",
  answer: TypedAnswer,
): WorkedStep[] {
  const places = Math.max(decimalPlacesOf(leftLabel), decimalPlacesOf(rightLabel));
  const leftPadded = Number(leftLabel).toFixed(places);
  const rightPadded = Number(rightLabel).toFixed(places);
  const leftInt = scaleToInt(Number(leftLabel), places);
  const rightInt = scaleToInt(Number(rightLabel), places);
  const combined = op === "+" ? leftInt + rightInt : leftInt - rightInt;
  const verb = op === "+" ? "add" : "subtract";
  return [
    {
      text: `Give both the same number of decimal places so the points line up: ${leftPadded} ${op} ${rightPadded}.`,
      blankText: "Write both with the same number of decimal places: ?",
    },
    {
      text: `With the points lined up the digits ${verb} like whole numbers: ${leftInt} ${op} ${rightInt} = ${combined}.`,
      blankText: `Ignore the points and ${verb} the digits: ?`,
    },
    {
      text: `Put the decimal point back ${placeWord(places)} from the right: ${formatAnswer(answer)}.`,
      blankText: `Put the decimal point back ${placeWord(places)} from the right: ?`,
      // A notation rung has no `= answer` to strip, so the derived hint would
      // just repeat the blank. Name the digits the point goes into instead.
      hintText: `You're placing the point in ${combined}, counting ${placeWord(places)} from the right: ?`,
    },
  ];
}

/** A decimal product, taught by "multiply as whole numbers, then place the
 *  point". `wholeProduct` is the digits multiplied ignoring the points;
 *  `places` is the total number of decimal places across the two factors. */
export function decimalMultiplySteps(
  leftLabel: string,
  rightLabel: string,
  wholeProduct: number,
  places: number,
  answer: TypedAnswer,
): WorkedStep[] {
  return [
    {
      text: `Ignore the decimal points and multiply the digits: this gives ${wholeProduct}.`,
      blankText: "Multiply as if there were no decimal points: ?",
    },
    {
      text: `The factors have ${placeWord(places)} in total, so put the point ${placeWord(places)} into ${wholeProduct}: ${formatAnswer(answer)}.`,
      blankText: `Put the decimal point ${placeWord(places)} from the right of ${wholeProduct}: ?`,
    },
  ];
}

// ── Probability ──────────────────────────────────────────────────────────────

/** P(event) = favorable / total, then simplify. Shared by the two "count
 *  favorable over total" families (theoretical_probability_simple +
 *  probability_as_fraction). */
export function probabilityFractionSteps(
  favorable: number,
  total: number,
  answer: TypedAnswer,
): WorkedStep[] {
  return [
    {
      text: `Count the favorable outcomes (${favorable}) out of all the equally likely outcomes (${total}).`,
      blankText: "Count the favorable outcomes and the total: ?",
    },
    {
      text: `Write that as a fraction and simplify: ${favorable}/${total} = ${formatAnswer(answer)}.`,
      blankText: `Write ${favorable}/${total} in simplest form: ?`,
    },
  ];
}

/** P(not event) = 1 − P(event). `eventFav`/`total` describe the event itself;
 *  the complement's favorable count is `total − eventFav`. */
export function complementProbabilitySteps(
  eventFav: number,
  total: number,
  answer: TypedAnswer,
): WorkedStep[] {
  const complementFav = total - eventFav;
  return [
    {
      text: `First find the probability of the event happening: ${eventFav}/${total}.`,
      blankText: "Write the probability of the event happening: ?",
    },
    {
      text: `Subtract from 1 for the complement: 1 − ${eventFav}/${total} = ${complementFav}/${total} = ${formatAnswer(answer)}.`,
      blankText: `Take ${eventFav}/${total} away from 1, then simplify: ?`,
    },
  ];
}

/** Expected count over `trials` when each trial has probability
 *  `probNum`/`probDen`: multiply trials by the probability. */
export function expectedFrequencySteps(
  trials: number,
  probNum: number,
  probDen: number,
  answer: TypedAnswer,
): WorkedStep[] {
  return [
    {
      text: `The probability on one try is ${probNum}/${probDen}.`,
      blankText: "Write the probability for a single try: ?",
    },
    {
      text: `Multiply the number of tries by the probability: ${trials} × ${probNum}/${probDen} = ${formatAnswer(answer)}.`,
      blankText: `Multiply ${trials} × ${probNum}/${probDen}: ?`,
    },
  ];
}

/** Count the total outcomes across independent stages: multiply the number of
 *  outcomes at each stage (the counting principle). */
export function sampleSpaceSteps(factors: number[], answer: TypedAnswer): WorkedStep[] {
  return [
    {
      text: `Count the outcomes at each stage: ${factors.join(" and ")}.`,
      blankText: "Count the outcomes possible at each stage: ?",
    },
    {
      text: `Multiply them together: ${factors.join(" × ")} = ${formatAnswer(answer)}.`,
      blankText: `Multiply ${factors.join(" × ")}: ?`,
    },
  ];
}

// ── Statistics (mean / median / range) ──────────────────────────────────────

/** Mean: add every value, then divide by how many there are. */
export function meanSteps(values: number[], answer: TypedAnswer): WorkedStep[] {
  const sum = values.reduce((acc, v) => acc + v, 0);
  return [
    {
      text: `Add all the values: ${values.join(" + ")} = ${sum}.`,
      blankText: "Add all the values together: ?",
    },
    {
      text: `Divide by how many there are (${values.length}): ${sum} ÷ ${values.length} = ${formatAnswer(answer)}.`,
      blankText: `Divide the total by how many there are — ${sum} ÷ ${values.length}: ?`,
    },
  ];
}

/** Median: order the values, then take the middle (or average the middle two
 *  when the count is even). */
export function medianSteps(values: number[], answer: TypedAnswer): WorkedStep[] {
  const sorted = [...values].sort((a, b) => a - b);
  const isOdd = sorted.length % 2 === 1;
  const finalText = isOdd
    ? `With ${sorted.length} values in order, the middle one is ${formatAnswer(answer)}.`
    : `With ${sorted.length} values in order, average the middle two to get ${formatAnswer(answer)}.`;
  const medianBlank = isOdd
    ? `Take the middle value of ${sorted.join(", ")}: ?`
    : `Average the middle two of ${sorted.join(", ")}: ?`;
  return [
    {
      text: `Put the values in order from least to greatest: ${sorted.join(", ")}.`,
      blankText: "Put the values in order from least to greatest: ?",
    },
    { text: finalText, blankText: medianBlank },
  ];
}

/** Range: the largest value minus the smallest. */
export function rangeSteps(values: number[], answer: TypedAnswer): WorkedStep[] {
  const max = Math.max(...values);
  const min = Math.min(...values);
  return [
    {
      text: `Find the largest value (${max}) and the smallest value (${min}).`,
      blankText: "Find the largest and smallest values: ?",
    },
    {
      text: `Subtract the smallest from the largest: ${max} − ${min} = ${formatAnswer(answer)}.`,
      blankText: `Subtract the smallest from the largest — ${max} − ${min}: ?`,
    },
  ];
}

/**
 * A decimal quotient. The old scaffold's first step said "rewrite so you're
 * dividing by a whole number (multiply both by the same power of 10 if needed)"
 * and then printed the UNCHANGED problem — a no-op instruction, and often a
 * misleading one (the divisor was frequently already whole). Here the rewrite is
 * actually performed when it's needed and skipped when it isn't, the division is
 * done on whole numbers, and the blank is the notation move: put the point back.
 */
export function decimalDivideSteps(
  dividendLabel: string,
  divisorLabel: string,
  answer: TypedAnswer,
): WorkedStep[] {
  const dividend = Number(dividendLabel);
  const divisor = Number(divisorLabel);
  const quotient = dividend / divisor;
  if (!Number.isFinite(quotient) || divisor === 0) return [];

  const steps: WorkedStep[] = [];

  // Rung 1 — only when the divisor actually has a decimal point to clear.
  const divisorPlaces = decimalPlacesOf(divisorLabel);
  const scale = Math.pow(10, divisorPlaces);
  const wholeDivisor = scaleToInt(divisor, divisorPlaces);
  const scaledDividend = divisorPlaces === 0 ? dividend : dividend * scale;
  const scaledDividendLabel =
    divisorPlaces === 0 ? dividendLabel : String(Number(scaledDividend.toFixed(6)));
  if (divisorPlaces > 0) {
    steps.push({
      text: `Multiply both by ${scale} so you're dividing by a whole number: ${scaledDividendLabel} ÷ ${wholeDivisor}.`,
      blankText: `Multiply both by ${scale} to make the divisor whole: ?`,
    });
  }

  // Rung 2 — divide as whole numbers. Scale the dividend up far enough that the
  // quotient is a whole number too (0.1 ÷ 0.2 becomes 10 ÷ 2 = 5).
  // Take the quotient's decimal places from its FORMATTED label, never from
  // String(quotient) — 15.3 / 9 is 1.7000000000000002 in binary floating point,
  // which would ask the scholar to move the point 16 places.
  const shift = Math.max(
    decimalPlacesOf(scaledDividendLabel),
    decimalPlacesOf(formatAnswer(answer)),
  );
  const wholeDividend = scaleToInt(scaledDividend, shift);
  const wholeQuotient = scaleToInt(quotient, shift);
  steps.push({
    text: `Ignore the decimal point and divide as whole numbers: ${wholeDividend} ÷ ${wholeDivisor} = ${wholeQuotient}.`,
    blankText: `Ignore the point and divide: ${wholeDividend} ÷ ${wholeDivisor} = ?`,
  });

  if (shift > 0) {
    steps.push({
      text: `Put the decimal point back ${placeWord(shift)} from the right: ${formatAnswer(answer)}.`,
      blankText: `Put the decimal point back ${placeWord(shift)} from the right: ?`,
      hintText: `You're placing the point in ${wholeQuotient}, counting ${placeWord(shift)} from the right: ?`,
    });
  } else {
    // Nothing to re-point: the scaled division IS the last move, so blank that
    // rather than tacking on a no-op notation step that copies the answer.
    steps[steps.length - 1] = {
      text: `Now it's whole numbers: ${wholeDividend} ÷ ${wholeDivisor} = ${formatAnswer(answer)}.`,
      blankText: `Divide ${wholeDividend} ÷ ${wholeDivisor}: ?`,
    };
  }
  return steps.length >= 2 ? steps : [];
}

// ── Discrete math: combinatorics ─────────────────────────────────────────────
// The break-node families PR #2527 shipped as bare {stem, answer} generators.
// Every value below is recomputed from the SAME operands the template drew, so
// the final step is answer-consistent by construction; earlier steps name the
// conceptual move without ever asserting the final value (verified by the
// gradeable-leak sweep in workedStepGen.test.ts).

/** P(n, r): place `r` of `n` in order. The conceptual move is recognising that
 *  order matters (so multiply the `r` descending factors from `n`); the final
 *  move is the product. Two genuine moves. */
export function permutationsSteps(n: number, r: number, answer: TypedAnswer): WorkedStep[] {
  const factors = Array.from({ length: r }, (_, i) => n - i);
  const product = factors.join(" × ");
  return [
    {
      text: `Order matters here, so multiply ${r} factors counting down from ${n}: ${product}.`,
      blankText: `Write the ${r} factors counting down from ${n}: ?`,
    },
    {
      text: `Multiply them: ${product} = ${formatAnswer(answer)}.`,
      blankText: `Multiply ${product}: ?`,
    },
  ];
}

/** Generalized pigeonhole: `n` items over `k` groups forces some group to hold
 *  at least ⌈n/k⌉. State the principle (spread evenly, the leftover forces one
 *  group higher), then round up — the value only appears in the final step. */
export function pigeonholeSteps(n: number, k: number, answer: TypedAnswer): WorkedStep[] {
  return [
    {
      // Honest whether or not k divides n: with a leftover the fullest group
      // sits above the even share; with none it sits exactly at it. "At least
      // the even share, rounded up" covers both, so no seed misteaches.
      text: `Spread the ${n} as evenly as possible over the ${k} groups — the fullest group can never hold less than the even share, rounded up.`,
      blankText: `Spread ${n} as evenly as possible over ${k} groups — what bounds the fullest group? (the even share, rounded up)`,
    },
    {
      text: `So the fullest group holds at least ⌈${n} ÷ ${k}⌉ = ${formatAnswer(answer)}.`,
      blankText: `Round ${n} ÷ ${k} up to a whole number: ?`,
    },
  ];
}

/** Counting principle: `n1` outcomes then `n2` outcomes → n1 × n2 total. */
export function countListOutcomesSteps(n1: number, n2: number, answer: TypedAnswer): WorkedStep[] {
  return [
    {
      text: `Each of the ${n1} first outcomes can pair with each of the ${n2} second outcomes.`,
      blankText: `How do ${n1} first outcomes combine with ${n2} second outcomes? (pair each with each)`,
    },
    {
      text: `Multiply the counts: ${n1} × ${n2} = ${formatAnswer(answer)}.`,
      blankText: `Multiply ${n1} × ${n2}: ?`,
    },
  ];
}

// ── Discrete math: number theory ─────────────────────────────────────────────

const NT_GCD = (a: number, b: number): number => (b === 0 ? Math.abs(a) : NT_GCD(b, a % b));

/** Every divisor of n, ascending (1, …, n). */
function divisorsOf(n: number): number[] {
  const out: number[] = [];
  for (let d = 1; d <= n; d++) if (n % d === 0) out.push(d);
  return out;
}

/** The gap between consecutive primes is the difference — name the move, then
 *  subtract. */
export function primeGapSteps(p1: number, p2: number, answer: TypedAnswer): WorkedStep[] {
  return [
    {
      text: `The gap between two consecutive primes is how far apart they sit — subtract the smaller from the larger.`,
      blankText: `What is the gap between consecutive primes? (larger minus smaller)`,
    },
    {
      text: `Subtract: ${p2} − ${p1} = ${formatAnswer(answer)}.`,
      blankText: `Subtract ${p2} − ${p1}: ?`,
    },
  ];
}

/** Count twin-prime pairs (p, p+2) below `u`: list the pairs, then count them.
 *  The pair list is prose (no single recoverable value), so it never leaks the
 *  count even when a listed prime equals it. */
export function twinPrimesSteps(u: number, answer: TypedAnswer): WorkedStep[] {
  const pairs: string[] = [];
  for (let p = 2; p + 2 < u; p++) {
    if (isPrimeLocal(p) && isPrimeLocal(p + 2)) pairs.push(`(${p}, ${p + 2})`);
  }
  return [
    {
      text: `List the twin-prime pairs (p, p+2) with both primes below ${u}: ${pairs.join(", ")}.`,
      blankText: `List the twin-prime pairs below ${u}: ?`,
    },
    {
      text: `Count the pairs: ${formatAnswer(answer)}.`,
      blankText: `Count the pairs you listed: ?`,
    },
  ];
}

function isPrimeLocal(n: number): boolean {
  if (n < 2) return false;
  for (let d = 2; d * d <= n; d++) if (n % d === 0) return false;
  return true;
}

/** Classify n from its positive-factor count. */
export function primeCompositeSteps(
  n: number,
  classification: "Prime" | "Composite",
): WorkedStep[] {
  const divisors = divisorsOf(n);
  return [
    {
      text: `List every whole number that divides ${n} exactly: ${divisors.join(", ")}.`,
      blankText: `List every factor of ${n}: ?`,
    },
    {
      text: `${n} has ${divisors.length} positive factors, so it is ${classification}.`,
      blankText: `Count the factors of ${n}: ? — so is ${n} prime or composite?`,
    },
  ];
}

/** Read an exponent off a given prime factorization. When the asked prime has
 *  an EXPLICIT exponent, the rule ("read the small raised number") scaffolds
 *  without answering. When the asked exponent is the implicit 1, the only rule
 *  that helps IS the answer ("no raised number means 1") — there is no honest
 *  scaffold, so return [] and let the coach carry it, matching the
 *  intermediate-equals-answer precedents above. */
export function primeFactorizationExponentSteps(
  prime: number,
  factorizationText: string,
  answer: TypedAnswer,
): WorkedStep[] {
  if (answer.type === "integer" && answer.value === 1) return [];
  return [
    {
      text: `A prime's exponent is the small raised number written just after it in the factorization.`,
      blankText: `Where do you read a prime's exponent? (the small raised number after it)`,
    },
    {
      text: `In ${factorizationText}, the exponent of ${prime} is ${formatAnswer(answer)}.`,
      blankText: `Read the exponent of ${prime} in ${factorizationText}: ?`,
    },
  ];
}

/** Remainder of n ÷ {2, 5, 10}. Genuine decomposition would be artificial (the
 *  remainder is a one-glance last-digit fact), so this is a reveal-only rule
 *  restatement + the labelled result — the last digit's VALUE is never shown, so
 *  the mod-10 case does not hand back the answer. */
export function divisibilityRuleSteps(n: number, divisor: number, answer: TypedAnswer): WorkedStep[] {
  return [
    {
      text: `For ${divisor}, only the last digit of ${n} decides the remainder — the earlier digits are already multiples of ${divisor}.`,
      blankText: `Which digit of ${n} decides the remainder when dividing by ${divisor}? (the last one)`,
    },
    {
      text: `So ${n} ÷ ${divisor} leaves remainder ${formatAnswer(answer)}.`,
      blankText: `What remainder does ${n} ÷ ${divisor} leave? ?`,
    },
  ];
}

/** Common factors of a and b = factors of their gcd. Three genuine moves: the
 *  common factors are exactly the divisors of the gcd; find that gcd, list its
 *  divisors, count. The gcd is stated inside a longer clause (not a lone
 *  `= gcd`), so it is never recovered as the answer even when gcd equals the
 *  count. */
export function commonFactorsSteps(a: number, b: number, answer: TypedAnswer): WorkedStep[] {
  const g = NT_GCD(a, b);
  const divisors = divisorsOf(g);
  return [
    {
      text: `A common factor of ${a} and ${b} must divide both, so it divides their greatest common factor — find that first.`,
      blankText: `What must every common factor of ${a} and ${b} divide? (their gcd)`,
    },
    {
      text: `gcd(${a}, ${b}) is ${g}, and its divisors are ${divisors.join(", ")}.`,
      blankText: `Find gcd(${a}, ${b}) and list its divisors: ?`,
    },
    {
      text: `Count the common factors: ${formatAnswer(answer)}.`,
      blankText: `Count the divisors of the gcd: ?`,
    },
  ];
}

// ── Exponents / two-step expressions ─────────────────────────────────────────

/** b^e as repeated multiplication: expand into e copies of b, then multiply. */
export function exponentRepeatedMultSteps(base: number, exponent: number, answer: TypedAnswer): WorkedStep[] {
  const expansion = Array.from({ length: exponent }, () => String(base)).join(" × ");
  return [
    {
      text: `${base}^${exponent} means ${exponent} copies of ${base} multiplied together: ${expansion}.`,
      blankText: `Write ${base}^${exponent} as repeated multiplication: ?`,
    },
    {
      text: `Multiply them out: ${expansion} = ${formatAnswer(answer)}.`,
      blankText: `Multiply ${expansion}: ?`,
    },
  ];
}

/** A two-step expression where the ×/÷ part is done before the +/− part.
 *  `highExpr` (e.g. "6 × 4") evaluates to `highResult`; then `lowLead lowOp
 *  highResult` gives the answer. When the intermediate equals the answer there
 *  is no honest scaffold (the first step would print the answer) — return [].*/
export function twoStepExpressionSteps(
  highExpr: string,
  highResult: number,
  lowLead: number,
  lowOp: "+" | "−",
  answer: TypedAnswer,
): WorkedStep[] {
  if (answer.type === "integer" && answer.value === highResult) return [];
  const verb = lowOp === "+" ? "add" : "subtract";
  return [
    {
      text: `Multiplication and division come before addition and subtraction, so do ${highExpr} = ${highResult} first.`,
      blankText: `Work out the × or ÷ part (${highExpr}) first: ?`,
    },
    {
      text: `Then ${verb}: ${lowLead} ${lowOp} ${highResult} = ${formatAnswer(answer)}.`,
      blankText: `Now ${verb} ${lowLead} ${lowOp} ${highResult}: ?`,
    },
  ];
}

// ── Modular arithmetic (remainder cycles) ────────────────────────────────────

/** Clock hours: (start + hours), then wrap around a 12-hour face. Emits steps
 *  only when the sum actually exceeds 12 (otherwise no wrap happens and the sum
 *  IS the answer — reveal-only). */
export function clockRemainderSteps(start: number, hours: number, answer: TypedAnswer): WorkedStep[] {
  const sum = start + hours;
  if (sum <= 12) return [];
  return [
    {
      text: `Add the hours to the start: ${start} + ${hours} = ${sum}.`,
      blankText: `Add ${start} + ${hours}: ?`,
    },
    {
      text: `Every 12 hours the clock returns to the same place, so subtract full 12s from ${sum}: ${formatAnswer(answer)} o'clock.`,
      blankText: `Wrap ${sum} around a 12-hour clock: ?`,
    },
  ];
}

/** Day of week: (day + daysLater), then wrap around a 7-day week. daysLater is
 *  always ≥ 20 here, so the week always wraps. */
export function weekdayRemainderSteps(day: number, daysLater: number, answer: TypedAnswer): WorkedStep[] {
  const total = day + daysLater;
  return [
    {
      text: `Add the days to the start: ${day} + ${daysLater} = ${total}.`,
      blankText: `Add ${day} + ${daysLater}: ?`,
    },
    {
      text: `Every 7 days returns to the same weekday, so subtract full weeks from ${total}: day ${formatAnswer(answer)}.`,
      blankText: `Wrap ${total} around a 7-day week: ?`,
    },
  ];
}

// ── Place value ──────────────────────────────────────────────────────────────

/** Which of two three-digit numbers is larger. A genuine decomposition would
 *  have to name the winner in a non-final step, so this is a reveal-only rule
 *  (compare digit by digit from the left) + the labelled result. */
export function compareGreaterSteps(answer: TypedAnswer): WorkedStep[] {
  return [
    {
      text: `Compare digit by digit from the hundreds place; the first place where the digits differ decides which number is larger.`,
      blankText: `How do you compare two three-digit numbers? (left to right, first differing digit wins)`,
    },
    {
      text: `The larger number is ${formatAnswer(answer)}.`,
      blankText: `Which number is larger? ?`,
    },
  ];
}

/** a + b within 20 with a carry, taught by making ten: take (10 − a) from b to
 *  reach 10, then add what is left. */
export function addWithin20MakeTenSteps(a: number, b: number, answer: TypedAnswer): WorkedStep[] {
  const need = 10 - a;
  const leftover = b - need;
  return [
    {
      text: `Take ${need} from ${b} to bring ${a} up to ten: ${a} + ${need} = 10, with ${leftover} left over.`,
      blankText: `How much of ${b} makes ${a} reach ten? (${need}, leaving ${leftover})`,
    },
    {
      text: `Add what is left to ten: 10 + ${leftover} = ${formatAnswer(answer)}.`,
      blankText: `Add 10 + ${leftover}: ?`,
    },
  ];
}

// ── Discrete math: multiple-choice (graph theory + logic) ────────────────────
// choiceItem() carries no workedSteps parameter (a parallel lane owns adding
// one), so these are attached at the call site with `{ ...choiceItem(...),
// ...withWorkedSteps(steps) }`. The final step names the correct CHOICE LABEL
// (not a number — formatAnswer of a multipleChoice answer is "choice N"); the
// answerLabel is passed in from the template. Earlier steps state the criterion
// WITHOUT the answer's label words, so they never preview the verdict.

/** A cycle graph on `n` vertices is 2-colourable exactly when `n` is even.
 *  `answerLabel` is the correct choice ("bipartite" / "not bipartite"). */
export function cycleBipartiteSteps(n: number, answerLabel: string): WorkedStep[] {
  const parity = n % 2 === 0 ? "even" : "odd";
  return [
    {
      text: `Walking a ring, the colours must alternate; they only close up consistently when the number of vertices is even.`,
      blankText: `When can you 2-colour a ring of vertices? (when the count is even)`,
    },
    {
      text: `${n} is ${parity}, so the cycle is ${answerLabel}.`,
      blankText: `Is a ${n}-vertex cycle bipartite? ?`,
    },
  ];
}

/** The degree sequence: find each vertex's degree, sort high→low, write it.
 *  Reveal-only steps (naming the two moves), because printing the degrees risks
 *  showing the sorted tuple itself. `answerLabel` is the correct choice string. */
export function degreeSequenceSteps(answerLabel: string): WorkedStep[] {
  return [
    {
      text: `A vertex's degree is how many edges touch it — count that for every vertex.`,
      blankText: `What is a vertex's degree? (the number of edges touching it)`,
    },
    {
      text: `List those degrees from largest to smallest.`,
      blankText: `In what order does a degree sequence list the degrees? (largest to smallest)`,
    },
    {
      text: `The degree sequence is ${answerLabel}.`,
      blankText: `Write the sorted degree sequence: ?`,
    },
  ];
}

/** Negation: a general rule (flip to the exact opposite, nothing added) + the
 *  labelled negation. Reveal-only — the negation is a recognition task. */
export function negationSteps(statement: string, answerLabel: string): WorkedStep[] {
  return [
    {
      text: `A negation flips a statement to its exact opposite — "all" becomes "some are not", "is" becomes "is not" — and adds nothing else.`,
      blankText: `What does a negation do to a statement? (flip it to the exact opposite)`,
    },
    {
      text: `The negation of "${statement}" is "${answerLabel}".`,
      blankText: `Write the negation of "${statement}": ?`,
    },
  ];
}

/** Parity of a sum of odd/even parts: the sum's parity is the parity of the
 *  NUMBER of odd parts; compare that to the target's parity. `answerLabel` is
 *  "possible" / "impossible". */
export function parityProofSteps(target: number, answerLabel: string): WorkedStep[] {
  return [
    {
      text: `Each odd part flips the running total's parity and each even part leaves it alone, so the sum's parity is the parity of how many odd parts there are.`,
      blankText: `What sets the parity of the sum? (how many odd parts there are)`,
    },
    {
      text: `Compare that parity to ${target}'s parity.`,
      blankText: `What do you compare the sum's parity against? (the target ${target})`,
    },
    {
      text: `The parities ${answerLabel === "possible" ? "match" : "do not match"}, so reaching ${target} is ${answerLabel}.`,
      blankText: `Can the parts add to ${target}? ?`,
    },
  ];
}
