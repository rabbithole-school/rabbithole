/**
 * ARITHMETIC CORRECTNESS + OPERAND PROVENANCE — the two axes the scaffold sweep
 * was missing.
 *
 * WHY THIS EXISTS (the #1178 review). `scaffoldProgress.ts` answers one
 * question well — *is the move left in the blank smaller than the problem?* —
 * and one question badly: whether the steps say anything TRUE. Its only content
 * signal was the NEW-NUMBER RATE, "does a number appear that wasn't in the
 * stem". That is satisfied by a step that is arithmetically wrong
 * (`60 × 2 = 130`) and by a step whose numbers were conjured from nowhere
 * (`Break 364 into chunks: 350 + 15`). A scaffold is a claim about how a
 * problem decomposes; a sweep that never checks the claim is checking shape,
 * not content.
 *
 * This module adds the two checks that make the sweep about content.
 *
 * ── 1 · ARITHMETIC ──────────────────────────────────────────────────────────
 * Every arithmetic claim in every step must be TRUE, evaluated exactly (see
 * `mathClaims.ts` — rationals over bigint, so the decimal families compare
 * without epsilon fudge):
 *
 *   • every side of an `=` chain evaluates to the same value;
 *   • an ordered/repeated LIST of values is a permutation of the stem's data
 *     set (a stats step that quietly drops or alters a value fails);
 *   • the scaffold must actually DERIVE the item's canonical answer — the
 *     final step has to contain a claim whose value IS the answer, reached by
 *     arithmetic, by a decimal-point placement on a value the scaffold already
 *     computed, or by selecting an order statistic of the stem's data set.
 *
 * The last one is the end-to-end check: it fails a decomposition whose steps
 * are each locally true but which does not reconstruct the item's own answer.
 *
 * ── 2 · PROVENANCE ──────────────────────────────────────────────────────────
 * Every number a step mentions must TRACE BACK, in reading order, to the stem
 * or to something an earlier step legitimately produced. A number that traces
 * to nothing was conjured, and a scholar reading that step is being asked to
 * accept a quantity out of thin air.
 *
 * A number is grounded when one of these DECLARED rules explains it. The list
 * is deliberately finite and named — "some arithmetic combination exists" with
 * an unbounded search would ground everything and check nothing:
 *
 *   stem           it is written in the stem (including each part of a stem
 *                  fraction, and the fraction's own value)
 *   result         an earlier verified claim produced it
 *   decomposition  it is a part of an unasserted expression that recombines to
 *                  a value already known (`350 + 14` where 364 is known) — the
 *                  "break it apart" move, self-verifying because the parts must
 *                  add back up
 *   unit           0 or 1
 *   power-of-ten   10, 100, 1000 … — a place-value constant, not a quantity
 *   count          how many values the stem's data set holds
 *   decimal-places how many decimal places a stem or answer label carries
 *   extremum       the largest or smallest value in the stem's data set
 *   place-part     a place-value part of a known value (600 of 638)
 *   rescale        a known value with its decimal point moved (557 → 5.57):
 *                  a change of notation, not new information
 *   common-multiple a whole number that is a multiple of two different known
 *                  whole numbers and no bigger than their product — the
 *                  common-denominator rung ("a common denominator for 8 and 2:
 *                  16")
 *   product        a product or quotient of two known values, up to that same
 *                  rescale (66 as 1.1 × 6 × 10)
 *   sum            a sum or difference of two known values, likewise
 *
 * ANNOUNCED numbers get a stricter ladder. A number a step merely states, with
 * no arithmetic around it to justify it — "the denominators are the same (8)" —
 * may not lean on `sum`, because `a ± b` over a handful of known values reaches
 * nearly every small integer and would ground anything. Products and quotients
 * survive the strict ladder because they preserve their operands' digits.
 *
 * Provenance is a NECESSARY condition, not a sufficient one: it proves a number
 * is traceable, not that the scaffold chose the pedagogically right move. Nor
 * is it complete: `rescale` will accept a mutated denominator that happens to
 * be a stem fraction with the point moved (6 for 3/5). The mutation pins in
 * `arithmeticAudit.test.ts` measure exactly how much the two axes do catch.
 *
 * ── 3 · HONEST n/a ──────────────────────────────────────────────────────────
 * Neither axis applies everywhere, and the audit says so instead of quietly
 * scoring an unevaluated draw as a pass:
 *
 *   • ARITHMETIC is n/a when a draw makes no checkable claim at all, or its
 *     answer is not a number.
 *   • PROVENANCE is n/a when the stem is NOT numerically self-contained — when
 *     the stem's own numbers cannot reproduce the answer, part of the ground
 *     truth lives outside the text ("a fair die" is six-sided; "two coins" have
 *     two faces each), so a scaffold number that traces to nothing may be world
 *     knowledge rather than invention. Those draws are reported as n/a for this
 *     axis rather than failed for it.
 *
 * Pure + deterministic: no model, no I/O, no clock.
 */

import type { WorkedStep } from "../../convex/lib/practice/fadedSteps";
import {
  type Claim,
  type Expr,
  type Rat,
  ONE,
  ZERO,
  claimsIn,
  isPowerOfTen,
  isPowerOfTenMultiple,
  parseExpression,
  ratAdd,
  ratDiv,
  ratEq,
  ratFromLiteral,
  ratIsInt,
  ratKey,
  ratMul,
  ratSub,
  ratToString,
  rat,
} from "./mathClaims";

/** As in `mathClaims.ts`: `bigint` literals need ES2020, the repo targets
 *  ES2017. */
const B0 = BigInt(0);
const B1 = BigInt(1);
const B2 = BigInt(2);
const B8 = BigInt(8);

// ── The stem's numeric facts ─────────────────────────────────────────────────

/** How the stem's OWN numbers reproduce the item's answer. A stem with a basis
 *  is numerically self-contained, which is what makes provenance checkable. */
export type StemBasis =
  | { kind: "expression" }
  | { kind: "ratio"; num: string; den: string }
  | { kind: "statistic"; stat: "mean" | "median" | "range" | "min" | "max" | "sum" };

export type StemFacts = {
  stem: string;
  /** Every numeric literal in the stem, plus the value of each stem fraction. */
  values: Rat[];
  /** The stem's data set, when it states one (`Find the mean of 7, 11, 13 …`). */
  list: Rat[] | null;
  /** Decimal-place counts present in the stem / answer labels. */
  placeCounts: Set<number>;
  basis: StemBasis | null;
};

const NUMBER_TOKEN_RE = /\d+(?:\.\d+)?/g;
const FRACTION_TOKEN_RE = /(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)/g;

function decimalPlacesOf(label: string): number {
  const dot = label.indexOf(".");
  return dot === -1 ? 0 : label.length - dot - 1;
}

/** Parse a canonical answer string ("136", "0.01", "3/8") exactly. */
export function parseAnswerRat(answerStr: string): Rat | null {
  const s = answerStr.trim();
  const frac = s.match(/^(-?\d+)\/(\d+)$/);
  if (frac) {
    const den = BigInt(frac[2]);
    if (den === B0) return null;
    return rat(BigInt(frac[1]), den);
  }
  return ratFromLiteral(s);
}

function medianOf(values: Rat[]): Rat | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => {
    const diff = a.n * b.d - b.n * a.d;
    return diff < B0 ? -1 : diff > B0 ? 1 : 0;
  });
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid];
  const sum = ratAdd(sorted[mid - 1], sorted[mid]);
  return ratDiv(sum, rat(B2));
}

function sumOf(values: Rat[]): Rat {
  return values.reduce((acc, v) => ratAdd(acc, v), ZERO);
}

function minOf(values: Rat[]): Rat {
  return values.reduce((a, b) => (b.n * a.d < a.n * b.d ? b : a));
}

function maxOf(values: Rat[]): Rat {
  return values.reduce((a, b) => (b.n * a.d > a.n * b.d ? b : a));
}

/**
 * Read the stem's numeric content and decide whether it is SELF-CONTAINED —
 * whether its own numbers reproduce the canonical answer under one of four
 * declared readings. Self-containment is the gate on the provenance axis, and
 * it doubles as an arithmetic check on the item itself: a `(7 + 2) × 6 = ?`
 * stem whose stored answer is not 54 has no basis and is reported, not scored.
 */
export function stemFacts(stem: string, answer: Rat | null, answerStr = ""): StemFacts {
  const values: Rat[] = [];
  const placeCounts = new Set<number>();
  const numberLabels: string[] = [];
  let placeSum = 0;
  for (const m of stem.matchAll(NUMBER_TOKEN_RE)) {
    numberLabels.push(m[0]);
    const v = ratFromLiteral(m[0]);
    if (v) values.push(v);
    const places = decimalPlacesOf(m[0]);
    placeCounts.add(places);
    placeSum += places;
  }
  // A decimal family counts places two ways — the WIDEST operand ("give both
  // the same number of places") and the TOTAL across the factors ("the factors
  // have 2 places in total") — so both are legitimate provenance, as is the
  // answer's own width.
  placeCounts.add(placeSum);
  if (answerStr) placeCounts.add(decimalPlacesOf(answerStr));
  for (const m of stem.matchAll(FRACTION_TOKEN_RE)) {
    const num = ratFromLiteral(m[1]);
    const den = ratFromLiteral(m[2]);
    if (!num || !den) continue;
    const q = ratDiv(num, den);
    if (q) values.push(q);
  }

  const listClaim = claimsIn(stem).find((c) => c.kind === "list");
  const list = listClaim && listClaim.kind === "list" ? listClaim.values : null;

  return {
    stem,
    values,
    list,
    placeCounts,
    basis: answer === null ? null : deriveBasis(stem, values, numberLabels, list, answer),
  };
}

function deriveBasis(
  stem: string,
  values: Rat[],
  numberLabels: string[],
  list: Rat[] | null,
  answer: Rat,
): StemBasis | null {
  // 1 · The stem IS an arithmetic expression (`(7 + 2) × 6 = ?`).
  const bare = stem
    .trim()
    .replace(/=\s*\?\s*\.?$/, "")
    .trim();
  const expr = parseExpression(bare);
  if (expr && ratEq(expr.value, answer)) return { kind: "expression" };

  // 2 · The stem states a data set and the answer is one of its order/summary
  //     statistics (`Find the median of 7, 12, 14, 10, 9.`).
  if (list && list.length > 0) {
    const median = medianOf(list);
    const mean = ratDiv(sumOf(list), rat(BigInt(list.length)));
    const range = ratSub(maxOf(list), minOf(list));
    const stats: Array<{
      stat: "mean" | "median" | "range" | "min" | "max" | "sum";
      value: Rat | null;
    }> = [
      { stat: "median", value: median },
      { stat: "mean", value: mean },
      { stat: "range", value: range },
      { stat: "min", value: minOf(list) },
      { stat: "max", value: maxOf(list) },
      { stat: "sum", value: sumOf(list) },
    ];
    for (const s of stats) {
      if (s.value && ratEq(s.value, answer)) return { kind: "statistic", stat: s.stat };
    }
  }

  // 3 · The answer is the RATIO of two numbers the stem names (`4 of the 6
  //     faces …`, `Write 33/100 as a decimal.`).
  for (let i = 0; i < values.length; i++) {
    for (let j = 0; j < values.length; j++) {
      if (i === j) continue;
      const q = ratDiv(values[i], values[j]);
      if (q && ratEq(q, answer)) {
        return { kind: "ratio", num: numberLabels[i] ?? ratToString(values[i]), den: numberLabels[j] ?? ratToString(values[j]) };
      }
    }
  }

  return null;
}

// ── The provenance ledger ────────────────────────────────────────────────────


/**
 * How hard the ledger is allowed to work to explain a number.
 *
 *   full       every rule, including the two-operand search. For an OPERAND of
 *              an expression the step is visibly computing with.
 *   announced  no sums or differences. For a number the step merely STATES
 *              ("the denominators are the same (8)"): `a ± b` over a handful of
 *              known values reaches nearly every small integer, so allowing it
 *              here would ground anything. Products and quotients survive
 *              because they preserve their operands' digits.
 *   direct     no two-operand search at all — the number must be one the reader
 *              can point straight at. Required of the value a DECOMPOSITION
 *              claims to be breaking up, because that value is the whole
 *              justification for its parts.
 */
type GroundMode = "full" | "announced" | "direct";

type GroundRule =
  | "stem"
  | "result"
  | "decomposition"
  | "unit"
  | "power-of-ten"
  | "count"
  | "decimal-places"
  | "extremum"
  | "place-part"
  | "rescale"
  | "common-multiple"
  | "product"
  | "sum";

/** Ceiling on how far a decimal point may be moved before a "rescale" stops
 *  being a notation change and starts being a coincidence. */
const MAX_SHIFT = 8;

/** Cap on how many known values the quadratic combination rules scan. The
 *  ledger is small in practice (a dozen values); the cap keeps a pathological
 *  step from making the sweep quadratic in its own length. */
const COMBINATION_WINDOW = 48;

class Ledger {
  private readonly known = new Map<string, GroundRule>();
  private readonly order: Rat[] = [];

  constructor(private readonly facts: StemFacts) {
    for (const v of facts.values) this.add(v, "stem");
    if (facts.list) for (const v of facts.list) this.add(v, "stem");
  }

  add(value: Rat, rule: GroundRule): void {
    const key = ratKey(value);
    if (this.known.has(key)) return;
    this.known.set(key, rule);
    this.order.push(value);
  }

  has(value: Rat, mode: GroundMode = "full"): boolean {
    return this.explain(value, mode) !== null;
  }

  /** Why is `value` allowed to appear? `null` means it was conjured. */
  explain(value: Rat, mode: GroundMode = "full"): GroundRule | null {
    const known = this.known.get(ratKey(value));
    if (known) return known;
    if (ratEq(value, ZERO) || ratEq(value, ONE)) return "unit";
    if (ratIsInt(value) && value.n > B1 && isPowerOfTen(value, MAX_SHIFT)) return "power-of-ten";
    if (this.facts.list && ratIsInt(value) && value.n === BigInt(this.facts.list.length)) {
      return "count";
    }
    if (ratIsInt(value) && value.n >= B0 && value.n <= B8) {
      if (this.facts.placeCounts.has(Number(value.n))) return "decimal-places";
    }
    if (this.facts.list && this.facts.list.length > 0) {
      if (ratEq(value, minOf(this.facts.list)) || ratEq(value, maxOf(this.facts.list))) {
        return "extremum";
      }
    }
    if (this.isPlacePart(value)) return "place-part";

    const window = this.order.slice(-COMBINATION_WINDOW);
    for (const m of window) {
      if (isPowerOfTenMultiple(m, value, MAX_SHIFT)) return "rescale";
    }
    if (this.isCommonMultiple(value, window)) return "common-multiple";
    if (mode === "direct") return null;
    for (let i = 0; i < window.length; i++) {
      for (let j = 0; j < window.length; j++) {
        for (const c of [ratMul(window[i]!, window[j]!), ratDiv(window[i]!, window[j]!)]) {
          if (!c || c.n === B0) continue;
          if (isPowerOfTenMultiple(c, value, MAX_SHIFT)) return "product";
        }
      }
    }
    if (mode === "announced") return null;
    for (let i = 0; i < window.length; i++) {
      for (let j = 0; j < window.length; j++) {
        for (const c of [ratAdd(window[i]!, window[j]!), ratSub(window[i]!, window[j]!)]) {
          if (!c || c.n === B0) continue;
          if (isPowerOfTenMultiple(c, value, MAX_SHIFT)) return "sum";
        }
      }
    }
    return null;
  }

  /** The common-denominator rung: a whole number that is a multiple of two
   *  DIFFERENT known whole numbers and no larger than their product — which is
   *  what "find a common denominator for 8 and 2: 16" states. */
  private isCommonMultiple(value: Rat, window: readonly Rat[]): boolean {
    if (!ratIsInt(value) || value.n < B2) return false;
    const bases = window.filter((v) => ratIsInt(v) && v.n >= B2).map((v) => v.n);
    for (let i = 0; i < bases.length; i++) {
      for (let j = i + 1; j < bases.length; j++) {
        const a = bases[i]!;
        const b = bases[j]!;
        if (a === b) continue;
        if (value.n % a !== B0 || value.n % b !== B0) continue;
        if (value.n <= a * b) return true;
      }
    }
    return false;
  }

  /** Is `value` a place-value part (d × 10^k) of a known integer? `600` is a
   *  part of `638`; `40` is not. */
  private isPlacePart(value: Rat): boolean {
    if (!ratIsInt(value) || value.n <= B0) return false;
    const label = String(value.n);
    if (!/^[1-9]0*$/.test(label)) return false;
    const digit = label[0];
    const zeros = label.length - 1;
    for (const m of this.order) {
      if (!ratIsInt(m) || m.n <= B0) continue;
      const s = String(m.n);
      const idx = s.length - 1 - zeros;
      if (idx < 0 || idx >= s.length) continue;
      if (s[idx] === digit) return true;
    }
    return false;
  }

  /** Is `value` the same digits as something already known, with the decimal
   *  point moved? The notational rung ("put the point back 2 places") is a real
   *  final move, and this is what makes it checkable. */
  isRescaleOfKnown(value: Rat): boolean {
    for (const m of this.order) {
      if (ratEq(m, value)) continue;
      if (isPowerOfTenMultiple(m, value, MAX_SHIFT)) return true;
    }
    return false;
  }
}

// ── The audit ────────────────────────────────────────────────────────────────

export type AxisResult = "pass" | "fail" | "n/a";

export type IssueKind =
  | "false-equation"
  | "list-not-stem"
  | "answer-not-derived"
  | "unexplained-number"
  /** Raised by the terminal-move axis in `scaffoldProgress.ts`, kept in this
   *  union so one issue list can carry every axis's findings. */
  | "terminal-move";

export type AuditIssue = {
  axis: "terminal" | "arithmetic" | "provenance";
  kind: IssueKind;
  /** 1-based index of the step that made the claim (0 for whole-item issues). */
  step: number;
  detail: string;
};

export type ArithmeticAudit = {
  arithmetic: AxisResult;
  provenance: AxisResult;
  issues: AuditIssue[];
  /** How the stem's own numbers reproduce the answer, when they do. */
  basis: StemBasis | null;
  /** How the final step reached the answer, when it did. */
  derivation: "equation" | "expression" | "notation" | "selection" | null;
  /** Math spans this reader could not parse — a hole in the READER, reported
   *  so it can never masquerade as a clean pass. */
  unparsed: string[];
  /** Every claim the steps made, and the subset the arithmetic axis could
   *  verify directly (equations, decompositions, data sets). */
  claimCount: number;
  checkedClaims: number;
};

export function auditArithmetic(
  stem: string,
  answerStr: string,
  steps: WorkedStep[],
): ArithmeticAudit {
  const answer = parseAnswerRat(answerStr);
  const facts = stemFacts(stem, answer, answerStr);
  const ledger = new Ledger(facts);
  const issues: AuditIssue[] = [];
  const unparsed: string[] = [];
  let claimCount = 0;
  let checkedClaims = 0;
  let derivation: ArithmeticAudit["derivation"] = null;

  const lastIndex = steps.length - 1;

  for (let i = 0; i < steps.length; i++) {
    const isFinal = i === lastIndex;
    const step = i + 1;
    for (const claim of claimsIn(steps[i]?.text ?? "")) {
      if (claim.kind !== "unparsed") claimCount++;
      switch (claim.kind) {
        case "unparsed":
          unparsed.push(claim.text);
          break;

        case "equation": {
          checkedClaims++;
          if (!claim.consistent) {
            issues.push({
              axis: "arithmetic",
              kind: "false-equation",
              step,
              detail: `"${claim.text}" — sides evaluate to ${claim.sides
                .map((s) => ratToString(s.value))
                .join(" vs ")}`,
            });
          }
          recordEquationProvenance(claim.sides, ledger, issues, step, claim.text);
          for (const side of claim.sides) {
            for (const atom of side.atoms) ledger.add(atom, "result");
          }
          ledger.add(claim.value, "result");
          if (isFinal && answer && ratEq(claim.value, answer) && derivation === null) {
            derivation = "equation";
          }
          break;
        }

        case "expression": {
          checkedClaims++;
          const ungrounded = claim.expr.atoms.filter((a) => !ledger.has(a));
          if (ungrounded.length === 0) {
            ledger.add(claim.expr.value, "result");
          } else if (ledger.has(claim.expr.value, "direct")) {
            // A DECOMPOSITION: "break 364 into 350 + 14". Self-verifying — the
            // parts have to recombine to the value they came from, so this is
            // an arithmetic check as much as a provenance one.
            for (const atom of claim.expr.atoms) ledger.add(atom, "decomposition");
          } else {
            issues.push({
              axis: "provenance",
              kind: "unexplained-number",
              step,
              detail: `"${claim.text}" uses ${ungrounded
                .map(ratToString)
                .join(", ")} and does not recombine to a known value`,
            });
            for (const atom of claim.expr.atoms) ledger.add(atom, "result");
            ledger.add(claim.expr.value, "result");
          }
          if (isFinal && answer && ratEq(claim.expr.value, answer) && derivation === null) {
            derivation = "expression";
          }
          break;
        }

        case "value": {
          if (!ledger.has(claim.value, "announced")) {
            issues.push({
              axis: "provenance",
              kind: "unexplained-number",
              step,
              detail: `${ratToString(claim.value)} traces to nothing in the stem or an earlier step`,
            });
          }
          if (isFinal && answer && ratEq(claim.value, answer) && derivation === null) {
            derivation = valueDerivation(claim.value, ledger, facts);
          }
          ledger.add(claim.value, "result");
          break;
        }

        case "list": {
          if (facts.list) {
            checkedClaims++;
            if (!isPermutation(claim.values, facts.list)) {
              issues.push({
                axis: "arithmetic",
                kind: "list-not-stem",
                step,
                detail: `"${claim.text}" is not a rearrangement of the stem's ${facts.list
                  .map(ratToString)
                  .join(", ")}`,
              });
            }
          } else {
            for (const v of claim.values) {
              if (!ledger.has(v, "announced")) {
                issues.push({
                  axis: "provenance",
                  kind: "unexplained-number",
                  step,
                  detail: `${ratToString(v)} traces to nothing in the stem or an earlier step`,
                });
              }
            }
          }
          for (const v of claim.values) ledger.add(v, "result");
          break;
        }
      }
    }
  }

  // The arithmetic axis applies whenever the item has a numeric answer and its
  // steps make numeric claims at all: even a family whose steps state no
  // equation (the decimal-placement rungs) can be asked the end-to-end
  // question — does this scaffold actually REACH the item's own answer?
  const arithmeticEvaluable = answer !== null && claimCount > 0;
  if (arithmeticEvaluable && derivation === null) {
    issues.push({
      axis: "arithmetic",
      kind: "answer-not-derived",
      step: steps.length,
      detail: `the final step never reaches ${answerStr} — no claim in it evaluates to the item's answer`,
    });
  }

  const arithmeticIssues = issues.filter((x) => x.axis === "arithmetic");
  const provenanceIssues = issues.filter((x) => x.axis === "provenance");

  return {
    arithmetic: !arithmeticEvaluable ? "n/a" : arithmeticIssues.length > 0 ? "fail" : "pass",
    provenance:
      facts.basis === null ? "n/a" : provenanceIssues.length > 0 ? "fail" : "pass",
    issues,
    basis: facts.basis,
    derivation,
    unparsed,
    claimCount,
    checkedClaims,
  };
}

/**
 * An `=` chain's provenance rule: at least one side must be fully grounded (the
 * side the scholar can already read), and any side that is NOT result-shaped —
 * anything with arithmetic in it — must be fully grounded too. A lone number or
 * fraction on the right is exempt: that is the result the equation asserts, and
 * the arithmetic check is what verifies it.
 */
function recordEquationProvenance(
  sides: Expr[],
  ledger: Ledger,
  issues: AuditIssue[],
  step: number,
  text: string,
): void {
  const grounded = sides.map((s) => s.atoms.every((a) => ledger.has(a)));
  const offenders: Rat[] = [];
  for (let i = 0; i < sides.length; i++) {
    if (grounded[i]) continue;
    if (sides[i].resultLike) continue;
    offenders.push(...sides[i].atoms.filter((a) => !ledger.has(a)));
  }
  if (offenders.length === 0 && !grounded.some(Boolean)) {
    offenders.push(...sides.flatMap((s) => s.atoms.filter((a) => !ledger.has(a))));
  }
  if (offenders.length === 0) return;
  const seen = new Set<string>();
  const unique = offenders.filter((o) => {
    const k = ratKey(o);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  issues.push({
    axis: "provenance",
    kind: "unexplained-number",
    step,
    detail: `"${text}" uses ${unique.map(ratToString).join(", ")}, which trace${
      unique.length === 1 ? "s" : ""
    } to nothing in the stem or an earlier step`,
  });
}

/** How a lone value in the final step can legitimately BE the answer without an
 *  equation: a decimal-point placement on something already computed, or the
 *  selection of an order statistic from the stem's data set. */
function valueDerivation(
  value: Rat,
  ledger: Ledger,
  facts: StemFacts,
): "notation" | "selection" | null {
  if (ledger.isRescaleOfKnown(value)) return "notation";
  if (facts.list && facts.list.length > 0) {
    const median = medianOf(facts.list);
    if (
      (median && ratEq(value, median)) ||
      ratEq(value, minOf(facts.list)) ||
      ratEq(value, maxOf(facts.list))
    ) {
      return "selection";
    }
  }
  return null;
}

function isPermutation(a: Rat[], b: Rat[]): boolean {
  if (a.length !== b.length) return false;
  const counts = new Map<string, number>();
  for (const v of b) counts.set(ratKey(v), (counts.get(ratKey(v)) ?? 0) + 1);
  for (const v of a) {
    const k = ratKey(v);
    const c = counts.get(k);
    if (!c) return false;
    counts.set(k, c - 1);
  }
  return true;
}

/** Re-exported so callers audit one claim shape without importing two modules. */
export type { Claim };
