import { describe, expect, test } from "vitest";
import { flairEmojiForCriterion } from "./flairPresentation";

describe("flairEmojiForCriterion", () => {
  test("chooses an emoji that reflects the flair label", () => {
    expect(
      flairEmojiForCriterion("rubric-full-opening", "Zooms in on one small moment"),
    ).toBe("🔎");
    expect(
      flairEmojiForCriterion(
        "rubric-full-sequence",
        "Keeps the sequence easy to follow",
      ),
    ).toBe("🧭");
  });

  test("gives unmatched criteria a stable fallback across surfaces", () => {
    expect(flairEmojiForCriterion("rubric-full-surprise")).toBe(
      flairEmojiForCriterion("rubric-full-surprise"),
    );
  });
});
