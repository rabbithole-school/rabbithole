import { describe, expect, it } from "vitest";
import { hintLadderRungAt } from "../../../shared/hintLadder";
import {
  PAD_HINT_IMAGE_GUARD,
  supportsPadHintModelCall,
  verifyPadHintOutput,
  type PadHintModelOutput,
} from "./padHints";

const valid: PadHintModelOutput = {
  nudge: "You split the tens cleanly; look at what happens to the two ones next.",
  steps: [
    {
      text: "Build the tens first: 4 × 10 = 40.",
      blankText: "Build the tens: ?",
      expected: "40",
      answerType: "integer",
      solutionExpression: "4 * 10",
    },
  ],
  finalStep: {
    text: "Combine the tens and ones: 40 + 2 = 42.",
    blankText: "Combine them: ?",
    expected: "42",
    answerType: "integer",
    solutionExpression: "40 + 2",
  },
};

describe("pad-grounded hint verifier", () => {
  it("keeps the final step server-side under the PR-3 sequencer", () => {
    const verified = verifyPadHintOutput(valid, {
      answerCanonical: "42",
      answerType: "integer",
      allowSteps: true,
    });
    expect(verified?.workedSteps).toHaveLength(2);
    expect(hintLadderRungAt(verified?.workedSteps, 0)).toMatchObject({
      kind: "completion",
      expected: "40",
    });
    expect(hintLadderRungAt(verified?.workedSteps, 1)).toBeNull();
    expect(JSON.stringify(hintLadderRungAt(verified?.workedSteps, 0))).not.toContain("42");
  });

  it("drops bad steps but preserves a verified one-line nudge", () => {
    const verified = verifyPadHintOutput(
      {
        ...valid,
        steps: [{ ...valid.steps![0], expected: "41" }],
      },
      {
        answerCanonical: "42",
        answerType: "integer",
        allowSteps: true,
      },
    );
    expect(verified).toEqual({ nudge: valid.nudge });
  });

  it("rejects an intermediate step that leaks the final answer", () => {
    const verified = verifyPadHintOutput(
      {
        ...valid,
        steps: [
          {
            ...valid.steps![0],
            text: "The final result will be 42; first build the tens.",
          },
        ],
      },
      {
        answerCanonical: "42",
        answerType: "integer",
        allowSteps: true,
      },
    );
    expect(verified).toEqual({ nudge: valid.nudge });
  });

  it("normalizes Unicode math operators before checking step values", () => {
    const verified = verifyPadHintOutput(
      {
        nudge: "Your reciprocal move is useful; inspect the product you wrote.",
        steps: [
          {
            text: "Multiply by the reciprocal: 2 × 8 = 16.",
            blankText: "Multiply 2 × 8: ?",
            expected: "16",
            answerType: "integer",
            solutionExpression: "2 × 8",
          },
        ],
        finalStep: {
          text: "Use that product to finish: 16 + 1 = 17.",
          blankText: "Finish the last move: ?",
          expected: "17",
          answerType: "integer",
          solutionExpression: "16 + 1",
        },
      },
      {
        answerCanonical: "17",
        answerType: "integer",
        allowSteps: true,
      },
    );
    expect(verified?.workedSteps?.[0].expected).toBe("16");
  });

  it("carries the non-math transcription guardrail", () => {
    expect(PAD_HINT_IMAGE_GUARD).toContain("Never transcribe");
    expect(PAD_HINT_IMAGE_GUARD).toContain("non-math");
  });

  it("fails soft when the one-line cell is invalid", () => {
    expect(
      verifyPadHintOutput(
        { ...valid, nudge: "The answer is 42." },
        {
          answerCanonical: "42",
          answerType: "integer",
          allowSteps: true,
        },
      ),
    ).toBeNull();
  });

  it("rejects a nudge that hands over a final-answer-producing expression", () => {
    expect(
      verifyPadHintOutput(
        {
          nudge:
            "Double-check the last multiplication: what is 482.5 × 2 exactly?",
        },
        {
          answerCanonical: "965",
          answerType: "integer",
          allowSteps: true,
        },
      ),
    ).toBeNull();
  });

  it("scrubs a candidate result copied from the pad without losing the grounded nudge", () => {
    expect(
      verifyPadHintOutput(
        {
          nudge:
            "Check whether the doubling move works, not the 965 itself.",
        },
        {
          stem: "4825 ÷ 5 = ?",
          answerCanonical: "965",
          answerType: "integer",
          allowSteps: true,
        },
      )?.nudge,
    ).toBe(
      "Check whether the doubling move works, not the result you wrote.",
    );
  });

  it("scrubs the answer from a comparison nudge even when it is a stem operand", () => {
    expect(
      verifyPadHintOutput(
        {
          nudge: "570 is greater because its tens digit is 7.",
        },
        {
          stem: "Which is greater: 507 or 570?",
          answerCanonical: "570",
          answerType: "integer",
          allowSteps: true,
        },
      )?.nudge,
    ).toBe("the result you wrote is greater because its tens digit is 7.");
  });

  it("allows an arithmetic nudge to repeat an answer token already used as an operand", () => {
    expect(
      verifyPadHintOutput(
        {
          nudge: "Look at what adding zero does to the 2 you started with.",
        },
        {
          stem: "2 + 0 = ?",
          answerCanonical: "2",
          answerType: "integer",
          allowSteps: true,
        },
      )?.nudge,
    ).toBe("Look at what adding zero does to the 2 you started with.");
  });

  it("excludes multiple-choice items before a pad-hint model call", () => {
    expect(supportsPadHintModelCall("multipleChoice")).toBe(false);
    expect(supportsPadHintModelCall("manipulative")).toBe(false);
    expect(supportsPadHintModelCall("integer")).toBe(true);
  });
});
