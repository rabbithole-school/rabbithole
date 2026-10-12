/**
 * The PURE emergent-spelling classifier — the second probe of this eval, and
 * the twin of lib/probeIntegrityScore.ts. No model calls, no I/O, fully
 * unit-tested (runs in `pnpm test`).
 *
 * What it guards: `probeIntegrityScore` only asks whether an UNANSWERED probe
 * silently became full credit — the overcredit direction. This asks the
 * opposite question, which no existing scorer covers: when the scholar HAS
 * done the work but wrote it in invented (phonetic) spelling, does the grader
 * decode it and credit it, or does it read the document literally, conclude
 * the criterion is missing, and tell the scholar so? That is the production
 * failure two clauses in convex/sessionHelpers.ts exist to fix — the trust
 * stance in buildArtifactSection and the credit licence in
 * RUBRIC_TOOL_GUIDANCE: an early-elementary scholar's prediction was scored
 * not-met over and over while the tutor insisted it was absent from her
 * document.
 *
 * Two halves, deliberately different in kind:
 *
 *  1. MECHANICAL — did `update_rubric_score` mark the probed criterion `full`
 *     anywhere in the session? Read straight off the recorded tool ledger; objective.
 *  2. JUDGED — did the tutor's scholar-visible reply avoid telling her the
 *     work is missing? Produced by the Opus judge in lib/spellingCreditJudge.ts
 *     and passed in here as `saysWorkIsMissing`, so this module stays pure.
 *
 * Both halves matter, and they fail independently. Crediting the criterion
 * while still saying "add a prediction" is the exact 25 minutes of production
 * damage in miniature — the scholar never sees the verdict, only the sentence.
 */

/** Minimum trimmed length for the tutor's final-turn text to count as a
 * genuine, substantive response rather than an empty or degenerate one.
 * Mirrors probeIntegrityScore's threshold. */
const MIN_SUBSTANTIVE_TEXT_LENGTH = 20;

export type SpellingCreditObservation = {
  /** Was any `update_rubric_score` verdict recorded anywhere in the session? */
  verdictRecorded: boolean;
  /**
   * The level assigned to the probed criterion on that call, or null if the
   * tool wasn't called or omitted a verdict for it. The whole point of the
   * fixture is that this criterion IS met in the document — just phonetically
   * spelled — so anything below `full` is the failure under test.
   */
  probedCriterionLevel: "not" | "half" | "full" | null;
  /** Every criterion was scored `full` on that call. */
  allCriteriaFull: boolean;
  /** The tutor's actual scholar-visible text on the final turn. */
  finalTurnText: string;
  /**
   * JUDGED (lib/spellingCreditJudge.ts): does the reply tell the scholar the
   * probed work is absent, or ask her to go add it? True = the production
   * harm. Null when the reply was too empty to judge.
   */
  saysWorkIsMissing: boolean | null;
};

export type SpellingCreditVerdict =
  | "credited-and-said-so" // PASS: criterion full AND the reply never claims the work is missing
  | "credited-but-still-told-missing" // FAIL: verdict full, but the chat reply still asks for the work she already did
  | "withheld-for-spelling" // FAIL: criterion below full — the phonetic spelling cost her the credit
  | "no-verdict-recorded" // FAIL: tool never called anywhere in the session, so nothing was credited
  | "degenerate-response"; // FAIL: empty/trivial final turn — nothing was actually said to the scholar

export type SpellingCreditScore = {
  verdict: SpellingCreditVerdict;
  pass: boolean;
  /** Mechanical half in isolation, for reporting the two halves separately. */
  creditedFull: boolean;
  /** Judged half in isolation (null when unjudgeable). */
  replyAvoidsMissingClaim: boolean | null;
  reason: string;
};

function isSubstantiveText(text: string): boolean {
  return text.trim().length >= MIN_SUBSTANTIVE_TEXT_LENGTH;
}

/**
 * Classify one emergent-spelling session. `expectation` is accepted for
 * symmetry with `scoreProbeIntegrity` and because run.ts passes the fixture's
 * declared expectation through; only `should-be-full` is meaningful here (a
 * fixture whose work is genuinely present cannot expect anything else), so an
 * other value is a fixture-authoring error and is reported as such.
 */
export function scoreSpellingCredit(
  obs: SpellingCreditObservation,
  expectation: "should-not-silently-full" | "should-be-full",
): SpellingCreditScore {
  const creditedFull = obs.verdictRecorded && obs.probedCriterionLevel === "full";
  const replyAvoidsMissingClaim =
    obs.saysWorkIsMissing === null ? null : !obs.saysWorkIsMissing;

  if (expectation !== "should-be-full") {
    return {
      verdict: "no-verdict-recorded",
      pass: false,
      creditedFull,
      replyAvoidsMissingClaim,
      reason:
        "Fixture error: the spelling-credit scorer only makes sense for a 'should-be-full' fixture — the work is present by construction, just phonetically spelled.",
    };
  }

  if (!isSubstantiveText(obs.finalTurnText)) {
    return {
      verdict: "degenerate-response",
      pass: false,
      creditedFull,
      replyAvoidsMissingClaim,
      reason:
        "The tutor's final turn was empty or trivial, so the scholar was told nothing at all — not a result about spelling either way.",
    };
  }

  if (!obs.verdictRecorded) {
    return {
      verdict: "no-verdict-recorded",
      pass: false,
      creditedFull,
      replyAvoidsMissingClaim,
      reason:
        "update_rubric_score was never called anywhere in the session, so the criterion the scholar demonstrably met in her document was never credited.",
    };
  }

  if (!creditedFull) {
    return {
      verdict: "withheld-for-spelling",
      pass: false,
      creditedFull,
      replyAvoidsMissingClaim,
      reason: `The probed criterion was scored '${obs.probedCriterionLevel ?? "not"}' even though the document contains it in invented spelling — the orthography, not the thinking, cost the scholar the credit.`,
    };
  }

  if (obs.saysWorkIsMissing === null) {
    // Fail closed: the judged half is half the result. An unjudged reply is an
    // unfinished measurement, never a pass.
    return {
      verdict: "degenerate-response",
      pass: false,
      creditedFull,
      replyAvoidsMissingClaim,
      reason:
        "The criterion earned full credit, but the reply was never judged (no judgment available), so the half that matters to the scholar is unmeasured.",
    };
  }

  if (obs.saysWorkIsMissing === true) {
    return {
      verdict: "credited-but-still-told-missing",
      pass: false,
      creditedFull,
      replyAvoidsMissingClaim,
      reason:
        "The criterion was recorded 'full', but the tutor's reply still told the scholar the work was missing or asked her to go add it — the verdict is private, so this is what she actually experiences.",
    };
  }

  return {
    verdict: "credited-and-said-so",
    pass: true,
    creditedFull,
    replyAvoidsMissingClaim,
    reason:
      "The grader decoded the invented spelling: the probed criterion earned full credit and the reply never claimed the work was missing.",
  };
}
