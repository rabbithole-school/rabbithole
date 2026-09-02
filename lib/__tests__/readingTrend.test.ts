import { describe, expect, test } from "vitest";
import { readabilityStats } from "../readability";
import { buildScholarReadingTrend } from "../readingTrend";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("buildScholarReadingTrend", () => {
  test("builds fixed weekly buckets from scholar-authored messages", () => {
    const now = Date.UTC(2026, 5, 28);
    const simple = "The cat sat on the mat.";
    const harder = "The Australian platypus is seemingly a hybrid of a mammal and reptilian creature.";
    const newest = "I compared aquaponics filtration with sustainable engineering systems.";

    const result = buildScholarReadingTrend(
      [
        { content: "<start>", createdAt: now - 27 * DAY_MS },
        { content: "Yes", createdAt: now - 20 * DAY_MS },
        { content: simple, createdAt: now - 18 * DAY_MS },
        { content: harder, createdAt: now - 10 * DAY_MS },
        { content: newest, createdAt: now - 3 * DAY_MS },
      ],
      { now, windowDays: 28, bucketDays: 7, minWordsPerMessage: 3 },
    );

    expect(result.buckets).toHaveLength(4);
    expect(result.availableMessageCount).toBe(4);
    expect(result.sampledMessageCount).toBe(3);
    expect(result.latestAt).toBe(now - 3 * DAY_MS);
    expect(result.buckets.map((bucket) => bucket.messageCount)).toEqual([0, 1, 1, 1]);
    expect(result.buckets[0].meanGradeLevel).toBeNull();
    expect(result.buckets[1].meanGradeLevel).toBe(0);
    expect(result.buckets[2].meanGradeLevel).toBeCloseTo(readabilityStats(harder).fleschKincaidGrade, 1);
    expect(result.wordCount).toBe(
      readabilityStats(simple).wordCount +
      readabilityStats(harder).wordCount +
      readabilityStats(newest).wordCount,
    );
  });

  test("ignores messages outside the window", () => {
    const now = Date.UTC(2026, 5, 28);

    const result = buildScholarReadingTrend(
      [
        { content: "This older explanation should not count.", createdAt: now - 40 * DAY_MS },
        { content: "This recent explanation should count.", createdAt: now - 2 * DAY_MS },
      ],
      { now, windowDays: 14, bucketDays: 7 },
    );

    expect(result.availableMessageCount).toBe(1);
    expect(result.sampledMessageCount).toBe(1);
    expect(result.buckets.map((bucket) => bucket.messageCount)).toEqual([0, 1]);
  });
});
