import { describe, expect, test } from "vitest";
import {
  completionClosingPool,
  selectCompletionClosing,
} from "../lib/tutorClosingGuidance";

describe("tutor closing guidance", () => {
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
        // Completion leaves the chat open, so no closing may claim the
        // conversation itself is over (TRA-501).
        expect(closing).not.toMatch(
          /\b(?:stop|stopping|close|closes|leave|conclusion|concludes|completes|over|bye|goodbye|end|ends)\b/i,
        );
      }
    }
    expect(completionClosingPool("pre-reader")).not.toEqual(
      completionClosingPool("5"),
    );
  });

  test("young readers get a young pool, decided by the turn-rules seam", () => {
    expect(completionClosingPool("pre-reader")).not.toEqual(
      completionClosingPool("K"),
    );
    for (const level of ["K", "1.5", "2.9"]) {
      expect(completionClosingPool(level)).toEqual(completionClosingPool("K"));
    }
    for (const level of ["3", "5", "college", null]) {
      expect(completionClosingPool(level)).toEqual(completionClosingPool("5"));
    }
    expect(completionClosingPool("K")).not.toEqual(completionClosingPool("5"));
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

});
