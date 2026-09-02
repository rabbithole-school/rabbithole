/**
 * Shared types for the teach-back ("explain it back" viva) eval.
 *
 * A scenario is one moment where a teach-back is (or is NOT) the right move.
 * The tutor plays a naive novice, the scholar TEACHES the concept, and a private
 * grading pass scores the EXPLANATION for the teacher. The eval measures the
 * tutor's conversation behavior (holds the novice stance, withholds the answer,
 * asks naive probes, never grades the kid) AND whether the shipped grader
 * discriminates a strong explanation from a thin / wrong one.
 */

/** How well the simulated scholar teaches the concept — drives the sim's brief
 *  AND the band the grader is expected to land the explanation in. */
export type ExplanationQuality = "strong" | "thin" | "wrong";

export interface Scenario {
  id: string;
  description: string;
  /**
   * The concept the scholar is set up to teach the tutor, in plain words — the
   * same phrasing the tutor would pass as `conceptLabel`.
   */
  concept: string;
  /**
   * Whether entering a teach-back is the right call for this moment. Most
   * scenarios set up a natural "I've got it / let me teach you" beat (true);
   * one sets up a mid-struggle-on-a-new-topic moment where a teach-back would
   * be premature (false). Scored as `cadenceFit` (judge) and mechanically as
   * enteredTeachBack × this flag.
   */
  expectTeachBack: boolean;
  /**
   * The band the sim aims for and the grader is expected to reflect. `null` when
   * expectTeachBack is false (no explanation is produced, so nothing to grade).
   */
  explanationQuality: ExplanationQuality | null;
  /** The scholar's opening line (they speak first, as in a real tutoring turn). */
  scholarOpener: string;
  /**
   * A one-line brief the SIM uses to stay in character (its stance / what it's
   * feeling / what it baits) — never shown to the tutor or the judge.
   */
  scholarStance: string;
}

/** One line of the conversation. `assistant` = tutor, `user` = scholar. */
export interface Turn {
  role: "user" | "assistant";
  content: string;
}

/** A record of a teach-back tool call the tutor made during a conversation. */
export interface TeachBackEvent {
  /** Which tutor turn (0-based index into the turn list) fired it. */
  atTurnIndex: number;
  tool: "start_teach_back" | "finish_teach_back";
  /** The conceptLabel the tutor passed to start_teach_back (if any). */
  conceptLabel: string | null;
}
