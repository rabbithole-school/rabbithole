import { describe, expect, it } from "vitest";

import {
  rawAnswersEqual,
  type AnswerType,
} from "../../../vendor/practice/answers";

// Teach-as-action (the "I haven't learned this yet" moment) grades its ONE blank
// CLIENT-SIDE with the vendored copy of the server's pure typed-answer core
// (native/vendor/practice/answers.ts — see native/src/app/practice.tsx's
// TeachingStep). The moment records nothing, but the blank must accept the same
// representations the server accepts (6/8 ≡ 0.75, reduced fractions, expression
// canonicalization) so a correct kid is never told "not quite". This test guards
// the vendored copy against drift and pins the exact predicate TeachingStep uses.

/** The exact client-side check TeachingStep runs on its one blank. */
function gradesCorrect(learnerRaw: string, truthRaw: string, type: AnswerType): boolean {
  return rawAnswersEqual(learnerRaw, truthRaw, type);
}

describe("teach-as-action client-side grading (vendored answers)", () => {
  it("accepts an exact integer match", () => {
    expect(gradesCorrect("42", "42", "integer")).toBe(true);
  });

  it("accepts the exact long-division co-solve answer", () => {
    expect(gradesCorrect("807", "807", "integer")).toBe(true);
  });

  it("rejects a wrong integer", () => {
    expect(gradesCorrect("41", "42", "integer")).toBe(false);
  });

  it("treats an unreduced fraction as equal by value (6/8 ≡ 3/4)", () => {
    expect(gradesCorrect("6/8", "3/4", "fraction")).toBe(true);
  });

  it("matches a fraction input against its decimal value under a decimal item (6/8 ≡ 0.75)", () => {
    expect(gradesCorrect("6/8", "0.75", "decimal")).toBe(true);
  });

  it("accepts a decimal with a trailing zero (6.50 ≡ 6.5)", () => {
    expect(gradesCorrect("6.50", "6.5", "decimal")).toBe(true);
  });

  it("rejects a wrong fraction", () => {
    expect(gradesCorrect("1/3", "3/4", "fraction")).toBe(false);
  });

  it("canonicalizes an expression answer (7 R 2 whitespace-insensitive)", () => {
    expect(gradesCorrect("7 R 2", "7R2", "expression")).toBe(true);
  });

  it("treats an empty or unparseable blank as incorrect (never a false pass)", () => {
    expect(gradesCorrect("", "42", "integer")).toBe(false);
    expect(gradesCorrect("abc", "42", "integer")).toBe(false);
  });
});
