/**
 * Types for the rubric-check eval — the "Submit & check" batch judge
 * (`checkRubric` in convex/deliverables.ts).
 *
 * Distinct from evals/rubric-integrity, which drives the TUTOR's
 * `update_rubric_score` tool mid-conversation. This one drives the grader
 * that sees only the rubric + the submitted document and NO transcript —
 * the least-context surface in the product, and therefore the one most
 * likely to misread a young scholar's writing.
 *
 * Every scholar identity here is fictional (`Nova`, borrowed from
 * evals/rubric-integrity). Submission strings are unattributed fixtures.
 */
export type Level = "not" | "half" | "full";

export type CheckRubricCriterion = {
  id: string;
  label: string;
  description?: string;
};

export type CheckRubricCase = {
  /** Stable id (the fixture filename without extension). */
  id: string;
  activityTitle: string;
  activityDescription?: string;
  deliverablePrompt: string;
  /**
   * Grade-string reading level, exactly as `users.readingLevel` stores it
   * ("K", "1", "2", …). `null` reproduces production's very common
   * unset case, which drops the calibration line from the prompt entirely.
   */
  readingLevel: string | null;
  criteria: CheckRubricCriterion[];
  /** The document text the scholar submitted (`deliverables.textContent`). */
  submission: string;
  /** The criterion this fixture is really about. */
  focusCriterionId: string;
  /** Levels for `focusCriterionId` that count as a pass for this fixture. */
  focusAllowed: Level[];
  /** Overall verdicts that count as a pass for this fixture. */
  overallAllowed: Level[];
  /**
   * Also grade the SAME document through the tutor path
   * (`update_rubric_score`, evals/rubric-integrity's runner) so the two
   * graders can be compared on identical input.
   */
  compareTutorPath?: boolean;
  /**
   * The activity's `assessesWritingMechanics` flag (TRA-502). Absent = the
   * production default (unset): spelling/punctuation/typing never move a
   * verdict. The tutor arm cannot carry this flag (rubric-integrity's context
   * has no slot for it), so only unflagged fixtures set `compareTutorPath`.
   */
  assessesWritingMechanics?: boolean;
  /** The focus criterion must come back marked `waived` (TRA-502). */
  expectWaived?: boolean;
  /** Prose describing what this fixture guards. */
  note?: string;
};

export type CheckRubricObservation = {
  /** Sanitized per-criterion levels, keyed by criterion id. */
  levels: Record<string, Level>;
  /** Notes the grader wrote per criterion. */
  notes: Record<string, string>;
  /** Criteria the grader marked `waived` (a `full` set aside under the conventions policy). */
  waived: Record<string, boolean>;
  /**
   * `overall` exactly as the model reported it — the value checkRubric passes
   * straight into `applyCheckResult`, whose validator requires a
   * not/half/full literal. `null` means the model omitted the field despite
   * the tool schema marking it required; in production that is an
   * ArgumentValidationError thrown OUTSIDE checkRubric's try/catch, i.e. the
   * scholar's "Check my work" fails outright with no verdict stored.
   */
  reportedOverall: Level | null;
  /**
   * `overall` as the TUTOR path's shared `scoreRubricVerdicts` would compute
   * it from the same verdicts (any "not" → "not"; else any "half" → "half").
   *
   * checkRubric never calls this — it stores the model's own `overall`, and
   * its system prompt defines "half" more loosely ("at least one criterion is
   * half OR not"). So a disagreement here is NOT the model contradicting
   * itself: it is the two graders writing DIFFERENT MEANINGS into the same
   * `deliverables.overall` field. Both agree on pass/fail (`overall === "full"`),
   * so the divergence shows up in what a scholar is told, not in whether they
   * passed.
   */
  derivedOverall: Level;
  /** Anthropic `stop_reason` — "max_tokens" would mean a truncated tool call
   * rather than a model that chose to omit a field. */
  stopReason: string | null;
  /** Top-level keys the model actually emitted in the tool input. */
  rawKeys: string[];
  feedback: string;
  conceptLabel: string;
  masteryLevel: number;
  confidence: number;
};
