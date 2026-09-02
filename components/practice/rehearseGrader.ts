/**
 * The client-side grader for a teacher REHEARSING a skill's question pool as a
 * scholar (the Content-view "Rehearse" on the Questions surface).
 *
 * The defect this closes: the old Rehearse link ran the ordinary scholar
 * `PracticeSession`, whose `submitAnswer` mutation minted real
 * `practiceMastery` / spaced-repetition rows — under the signed-in TEACHER's own
 * account. This grader is the injected, zero-write substitute for that submit.
 *
 * Why it CANNOT write, structurally (not by a runtime flag):
 *   • The factory is handed ONLY a `runRehearseQuery` capability — a function
 *     that reads the teacher-gated `rehearseGradeItem` QUERY. No mutation
 *     reference is in scope on this path, so there is nothing to call. (A Convex
 *     QUERY is itself write-incapable at the runtime level.)
 *   • Grading is CLIENT-SIDE and PURE: it runs the SAME `gradeSubmission`
 *     dispatcher the server drill uses, under `REHEARSE_POLICY` (every
 *     side-effect knob off), so a rehearse verdict is identical to a real one
 *     while minting nothing.
 *
 * This mirrors `TeachingStep`'s pattern: a read query reveals the answer to a
 * caller allowed to see it (the query is teacher-gated), and the verdict is then
 * computed on the client with the shared pure grader — never re-implemented.
 */

import { api } from "@/convex/_generated/api";
import {
  gradeSubmission,
  REHEARSE_POLICY,
  type ServableItem,
  type Submission,
} from "@/convex/lib/practice/servable";

/** The verdict a rehearse submission earns — the render-relevant subset of a
 *  drill `SubmitResult`. Everything spaced-repetition / mastery-shaped is absent
 *  because rehearse records nothing. */
export type RehearseVerdict = {
  correct: boolean;
  /** The reveal string, present only on a correct answer (drills withhold on a
   *  miss — `REHEARSE_POLICY.revealAnswer === "onCorrect"`). */
  correctAnswer?: string;
  /** "so close — needs the unit" signal, exactly as the drill reports it. */
  unitOutcome?: "missing" | "wrong";
  isDontKnow: boolean;
};

export type RehearseGrader = (input: {
  itemId: string;
  domain?: string;
  submission: Submission;
}) => Promise<RehearseVerdict>;

/** The ONLY backend capability a rehearse grader is given: reading the
 *  teacher-gated answer oracle. It is a read query — the grader is handed no
 *  mutation, by construction. */
export type RunRehearseQuery = (args: {
  itemId: string;
  domain?: string;
}) => Promise<ServableItem>;

/**
 * Build a rehearse grader from a single read capability. The returned function
 * fetches the answer oracle and grades the submission on the client with the
 * shared `gradeSubmission` under `REHEARSE_POLICY`. It has no way to write.
 */
export function createRehearseGrader(runRehearseQuery: RunRehearseQuery): RehearseGrader {
  return async ({ itemId, domain, submission }) => {
    const item = await runRehearseQuery({ itemId, domain });
    const grade = gradeSubmission(item, submission, REHEARSE_POLICY);
    return {
      correct: grade.correct,
      correctAnswer: grade.revealedAnswer,
      unitOutcome: grade.unitOutcome,
      isDontKnow: grade.isDontKnow,
    };
  };
}

/** The Convex query reference the caller wires `runRehearseQuery` to — exported
 *  so the page binds exactly this read (and only this read). */
export const rehearseGradeItemRef = api.practiceSkills.rehearseGradeItem;
