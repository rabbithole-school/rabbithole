import { describe, expect, test } from "vitest";
import { SPIRAL_GAP_MS } from "../practice/spiralBreaker";
import {
  weeklyMathTopics,
  type WeeklyMathTopicAttempt,
  type WeeklyMathTopicErrorEvent,
} from "../practice/weeklyMathTopics";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 21, 22);
const SINCE = NOW - 7 * DAY_MS;

function attempt(
  nodeKey: string,
  itemId: string,
  createdAt: number,
  over: Partial<WeeklyMathTopicAttempt> = {},
): WeeklyMathTopicAttempt {
  return {
    domain: "whole-number-arithmetic",
    nodeKey,
    itemId,
    correct: false,
    lane: "review",
    createdAt,
    ...over,
  };
}

function event(
  nodeKey: string,
  itemId: string,
  createdAt: number,
  pattern = "REVERSED_OPERANDS",
): WeeklyMathTopicErrorEvent {
  return {
    nodeKey,
    domain: "whole-number-arithmetic",
    pattern,
    itemId,
    createdAt,
  };
}

describe("weeklyMathTopics", () => {
  test("selects repeated misses without classified error events", () => {
    const rows = [
      attempt("grouping", "a", NOW - 5 * 60_000),
      attempt("grouping", "b", NOW),
    ];

    expect(weeklyMathTopics([], rows, SINCE, NOW)).toMatchObject([
      {
        nodeKey: "grouping",
        tier: "practice",
        attemptCount: 2,
        missCount: 2,
        missSittingCount: 1,
        breakerCount: 0,
      },
    ]);
  });

  test("marks difficulty that returns across sittings as sustained", () => {
    const firstDay = NOW - 2 * DAY_MS;
    const attempts = [
      attempt("grouping", "a", firstDay),
      attempt("grouping", "b", firstDay + 5 * 60_000),
      attempt("grouping", "c", NOW),
    ];

    expect(
      weeklyMathTopics([], attempts, SINCE, NOW),
    ).toMatchObject([
      {
        nodeKey: "grouping",
        tier: "sustained",
        missCount: 3,
        missSittingCount: 2,
        dayCount: 2,
      },
    ]);

    const sameSittingAttempts = attempts.map((row, index) => ({
      ...row,
      createdAt: firstDay + index * 5 * 60_000,
    }));
    expect(
      weeklyMathTopics([], sameSittingAttempts, SINCE, NOW)[0]?.tier,
    ).toBe("practice");
  });

  test("treats exactly thirty minutes as one sitting and a larger gap as another", () => {
    const first = NOW - 2 * DAY_MS;
    const sameDayAttempts = [
      attempt("grouping", "a", first),
      attempt("grouping", "b", first + SPIRAL_GAP_MS),
      attempt("grouping", "c", first + SPIRAL_GAP_MS + 1),
    ];

    expect(
      weeklyMathTopics([], sameDayAttempts, SINCE, NOW)[0],
    ).toMatchObject({ tier: "practice", missSittingCount: 1 });

    const nextDayAttempt = attempt("grouping", "c", first + DAY_MS);
    expect(
      weeklyMathTopics(
        [],
        [sameDayAttempts[0], sameDayAttempts[1], nextDayAttempt],
        SINCE,
        NOW,
      )[0],
    ).toMatchObject({
      tier: "sustained",
      missSittingCount: 2,
      dayCount: 2,
    });
  });

  test("keeps later correctness as nuance instead of erasing sustained difficulty", () => {
    const first = NOW - 2 * DAY_MS;
    const attempts = [
      attempt("grouping", "a", first),
      attempt("grouping", "b", first + 5 * 60_000),
      attempt("grouping", "c", NOW - 60_000),
      attempt("grouping", "resolved", NOW, { correct: true }),
    ];
    expect(
      weeklyMathTopics([], attempts, SINCE, NOW)[0],
    ).toMatchObject({
      tier: "sustained",
      missCount: 3,
      correctCount: 1,
      latestAttemptCorrect: true,
      trailingCorrectCount: 1,
    });
  });

  test("uses the acute breaker cue without requiring classifier output", () => {
    const first = NOW - 10 * 60_000;
    const rows = [
      attempt("grouping", "a", first),
      attempt("grouping", "b", first + 5 * 60_000),
      attempt("grouping", "c", NOW, {
        breaker: {
          streak: 3,
          offer: "accepted",
          recovery: "none",
        },
      }),
    ];
    expect(weeklyMathTopics([], rows, SINCE, NOW)[0]).toMatchObject({
      tier: "acute",
      missCount: 3,
      breakerCount: 1,
    });
  });

  test("does not reconstruct breaker evidence through excluded attempts", () => {
    const first = NOW - 10 * 60_000;
    const excludedMiss = [
      attempt("grouping", "a", first),
      attempt("grouping", "excluded", first + 60_000, {
        breakerEligible: false,
      }),
      attempt("grouping", "c", first + 2 * 60_000, {
        breakerLifecycle: {
          version: 2,
          triggerNodeKey: "grouping",
          triggeredAt: first + 2 * 60_000,
        },
      }),
    ];
    expect(weeklyMathTopics([], excludedMiss, SINCE, NOW)[0]).toMatchObject({
      breakerCount: 0,
    });

    const excludedCorrect = [
      attempt("grouping", "a", first),
      attempt("grouping", "b", first + 60_000),
      attempt("grouping", "reset", first + 90_000, {
        correct: true,
        breakerEligible: false,
      }),
      attempt("grouping", "c", first + 2 * 60_000, {
        breakerLifecycle: {
          version: 2,
          triggerNodeKey: "grouping",
          triggeredAt: first + 2 * 60_000,
        },
      }),
    ];
    expect(weeklyMathTopics([], excludedCorrect, SINCE, NOW)[0]).toMatchObject({
      breakerCount: 0,
    });
  });

  test("softens a completed v2 repair with a verified fresh correct item", () => {
    const first = NOW - 10 * 60_000;
    const triggerAt = first + 2 * 60_000;
    const freshAt = first + 5 * 60_000;
    const rows = [
      attempt("grouping", "a", first),
      attempt("grouping", "b", first + 60_000),
      attempt("grouping", "c", triggerAt, {
        breakerLifecycle: {
          version: 2,
          triggerNodeKey: "grouping",
          triggeredAt: triggerAt,
          repairStartedAt: triggerAt + 1,
          repairCompletedAt: triggerAt + 2,
          freshItemId: "fresh",
          freshResult: {
            attemptId: "attempt-fresh",
            itemId: "fresh",
            correct: true,
            completedAt: freshAt + 1,
          },
        },
      }),
      attempt("grouping", "fresh", freshAt, {
        correct: true,
        lane: "new",
      }),
    ];

    expect(weeklyMathTopics([], rows, SINCE, NOW)[0]).toMatchObject({
      tier: "practice",
      missCount: 3,
      breakerCount: 1,
      latestAttemptCorrect: true,
      supportOutcome: "fresh_correct",
    });
  });

  test("keeps a v2 repair open when the fresh same-skill item misses", () => {
    const first = NOW - 10 * 60_000;
    const triggerAt = first + 2 * 60_000;
    const freshAt = first + 5 * 60_000;
    const rows = [
      attempt("grouping", "a", first),
      attempt("grouping", "b", first + 60_000),
      attempt("grouping", "c", triggerAt, {
        breakerLifecycle: {
          version: 2,
          triggerNodeKey: "grouping",
          triggeredAt: triggerAt,
          repairStartedAt: triggerAt + 1,
          coachEscalatedAt: triggerAt + 2,
          freshItemId: "fresh",
          freshResult: {
            attemptId: "attempt-fresh",
            itemId: "fresh",
            correct: false,
            completedAt: freshAt + 1,
          },
        },
      }),
      attempt("grouping", "fresh", freshAt, {
        lane: "new",
      }),
    ];

    expect(weeklyMathTopics([], rows, SINCE, NOW)[0]).toMatchObject({
      tier: "acute",
      missCount: 4,
      breakerCount: 1,
      latestAttemptCorrect: false,
      supportOutcome: "fresh_missed",
    });
  });

  test("does not attribute a mixed-topic practice brake to its triggering item", () => {
    const first = NOW - 10 * 60_000;
    const rows = [
      attempt("other", "a", first),
      attempt("grouping", "b", first + 5 * 60_000),
      attempt("grouping", "c", NOW, {
        breaker: {
          streak: 3,
          offer: "accepted",
          recovery: "none",
        },
      }),
    ];

    expect(
      weeklyMathTopics([], rows, SINCE, NOW).find(
        ({ nodeKey }) => nodeKey === "grouping",
      ),
    ).toMatchObject({
      tier: "practice",
      missCount: 2,
      breakerCount: 0,
    });
  });

  test("uses classified patterns only as optional explanation", () => {
    const first = NOW - 2 * DAY_MS;
    const attempts = [
      attempt("grouping", "a", first),
      attempt("grouping", "b", NOW),
    ];
    expect(
      weeklyMathTopics(
        [
          event("grouping", "a", first, "REVERSED_OPERANDS"),
          event("grouping", "unmatched", NOW, "DROPPED_CARRY"),
        ],
        attempts,
        SINCE,
        NOW,
      )[0],
    ).toMatchObject({
      tier: "practice",
      pattern: "REVERSED_OPERANDS",
      patternDescription: expect.any(String),
    });
  });

  test("ignores retries, future attempts, and one-off misses", () => {
    expect(
      weeklyMathTopics(
        [],
        [
          attempt("one-off", "a", NOW),
          attempt("retry-only", "b", NOW, { retry: true }),
          attempt("retry-only", "c", NOW, { retry: true }),
          attempt("future", "d", NOW + 1),
          attempt("future", "e", NOW + 2),
        ],
        SINCE,
        NOW,
      ),
    ).toEqual([]);
  });

  test("ranks sustained, acute, then ordinary topics deterministically", () => {
    const rows = [
      attempt("ordinary", "o1", NOW - 20 * 60_000),
      attempt("ordinary", "o2", NOW - 19 * 60_000),
      attempt("acute", "a1", NOW - 10 * 60_000),
      attempt("acute", "a2", NOW - 9 * 60_000),
      attempt("acute", "a3", NOW - 8 * 60_000, {
        breaker: { streak: 3, offer: "declined", recovery: "won" },
      }),
      attempt("sustained", "s1", NOW - DAY_MS),
      attempt("sustained", "s2", NOW - DAY_MS + 1_000),
      attempt("sustained", "s3", NOW),
    ];

    expect(
      weeklyMathTopics([], rows, SINCE, NOW).map(({ nodeKey, tier }) => ({
        nodeKey,
        tier,
      })),
    ).toEqual([
      { nodeKey: "sustained", tier: "sustained" },
      { nodeKey: "acute", tier: "acute" },
      { nodeKey: "ordinary", tier: "practice" },
    ]);
  });

  test("carries recent missed examples without requiring an answer", () => {
    const rows = [
      attempt("grouping", "a", NOW - 1_000, {
        stemSnapshot: "8 + 2 × 3",
        answerText: "30",
        expectedAnswer: "14",
        explanationReason: "miss",
      }),
      attempt("grouping", "b", NOW, {
        stemSnapshot: "4 × (3 + 2)",
        expectedAnswer: "20",
        explanationReason: "dont_know",
      }),
    ];

    expect(weeklyMathTopics([], rows, SINCE, NOW)[0]?.missExamples).toEqual([
      {
        stem: "8 + 2 × 3",
        learnerAnswer: "30",
        expectedAnswer: "14",
        isDontKnow: false,
      },
      {
        stem: "4 × (3 + 2)",
        expectedAnswer: "20",
        isDontKnow: true,
      },
    ]);
  });
});
