import { describe, expect, it } from "vitest";
import { rawAnswersEqual } from "../convex/lib/practice/answers";
import {
  completedHintLadderText,
  gradeHintLadderCompletion,
  gradeableResultForStep,
  hintLadderRungAt,
  hintLadderStepCount,
  hintLadderBlocksMainSubmit,
  resolveHintLadderAttempt,
} from "./hintLadder";

const steps = [
  {
    text: "Find a common denominator for 4 and 3: 12.",
    blankText: "Find a common denominator: ___",
  },
  {
    text: "Convert: 1/4 = 3/12 and 1/3 = 4/12.",
    blankText: "Convert both fractions: ___",
  },
  {
    text: "Add and simplify: 3/12 + 4/12 = 7/12.",
    blankText: "Add and simplify: ___",
  },
];

describe("deterministic hint ladder", () => {
  it("degrades no-step and one-step items directly to the coach", () => {
    expect(hintLadderStepCount(undefined)).toBe(0);
    expect(hintLadderStepCount([])).toBe(0);
    expect(hintLadderStepCount([{ text: "The final answer is 4." }])).toBe(0);
    expect(hintLadderRungAt([{ text: "The final answer is 4." }], 0)).toBeNull();
  });

  it("serves intermediate rungs in order and never addresses the final step", () => {
    expect(hintLadderStepCount(steps)).toBe(2);
    expect(hintLadderRungAt(steps, 0)).toMatchObject({
      kind: "completion",
      stepIndex: 0,
      expected: "12",
      answerType: "integer",
    });
    expect(hintLadderRungAt(steps, 1)).toEqual({
      kind: "reveal",
      stepIndex: 1,
      text: steps[1].text,
    });
    expect(hintLadderRungAt(steps, 2)).toBeNull();
    expect(JSON.stringify([hintLadderRungAt(steps, 0), hintLadderRungAt(steps, 1)]))
      .not.toContain("7/12");
  });

  it("only grades a step with one honest result value", () => {
    const rung = hintLadderRungAt(steps, 0);
    expect(rung).not.toBeNull();
    expect(gradeableResultForStep(steps[1])).toBeNull();
    expect(gradeHintLadderCompletion(rung!, "12.0", rawAnswersEqual)).toBe(true);
    expect(gradeHintLadderCompletion(rung!, "13", rawAnswersEqual)).toBe(false);
    if (rung?.kind === "completion") {
      expect(completedHintLadderText(rung)).toBe("Find a common denominator: 12");
    }
  });

  it("a wrong try reveals the value and completes instead of asking forever", () => {
    const rung = hintLadderRungAt(steps, 0);
    expect(rung).not.toBeNull();
    expect(resolveHintLadderAttempt(rung!, "13", rawAnswersEqual)).toEqual({
      completed: true,
      correct: false,
      revealedAfterWrong: true,
    });
  });

  it("the correct completion path remains completed without a reveal", () => {
    const rung = hintLadderRungAt(steps, 0);
    expect(rung).not.toBeNull();
    expect(resolveHintLadderAttempt(rung!, "12", rawAnswersEqual)).toEqual({
      completed: true,
      correct: true,
      revealedAfterWrong: false,
    });
  });

  it("blocks main submit only during the atomic serve, never for an active rung", () => {
    expect(
      hintLadderBlocksMainSubmit({
        servePending: true,
        activeCompletion: false,
      }),
    ).toBe(true);
    expect(
      hintLadderBlocksMainSubmit({
        servePending: false,
        activeCompletion: true,
      }),
    ).toBe(false);
  });

  it("grades equivalent intermediate fractions through the canonical comparator", () => {
    const rung = hintLadderRungAt(
      [
        { text: "Simplify: 6/8 = 3/4.", blankText: "Simplify 6/8: ?" },
        { text: "Use that result to finish the item." },
      ],
      0,
    );
    expect(rung).toMatchObject({ kind: "completion", answerType: "fraction" });
    expect(gradeHintLadderCompletion(rung!, "6/8", rawAnswersEqual)).toBe(true);
  });

  it("grades generated Unicode operator steps through the existing expression parser", () => {
    const rung = hintLadderRungAt(
      [
        {
          text: "Dividing by 1/8 means multiply by 8: 2 × 8.",
          blankText: "Multiply by the reciprocal of 1/8: ?",
        },
        { text: "Use that product to finish the division." },
      ],
      0,
    );
    expect(rung).toMatchObject({
      kind: "completion",
      expected: "2 × 8",
      answerType: "expression",
    });
    expect(gradeHintLadderCompletion(rung!, "2*8", rawAnswersEqual)).toBe(true);
    expect(gradeHintLadderCompletion(rung!, "2 × 8", rawAnswersEqual)).toBe(true);
    expect(gradeHintLadderCompletion(rung!, "16", rawAnswersEqual)).toBe(true);
    expect(gradeHintLadderCompletion(rung!, "15", rawAnswersEqual)).toBe(false);
  });
});
