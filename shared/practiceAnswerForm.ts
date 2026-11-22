/**
 * What a typed practice item says about the FORM of its answer, shared by the
 * web and iPad practice screens:
 *
 *  - `answerFormHint` — the one line under the answer box when the served item
 *    carries an `answerForm` ("Answer in factored form").
 *  - `formNudgeOf` — the ONE adapter that recognises the grader's "right value,
 *    not yet in the form asked" outcome on a `submitAnswer` result. That outcome
 *    records nothing: the scholar keeps their answer, edits it, and resubmits.
 *    Every client reads the outcome through this function, so a change in the
 *    server's field names is a one-line fix here.
 *  - `usesAlgebraEditor` — whether an item is typed on the algebra pad.
 *
 * Imports nothing, so it vendors into the native app as a flat copy.
 */

/** Which extra keys the on-screen algebra pad shows (served-item contract §4). */
export type AnswerPalette = "algebra" | "complex" | "logs" | "sequence";

const ANSWER_FORM_HINTS: Record<string, string> = {
  lowestTerms: "Answer in lowest terms.",
  decimalNotation: "Answer as a decimal.",
  simplifiedRadical: "Simplify any square roots as far as they go.",
  factored: "Answer in factored form.",
  expanded: "Multiply it out and combine like terms.",
  complexStandard: "Answer in the form a + bi.",
  rationalizedDenominator: "Leave no root in the denominator.",
  singleLog: "Write it as a single logarithm.",
  expandedLog: "Expand it into separate logarithms.",
  singleFraction: "Write it as one fraction in lowest terms.",
  positiveExponents: "Use only positive exponents.",
  radicalForm: "Write it with a root sign.",
  exponentForm: "Write it with a fractional exponent.",
};

/** The hint line for an item's requested answer form, or null for none/unknown. */
export function answerFormHint(answerForm: string | null | undefined): string | null {
  if (!answerForm) return null;
  return ANSWER_FORM_HINTS[answerForm] ?? null;
}

/** Said when the server flags the form but sends no sentence of its own. */
export const FORM_NUDGE_FALLBACK = "That's equal to the answer. Now write it in the form asked for.";

/**
 * The form-nudge sentence when a submit result is the "equivalent but not in
 * the requested form" outcome, else null. The grader's shape (submitAnswer and
 * the placement/mapping mutations): an optional
 * `formNudge: { form: string; message: string }` beside `correct: false`.
 */
export function formNudgeOf(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const nudge = (result as { formNudge?: unknown }).formNudge;
  if (typeof nudge !== "object" || nudge === null) return null;
  const message = (nudge as { message?: unknown }).message;
  return typeof message === "string" && message.trim() ? message.trim() : FORM_NUDGE_FALLBACK;
}

/**
 * How many form nudges this item has received — sent back with every submit
 * as `formNudgesUsed` (0 on the first submit, +1 per nudge, reset per item).
 * The server grades normally once its cap is reached.
 */
export function nextFormNudgesUsed(previous: number, result: unknown): number {
  return formNudgeOf(result) !== null ? previous + 1 : previous;
}

/** A typed item uses the algebra pad when it declares a palette, or asks for a
 *  set of solutions. Everything else keeps its existing input. */
export function usesAlgebraEditor(item: { answerType: string; answerPalette?: string | null }): boolean {
  return item.answerType === "solutionSet" || isAnswerPalette(item.answerPalette);
}

export function isAnswerPalette(value: unknown): value is AnswerPalette {
  return value === "algebra" || value === "complex" || value === "logs" || value === "sequence";
}
