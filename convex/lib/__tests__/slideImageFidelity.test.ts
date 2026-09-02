import { describe, expect, test } from "vitest";
import { buildFaithfulSlideImagePrompt } from "../slideImageFidelity";

describe("faithful slide image prompt", () => {
  test.each([
    "Show photosynthesis moving carbon from plants into the atmosphere.",
    "Put the gazelle above the lions as the apex predator.",
  ])("tells Gemini to preserve the learner's incorrect model: %s", (brief) => {
    const prompt = buildFaithfulSlideImagePrompt(brief);
    expect(prompt).toContain(brief);
    expect(prompt).toContain(
      "even when it is factually or scientifically incorrect",
    );
    expect(prompt).toContain("Do not substitute a canonical textbook version.");
  });
});
