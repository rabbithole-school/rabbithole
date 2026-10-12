/**
 * The PURE unanswered-probe classifier — no model calls, no I/O, fully
 * unit-tested (runs in `pnpm test`). This is the deterministic core that
 * guards the one thing `update_rubric_score`'s guidance can get wrong when
 * the prompt changes: letting an unresolved conversational question about a
 * criterion quietly become full-credit evidence once the artifact merely
 * looks complete (review/experiment-detective-tutor-audit.html, Moment F).
 *
 * The signal it consumes is produced by the model-in-the-loop driver
 * (lib/driver.ts): a scripted scholar conversation plays through a
 * document-rubric activity against the real production tutor prompt +
 * `update_rubric_score` tool, and we record what that tool returned for the
 * probed criterion ACROSS THE WHOLE SESSION (or that it was never called at
 * all). Session-wide, not final-turn-only: a tutor that credits the criterion
 * on the turn the document appears and then spends the last turn confirming it
 * in prose calls no tool on that turn, and reading only the last turn scored
 * that correct session as a dropped thread. See lib/rubricCallRecord.ts.
 */

export type ProbeExpectation = "should-not-silently-full" | "should-be-full";

/** Minimum trimmed length for the tutor's final-turn text to count as a
 * genuine, substantive response rather than an empty or degenerate one. */
const MIN_SUBSTANTIVE_TEXT_LENGTH = 20;

export type ProbeIntegrityObservation = {
  /**
   * Was `update_rubric_score` called ANYWHERE in the session — any turn, any
   * tool round? Named for what it measures. It was `toolCalledOnFinalTurn`
   * while the driver really did read only the final turn; keeping that name
   * over a session-wide value made every emitted `reason` string say "the
   * submission turn" about a session-wide fact, and eval artifacts have to be
   * self-explanatory. Renamed rather than re-documented so a stale caller
   * fails the typecheck instead of silently mislabelling its own output.
   */
  verdictRecorded: boolean;
  /**
   * The HIGHEST level the probed criterion reached in the session, or null if
   * no call carried a verdict for it (an omitted criterion is treated as
   * "not" by production's scoreRubricVerdicts, but null is reported here so a
   * silent-omission bug stays distinguishable from an explicit "not").
   * Highest-ever because production's flair is monotonic — see
   * lib/rubricCallRecord.ts.
   */
  probedCriterionLevel: "not" | "half" | "full" | null;
  /** Some call in the session scored every criterion `full`. */
  allCriteriaFull: boolean;
  /** Whether the document-rubric response is non-empty and substantive. */
  finalTextIsSubstantive: boolean;
  /**
   * The tutor's actual scholar-visible text on the final turn. Inspected so a
   * "revisited" or "partial-with-gap" verdict is backed by a genuine,
   * substantive response — not silence, an empty/degenerate turn (the
   * max-tokens-truncation bug this harness hit during development), or a
   * dropped thread the classifier would otherwise credit as a pass just
   * because the tool wasn't called or didn't return "full".
   */
  finalTurnText: string;
};

export type ProbeIntegrityVerdict =
  | "silent-full-credit" // FAIL: probed criterion marked full despite the unanswered probe
  | "silent-non-response" // FAIL: tool wasn't called AND the tutor said nothing substantive — a dropped thread, not a revisit
  | "revisited" // PASS: tool wasn't called, and the tutor responded substantively — consistent with deferring to revisit
  | "partial-with-gap" // PASS/FAIL: criterion scored below full; PASS only if the tutor actually said something about it
  | "genuinely-full" // PASS (should-be-full case): criterion legitimately earned full credit
  | "overly-conservative"; // FAIL (should-be-full case): a genuinely answered probe still withheld

export type ProbeIntegrityScore = {
  verdict: ProbeIntegrityVerdict;
  pass: boolean;
  reason: string;
};

function isSubstantiveText(text: string): boolean {
  return text.trim().length >= MIN_SUBSTANTIVE_TEXT_LENGTH;
}

/**
 * A genuine engagement with the open gap, not just a substantive-length reply.
 * RUBRIC_TOOL_GUIDANCE and buildAdvanceRubricSection both instruct the tutor
 * to "ask one Socratic question about the biggest gap" whenever a criterion
 * is below full — every observed passing transcript during development
 * followed that instruction and ended in a question mark. A generic
 * acknowledgment like "Your report is nicely organized overall." is long
 * enough to pass a length-only check while never actually re-engaging with
 * the specific criterion the probe was about — requiring a "?" closes that
 * gap without needing full NLP-level topic matching.
 */
function engagesWithTheGap(text: string): boolean {
  return isSubstantiveText(text) && text.includes("?");
}

/** Classify a single session's outcome against its fixture's expectation. */
export function scoreProbeIntegrity(
  obs: ProbeIntegrityObservation,
  expectation: ProbeExpectation,
): ProbeIntegrityScore {
  if (expectation === "should-not-silently-full") {
    if (!obs.verdictRecorded) {
      const engaged = engagesWithTheGap(obs.finalTurnText);
      return {
        verdict: engaged ? "revisited" : "silent-non-response",
        pass: engaged,
        reason: engaged
          ? "update_rubric_score was never called anywhere in the session, and the tutor asked a substantive follow-up question — consistent with revisiting the open question instead of scoring past it."
          : "update_rubric_score was never called anywhere in the session, and the tutor's response was empty, trivial, or didn't actually ask anything back — a dropped thread, not a genuine revisit of the open question.",
      };
    }
    if (obs.probedCriterionLevel === "full") {
      return {
        verdict: "silent-full-credit",
        pass: false,
        reason:
          "update_rubric_score marked the probed criterion 'full' at some point in the session even though the tutor's own earlier question about it was never answered. Scored on the peak: production mints the flair on that call and never revokes it.",
      };
    }
    const engaged = engagesWithTheGap(obs.finalTurnText);
    return {
      verdict: "partial-with-gap",
      pass: engaged,
      reason: engaged
        ? `The probed criterion never rose above '${obs.probedCriterionLevel ?? "not"}' anywhere in the session, so it was not silently 'full', and the tutor asked a substantive question naming the gap.`
        : `The probed criterion never rose above '${obs.probedCriterionLevel ?? "not"}' anywhere in the session (so it was not silently 'full'), but the tutor's response was empty, trivial, or generic — it never actually engaged with the open question, so the gap was not really communicated to the scholar.`,
    };
  }

  // should-be-full: regression guard against overcorrection. A genuinely
  // answered probe must still earn full credit and a substantive response.
  if (obs.verdictRecorded && obs.probedCriterionLevel === "full") {
    if (!obs.allCriteriaFull) {
      return {
        verdict: "partial-with-gap",
        pass: false,
        reason:
          "The probed criterion earned full credit, but another criterion was held back even though the scholar completed the work — check the fixture's artifact against the full rubric.",
      };
    }
    return {
      verdict: "genuinely-full",
      pass: obs.finalTextIsSubstantive,
      reason: obs.finalTextIsSubstantive
        ? "The genuinely answered criterion earned full credit and the document review received a substantive response."
        : "The criterion earned full credit, but the document review received no substantive response.",
    };
  }
  return {
    verdict: obs.verdictRecorded ? "partial-with-gap" : "revisited",
    pass: false,
    reason:
      "The scholar genuinely answered the probe in conversation, but the tutor still withheld full credit for that criterion — an overly conservative regression.",
  };
}
