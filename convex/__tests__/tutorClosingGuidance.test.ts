import { describe, expect, test } from "vitest";
import {
  completionClosingPool,
  isAutomaticCompletionClosing,
  selectCompletionClosing,
} from "../lib/tutorClosingGuidance";

describe("tutor closing guidance", () => {
  test("the completion note is a plain status, not a verdict on the scholar's reasoning", () => {
    const levels = ["pre-reader", "K", "2.5", "5", "college", null];
    for (const level of levels) {
      for (const closing of completionClosingPool(level)) {
        expect(closing).toMatch(/\bdone\b/);
        expect(closing).not.toMatch(/[?!\n]/);
        // TRA-703: "the thinking was yours" read as a non-answer and
        // confused scholars. The note says only the activity's status.
        expect(closing).not.toMatch(
          /\b(?:you(?:r)? (?:worked|carried|did|thought|finished)|reasoning|thinking|own words|yours|good|great|solid|strong|correct|answer)\b/i,
        );
        // Completion leaves the chat open, so the note may not claim the
        // conversation itself is over (TRA-501) and says they can go on.
        expect(closing).not.toMatch(
          /\b(?:stop|stopping|close|closes|leave|conclusion|concludes|over|bye|goodbye|end|ends)\b/i,
        );
        expect(closing).toMatch(/keep talking/);
      }
    }
  });

  test("pre-readers get their own spoken note; everyone else shares one", () => {
    expect(completionClosingPool("pre-reader")).not.toEqual(
      completionClosingPool("5"),
    );
    for (const level of ["K", "1.5", "2.9", "3", "college", null]) {
      expect(completionClosingPool(level)).toEqual(completionClosingPool("5"));
    }
    expect(selectCompletionClosing("5", "a")).toBe(
      selectCompletionClosing("5", "b"),
    );
  });

  test("old stock lines are still recognized as automatic closings", () => {
    expect(
      isAutomaticCompletionClosing(
        "This activity is finished, and the thinking was yours.",
      ),
    ).toBe(true);
    expect(isAutomaticCompletionClosing(selectCompletionClosing("5", "k"))).toBe(
      true,
    );
    expect(isAutomaticCompletionClosing("Sharks can be very deadly.")).toBe(
      false,
    );
  });
});
