import { describe, expect, test } from "vitest";
import { vocabularyWins } from "../vocabulary";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("vocabularyWins", () => {
  test("finds recent sophisticated first appearances with snippets", () => {
    const now = Date.UTC(2026, 5, 28);
    const wins = vocabularyWins(
      [
        { content: "<start>", createdAt: now - 20 * DAY_MS },
        {
          content: "Photosynthesis was in an older note outside the window.",
          createdAt: now - 120 * DAY_MS,
        },
        {
          content: "Because something happened around the playground.",
          createdAt: now - 9 * DAY_MS,
        },
        {
          content: "The aquaponics filtration system uses nitrification.",
          createdAt: now - 6 * DAY_MS,
        },
        {
          content: "Nitrification connects microorganisms and sustainability.",
          createdAt: now - 1 * DAY_MS,
        },
      ],
      { now, windowDays: 90, limit: 8 },
    );

    expect(wins.map((win) => win.word)).toEqual([
      "microorganisms",
      "sustainability",
      "nitrification",
      "aquaponics",
      "filtration",
    ]);
    expect(wins.find((win) => win.word === "nitrification")).toMatchObject({
      firstSeenAt: now - 6 * DAY_MS,
      useCount: 2,
    });
    expect(wins.find((win) => win.word === "aquaponics")?.snippet).toContain("aquaponics filtration");
    expect(wins.some((win) => win.word === "because")).toBe(false);
    expect(wins.some((win) => win.word === "something")).toBe(false);
    expect(wins.some((win) => win.word === "photosynthesis")).toBe(false);
  });

  test("respects the limit after sorting by recent first use", () => {
    const now = Date.UTC(2026, 5, 28);
    const wins = vocabularyWins(
      [
        { content: "Architecture hydraulics chromatography", createdAt: now - 4 * DAY_MS },
        { content: "Metacognition biodiversity", createdAt: now - 1 * DAY_MS },
      ],
      { now, limit: 2 },
    );

    expect(wins.map((win) => win.word)).toEqual(["metacognition", "biodiversity"]);
  });
});
