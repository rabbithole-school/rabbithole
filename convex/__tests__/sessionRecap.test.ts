import { describe, expect, test } from "vitest";
import {
  recapLinesFromGrowthStories,
  recapLinesFromSessionObservations,
  tinySessionRecap,
} from "../lib/sessionRecap";

describe("recapLinesFromGrowthStories", () => {
  test("frames growth as the scholar's own figuring out", () => {
    const lines = recapLinesFromGrowthStories([
      {
        conceptLabel: "Fractions",
        domain: "Math",
        latestAt: 1,
        excerpt: "I can compare eighths and fourths now",
        studentInitiated: false,
      },
    ]);

    expect(lines).toEqual([
      {
        key: "Fractions:1",
        text: "You figured out something new about fractions.",
        excerpt: "I can compare eighths and fourths now",
        conceptLabel: "Fractions",
        domain: "Math",
        tier: "growth",
      },
    ]);
  });

  describe("guaranteed proportional recap fallbacks", () => {
    test("mirrors current-session concepts without claiming growth", () => {
      const lines = recapLinesFromSessionObservations([
        {
          conceptLabel: "Adding money amounts",
          domain: "Mathematics",
          observedAt: 2,
        },
        {
          conceptLabel: "Decimal place value",
          domain: "Mathematics",
          observedAt: 3,
        },
      ]);

      expect(lines).toEqual([
        expect.objectContaining({
          tier: "mirror",
          text: "Today you worked on decimal place value and adding money amounts.",
          excerpt: null,
        }),
      ]);
      expect(lines[0].text).not.toMatch(/figured out|mastered|grew/i);
    });

    test("closes warmly when the session has no observations", () => {
      expect(tinySessionRecap()).toEqual([
        expect.objectContaining({
          tier: "tiny",
          text: "Short visit — this will be here when you want it.",
        }),
      ]);
    });
  });

  test("credits scholar-initiated connections without levels or engagement", () => {
    const lines = recapLinesFromGrowthStories([
      {
        conceptLabel: "DNA",
        domain: "Science",
        latestAt: 2,
        excerpt: "   “This is like a recipe for bodies.”   ",
        studentInitiated: true,
      },
    ]);

    expect(lines[0].text).toBe("You connected your own question to DNA.");
    expect(lines[0].excerpt).toBe("This is like a recipe for bodies.");
    expect(lines[0].text).not.toMatch(/level|score|engagement|time/i);
  });

  test("caps recap lines", () => {
    const lines = recapLinesFromGrowthStories(
      [
        {
          conceptLabel: "Concept A",
          domain: "Math",
          latestAt: 1,
          excerpt: null,
          studentInitiated: false,
        },
        {
          conceptLabel: "Concept B",
          domain: "Math",
          latestAt: 2,
          excerpt: null,
          studentInitiated: false,
        },
      ],
      1,
    );

    expect(lines).toHaveLength(1);
  });
});
