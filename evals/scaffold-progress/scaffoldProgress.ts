/**
 * Scaffold-progress metrics — a PURE, deterministic audit of whether a worked
 * scaffold actually makes the final blank easier than the bare problem.
 *
 * WHY THIS EXISTS (the 816 ÷ 6 report, 2026-07-25). The teach-as-action moment
 * for long division revealed "Think of division as the missing factor:
 * 6 × ? = 816" and then asked the scholar to finish it. That restates the
 * problem in different words and leaves the ENTIRE original computation in the
 * blank: a scholar who just tapped "I haven't learned this yet" is handed back
 * the same problem they said they couldn't do. The existing property tests
 * (convex/__tests__/workedStepGen.test.ts) cannot see this — they check that
 * steps render, that the final step embeds the answer, and that the fade doesn't
 * leak. All three PASS for a completely useless scaffold.
 *
 * The decisive question a scaffold must answer is: **what single move is left in
 * the blank, and is it smaller than the original problem?** This module answers
 * it mechanically.
 *
 * ── The terminal move ────────────────────────────────────────────────────────
 * The teaching moment fades exactly one step (fade level 1), so the blank is the
 * FINAL step. `auditScaffold` extracts the arithmetic sentence in that step's
 * text which produces the answer (`x op y … = answer`) and classifies it:
 *
 *   ok         — a move on numbers other than the stem's own operands: the
 *                scaffold computed something and the blank combines it.
 *   notation   — no arithmetic left; the answer is a NOTATIONAL rewrite of a
 *                value the scaffold already computed (same digits, point moved).
 *                Legitimate: "place the decimal point" is a real final move.
 *   restates   — the terminal sentence IS the stem: `816 ÷ 6 = 136`. The blank
 *                is the original problem. HARD FAILURE.
 *   implicit   — the final step never shows the move at all (it asserts the
 *                answer in prose). The scholar is told *that*, never *how*.
 *                HARD FAILURE.
 *   leak       — the answer was already computed in a REVEALED step, so
 *                "finish the last step" is a copy, not a computation. Outranks
 *                every other class.
 *   n/a        — not a bare `a op b = ?` stem (word problems, fraction stems).
 *                Judged on the new-number rate instead.
 *
 * A secondary, softer metric — NEW-NUMBER RATE — reports the fraction of
 * REVEALED steps that introduce a number not in the stem. A 0% step is
 * procedural narration; that can still be legitimate (naming a place value,
 * flipping a fraction), so it is a smell, not a verdict.
 *
 * No model, no I/O, no clock: every metric is computed from the item's own
 * generated text, so the audit is reproducible and CI-safe.
 */

import type { WorkedStep } from "../../convex/lib/practice/fadedSteps";
import {
  auditArithmetic,
  parseAnswerRat,
  type ArithmeticAudit,
  type AuditIssue,
  type AxisResult,
} from "./arithmeticAudit";
import { claimsIn, parseExpression, ratEq } from "./mathClaims";

const EPS = 1e-9;

/** Every number token in a string, as a JS number. */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\d+(?:\.\d+)?/g)) out.push(Number(m[0]));
  return out;
}

/** Digits of a number with the decimal point and outer zeros stripped — the
 *  comparison behind the `notation` class (0.04 and 4 both → "4"). */
export function digitString(n: number): string {
  return String(n).replace(/[^0-9]/g, "").replace(/^0+/, "").replace(/0+$/, "") || "0";
}

export type Op = "+" | "−" | "×" | "÷";

/** A bare arithmetic stem `a op b = ?` — the drill shape this audit applies to. */
export type DirectStem = { a: number; op: Op; b: number };

export function parseDirectStem(stem: string): DirectStem | null {
  const m = stem
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*([+−×÷*\-/])\s*(\d+(?:\.\d+)?)\s*=\s*\??$/);
  if (!m) return null;
  const raw = m[2];
  const op: Op = raw === "*" ? "×" : raw === "/" ? "÷" : raw === "-" ? "−" : (raw as Op);
  return { a: Number(m[1]), op, b: Number(m[3]) };
}

/**
 * The authored non-drill families with a terminal move we can name without
 * interpreting arbitrary word problems.  These parsers deliberately mirror the
 * fixed generator stems and worked-step contracts; an unfamiliar story remains
 * `n/a` rather than becoming a regex-shaped guess.
 */
type NarratedStem =
  | { kind: "probability"; favorable: number; total: number; complement?: boolean }
  | { kind: "expected-frequency"; trials: number }
  | { kind: "sample-space"; factors: number[] }
  | { kind: "statistic"; stat: "mean" | "median" | "range"; values: number[] }
  | { kind: "decimal-notation"; numerator: number; denominator: 10 | 100 };

function parseNarratedStem(stem: string): NarratedStem | null {
  const decimalNotation = stem.match(/^Write (\d+)\/(10|100) as a decimal\.$/);
  if (decimalNotation) {
    return {
      kind: "decimal-notation",
      numerator: Number(decimalNotation[1]),
      denominator: Number(decimalNotation[2]) as 10 | 100,
    };
  }

  const ratio = stem.match(/^(\d+) of the (\d+) .+\. Write that probability in simplest form\.$/);
  if (ratio) return { kind: "probability", favorable: Number(ratio[1]), total: Number(ratio[2]) };

  // These are the only fair-die wordings emitted by the probability templates.
  // The quantities are authored facts (six faces and the enumerated favorable
  // faces), not inferred from loose natural-language similarity.
  if (/^A fair die is rolled\. What is the probability of /.test(stem)) {
    if (/probability of rolling an (?:even|odd) number\?$/.test(stem)) {
      return { kind: "probability", favorable: 3, total: 6 };
    }
    if (/probability of rolling a \d+\?$/.test(stem)) {
      return { kind: "probability", favorable: 1, total: 6 };
    }
    const greater = stem.match(/rolling a number greater than (\d+)\?$/);
    if (greater) return { kind: "probability", favorable: 6 - Number(greater[1]), total: 6 };
    const atLeast = stem.match(/rolling at least (\d+)\?$/);
    if (atLeast) return { kind: "probability", favorable: 7 - Number(atLeast[1]), total: 6 };
    if (/NOT rolling an (?:even|odd) number\?$/.test(stem)) {
      return { kind: "probability", favorable: 3, total: 6, complement: true };
    }
    if (/NOT rolling a \d+\?$/.test(stem)) {
      return { kind: "probability", favorable: 1, total: 6, complement: true };
    }
  }

  const expected = stem.match(/^You roll a fair die (\d+) times\. About how many \d+s would you expect\?$/);
  if (expected) return { kind: "expected-frequency", trials: Number(expected[1]) };

  const sampleSpaces: Record<string, number[]> = {
    "You roll a die and flip a coin. How many different outcomes are possible in all?": [6, 2],
    "You flip two coins. How many different outcomes are possible?": [2, 2],
    "You flip three coins. How many different outcomes are possible?": [2, 2, 2],
    "You roll two dice. How many different outcomes (ordered pairs) are possible?": [6, 6],
    "A spinner has 4 equal-sized colors. You spin it and flip a coin. How many outcomes are possible in all?": [4, 2],
    "You roll a die and spin a spinner with 3 equal colors. How many outcomes are possible in all?": [6, 3],
  };
  if (sampleSpaces[stem]) return { kind: "sample-space", factors: sampleSpaces[stem] };

  const statistic = stem.match(/^Find the (mean|median|range) of ((?:\d+, )*\d+)\.$/);
  if (statistic) {
    return {
      kind: "statistic",
      stat: statistic[1] as "mean" | "median" | "range",
      values: statistic[2].split(", ").map(Number),
    };
  }
  return null;
}

function textHasNumber(text: string, value: number): boolean {
  return new RegExp(`(?:^|\\D)${value}(?!\\d)`).test(text);
}

function bareExpressionText(stem: string): string | null {
  const text = stem.trim().replace(/=\s*\?\s*$/, "").trim();
  return parseExpression(text) ? text : null;
}

function normalizedExpression(text: string): string {
  return text.replace(/\s/g, "").replace(/\*/g, "×").replace(/-/g, "−");
}

/** Verify quantities that the authored worked-step prose explicitly narrates.
 * This closes the old blind spot where a changed count outside an equation was
 * invisible to the terminal metric. */
function narratedFactsMatch(stem: NarratedStem, steps: WorkedStep[]): boolean {
  const text = steps.map((s) => s.text).join("\n");
  const first = steps[0]?.text ?? "";
  switch (stem.kind) {
    case "probability":
      if (stem.complement) {
        return first === `First find the probability of the event happening: ${stem.favorable}/${stem.total}.`;
      }
      return first ===
        `Count the favorable outcomes (${stem.favorable}) out of all the equally likely outcomes (${stem.total}).`;
    case "expected-frequency":
      return first === "The probability on one try is 1/6." && textHasNumber(text, stem.trials);
    case "sample-space":
      return first === `Count the outcomes at each stage: ${stem.factors.join(" and ")}.`;
    case "statistic": {
      if (stem.stat === "mean") {
        const sum = stem.values.reduce((total, value) => total + value, 0);
        return first === `Add all the values: ${stem.values.join(" + ")} = ${sum}.`;
      }
      if (stem.stat === "median") {
        return first ===
          `Put the values in order from least to greatest: ${[...stem.values].sort((a, b) => a - b).join(", ")}.`;
      }
      return first ===
        `Find the largest value (${Math.max(...stem.values)}) and the smallest value (${Math.min(...stem.values)}).`;
    }
    case "decimal-notation": {
      const hundredths = stem.denominator === 100;
      const placeName = hundredths ? "hundredths" : "tenths";
      const spot = hundredths
        ? "the second spot after the decimal point (two places)"
        : "the first spot right after the decimal point";
      return first === `The bottom number is ${stem.denominator}, so this is ${placeName} — ${spot}.`;
    }
  }
}

/** One arithmetic sentence found in a step: `operands` joined by `ops`, equal to
 *  `result`. `2400 + 240 + 3 = 2643` → operands [2400,240,3], ops ["+","+"]. */
export type Sentence = { operands: number[]; ops: Op[]; result: number };

const SENTENCE_RE = /(\d+(?:\.\d+)?(?:\s*[+−×÷]\s*\d+(?:\.\d+)?)+)\s*=\s*(\d+(?:\.\d+)?)/g;

/** Every `expr = value` sentence in a step's text. */
export function sentencesIn(text: string): Sentence[] {
  const out: Sentence[] = [];
  for (const m of text.matchAll(SENTENCE_RE)) {
    const expr = m[1];
    const operands = numbersIn(expr);
    const ops = [...expr.matchAll(/[+−×÷]/g)].map((o) => o[0] as Op);
    out.push({ operands, ops, result: Number(m[2]) });
  }
  return out;
}

/** Is `s` the stem's own operation on the stem's own operands (either order for
 *  a commutative op)? Re-stating the problem is not progress. */
export function sentenceIsStem(s: Sentence, stem: DirectStem): boolean {
  if (s.operands.length !== 2 || s.ops.length !== 1 || s.ops[0] !== stem.op) return false;
  const [x, y] = s.operands;
  if (x === stem.a && y === stem.b) return true;
  return (stem.op === "+" || stem.op === "×") && x === stem.b && y === stem.a;
}

/** Does a step present `answerStr` as a COMPUTED RESULT (right of an "=")? A bare
 *  occurrence of the digits as an input is not a leak — the mean of 8, 10, 4, 7,
 *  6 legitimately shows a 7 among the data. */
export function stepAssertsAnswer(text: string, answerStr: string): boolean {
  const esc = answerStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`=\\s*${esc}(?!\\d|\\.\\d|/)`).test(text);
}

/** Numeric value of a canonical answer string ("136", "1/2", "0.75"). */
export function answerValueOf(answerStr: string): number | null {
  const frac = answerStr.match(/^(-?\d+)\/(\d+)$/);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  const n = Number(answerStr);
  return Number.isFinite(n) ? n : null;
}

export type Verdict = "ok" | "notation" | "restates" | "implicit" | "leak" | "n/a";

/** The two hard-failure classes — a scaffold that leaves the whole problem in
 *  the blank, or never shows the move at all. */
export const HARD_FAILURES: readonly Verdict[] = ["restates", "implicit", "leak"];

export type ScaffoldAudit = {
  stem: string;
  stepCount: number;
  /** Steps revealed in the teaching moment (all but the last). */
  revealedCount: number;
  /** Revealed steps that introduce ≥1 number not in the stem. */
  newNumberSteps: number;
  newNumberRate: number;
  /** The arithmetic sentence the blank asks for, when the final step shows one. */
  terminal: Sentence | null;
  verdict: Verdict;
  /** The final step's blank prompt — the sentence the scholar actually reads. */
  blankText: string;
};

/**
 * Audit ONE generated item's scaffold under the teaching-moment fade (level 1:
 * every step revealed except the final, answer-producing one).
 */
export function auditScaffold(
  stem: string,
  answerStr: string,
  steps: WorkedStep[],
): ScaffoldAudit {
  const direct = parseDirectStem(stem);
  const narrated = parseNarratedStem(stem);
  const expressionStem = direct ? null : bareExpressionText(stem);
  const stemNums = new Set(numbersIn(stem));
  const revealed = steps.slice(0, Math.max(0, steps.length - 1));
  const finalStep = steps[steps.length - 1];

  let newNumberSteps = 0;
  const computed = new Set<number>();
  for (const s of revealed) {
    const ns = numbersIn(s.text);
    let fresh = false;
    for (const n of ns) {
      if (!stemNums.has(n)) {
        computed.add(n);
        fresh = true;
      }
    }
    if (fresh) newNumberSteps++;
  }

  const answerValue = answerValueOf(answerStr);
  const answerRat = parseAnswerRat(answerStr);
  const leaks = revealed.some((s) => stepAssertsAnswer(s.text, answerStr));

  // The terminal move: the sentence in the FINAL step that yields the answer.
  const terminal =
    answerValue === null
      ? null
      : (sentencesIn(finalStep?.text ?? "").find(
          (s) => Math.abs(s.result - answerValue) < EPS,
        ) ?? null);

  // Fractions and the narrated quantity families use exact rational claims,
  // rather than the decimal-only `Sentence` reader above.  A terminal claim is
  // still required to reach the canonical answer; merely printing its digits in
  // explanatory prose is not a move the blank can ask a scholar to make.
  const finalReachesAnswer =
    answerRat !== null &&
    (stepAssertsAnswer(finalStep?.text ?? "", answerStr) ||
      (answerValue !== null && terminal?.result === answerValue) ||
      claimsIn(finalStep?.text ?? "").some(
        (claim) => {
          if (claim.kind === "expression") {
            return ratEq(claim.expr.value, answerRat);
          }
          return (
            (claim.kind === "equation" || claim.kind === "value") &&
            ratEq(claim.value, answerRat)
          );
        },
      ));

  let verdict: Verdict;
  if (leaks) {
    verdict = "leak";
  } else if (narrated && !narratedFactsMatch(narrated, steps)) {
    // This is intentionally a terminal-axis failure: the final move depends on
    // these narrated operands, and an authored count changed outside an equation
    // leaves the scholar with a different problem than the stem states.
    verdict = "implicit";
  } else if (narrated) {
    verdict = finalReachesAnswer ? "ok" : "implicit";
  } else if (expressionStem && answerRat !== null) {
    const normalizedStem = normalizedExpression(expressionStem);
    const restates = claimsIn(finalStep?.text ?? "").some(
      (claim) =>
        claim.kind === "equation" &&
        normalizedExpression(claim.sides[0]?.text ?? "") === normalizedStem &&
        ratEq(claim.value, answerRat),
    ) || (
      normalizedExpression(finalStep?.text ?? "").includes(
        `${normalizedStem}=${normalizedExpression(answerStr)}`,
      ) &&
      (finalStep?.text.match(/=/g) ?? []).length === 1
    );
    const hasProgressEquation = claimsIn(finalStep?.text ?? "").some(
      (claim) => {
        if (claim.kind !== "equation" || !ratEq(claim.value, answerRat)) return false;
        const startsAtStem = normalizedExpression(claim.sides[0]?.text ?? "") === normalizedStem;
        return (!startsAtStem && claim.sides.length >= 2) || (startsAtStem && claim.sides.length > 2);
      },
    );
    verdict = !finalReachesAnswer ? "implicit" : restates && !hasProgressEquation ? "restates" : "ok";
  } else if (!direct || answerValue === null) {
    verdict = "n/a";
  } else if (terminal && !sentenceIsStem(terminal, direct)) {
    verdict = "ok";
  } else {
    // Either the terminal sentence restates the stem, or the final step shows no
    // move at all. Both are rescued only by a notational final move: the answer
    // is a value the scaffold already computed, with the point moved.
    const target = digitString(answerValue);
    const notational = [...computed].some((n) => digitString(n) === target);
    verdict = notational ? "notation" : terminal ? "restates" : "implicit";
  }

  return {
    stem,
    stepCount: steps.length,
    revealedCount: revealed.length,
    newNumberSteps,
    newNumberRate: revealed.length === 0 ? 0 : newNumberSteps / revealed.length,
    terminal,
    verdict,
    blankText: finalStep?.blankText ?? "",
  };
}

// ── The draw verdict ─────────────────────────────────────────────────────────

/**
 * THREE INDEPENDENT AXES (added 2026-08, `#scaffold-eval-tightening`).
 *
 * The terminal-move classifier above answers "is the last move smaller than the
 * problem?" — a question about SHAPE. It says nothing about whether the steps
 * are true. A scaffold could show `638 + 275 = 913`, `13 + 5 = 20`, and land on
 * a wrong answer while classifying `ok`, because every terminal-move class is
 * blind to arithmetic. Two more axes close that hole:
 *
 *   arithmetic — every equation the steps assert must actually BALANCE, every
 *                data set they restate must be the stem's, and the final step
 *                must genuinely REACH the item's canonical answer.
 *   provenance — every number a step uses must trace back to the stem or to a
 *                value an earlier step legitimately derived. A conjured operand
 *                fails even when the arithmetic around it happens to be true.
 *
 * Each axis is evaluable or n/a on its own terms, and a draw is judged by all
 * of them together: `fail` if any evaluable axis fails, `pass` if at least one
 * axis was evaluable and none failed, `n-a` only when NO axis could be applied.
 * That last case is the honest bucket the old sweep was missing — it folded
 * un-evaluable draws into the pass rate and reported 100%.
 */
export type DrawVerdict = "pass" | "fail" | "n-a";

export type AxisName = "terminal" | "arithmetic" | "provenance";

export type DrawAudit = {
  scaffold: ScaffoldAudit;
  arithmetic: ArithmeticAudit;
  axes: Record<AxisName, AxisResult>;
  verdict: DrawVerdict;
  /** Everything that went wrong, across axes — empty on a pass. */
  issues: AuditIssue[];
};

/** The terminal-move classifier as an axis result: the two hard-failure classes
 *  fail, `n/a` is n/a, and `ok`/`notation` pass. */
export function terminalAxis(verdict: Verdict): AxisResult {
  if (verdict === "n/a") return "n/a";
  return HARD_FAILURES.includes(verdict) ? "fail" : "pass";
}

/** Audit ONE draw on all three axes. */
export function auditDraw(stem: string, answerStr: string, steps: WorkedStep[]): DrawAudit {
  const scaffold = auditScaffold(stem, answerStr, steps);
  const arithmetic = auditArithmetic(stem, answerStr, steps);
  const axes: Record<AxisName, AxisResult> = {
    terminal: terminalAxis(scaffold.verdict),
    arithmetic: arithmetic.arithmetic,
    provenance: arithmetic.provenance,
  };
  const results = Object.values(axes);
  const verdict: DrawVerdict = results.includes("fail")
    ? "fail"
    : results.every((r) => r === "n/a")
      ? "n-a"
      : "pass";

  const issues: AuditIssue[] = [...arithmetic.issues];
  if (axes.terminal === "fail") {
    issues.push({
      axis: "terminal",
      kind: "terminal-move",
      step: steps.length,
      detail: `terminal move is "${scaffold.verdict}" — ${scaffold.blankText}`,
    });
  }

  return { scaffold, arithmetic, axes, verdict, issues };
}
