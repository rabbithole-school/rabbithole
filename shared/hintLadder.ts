/**
 * Deterministic pre-answer help ladder shared by the server, web, and native.
 * The final worked step is never addressable: it is the answer-producing step
 * the scholar must finish in the item's real answer field.
 */

export type HintLadderAnswerType = "integer" | "decimal" | "fraction" | "expression";

export type HintLadderWorkedStep = {
  text: string;
  blankText?: string;
  /** Verified model-authored steps carry an explicit intermediate value. */
  expected?: string;
  answerType?: HintLadderAnswerType;
};

export type HintLadderRung =
  | {
      kind: "completion";
      stepIndex: number;
      prompt: string;
      expected: string;
      answerType: HintLadderAnswerType;
    }
  | {
      kind: "reveal";
      stepIndex: number;
      text: string;
    };

export type CompletedHintLadderRung = {
  rung: HintLadderRung;
  /** A wrong try still completes the rung, but the expected value was revealed. */
  revealedAfterWrong: boolean;
};

export type HintLadderAttemptResult = {
  completed: true;
  correct: boolean;
  revealedAfterWrong: boolean;
};

/**
 * The main answer is blocked only while the server is atomically serving and
 * marking a rung. Once that request settles, the rung owns keyboard focus but
 * never owns the item's submit gate.
 */
export function hintLadderBlocksMainSubmit(state: {
  servePending: boolean;
  activeCompletion: boolean;
}): boolean {
  return state.servePending;
}

export function hintLadderStepCount(steps: HintLadderWorkedStep[] | undefined): number {
  return Math.max(0, (steps?.length ?? 0) - 1);
}

function normalizePrompt(blankText: string): string {
  return blankText.replace(/_{2,}/g, "?").trim();
}

function answerTypeFor(expected: string): HintLadderAnswerType {
  if (/^[+-]?\d+$/.test(expected)) return "integer";
  if (/^[+-]?(?:\d+\.\d*|\.\d+)$/.test(expected)) return "decimal";
  if (/^[+-]?\d+\s*\/\s*[+-]?\d+$/.test(expected)) return "fraction";
  return "expression";
}

function isGradeableCandidate(candidate: string): boolean {
  if (
    /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:\s*\/\s*[+-]?\d+)?$/.test(candidate)
  ) {
    return true;
  }
  return (
    /[+\-−×÷*/^]/.test(candidate) &&
    /^[\d\s()+\-−×÷*/^./]+$/.test(candidate)
  );
}

/**
 * Conservatively recover a single gradeable result from a worked step. Steps
 * that ask for several values or a prose judgment remain tap-to-reveal.
 */
export function gradeableResultForStep(
  step: HintLadderWorkedStep,
): { prompt: string; expected: string; answerType: HintLadderAnswerType } | null {
  if (!step.blankText) return null;
  if (step.expected && step.answerType) {
    return {
      prompt: normalizePrompt(step.blankText),
      expected: step.expected,
      answerType: step.answerType,
    };
  }

  const equalityCount = (step.text.match(/=/g) ?? []).length;
  let candidate: string | undefined;
  if (equalityCount === 1) {
    candidate = step.text.split("=")[1];
  } else if (equalityCount === 0) {
    const colon = step.text.lastIndexOf(":");
    if (colon >= 0) candidate = step.text.slice(colon + 1);
  }
  candidate = candidate?.trim().replace(/[.!?]\s*$/, "").trim();
  if (!candidate || !isGradeableCandidate(candidate)) return null;

  return {
    prompt: normalizePrompt(step.blankText),
    expected: candidate,
    answerType: answerTypeFor(candidate),
  };
}

/**
 * Return exactly one intermediate rung. `steps.length - 1` and beyond always
 * return null, structurally withholding the final worked step.
 */
export function hintLadderRungAt(
  steps: HintLadderWorkedStep[] | undefined,
  stepIndex: number,
): HintLadderRung | null {
  if (
    !steps ||
    !Number.isInteger(stepIndex) ||
    stepIndex < 0 ||
    stepIndex >= hintLadderStepCount(steps)
  ) {
    return null;
  }
  const step = steps[stepIndex];
  const gradeable = gradeableResultForStep(step);
  return gradeable
    ? { kind: "completion", stepIndex, ...gradeable }
    : { kind: "reveal", stepIndex, text: step.text };
}

export function gradeHintLadderCompletion(
  rung: HintLadderRung,
  learnerAnswer: string,
  answersEqual: (
    learner: string,
    expected: string,
    answerType: HintLadderAnswerType,
  ) => boolean,
): boolean {
  if (rung.kind !== "completion") return false;
  const normalizeExpression = (value: string) =>
    value.replace(/×/g, "*").replace(/÷/g, "/").replace(/−/g, "-");
  const normalizedLearner =
    rung.answerType === "expression"
      ? normalizeExpression(learnerAnswer)
      : learnerAnswer;
  const normalizedExpected =
    rung.answerType === "expression"
      ? normalizeExpression(rung.expected)
      : rung.expected;
  return answersEqual(normalizedLearner, normalizedExpected, rung.answerType);
}

/**
 * Teach-as-action is attempt-gated, never correctness-gated. One grade attempt
 * always completes the rung: a correct value is acknowledged, while a wrong
 * value reveals the expected intermediate result and continues.
 */
export function resolveHintLadderAttempt(
  rung: HintLadderRung,
  learnerAnswer: string,
  answersEqual: (
    learner: string,
    expected: string,
    answerType: HintLadderAnswerType,
  ) => boolean,
): HintLadderAttemptResult {
  const correct = gradeHintLadderCompletion(rung, learnerAnswer, answersEqual);
  return {
    completed: true,
    correct,
    revealedAfterWrong: !correct,
  };
}

export function completedHintLadderText(
  rung: Extract<HintLadderRung, { kind: "completion" }>,
): string {
  const filled = rung.prompt.replace(/\?\s*$/, rung.expected);
  return filled === rung.prompt ? `${rung.prompt} ${rung.expected}` : filled;
}
