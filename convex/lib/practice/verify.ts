/**
 * The generation verification gate (Spike A), in JS for Convex actions.
 *
 * An LLM-generated candidate carries a stem, a stated answer, and a restricted
 * arithmetic `solutionExpression` that computes the answer. We accept it ONLY
 * when the safe evaluator's result agrees with the stated answer (typed-value
 * equivalence — never string compare) AND the answer FORMAT is enterable: a stem
 * that says "answer as a fraction" must be typed "fraction" (the only pad layout
 * with a "/" key), and a "fraction" item must not resolve to a whole number.
 * Anything else is rejected and never shown to a child. This is the contract
 * that lets us trust LLM word problems.
 *
 * Pure module — tested directly; the action (convex/practiceGen.ts) is the
 * thin wrapper that calls the model and stores only what passes.
 */

import {
  type AnswerType,
  type TypedAnswer,
  answersEqual,
  decAns,
  parseAnswer,
} from "./answers";
import { evalArithmetic } from "./evalExpr";
import { hasMarkdownFormatting } from "./plainText";

export type Candidate = {
  stem: string;
  answer: string;
  answerType: AnswerType;
  solutionExpression: string;
};

export type VerifyResult =
  | { ok: true; typedAnswer: TypedAnswer; value: number }
  | { ok: false; reason: string };

// Word-problem answers must be numeric (the arithmetic evaluator's domain).
const NUMERIC_TYPES: AnswerType[] = ["integer", "decimal", "fraction"];

/**
 * A stem that instructs the learner to answer as a fraction. Fraction input is
 * only offered for answerType "fraction" (web: the hardware-keyboard "/" routed
 * through the 2-D expression editor; native: the "/" key on
 * native/src/lib/practicePad.ts), so such a stem is only answerable when the
 * item is typed "fraction". This is the exact contradiction behind the
 * fraction-as-division bug: a stem that says "express your answer as a fraction"
 * typed `integer` gives no "/" input path.
 *
 * Matches the common pedagogical phrasings, tolerating adjectives between the
 * article and "fraction" ("as a simplified/improper/mixed/reduced fraction") and
 * the equivalent "simplest form" / "lowest terms" instructions. Biased toward
 * matching: a rare false positive only costs one over-generated candidate at the
 * gate, whereas a miss ships an unanswerable item — the failure this guards.
 */
const FRACTION_INSTRUCTION =
  /\bas an?\s+(?:\w+\s+){0,2}fractions?\b|\bin\s+fraction\s+form\b|\bin\s+(?:simplest|lowest)\s+(?:form|terms)\b/i;

export function stemAsksForFraction(stem: string): boolean {
  return FRACTION_INSTRUCTION.test(stem);
}

export function verifyCandidate(c: Candidate): VerifyResult {
  if (!c.stem || c.stem.trim().length < 6) return { ok: false, reason: "stem too short" };
  if (hasMarkdownFormatting(c.stem)) {
    return { ok: false, reason: "stem must be plain text without Markdown formatting" };
  }
  if (!NUMERIC_TYPES.includes(c.answerType)) {
    return { ok: false, reason: `unsupported answerType ${c.answerType}` };
  }
  const typed = parseAnswer(c.answer, c.answerType);
  if (!typed) return { ok: false, reason: "answer not parseable" };

  const value = evalArithmetic(c.solutionExpression);
  if (value === null) return { ok: false, reason: "solutionExpression did not evaluate" };

  if (!answersEqual(typed, decAns(value))) {
    return { ok: false, reason: "stated answer ≠ computed solution" };
  }
  // integer answers must actually be integers
  if (c.answerType === "integer" && !Number.isInteger(value)) {
    return { ok: false, reason: "non-integer value for integer answer" };
  }
  // ── Answer-FORMAT contract (not just arithmetic) ──────────────────────────
  // A stem that tells the learner to answer "as a fraction" is only enterable
  // when the item is typed "fraction" — that's what puts the "/" key on the
  // numeric pad. An integer/decimal item carrying that instruction is literally
  // impossible to answer (the reported fraction-as-division bug).
  if (stemAsksForFraction(c.stem) && c.answerType !== "fraction") {
    return { ok: false, reason: `stem asks for a fraction but answerType is ${c.answerType}` };
  }
  // A "fraction" item whose answer is a whole number is mis-typed: it need not be
  // a fraction at all, and for the a/b = a÷b concept a whole-number result
  // (8 ÷ 4 = 2) defeats the very idea that a fraction *is* a division.
  if (c.answerType === "fraction" && Number.isInteger(value)) {
    return { ok: false, reason: "fraction answer resolves to a whole number" };
  }
  return { ok: true, typedAnswer: typed, value };
}

/** Filter a batch of candidates to only the verified ones. */
export function verifyBatch(candidates: Candidate[]): {
  passed: { candidate: Candidate; typedAnswer: TypedAnswer }[];
  rejected: { candidate: Candidate; reason: string }[];
} {
  const passed: { candidate: Candidate; typedAnswer: TypedAnswer }[] = [];
  const rejected: { candidate: Candidate; reason: string }[] = [];
  for (const c of candidates) {
    const r = verifyCandidate(c);
    if (r.ok) passed.push({ candidate: c, typedAnswer: r.typedAnswer });
    else rejected.push({ candidate: c, reason: r.reason });
  }
  return { passed, rejected };
}
