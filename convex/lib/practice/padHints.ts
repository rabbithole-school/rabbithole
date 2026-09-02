/**
 * Pad-grounded hint prompt + verifier. Model output never crosses the wire
 * directly: one-line nudges and every step value are mechanically checked first.
 */

import { answersEqual, decAns, parseAnswer, type AnswerType } from "./answers";
import { evalArithmetic } from "./evalExpr";
import { hasMarkdownFormatting } from "./plainText";
import type {
  HintLadderAnswerType,
  HintLadderWorkedStep,
} from "../../../shared/hintLadder";

export const PAD_HINT_IMAGE_GUARD =
  "Engage only with the mathematics visible in the image. Never transcribe, " +
  "quote, or mention non-math content from the image in the reply.";

export type PadHintModelStep = {
  text: string;
  blankText: string;
  expected: string;
  answerType: HintLadderAnswerType;
  solutionExpression: string;
};

export type PadHintModelOutput = {
  nudge: string;
  steps?: PadHintModelStep[];
  finalStep?: PadHintModelStep;
};

export type VerifiedPadHint = {
  nudge: string;
  /** Full verified sequence, including the server-only final step. */
  workedSteps?: HintLadderWorkedStep[];
};

export const PAD_HINT_TOOL = {
  name: "emit_pad_hint" as const,
  description: "Return one pad-grounded nudge and, when requested, a worked-step sequence.",
  input_schema: {
    type: "object" as const,
    properties: {
      nudge: {
        type: "string" as const,
        description:
          "One short sentence grounded in the scholar's visible mathematical work. Name the next thing to inspect, never the answer.",
      },
      steps: {
        type: "array" as const,
        description:
          "Intermediate steps following the scholar's own method. Omit when no honest verified sequence is available.",
        items: {
          type: "object" as const,
          properties: {
            text: { type: "string" as const },
            blankText: { type: "string" as const },
            expected: { type: "string" as const },
            answerType: {
              type: "string" as const,
              enum: ["integer", "decimal", "fraction", "expression"],
            },
            solutionExpression: {
              type: "string" as const,
              description: "Arithmetic using digits, + - * / and parentheses that evaluates to expected.",
            },
          },
          required: ["text", "blankText", "expected", "answerType", "solutionExpression"],
        },
      },
      finalStep: {
        type: "object" as const,
        description:
          "The final answer-producing step, used only for server verification and never shown to the scholar.",
        properties: {
          text: { type: "string" as const },
          blankText: { type: "string" as const },
          expected: { type: "string" as const },
          answerType: {
            type: "string" as const,
            enum: ["integer", "decimal", "fraction", "expression"],
          },
          solutionExpression: { type: "string" as const },
        },
        required: ["text", "blankText", "expected", "answerType", "solutionExpression"],
      },
    },
    required: ["nudge"],
  },
};

export function buildPadHintPrompt(args: {
  stem: string;
  allowSteps: boolean;
}): string {
  return (
    `You are producing a silent, pre-answer math hint for a gifted elementary scholar.\n` +
    `Problem: ${args.stem}\n\n` +
    `Look at the scholar's actual pad and follow THEIR method. The nudge is exactly one short sentence: identify the specific written line, column, or move where their work turns, then point to the next thing in THAT work to inspect or do. Do not send them back to a line they already did correctly. Treat every candidate final result written on the pad as untrusted: never repeat or confirm it. Do not ask the scholar to evaluate or re-evaluate an expression whose value is the final answer; probe why their method works or point one move earlier instead. Never state, confirm, or compute the final answer. Never replace their method with the canonical algorithm.\n` +
    `${PAD_HINT_IMAGE_GUARD}\n` +
    (args.allowSteps
      ? `This item has no deterministic worked steps. If the pad contains enough mathematical work, also emit a complete sequence following their method: intermediate steps plus a separate final answer-producing step. Each step needs a blank prompt, expected value, answer type, and arithmetic solutionExpression. The final step is server-verification-only.`
      : `Do not emit steps for this item; its deterministic step producer already owns that cell.`)
  );
}

function normalizeExpression(value: string): string {
  return value.replace(/×/g, "*").replace(/÷/g, "/").replace(/−/g, "-");
}

function answerTokenPattern(answer: string): RegExp | null {
  const normalized = answer.trim();
  if (!normalized) return null;
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\d])${escaped}(?![\\d])`);
}

function answerTokenCount(text: string, answer: string): number {
  const pattern = answerTokenPattern(answer);
  if (!pattern) return 0;
  const global = new RegExp(pattern.source, "g");
  return [...text.matchAll(global)].length;
}

function leaksFinalAnswer(text: string, answer: string): boolean {
  return answerTokenCount(text, answer) > 0;
}

function isComparisonStem(stem: string): boolean {
  return (
    /\b(?:which|what)\s+(?:number\s+)?is\s+(?:greater|less|larger|smaller)\b/i.test(
      stem,
    ) ||
    /\bcompare\b/i.test(stem) ||
    /[<>]\s*\?/.test(stem)
  );
}

function scrubCandidateAnswerReference(
  text: string,
  answerCanonical: string,
  stem: string,
): string {
  const escaped = answerCanonical
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return text;
  const nudgeCount = answerTokenCount(text, answerCanonical);
  const stemCount = answerTokenCount(stem, answerCanonical);
  const replacementsNeeded = isComparisonStem(stem)
    ? nudgeCount
    : Math.max(0, nudgeCount - stemCount);
  if (replacementsNeeded === 0) return text;

  let remaining = replacementsNeeded;
  return text.replace(
    new RegExp(
      `(^|[^\\d])(?:the\\s+)?${escaped}(?:\\s+itself)?(?![\\d])`,
      "g",
    ),
    (match, prefix: string) => {
      if (remaining <= 0) return match;
      remaining -= 1;
      return `${prefix}the result you wrote`;
    },
  );
}

function computesFinalAnswer(
  text: string,
  answerCanonical: string,
  answerType: AnswerType,
): boolean {
  const answer = parseAnswer(answerCanonical, answerType);
  if (!answer) return true;
  const expressions = text.match(
    /[+-]?\d+(?:\.\d+)?(?:\s*[+\-−×÷*/]\s*[+-]?\d+(?:\.\d+)?)+/g,
  ) ?? [];
  return expressions.some((expression) => {
    const value = evalArithmetic(normalizeExpression(expression));
    return value !== null && answersEqual(answer, decAns(value));
  });
}

function verifyNudge(
  nudge: unknown,
  answerCanonical: string,
  answerType: AnswerType,
  stem: string,
): string | null {
  if (typeof nudge !== "string") return null;
  const text = scrubCandidateAnswerReference(
    nudge.trim(),
    answerCanonical,
    stem,
  );
  const nudgeAnswerCount = answerTokenCount(text, answerCanonical);
  const stemAnswerCount = answerTokenCount(stem, answerCanonical);
  if (
    text.length < 4 ||
    text.length > 240 ||
    text.includes("\n") ||
    hasMarkdownFormatting(text) ||
    /[.!?]\s+[A-Z]/.test(text) ||
    /\b(?:answer|result)\s+(?:is|=)\s+the result you wrote\b/i.test(text) ||
    (isComparisonStem(stem) && nudgeAnswerCount > 0) ||
    nudgeAnswerCount > stemAnswerCount ||
    computesFinalAnswer(text, answerCanonical, answerType)
  ) {
    return null;
  }

  return text;
}

export function supportsPadHintModelCall(answerType: string): boolean {
  return ["integer", "decimal", "fraction", "expression"].includes(answerType);
}

function verifyStep(step: PadHintModelStep): HintLadderWorkedStep | null {
  if (
    !step ||
    typeof step.text !== "string" ||
    typeof step.blankText !== "string" ||
    typeof step.expected !== "string" ||
    typeof step.solutionExpression !== "string" ||
    !["integer", "decimal", "fraction", "expression"].includes(step.answerType)
  ) {
    return null;
  }
  const expected = parseAnswer(step.expected, step.answerType as AnswerType);
  const value = evalArithmetic(normalizeExpression(step.solutionExpression));
  if (!expected || value === null || !answersEqual(expected, decAns(value))) {
    return null;
  }
  const text = step.text.trim();
  const blankText = step.blankText.trim();
  if (!text || !blankText || hasMarkdownFormatting(text) || hasMarkdownFormatting(blankText)) {
    return null;
  }
  return {
    text,
    blankText,
    expected: step.expected.trim(),
    answerType: step.answerType,
  };
}

export function verifyPadHintOutput(
  raw: PadHintModelOutput,
  args: {
    answerCanonical: string;
    answerType: AnswerType;
    allowSteps: boolean;
    stem?: string;
  },
): VerifiedPadHint | null {
  const nudge = verifyNudge(
    raw?.nudge,
    args.answerCanonical,
    args.answerType,
    args.stem ?? "",
  );
  if (!nudge) return null;
  if (!args.allowSteps || !raw.steps?.length || !raw.finalStep) {
    return { nudge };
  }
  if (raw.steps.length > 5) return { nudge };

  const intermediate = raw.steps.map(verifyStep);
  const finalStep = verifyStep(raw.finalStep);
  if (intermediate.some((step) => step === null) || !finalStep) {
    return { nudge };
  }
  const finalExpected = parseAnswer(
    finalStep.expected ?? "",
    finalStep.answerType as AnswerType,
  );
  const itemAnswer = parseAnswer(args.answerCanonical, args.answerType);
  if (!finalExpected || !itemAnswer || !answersEqual(finalExpected, itemAnswer)) {
    return { nudge };
  }
  const leaks = intermediate.some((step) => {
    if (!step) return true;
    const expected = parseAnswer(step.expected ?? "", step.answerType as AnswerType);
    return (
      leaksFinalAnswer(step.text, args.answerCanonical) ||
      leaksFinalAnswer(step.blankText ?? "", args.answerCanonical) ||
      (expected !== null && answersEqual(expected, itemAnswer))
    );
  });
  if (leaks) return { nudge };

  return {
    nudge,
    workedSteps: [...(intermediate as HintLadderWorkedStep[]), finalStep],
  };
}
