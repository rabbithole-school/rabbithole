import { describe, expect, test } from "vitest";
import {
  deriveGrowthStories,
  MAX_STORIES,
  MIN_LEVEL_RISE,
  MIN_SPAN_MS,
  type GrowthSourceObservation,
} from "../lib/growthStories";

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

function obs(overrides: Partial<GrowthSourceObservation>): GrowthSourceObservation {
  return {
    conceptLabel: "Fractions",
    domain: "Mathematics",
    masteryLevel: 1.0,
    observedAt: T0,
    evidenceType: "direct_demonstration",
    transcriptExcerpt: "I split the pizza into eighths",
    studentInitiated: false,
    ...overrides,
  };
}

describe("deriveGrowthStories", () => {
  test("a concept with a real rise over real time becomes a story", () => {
    const stories = deriveGrowthStories([
      obs({ masteryLevel: 1.0, observedAt: T0 }),
      obs({ masteryLevel: 2.5, observedAt: T0 + 10 * DAY, transcriptExcerpt: "now I can compare them" }),
    ]);
    expect(stories).toHaveLength(1);
    expect(stories[0]).toMatchObject({
      conceptLabel: "Fractions",
      domain: "Mathematics",
      startedAt: T0,
      latestAt: T0 + 10 * DAY,
      excerpt: "now I can compare them",
    });
  });

  test("a single observation is never a story", () => {
    expect(deriveGrowthStories([obs({ masteryLevel: 4.0 })])).toHaveLength(0);
  });

  test("a rise within one week is too noisy to claim", () => {
    const stories = deriveGrowthStories([
      obs({ masteryLevel: 1.0, observedAt: T0 }),
      obs({ masteryLevel: 3.0, observedAt: T0 + MIN_SPAN_MS - 1 }),
    ]);
    expect(stories).toHaveLength(0);
  });

  test("a flat or small rise is not growth", () => {
    const stories = deriveGrowthStories([
      obs({ masteryLevel: 2.0, observedAt: T0 }),
      obs({ masteryLevel: 2.0 + MIN_LEVEL_RISE - 0.1, observedAt: T0 + 30 * DAY }),
    ]);
    expect(stories).toHaveLength(0);
  });

  test("misconception signals are excluded from the math", () => {
    // The misconception row would otherwise be the low starting point that
    // fabricates a rise.
    const stories = deriveGrowthStories([
      obs({ masteryLevel: 0.5, observedAt: T0, evidenceType: "misconception_signal" }),
      obs({ masteryLevel: 2.0, observedAt: T0 + 10 * DAY }),
    ]);
    expect(stories).toHaveLength(0);
  });

  test("ordering by observedAt, not input order", () => {
    // Latest-first input must not read as a decline.
    const stories = deriveGrowthStories([
      obs({ masteryLevel: 3.0, observedAt: T0 + 20 * DAY }),
      obs({ masteryLevel: 1.0, observedAt: T0 }),
    ]);
    expect(stories).toHaveLength(1);
    expect(stories[0].startedAt).toBe(T0);
  });

  test("excerpt falls back to the latest non-empty one", () => {
    const stories = deriveGrowthStories([
      obs({ masteryLevel: 1.0, observedAt: T0, transcriptExcerpt: "early moment" }),
      obs({ masteryLevel: 3.0, observedAt: T0 + 10 * DAY, transcriptExcerpt: "   " }),
    ]);
    expect(stories[0].excerpt).toBe("early moment");
  });

  test("studentInitiated is true if any observation was", () => {
    const stories = deriveGrowthStories([
      obs({ masteryLevel: 1.0, observedAt: T0, studentInitiated: true }),
      obs({ masteryLevel: 3.0, observedAt: T0 + 10 * DAY }),
    ]);
    expect(stories[0].studentInitiated).toBe(true);
  });

  test("stories sort newest-first and cap at MAX_STORIES", () => {
    const observations: GrowthSourceObservation[] = [];
    for (let c = 0; c < MAX_STORIES + 3; c++) {
      observations.push(
        obs({ conceptLabel: `Concept ${c}`, masteryLevel: 1.0, observedAt: T0 + c * DAY }),
        obs({ conceptLabel: `Concept ${c}`, masteryLevel: 3.0, observedAt: T0 + c * DAY + 10 * DAY }),
      );
    }
    const stories = deriveGrowthStories(observations);
    expect(stories).toHaveLength(MAX_STORIES);
    expect(stories[0].conceptLabel).toBe(`Concept ${MAX_STORIES + 2}`);
    expect(stories[0].latestAt).toBeGreaterThan(stories[stories.length - 1].latestAt);
  });
});
