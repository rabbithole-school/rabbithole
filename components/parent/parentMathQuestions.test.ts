import { describe, expect, test, vi } from "vitest";
import {
  parentMathCannedQuestions,
  sendParentMathCannedQuestion,
} from "./parentMathQuestions";

describe("parent math canned questions", () => {
  test("the selected text is sent unchanged", () => {
    const selected =
      parentMathCannedQuestions("Kai Kahale")[1];
    const seedComposer = vi.fn();

    sendParentMathCannedQuestion(selected, seedComposer);

    expect(seedComposer).toHaveBeenCalledWith(selected, { send: true });
  });
});
