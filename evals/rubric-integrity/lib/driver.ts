/**
 * The conversation driver for the rubric-integrity eval — plays a fixture's
 * SCRIPTED scholar turns against the real tool-bound tutor and records what
 * `update_rubric_score` returned on the FINAL scripted turn, which is the
 * moment the fixture's report becomes visible as `finalArtifactContent`
 * (governed by `artifactVisibleFromTurn`).
 *
 * Difference from evals/activity-completion's driver: there is no emergent
 * sim and no goal-reached/grace-window bookkeeping — the script is fully
 * authored, so "did the tutor silently give the probed criterion full credit
 * on the submission turn" is read directly off that turn's tool call.
 */
import { generateTutorTurn } from "./runRubricTutor";
import type { RubricCase, RubricSessionResult, RubricTurn } from "./types";

export async function runRubricSession(
  testCase: RubricCase,
  opts: {
    offline?: boolean;
    onTurn?: (t: RubricTurn) => void;
  } = {},
): Promise<RubricSessionResult> {
  const offline = opts.offline ?? false;
  const turns: RubricTurn[] = [];
  const push = (t: RubricTurn) => {
    turns.push(t);
    opts.onTurn?.(t);
  };

  let toolCalledOnFinalTurn = false;
  let probedCriterionLevel: "not" | "half" | "full" | null = null;
  let allCriteriaFull = false;
  let finalTurnText = "";

  for (let i = 0; i < testCase.script.length; i++) {
    push({ role: "scholar", content: testCase.script[i] });
    const isFinalTurn = i === testCase.script.length - 1;
    const documentContent =
      i >= testCase.artifactVisibleFromTurn
        ? testCase.finalArtifactContent
        : null;

    const tutor = await generateTutorTurn(
      testCase,
      documentContent,
      turns,
      offline,
    );
    push({ role: "tutor", content: tutor.text });

    if (isFinalTurn) {
      toolCalledOnFinalTurn = tutor.called;
      finalTurnText = tutor.text;
      if (tutor.called && tutor.verdicts) {
        const probed = tutor.verdicts.find(
          (v) => v.criterionId === testCase.probedCriterionId,
        );
        probedCriterionLevel = probed?.level ?? null;
        allCriteriaFull = tutor.overall === "full";
      }
    }
  }

  return {
    case: testCase,
    turns,
    toolCalledOnFinalTurn,
    probedCriterionLevel,
    allCriteriaFull,
    finalTurnText,
    finalTextIsSubstantive: finalTurnText.trim().length >= 20,
  };
}
