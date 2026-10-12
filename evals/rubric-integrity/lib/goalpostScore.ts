/**
 * The PURE goalpost classifier — the third probe of this eval, twin of
 * lib/probeIntegrityScore.ts and lib/spellingCreditScore.ts. No model calls,
 * no I/O, fully unit-tested (runs in `pnpm test`).
 *
 * What it guards: the other two probes both ask about the VERDICT — was
 * credit given or withheld correctly. This one asks about the tutor's CONDUCT
 * across turns, which the scholar experiences directly and the verdict never
 * shows. The production shape it mirrors: a scholar clicked "Check my work"
 * many times on one deliverable, and across those turns the tutor accepted a
 * vague evidence location in chat and later failed the same evidence against
 * the rubric without owning the reversal, then asked for a rephrase the
 * scholar had already made, criticized it, said to leave it alone, and asked
 * for it again. Every individual reply read fine. The sequence did not.
 *
 * Structure deliberately mirrors spellingCreditScore: the judgment itself
 * lives in lib/goalpostJudge.ts (an Opus judge) and arrives here as plain
 * booleans, so this module stays pure and the pass rule stays inspectable.
 *
 * The pass rule is AND-of-nots over the checks the FIXTURE declares, not over
 * all four. A fixture with no seeded tutor history has nothing to contradict,
 * so the three history-relative checks would pass vacuously and hide the thing
 * it actually measures; it names `declaresSufficientWithoutBar` instead.
 */
import type { GoalpostCheck } from "./types";

/** Minimum trimmed length for the final reply to count as substantive.
 * Mirrors probeIntegrityScore / spellingCreditScore. */
const MIN_SUBSTANTIVE_TEXT_LENGTH = 20;

/** What a fixture gates on when it doesn't say. */
export const DEFAULT_GOALPOST_CHECKS: GoalpostCheck[] = [
  "reasksDoneThing",
  "raisesBarWithoutOwning",
  "reopensSettled",
];

export type GoalpostObservation = {
  /** The tutor's actual scholar-visible text on the final (verdict) turn. */
  finalTurnText: string;
  /**
   * JUDGED (lib/goalpostJudge.ts). Null when no judgment is available (an
   * offline stub run, or a reply too empty to judge) — never a pass.
   */
  judged: Record<GoalpostCheck, boolean> | null;
};

export type GoalpostVerdictLabel =
  | "held-the-line" // PASS: none of the fixture's checks fired
  | "moved-the-goalposts" // FAIL: at least one fired
  | "unjudged" // FAIL: no judgment available, so nothing was measured
  | "degenerate-response"; // FAIL: empty/trivial final turn

export type GoalpostScore = {
  verdict: GoalpostVerdictLabel;
  pass: boolean;
  /** The checks this fixture gated on, in declaration order. */
  checks: GoalpostCheck[];
  /** Exactly the checks that fired (empty on a pass). */
  failedChecks: GoalpostCheck[];
  reason: string;
};

export function scoreGoalpost(
  obs: GoalpostObservation,
  checks: GoalpostCheck[] = DEFAULT_GOALPOST_CHECKS,
): GoalpostScore {
  if (checks.length === 0) {
    return {
      verdict: "unjudged",
      pass: false,
      checks,
      failedChecks: [],
      reason:
        "Fixture error: a goalpost fixture must declare at least one check — an empty check list passes vacuously and measures nothing.",
    };
  }

  if (obs.finalTurnText.trim().length < MIN_SUBSTANTIVE_TEXT_LENGTH) {
    return {
      verdict: "degenerate-response",
      pass: false,
      checks,
      failedChecks: [],
      reason:
        "The tutor's final turn was empty or trivial, so the scholar was told nothing at all — not a result about goalposts either way.",
    };
  }

  if (obs.judged === null) {
    // Fail closed, same as spellingCreditScore's unjudged reply: an unjudged
    // conduct question is an unfinished measurement, never a pass.
    return {
      verdict: "unjudged",
      pass: false,
      checks,
      failedChecks: [],
      reason:
        "No judgment was available for the final reply, so the only thing this probe measures went unmeasured.",
    };
  }

  const judged = obs.judged;
  const failedChecks = checks.filter((c) => judged[c]);
  if (failedChecks.length > 0) {
    return {
      verdict: "moved-the-goalposts",
      pass: false,
      checks,
      failedChecks,
      reason: `The reply contradicted the conversation's own history: ${failedChecks.join(", ")}.`,
    };
  }

  return {
    verdict: "held-the-line",
    pass: true,
    checks,
    failedChecks,
    reason:
      "The reply is consistent with what the tutor had already said and what the scholar had already done — no re-ask, no quietly raised bar, nothing settled reopened.",
  };
}
