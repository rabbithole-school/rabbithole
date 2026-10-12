/**
 * The comparison arm — the SAME document graded by the TUTOR path
 * (`update_rubric_score`), so "does checkRubric read a young scholar's
 * writing better or worse than the tutor does" is an A/B on identical input
 * rather than an anecdote.
 *
 * Reuses evals/rubric-integrity/lib/runRubricTutor.ts's `generateTutorTurn`
 * verbatim — the real `buildSystemPrompt` with `standaloneDeliverableContext`
 * + the real tool constants — rather than forking a second copy of the tutor
 * side. (It deliberately does NOT reuse that eval's `lib/driver.ts`: this arm
 * needs a single one-shot grading turn, not a scripted multi-turn session.)
 *
 * ⚠️ Known asymmetry, load-bearing when reading the numbers: that harness's
 * `assembleTutorPrompt` passes `readingLevel: null` to `buildSystemPrompt`.
 * So the tutor arm always grades WITHOUT a reading-level line. Compare it
 * only against the checkRubric fixtures that also have `readingLevel: null`;
 * that is exactly why this eval ships a no-reading-level twin of the
 * invented-spelling case.
 *
 * The conversation is one neutral scholar turn ("I finished my writing") on
 * purpose — anything more would leak evidence the document itself does not
 * carry, and the whole point is to hold the document constant.
 */
import { generateTutorTurn } from "../../rubric-integrity/lib/runRubricTutor";
import type { RubricCase } from "../../rubric-integrity/lib/types";
import type { CheckRubricCase, Level } from "./types";

/** The single scholar turn that hands the document over. */
export const HANDOVER_TURN = "I finished my writing. Can you check it?";

export type TutorArmObservation = {
  called: boolean;
  levels: Record<string, Level>;
  overall: Level | null;
  text: string;
};

/** Adapt a checkRubric fixture to the RubricCase shape the tutor runner takes. */
function asRubricCase(testCase: CheckRubricCase): RubricCase {
  return {
    id: testCase.id,
    activityTitle: testCase.activityTitle,
    deliverablePrompt: testCase.deliverablePrompt,
    criteria: testCase.criteria,
    probedCriterionId: testCase.focusCriterionId,
    script: [HANDOVER_TURN],
    artifactVisibleFromTurn: 0,
    finalArtifactContent: testCase.submission,
    expectation: "should-be-full",
  };
}

export async function runTutorArm(
  testCase: CheckRubricCase,
  { offline = false }: { offline?: boolean } = {},
): Promise<TutorArmObservation> {
  const turn = await generateTutorTurn(
    asRubricCase(testCase),
    testCase.submission,
    [{ role: "scholar", content: HANDOVER_TURN }],
    offline,
  );
  const levels: Record<string, Level> = {};
  for (const v of (turn.calls.at(-1)?.verdicts ?? [])) levels[v.criterionId] = v.level;
  return {
    called: turn.calls.length > 0,
    levels,
    overall: turn.calls.at(-1)?.overall ?? null,
    text: turn.text,
  };
}
