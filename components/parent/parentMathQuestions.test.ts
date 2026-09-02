import { describe, expect, test, vi } from "vitest";
import {
  parentMathCannedQuestions,
  sendParentMathCannedQuestion,
} from "./parentMathQuestions";

describe("parent math canned questions", () => {
  test("every question is consistently punctuated", () => {
    const questions = parentMathCannedQuestions("Kai Kahale");

    expect(questions).toEqual([
      "What's a fun math activity we could do at home this weekend?",
      "Give me a dinner-table math question Kai would enjoy?",
    ]);
    expect(questions.every((question) => question.endsWith("?"))).toBe(true);
  });

  test("the selected text is sent unchanged", () => {
    const selected =
      parentMathCannedQuestions("Kai Kahale")[1];
    const seedComposer = vi.fn();

    sendParentMathCannedQuestion(selected, seedComposer);

    expect(seedComposer).toHaveBeenCalledWith(selected, { send: true });
  });
});
