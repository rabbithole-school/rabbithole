import { describe, it, expect } from "vitest";
import {
  gradeSubmission,
  PRACTICE_POLICY,
  REHEARSE_POLICY,
  type ServableItem,
  type Submission,
} from "../servable";
import type { AnswerType, TypedAnswer, UnitKey } from "../answers";
import type { NumberLineSpec } from "../../../../lib/manipulative/types";

// Parity + no-write proof for the teacher "Rehearse" grader. A rehearse session
// grades with the SAME `gradeSubmission` dispatcher the drill uses, only under
// REHEARSE_POLICY — so its verdict must equal the drill's for every answer type,
// while its policy mints nothing. Pure: no Convex, no deployment.

function templateItem(
  answerType: AnswerType,
  answer: TypedAnswer,
  opts: { choices?: string[]; requiredUnit?: UnitKey } = {},
): ServableItem {
  return {
    kind: "template",
    itemId: `skill#1`,
    skillKey: "skill",
    skillLabel: "Skill",
    domain: "whole-number-arithmetic",
    prompt: { stem: "stem", answerType },
    tutorContext: { type: "text", stem: "stem" },
    ref: { skillKey: "skill", seed: 1 },
    verifier: {
      kind: "template",
      answerType,
      answer,
      ...(opts.choices ? { choices: opts.choices } : {}),
      ...(opts.requiredUnit ? { requiredUnit: opts.requiredUnit } : {}),
    },
  };
}

// A real numberline "place the point at 3.25" manipulative — the pure grader
// re-runs its spec against the submitted state, exactly as the server does.
const NUMBERLINE_SPEC: NumberLineSpec = {
  kind: "numberline",
  id: "nl-decimal",
  concept: "Decimal magnitude",
  prompt: "Place the point at 3.25.",
  min: 0,
  max: 5,
  tickStep: 1,
  snap: 0.01,
  start: 0,
  goal: { type: "placeAt", value: 3.25, tolerance: 0.01 },
};

function manipulativeItem(): ServableItem {
  return {
    kind: "manipulative",
    itemId: "gen#nl",
    skillKey: "skill",
    skillLabel: "Skill",
    domain: "whole-number-arithmetic",
    prompt: { stem: "Place the point at 3.25.", answerType: "manipulative" as AnswerType },
    tutorContext: { type: "text", stem: "Place the point at 3.25." },
    ref: "x" as never,
    verifier: { kind: "manipulative", spec: JSON.stringify(NUMBERLINE_SPEC) },
  };
}

// One row per (item, submission) case, with the correctness the SERVER drill
// assigns. The rehearse grader must agree on every one.
const CASES: {
  name: string;
  item: ServableItem;
  submission: Submission;
  correct: boolean;
}[] = [
  {
    name: "integer — right",
    item: templateItem("integer", { type: "integer", value: 42 }),
    submission: { kind: "typed", raw: "42" },
    correct: true,
  },
  {
    name: "integer — wrong",
    item: templateItem("integer", { type: "integer", value: 42 }),
    submission: { kind: "typed", raw: "41" },
    correct: false,
  },
  {
    name: "decimal — representation (6.50 ≡ 6.5)",
    item: templateItem("decimal", { type: "decimal", value: 6.5 }),
    submission: { kind: "typed", raw: "6.50" },
    correct: true,
  },
  {
    name: "fraction — representation (6/8 ≡ 3/4)",
    item: templateItem("fraction", { type: "fraction", num: 3, den: 4 }),
    submission: { kind: "typed", raw: "6/8" },
    correct: true,
  },
  {
    name: "fraction — wrong value",
    item: templateItem("fraction", { type: "fraction", num: 3, den: 4 }),
    submission: { kind: "typed", raw: "2/4" },
    correct: false,
  },
  {
    name: "expression — canonical equivalence (x=8 ≡ 8)",
    item: templateItem("expression", { type: "expression", canonical: "8" }),
    submission: { kind: "typed", raw: "x = 8" },
    correct: true,
  },
  {
    name: "multipleChoice — right index (typed)",
    item: templateItem(
      "multipleChoice",
      { type: "multipleChoice", choiceIndex: 2 },
      { choices: ["a", "b", "c"] },
    ),
    submission: { kind: "typed", raw: "2" },
    correct: true,
  },
  {
    name: "multipleChoice — right index (choice submission)",
    item: templateItem(
      "multipleChoice",
      { type: "multipleChoice", choiceIndex: 2 },
      { choices: ["a", "b", "c"] },
    ),
    submission: { kind: "choice", index: 2 },
    correct: true,
  },
  {
    name: "multipleChoice — wrong index",
    item: templateItem(
      "multipleChoice",
      { type: "multipleChoice", choiceIndex: 2 },
      { choices: ["a", "b", "c"] },
    ),
    submission: { kind: "choice", index: 0 },
    correct: false,
  },
  {
    name: "unit-bearing — right value AND unit",
    item: templateItem("integer", { type: "integer", value: 112 }, { requiredUnit: "cm^3" }),
    submission: { kind: "typed", raw: "112 cm^3" },
    correct: true,
  },
  {
    name: "unit-bearing — right value, missing unit",
    item: templateItem("integer", { type: "integer", value: 112 }, { requiredUnit: "cm^3" }),
    submission: { kind: "typed", raw: "112" },
    correct: false,
  },
  {
    name: "don't-know is always a miss",
    item: templateItem("integer", { type: "integer", value: 42 }),
    submission: { kind: "dontKnow" },
    correct: false,
  },
  {
    name: "manipulative — solved state",
    item: manipulativeItem(),
    submission: { kind: "manipulativeState", stateJson: JSON.stringify({ value: 3.25 }) },
    correct: true,
  },
  {
    name: "manipulative — wrong state",
    item: manipulativeItem(),
    submission: { kind: "manipulativeState", stateJson: JSON.stringify({ value: 1.0 }) },
    correct: false,
  },
];

describe("REHEARSE_POLICY parity with the drill grader", () => {
  it.each(CASES)("$name — rehearse verdict == server verdict", ({ item, submission, correct }) => {
    const server = gradeSubmission(item, submission, PRACTICE_POLICY);
    const rehearse = gradeSubmission(item, submission, REHEARSE_POLICY);
    expect(server.correct).toBe(correct);
    expect(rehearse.correct).toBe(server.correct);
    // The "so close — needs the unit" signal must match too.
    expect(rehearse.unitOutcome).toBe(server.unitOutcome);
    // Reveal parity: both withhold on a miss and reveal on a correct.
    expect(!!rehearse.revealedAnswer).toBe(!!server.revealedAnswer);
    // A manipulative NEVER reveals an answer string, under either policy.
    if (item.kind === "manipulative") {
      expect(rehearse.revealedAnswer).toBeUndefined();
      expect(server.revealedAnswer).toBeUndefined();
    }
  });
});

describe("REHEARSE_POLICY records nothing", () => {
  it("turns every side-effect knob off", () => {
    expect(REHEARSE_POLICY.recordMastery).toBe(false);
    expect(REHEARSE_POLICY.recordPracticeAttempt).toBe(false);
    expect(REHEARSE_POLICY.recordLatency).toBe(false);
    expect(REHEARSE_POLICY.classifyErrorPatterns).toBe(false);
    expect(REHEARSE_POLICY.explanation).toBe("none");
  });

  it("produces no side-effect intentions from a graded submission", () => {
    for (const { item, submission } of CASES) {
      const grade = gradeSubmission(item, submission, REHEARSE_POLICY);
      expect(grade.shouldRecordMastery).toBe(false);
      expect(grade.shouldRecordPracticeAttempt).toBe(false);
      expect(grade.shouldRecordLatency).toBe(false);
      expect(grade.shouldClassifyError).toBe(false);
      expect(grade.explanationReason).toBeUndefined();
    }
  });
});
