/**
 * Aggregate stats for the rubricTelegraphing dimension — the "how often does
 * the tutor narrate the scoring map" baseline that
 * review/experiment-detective-tutor-audit.html §8 asks to publish BEFORE any
 * prompt change. Pure + framework-free so it's unit-testable without a judge
 * call (see __tests__/rubricTelegraphingStats.test.ts).
 */

export interface RubricTelegraphingStats {
  /** How many turns actually triggered scoring (non-null verdict). */
  scoredTurns: number;
  /** Turns scored <= violationThreshold — a clear telegraphing violation. */
  violations: number;
  /** violations / scoredTurns, or null if no turn was ever scored. */
  violationRate: number | null;
  /** Mean of the scored (non-null) values, or null if none were scored. */
  mean: number | null;
}

/**
 * @param scores turn-level rubricTelegraphing verdicts (null = not an
 *   evaluative/confirmation moment for that turn, so not counted).
 * @param violationThreshold scores at or below this count as a violation
 *   (default 2 — a turn that clearly telegraphed the scoring map).
 */
export function rubricTelegraphingStats(
  scores: ReadonlyArray<number | null | undefined>,
  violationThreshold = 2,
): RubricTelegraphingStats {
  const scored = scores.filter((s): s is number => typeof s === "number");
  const violations = scored.filter((s) => s <= violationThreshold).length;
  return {
    scoredTurns: scored.length,
    violations,
    violationRate: scored.length === 0 ? null : violations / scored.length,
    mean: scored.length === 0 ? null : scored.reduce((a, b) => a + b, 0) / scored.length,
  };
}
