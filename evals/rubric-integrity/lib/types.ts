/**
 * Types for the rubric-integrity eval (Moment F,
 * review/experiment-detective-tutor-audit.html): does the live
 * `update_rubric_score` tool ever let an unanswered tutor probe about a
 * criterion silently become full-credit evidence once the final artifact
 * merely looks complete?
 *
 * Every fixture uses SCRIPTED scholar turns (no emergent sim) — same
 * precedent as evals/activity-completion's should-withhold fixtures — because
 * this scenario needs precise, reproducible control over exactly when a
 * probe goes unanswered. The artifact (document) appears once, fully formed,
 * at `artifactVisibleFromTurn`; before that turn the tutor sees no document
 * yet, matching the real shape (the scholar writes the report only after the
 * conversation, not incrementally).
 */
import type { SimTurn } from "../../../convex/lib/curriculumSimShared";

export type { SimTurn };
/** Alias for readability in this eval — same `{ role, content }` shape as
 * curriculum-sim's SimTurn ("tutor" | "scholar" roles), reused directly so
 * this harness doesn't fork a parallel turn type. */
export type RubricTurn = SimTurn;

export type RubricCriterion = {
  id: string;
  label: string;
  description?: string;
};

export type RubricCase = {
  /** Stable id (usually the fixture filename without extension). */
  id: string;
  activityTitle: string;
  deliverablePrompt: string;
  criteria: RubricCriterion[];
  /** The criterion this fixture is testing the unanswered-probe behavior on. */
  probedCriterionId: string;
  /** Scripted scholar turns, played verbatim in order. */
  script: string[];
  /**
   * 0-based index into `script`. Before this scholar turn, no document
   * exists yet (artifactData is null); from this turn on, the tutor sees
   * `finalArtifactContent` as the scholar's submitted document.
   */
  artifactVisibleFromTurn: number;
  finalArtifactContent: string;
  /**
   * `should-not-silently-full` — the probe was asked and never really
   * answered; the probed criterion must not quietly become `full` once the
   * artifact looks complete.
   * `should-be-full` — regression guard: the probe WAS genuinely answered in
   * conversation, so the criterion (and the whole rubric) should legitimately
   * earn full credit and receive a substantive response.
   */
  expectation: "should-not-silently-full" | "should-be-full";
  /** Optional prose describing the failure mode this case guards. */
  note?: string;
};


export type RubricSessionResult = {
  case: RubricCase;
  turns: RubricTurn[];
  /** Whether `update_rubric_score` was called on the fixture's FINAL scripted turn. */
  toolCalledOnFinalTurn: boolean;
  /**
   * The level assigned to `probedCriterionId` on that call, or null if the
   * tool wasn't called or omitted a verdict for it.
   */
  probedCriterionLevel: "not" | "half" | "full" | null;
  /** Every criterion full on that call (i.e. the rubric legitimately passed). */
  allCriteriaFull: boolean;
  /** The tutor's scholar-visible text on the final turn (post-tool-result). */
  finalTurnText: string;
  /** Whether the final response is non-empty and substantive. */
  finalTextIsSubstantive: boolean;
};
