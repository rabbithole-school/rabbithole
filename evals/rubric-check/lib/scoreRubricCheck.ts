/**
 * The PURE layer of the rubric-check eval — no model calls, no I/O.
 *
 * Given what the grader returned for a fixture, decide whether it met that
 * fixture's expectation and reduce the verdict to a number so repeated runs
 * can be summarized. Unit-tested in __tests__/scoreRubricCheck.test.ts and
 * runs in `pnpm test` (same two-layer split as evals/rubric-integrity:
 * deterministic classifier + live runner that feeds it).
 *
 * Expectations are stated as ALLOWED LEVEL SETS rather than one exact level.
 * Judged output on a 3-point scale is noisy, and the honest claim for most of
 * these fixtures is a floor or a ceiling ("must not be scored `not`", "must
 * not be scored `full`"), not a point prediction.
 */
import type { CheckRubricCase, CheckRubricObservation, Level } from "./types";

/** not/half/full → 0/0.5/1, so a run of N gradings has a mean and a spread. */
export const LEVEL_SCORE: Record<Level, number> = {
  not: 0,
  half: 0.5,
  full: 1,
};

export type RubricCheckScore = {
  /** Both halves below held. */
  pass: boolean;
  /**
   * The CONTENT judgement: did the focus criterion land inside its allowed
   * set? Reported separately from `overallPass` on purpose — a grader that
   * emits a malformed `overall` must not be scored as if it misread the
   * scholar's writing.
   */
  focusPass: boolean;
  /** The `overall` verdict landed inside its allowed set AND was present. */
  overallPass: boolean;
  /** Level the grader gave the fixture's focus criterion. */
  focusLevel: Level | null;
  focusScore: number | null;
  /**
   * The model omitted `overall` entirely. In production this is not a soft
   * miss: `applyCheckResult` requires a not/half/full literal, and the throw
   * lands outside checkRubric's try/catch.
   */
  missingOverall: boolean;
  /**
   * The reported `overall` differs from what the tutor path's
   * `scoreRubricVerdicts` would derive. A definitional fork between the two
   * graders, not a self-contradiction — see CheckRubricObservation.
   */
  overallConsistent: boolean;
  reason: string;
};

export function scoreCheckRun(
  testCase: CheckRubricCase,
  observation: CheckRubricObservation,
): RubricCheckScore {
  const focusLevel = observation.levels[testCase.focusCriterionId] ?? null;
  const missingOverall = observation.reportedOverall === null;
  const overallConsistent =
    observation.reportedOverall === observation.derivedOverall;

  const waivedOk =
    !testCase.expectWaived ||
    observation.waived?.[testCase.focusCriterionId] === true;
  const focusPass =
    focusLevel !== null &&
    testCase.focusAllowed.includes(focusLevel) &&
    waivedOk;
  const overallPass =
    !missingOverall &&
    testCase.overallAllowed.includes(observation.reportedOverall as Level);

  const reasons: string[] = [];
  if (focusLevel === null) {
    reasons.push(`no verdict for focus criterion "${testCase.focusCriterionId}"`);
  } else if (!waivedOk) {
    reasons.push(`focus "${testCase.focusCriterionId}" was not marked waived`);
  } else if (!focusPass) {
    reasons.push(
      `focus "${testCase.focusCriterionId}" scored ${focusLevel}, expected one of ${testCase.focusAllowed.join("/")}`,
    );
  }
  if (missingOverall) {
    reasons.push("grader omitted `overall` (production would throw on write)");
  } else if (!overallPass) {
    reasons.push(
      `overall ${observation.reportedOverall}, expected one of ${testCase.overallAllowed.join("/")}`,
    );
  }
  return {
    pass: focusPass && overallPass,
    focusPass,
    overallPass,
    focusLevel,
    focusScore: focusLevel === null ? null : LEVEL_SCORE[focusLevel],
    missingOverall,
    overallConsistent,
    reason: reasons.length === 0 ? "met expectation" : reasons.join("; "),
  };
}

export type Spread = {
  n: number;
  mean: number;
  min: number;
  max: number;
  /** Population standard deviation. n=1 gives 0 — read it with the n. */
  stdev: number;
};

export function spread(values: readonly number[]): Spread {
  if (values.length === 0) {
    return { n: 0, mean: NaN, min: NaN, max: NaN, stdev: NaN };
  }
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return {
    n,
    mean,
    min: Math.min(...values),
    max: Math.max(...values),
    stdev: Math.sqrt(variance),
  };
}

/** Count how often each level appeared, for the report's distribution column. */
export function levelHistogram(levels: readonly (Level | null)[]): string {
  const counts: Record<string, number> = { not: 0, half: 0, full: 0, none: 0 };
  for (const l of levels) counts[l ?? "none"] += 1;
  return (["not", "half", "full", "none"] as const)
    .filter((k) => counts[k] > 0)
    .map((k) => `${k}×${counts[k]}`)
    .join(" ");
}
