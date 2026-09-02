import { describe, expect, test } from "vitest";
import {
  MARK_ACTIVITY_COMPLETE_SUCCESS_GUIDANCE,
  MARK_ACTIVITY_COMPLETE_TOOL_DESCRIPTION,
} from "../lib/activityCompletionTool";
import {
  RUBRIC_SCORE_COMPLETE_GUIDANCE,
  RUBRIC_SCORE_TOOL_DESCRIPTION,
} from "../lib/rubricScoreTool";
import {
  AUTOMATED_COMPLETION_CLOSING_GUIDANCE,
  SCHOLAR_OWNED_COMPLETION_CLOSING_GUIDANCE,
  TIME_LIMIT_WRAP_GUIDANCE,
  completionClosingPool,
  selectCompletionClosing,
} from "../lib/tutorClosingGuidance";

describe("tutor closing guidance", () => {
  test("completion tools share the automatic closing contract", () => {
    expect(MARK_ACTIVITY_COMPLETE_TOOL_DESCRIPTION).toContain(
      AUTOMATED_COMPLETION_CLOSING_GUIDANCE,
    );
    expect(RUBRIC_SCORE_TOOL_DESCRIPTION).toContain(
      AUTOMATED_COMPLETION_CLOSING_GUIDANCE,
    );
    expect(MARK_ACTIVITY_COMPLETE_SUCCESS_GUIDANCE).toContain(
      "app has already written its closing sentence",
    );
    expect(RUBRIC_SCORE_COMPLETE_GUIDANCE).toContain(
      "app has already written its closing sentence",
    );
  });

  test("model-authored fallback guidance preserves conclusion ownership", () => {
    expect(SCHOLAR_OWNED_COMPLETION_CLOSING_GUIDANCE).toContain(
      "Unless they explicitly asked for a recap",
    );
    expect(SCHOLAR_OWNED_COMPLETION_CLOSING_GUIDANCE).toContain(
      "name at most the shape of the thinking",
    );
    expect(SCHOLAR_OWNED_COMPLETION_CLOSING_GUIDANCE).toContain(
      "never enumerate the components",
    );
    expect(SCHOLAR_OWNED_COMPLETION_CLOSING_GUIDANCE).toContain(
      "If the sentence would remind a reader what the answer was",
    );
  });

  test("automatic closings are one sentence, content-free, and reading-level aware", () => {
    const levels = ["pre-reader", "K", "2.5", "5", "college"];
    for (const level of levels) {
      for (const closing of completionClosingPool(level)) {
        expect(closing).toMatch(/\.$/);
        expect(closing.slice(0, -1)).not.toContain(".");
        expect(closing).not.toMatch(/[?!\n]/);
        expect(closing).not.toMatch(
          /\b(?:good|great|solid|strong|correct|answer|evidence|criterion)\b/i,
        );
      }
    }
    expect(completionClosingPool("pre-reader")).not.toEqual(
      completionClosingPool("5"),
    );
  });

  test("automatic closing selection is stable but not a single template", () => {
    expect(selectCompletionClosing("5", "same-key")).toBe(
      selectCompletionClosing("5", "same-key"),
    );
    const selections = new Set(
      Array.from({ length: 40 }, (_, index) =>
        selectCompletionClosing("5", `completion-${index}`),
      ),
    );
    expect(selections.size).toBeGreaterThan(1);
  });

  test("time-limit guidance distinguishes an engaged close from departure", () => {
    expect(TIME_LIMIT_WRAP_GUIDANCE).toContain(
      "still engaged and the thought is unfinished",
    );
    expect(TIME_LIMIT_WRAP_GUIDANCE).toContain(
      "one brief content-free goodbye",
    );
    expect(TIME_LIMIT_WRAP_GUIDANCE).toContain(
      "no recap, praise, question, reflection, or suggested next step",
    );
    expect(TIME_LIMIT_WRAP_GUIDANCE).not.toContain("Offer a brief summary");
  });
});
