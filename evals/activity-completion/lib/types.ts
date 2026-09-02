/**
 * Types for the activity-completion eval. The scholar-simulator + activity /
 * profile shapes are reused from the curriculum-sim harness so the "kid voice"
 * stays single-sourced (buildKidSystem in convex/lib/curriculumSimShared.ts);
 * this file only adds the completion-specific fixture + result shapes.
 */
import type {
  ScholarProfile,
  SimActivity,
  SimTurn,
} from "../../curriculum-sim/lib/types";
import type {
  CompletionExpectation,
  CompletionObservation,
} from "./completionScore";

export type { ScholarProfile, SimActivity, SimTurn };

/**
 * One fixture: a conversation-only activity under test + the synthetic scholar
 * that plays through it + what the tutor SHOULD do by the end.
 *
 * `should-complete` cases pair an engaged scholar who works the goal through
 * with an activity whose arc genuinely finishes — the tutor must close it out
 * (on-time). `should-withhold` cases pair a disengaged / bail-early scholar
 * (or a "I'm done" hello) with the same shape — the tutor must NOT complete.
 */
export type CompletionCase = {
  /** Stable id (usually the fixture filename without extension). */
  id: string;
  activity: SimActivity;
  profile: ScholarProfile;
  expectation: CompletionExpectation;
  /**
   * Fixed scholar turns, played verbatim in order instead of the emergent sim. A
   * scripted scholar never signals [[DONE]]/[[STUCK]], so the goal is
   * definitionally never reached — any completion is too-soon. Used by
   * should-withhold fixtures so the scenario can't drift.
   */
  script?: string[];
  /**
   * Optional case-insensitive regexes that must all match one scholar turn for
   * deterministic goal evidence when the sim forgets to append [[DONE]].
   */
  goalEvidencePatterns?: string[];
  /** Optional prose describing the failure mode this case guards. */
  note?: string;
};

export type CompletionSessionResult = {
  case: CompletionCase;
  turns: SimTurn[];
  observation: CompletionObservation;
};
