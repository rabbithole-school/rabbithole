import { describe, expect, test } from "vitest";
import {
  buildPortfolioWritingSamples,
  portfolioProseStats,
  PORTFOLIO_MIN_PROSE_WORDS,
  type PortfolioProseCandidate,
} from "../portfolioWriting";

const DAY_MS = 24 * 60 * 60 * 1000;

const STORY =
  "Yesterday my family drove to the rocky beach near the lighthouse. " +
  "The waves were enormous and cold, crashing against the black stones. " +
  "I found a tide pool full of tiny crabs and a bright orange starfish clinging to the edge.";

const MATH_WORKSHEET = "3/4 + 1/2 = 5/4 and 12 x 3 = 36 so 7 - 2 = 5 and 9 + 8 = 17 100 / 4 = 25";

describe("portfolioProseStats", () => {
  test("treats a composed story as prose and scores a grade level", () => {
    const stats = portfolioProseStats(STORY);
    expect(stats.isProse).toBe(true);
    expect(stats.wordCount).toBeGreaterThanOrEqual(PORTFOLIO_MIN_PROSE_WORDS);
    expect(stats.fleschKincaidGrade).toBeGreaterThan(0);
  });

  test("rejects a digit-dominated math worksheet", () => {
    const stats = portfolioProseStats(MATH_WORKSHEET);
    expect(stats.isProse).toBe(false);
    expect(stats.alphaShare).toBeLessThan(0.6);
  });

  test("rejects a short scrap below the word floor", () => {
    const stats = portfolioProseStats("My dog is fast.");
    expect(stats.isProse).toBe(false);
  });
});

describe("buildPortfolioWritingSamples", () => {
  const now = Date.UTC(2026, 5, 28);

  function candidate(overrides: Partial<PortfolioProseCandidate>): PortfolioProseCandidate {
    return {
      id: "item",
      text: STORY,
      caption: null,
      createdAt: now - DAY_MS,
      ...overrides,
    };
  }

  test("includes in-window prose, excludes worksheets and short scraps", () => {
    const samples = buildPortfolioWritingSamples(
      [
        candidate({ id: "story", text: STORY, createdAt: now - 2 * DAY_MS }),
        candidate({ id: "math", text: MATH_WORKSHEET, createdAt: now - 3 * DAY_MS }),
        candidate({ id: "scrap", text: "Too short.", createdAt: now - 4 * DAY_MS }),
      ],
      { now, windowDays: 90 },
    );
    expect(samples.map((s) => s.id)).toEqual(["story"]);
    expect(samples[0].gradeLevel).toBeGreaterThan(0);
    expect(samples[0].snippet.length).toBeGreaterThan(0);
  });

  test("excludes samples outside the window", () => {
    const samples = buildPortfolioWritingSamples(
      [candidate({ id: "old", createdAt: now - 200 * DAY_MS })],
      { now, windowDays: 90 },
    );
    expect(samples).toHaveLength(0);
  });

  test("sorts newest-first and respects the limit", () => {
    const samples = buildPortfolioWritingSamples(
      [
        candidate({ id: "a", createdAt: now - 10 * DAY_MS }),
        candidate({ id: "b", createdAt: now - 2 * DAY_MS }),
        candidate({ id: "c", createdAt: now - 5 * DAY_MS }),
      ],
      { now, windowDays: 90, limit: 2 },
    );
    expect(samples.map((s) => s.id)).toEqual(["b", "c"]);
  });
});
