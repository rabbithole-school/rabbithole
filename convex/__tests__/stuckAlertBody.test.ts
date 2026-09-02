import { describe, expect, test } from "vitest";
import {
  breakerResponseLine,
  buildBreakerOutcomeReply,
  buildNotYetTaughtAlertBody,
  buildStuckAlertBody,
  formatAttemptElapsed,
  isAllDontKnowStreak,
  shouldAlertOnStuckEpisode,
  tallyPracticeSitting,
  type StuckAlertBodyInput,
  type StuckAlertMiss,
} from "../lib/practice/stuckAlertBody";
import { normalizePracticeStuckDiagnosis } from "../lib/practice/stuckAlertPrompt";
import { SPIRAL_GAP_MS } from "../lib/practice/spiralBreaker";

const NOW = Date.UTC(2026, 7, 19, 19, 0, 0);

const fullMisses: StuckAlertMiss[] = [
  {
    nodeKey: "evaluate_expression",
    skillLabel: "Evaluate a two-operation numerical expression using precedence",
    stemSnapshot: "3 + 4 × 2",
    answerText: "14",
    expectedAnswer: "11",
    errorPattern: "Order of the operation isn't yet anchored.",
    elapsedMs: 8_000,
    isDontKnow: false,
  },
  {
    nodeKey: "divisibility_rules",
    skillLabel: "Divisibility rules for 2, 5, and 10",
    stemSnapshot: "Is 470 divisible by 4?",
    answerText: "yes",
    expectedAnswer: "no",
    elapsedMs: 125_000,
    isDontKnow: false,
  },
  {
    nodeKey: "multiply_2_by_1",
    skillLabel: "Multiply a 2-digit number by a 1-digit number",
    stemSnapshot: "47 × 6",
    expectedAnswer: "282",
    isDontKnow: true,
  },
];

describe("normalizePracticeStuckDiagnosis", () => {
  test.each(["NONE", "none", "none.", "  (None!)  "])(
    "drops the no-through-line sentinel %j",
    (value) => {
      expect(normalizePracticeStuckDiagnosis(value)).toBeUndefined();
    },
  );

  test("keeps a genuine diagnosis after collapsing newlines", () => {
    expect(
      normalizePracticeStuckDiagnosis(
        "The operation order is not yet stable.\nThe same reversal appears twice.",
      ),
    ).toBe(
      "The operation order is not yet stable. The same reversal appears twice.",
    );
  });
});

describe("formatAttemptElapsed", () => {
  test("formats under a minute in seconds", () => {
    expect(formatAttemptElapsed(8_400)).toBe("8s");
  });

  test("formats a longer gap in whole minutes", () => {
    expect(formatAttemptElapsed(125_000)).toBe("2 min");
  });

  test("omits an absent or invalid gap", () => {
    expect(formatAttemptElapsed()).toBeUndefined();
    expect(formatAttemptElapsed(Number.NaN)).toBeUndefined();
  });
});

describe("breakerResponseLine", () => {
  test("describes an accepted conversation in progress", () => {
    expect(breakerResponseLine({ offer: "accepted" })).toBe(
      "They chose to talk it through with the tutor; the conversation is under way.",
    );
  });

  test("describes a declined conversation without judging the choice", () => {
    expect(breakerResponseLine({ offer: "declined" })).toBe(
      "They chose to finish on an easier one; the session is winding down.",
    );
  });

  test("adds the completed recovery result", () => {
    expect(
      breakerResponseLine({ offer: "accepted", recovery: "won" }),
    ).toBe(
      "They chose to talk it through with the tutor; the conversation is under way. They got the final easier item right.",
    );
  });

  test("states when no response was recorded", () => {
    expect(breakerResponseLine()).toBe(
      "No response was recorded yet; they may have left the session.",
    );
  });

  test("describes the versioned repair lifecycle without changing legacy wording", () => {
    expect(
      breakerResponseLine({
        offer: "accepted",
        lifecycle: {
          version: 2,
          triggeredAt: NOW,
          repairStartedAt: NOW,
          repairCompletedAt: NOW + 1,
          coachEscalatedAt: NOW + 2,
          freshResult: { correct: true },
        },
      }),
    ).toBe(
      "Step-card repair completed. Coach escalation started. Fresh same-node item: correct.",
    );
    expect(breakerResponseLine({ offer: "declined" })).toBe(
      "They chose to finish on an easier one; the session is winding down.",
    );
  });
});

describe("breaker state in alert bodies", () => {
  test("keeps the immediate parent independent of a later outcome", () => {
    const body = buildStuckAlertBody(
      input({ breaker: { offer: "declined", recovery: "won" } }),
    );
    expect(body).not.toContain("They chose");
    expect(body).not.toContain("What happened next");
  });

  test("describes the pushed repair instead of the retired binary offer", () => {
    const body = buildStuckAlertBody(
      input({
        breaker: {
          lifecycle: {
            version: 2,
            triggeredAt: NOW,
          },
        },
      }),
    );
    expect(body).toContain(
      "Rabbithole paused the run with one step-card repair ready, plus the tutor or an easier finish.",
    );
    expect(body).not.toContain("offered to talk one through");
  });
});

describe("buildBreakerOutcomeReply", () => {
  test("reports a successful fresh item after repair and carries the AI read", () => {
    expect(
      buildBreakerOutcomeReply(
        {
          lifecycle: {
            version: 2,
            triggeredAt: NOW,
            repairShownAt: NOW + 1,
            repairStartedAt: NOW + 2,
            repairCompletedAt: NOW + 3,
            freshResult: { correct: true },
          },
        },
        "The regrouping move was not yet stable.",
      ),
    ).toBe(
      [
        "*What happened next:* They completed the step-card repair, then got the fresh same-skill item right.",
        "_AI read:_ The regrouping move was not yet stable.",
      ].join("\n"),
    );
  });

  test("distinguishes an assisted fresh success from an independent one", () => {
    expect(
      buildBreakerOutcomeReply({
        lifecycle: {
          version: 2,
          triggeredAt: NOW,
          repairCompletedAt: NOW + 1,
          freshResult: { correct: true, assisted: true },
        },
      }),
    ).toContain("got the fresh same-skill item right with more help");
  });

  test("reports the scholar's final choice after a fresh miss", () => {
    expect(
      buildBreakerOutcomeReply({
        recovery: "won",
        lifecycle: {
          version: 2,
          triggeredAt: NOW,
          repairCompletedAt: NOW + 1,
          freshResult: { correct: false },
          easyExitedAt: NOW + 2,
        },
      }),
    ).toContain(
      "missed the fresh same-skill item, then got the easier finish right",
    );
    expect(
      buildBreakerOutcomeReply({
        lifecycle: {
          version: 2,
          triggeredAt: NOW,
          repairCompletedAt: NOW + 1,
          freshResult: { correct: false },
          stoppedAt: NOW + 2,
        },
      }),
    ).toContain("missed the fresh same-skill item, then stopped for now");
  });

  test.each([
    {
      name: "easier finish",
      breaker: {
        recovery: "missed" as const,
        lifecycle: {
          version: 2 as const,
          triggeredAt: NOW,
          easyExitedAt: NOW + 1,
        },
      },
      line: "They chose the easier finish and missed that item.",
    },
    {
      name: "tutor path",
      breaker: {
        lifecycle: {
          version: 2 as const,
          triggeredAt: NOW,
          coachEscalatedAt: NOW + 1,
        },
      },
      line: "They opened the tutor to work through the stuck item",
    },
    {
      name: "unavailable repair",
      breaker: {
        lifecycle: {
          version: 2 as const,
          triggeredAt: NOW,
          repairUnavailableAt: NOW + 1,
        },
      },
      line: "No step-card repair was available",
    },
    {
      name: "abandoned repair",
      breaker: {
        lifecycle: {
          version: 2 as const,
          triggeredAt: NOW,
          repairShownAt: NOW + 1,
        },
      },
      line: "The repair card was shown",
    },
  ])("reports the $name outcome", ({ breaker, line }) => {
    expect(buildBreakerOutcomeReply(breaker)).toContain(line);
  });
});

describe("shouldAlertOnStuckEpisode", () => {
  test("accepts one diagnosable wrong answer among non-diagnosable misses", () => {
    expect(
      shouldAlertOnStuckEpisode([
        {
          explanationReason: "dont_know",
          expectedAnswer: "7",
        },
        {
          answerText: '{"perGroup":1}',
        },
        {
          answerText: "14",
          expectedAnswer: "11",
        },
      ]),
    ).toBe(true);
  });

  describe("isAllDontKnowStreak", () => {
    test("accepts exactly three don't-knows", () => {
      expect(
        isAllDontKnowStreak([
          { explanationReason: "dont_know" },
          { explanationReason: "dont_know" },
          { explanationReason: "dont_know" },
        ]),
      ).toBe(true);
    });

    test("rejects a mixed or wrong-sized streak", () => {
      expect(
        isAllDontKnowStreak([
          { explanationReason: "dont_know" },
          { explanationReason: "miss" },
          { explanationReason: "dont_know" },
        ]),
      ).toBe(false);
      expect(
        isAllDontKnowStreak([
          { explanationReason: "dont_know" },
          { explanationReason: "dont_know" },
        ]),
      ).toBe(false);
    });
  });

  test("rejects all-dont-know and all-manipulative episodes", () => {
    expect(
      shouldAlertOnStuckEpisode([
        {
          explanationReason: "dont_know",
          answerText: "14",
          expectedAnswer: "11",
        },
        {
          explanationReason: "dont_know",
          expectedAnswer: "7",
        },
      ]),
    ).toBe(false);
    expect(
      shouldAlertOnStuckEpisode([
        { answerText: '{"width":2}' },
        { answerText: '{"width":3}' },
      ]),
    ).toBe(false);
  });

  test("requires non-empty submitted and expected answers", () => {
    expect(
      shouldAlertOnStuckEpisode([
        { answerText: "   ", expectedAnswer: "7" },
        { answerText: "9", expectedAnswer: "\n" },
      ]),
    ).toBe(false);
  });
});

function input(overrides: Partial<StuckAlertBodyInput> = {}): StuckAlertBodyInput {
  return {
    missStreak: 3,
    misses: fullMisses,
    sitting: {
      correct: 4,
      total: 11,
      startedAt: NOW - 23 * 60_000,
      bounded: false,
    },
    diagnosis:
      "Both misses treat a rule as a yes/no lookup rather than testing it — the check itself isn't yet a procedure they run.",
    fallbackSkillLabel: fullMisses.at(-1)!.skillLabel,
    now: NOW,
    ...overrides,
  };
}

describe("buildStuckAlertBody", () => {
  test("renders an immediate factual parent without a premature outcome or AI read", () => {
    expect(buildStuckAlertBody(input())).toBe(
      [
        "Missed 3 practice items in a row. Rabbithole paused the run and offered to talk one through with the tutor, or to finish on an easier one.",
        "This sitting: 4 of 11 correct, over 23 min.",
        "",
        "• *Evaluate a two-operation numerical expression using precedence* (8s on this one)",
        "   `3 + 4 × 2` → answered `14`  (expected `11`)",
        "   ↳ Order of the operation isn't yet anchored.",
        "• *Divisibility rules for 2, 5, and 10* (2 min on this one)",
        "   `Is 470 divisible by 4?` → answered `yes`  (expected `no`)",
        "• *Multiply a 2-digit number by a 1-digit number*",
        '   `47 × 6` → tapped "I don\'t know"',
        "",
        "Might be a good moment to check in.",
      ].join("\n"),
    );
  });

  test("keeps the complete factual body when diagnosis is absent", () => {
    const body = buildStuckAlertBody(input({ diagnosis: undefined }));
    expect(body).not.toContain("_AI read:_");
    expect(body).toContain("This sitting: 4 of 11 correct, over 23 min.");
    expect(body.match(/^• /gm)).toHaveLength(3);
  });

  test("omits the pattern line when no deterministic pattern matched", () => {
    const body = buildStuckAlertBody(
      input({ misses: [fullMisses[1]], diagnosis: undefined }),
    );
    expect(body).not.toContain("↳");
  });

  test("renders a don't-know as honest confusion rather than a wrong answer", () => {
    const body = buildStuckAlertBody(
      input({ misses: [fullMisses[2]], diagnosis: undefined }),
    );
    expect(body).toContain('`47 × 6` → tapped "I don\'t know"');
    expect(body).not.toContain("answered");
    expect(body).not.toContain("expected");
  });

  test("renders a stem-only miss without empty code spans", () => {
    const body = buildStuckAlertBody(
      input({
        misses: [
          {
            nodeKey: "legacy",
            skillLabel: "Legacy skill",
            stemSnapshot: "A legacy prompt",
            isDontKnow: false,
          },
        ],
        diagnosis: undefined,
      }),
    );
    expect(body).toContain("   `A legacy prompt`");
    expect(body).not.toContain("answered");
    expect(body).not.toContain("expected");
    expect(body).not.toContain("``");
  });

  test("neutralizes backticks and Slack control characters in code spans", () => {
    const body = buildStuckAlertBody(
      input({
        misses: [
          {
            nodeKey: "unsafe",
            skillLabel: "Safe rendering",
            stemSnapshot: "Use `<x&y>` then > 2",
            answerText: "`<wrong&answer>`",
            expectedAnswer: "<right>",
            isDontKnow: false,
          },
        ],
        diagnosis: undefined,
      }),
    );
    expect(body).toContain("`Use &lt;x&amp;y&gt; then &gt; 2`");
    expect(body).toContain("answered `&lt;wrong&amp;answer&gt;`");
    expect(body).toContain("(expected `&lt;right&gt;`)");
    expect(body).not.toContain("`<");
  });

  test("neutralizes Slack emphasis markers in labels and keeps diagnosis out of the parent", () => {
    const body = buildStuckAlertBody(
      input({
        misses: [
          {
            nodeKey: "markup",
            skillLabel: "Use *groups* and _remainders_",
            stemSnapshot: "12 ÷ 5",
            answerText: "2",
            expectedAnswer: "2 R2",
            isDontKnow: false,
          },
        ],
        diagnosis: "The *grouping* procedure is _not yet_ stable.",
      }),
    );
    expect(body).toContain(
      "• *Use \\*groups\\* and \\_remainders\\_*",
    );
    expect(body).not.toContain("_AI read:_");
  });

  test("does not render an empty code span for a backtick-only answer", () => {
    const body = buildStuckAlertBody(
      input({
        misses: [
          {
            nodeKey: "ticks",
            skillLabel: "Backtick answer",
            stemSnapshot: "What is 2 + 2?",
            answerText: "```",
            isDontKnow: false,
          },
        ],
        diagnosis: undefined,
      }),
    );
    expect(body).toContain("   `What is 2 + 2?`");
    expect(body).not.toContain("answered");
    expect(body).not.toContain("``");
  });

  test("truncates long stems and answers with an ellipsis", () => {
    const body = buildStuckAlertBody(
      input({
        misses: [
          {
            nodeKey: "long",
            skillLabel: "Long inputs",
            stemSnapshot: "S".repeat(100),
            answerText: "A".repeat(50),
            expectedAnswer: "E".repeat(50),
            isDontKnow: false,
          },
        ],
        diagnosis: undefined,
      }),
    );
    expect(body).toContain(`\`${"S".repeat(89)}…\``);
    expect(body).toContain(`answered \`${"A".repeat(39)}…\``);
    expect(body).toContain(`(expected \`${"E".repeat(39)}…\`)`);
  });

  test("falls back to the exact legacy body when no miss is renderable", () => {
    expect(
      buildStuckAlertBody(
        input({
          misses: [],
          diagnosis: undefined,
          sitting: undefined,
          fallbackSkillLabel: "Divisibility rules for 2, 5, and 10",
        }),
      ),
    ).toBe(
      [
        "Missed 3 practice items in a row. Rabbithole paused the run and offered to talk one through with the tutor, or to finish on an easier one.",
        "Most recently on *Divisibility rules for 2, 5, and 10*.",
        "Might be a good moment to check in.",
      ].join("\n"),
    );
  });
});

describe("tallyPracticeSitting", () => {
  test("ends the sitting at a gap over 30 minutes", () => {
    expect(
      tallyPracticeSitting([
        { correct: false, lane: "frontier", createdAt: NOW },
        {
          correct: true,
          lane: "review",
          createdAt: NOW - 5 * 60_000,
        },
        {
          correct: true,
          lane: "review",
          createdAt: NOW - 5 * 60_000 - SPIRAL_GAP_MS - 1,
        },
      ]),
    ).toEqual({
      correct: 1,
      total: 2,
      startedAt: NOW - 5 * 60_000,
      bounded: false,
    });
  });

  test("excludes retry rows from the sitting", () => {
    expect(
      tallyPracticeSitting([
        { correct: true, retry: true, lane: "review", createdAt: NOW },
        {
          correct: false,
          lane: "confirmation",
          createdAt: NOW - 1_000,
        },
      ]),
    ).toEqual({
      correct: 0,
      total: 1,
      startedAt: NOW - 1_000,
      bounded: false,
    });
  });

  test("excludes breaker-ineligible rows from the sitting score", () => {
    expect(
      tallyPracticeSitting([
        { correct: false, lane: "frontier", createdAt: NOW },
        {
          correct: true,
          breakerEligible: false,
          lane: "review",
          createdAt: NOW - 1_000,
        },
        {
          correct: false,
          breakerEligible: false,
          lane: "confirmation",
          createdAt: NOW - 2_000,
        },
        { correct: true, lane: "review", createdAt: NOW - 3_000 },
      ]),
    ).toEqual({
      correct: 1,
      total: 2,
      startedAt: NOW - 3_000,
      bounded: false,
    });
  });

  test("excludes placement from the score without breaking the sitting window", () => {
    expect(
      tallyPracticeSitting([
        { correct: false, lane: "frontier", createdAt: NOW },
        { correct: true, lane: "placement", createdAt: NOW - 10_000 },
        { correct: true, lane: "review", createdAt: NOW - 20_000 },
      ]),
    ).toEqual({
      correct: 1,
      total: 2,
      startedAt: NOW - 20_000,
      bounded: false,
    });
  });

  test("measures duration from the first counted attempt after placement", () => {
    expect(
      tallyPracticeSitting([
        { correct: false, lane: "frontier", createdAt: NOW },
        { correct: true, lane: "review", createdAt: NOW - 2 * 60_000 },
        { correct: false, lane: "confirmation", createdAt: NOW - 3 * 60_000 },
        { correct: true, lane: "placement", createdAt: NOW - 12 * 60_000 },
        { correct: false, lane: "placement", createdAt: NOW - 20 * 60_000 },
      ]),
    ).toEqual({
      correct: 1,
      total: 3,
      startedAt: NOW - 3 * 60_000,
      bounded: false,
    });
  });

  test("marks a scan-bound tally and renders the denominator honestly", () => {
    const sitting = tallyPracticeSitting(
      [
        { correct: false, lane: "frontier", createdAt: NOW },
        { correct: true, lane: "placement", createdAt: NOW - 1_000 },
        { correct: true, lane: "review", createdAt: NOW - 2_000 },
      ],
      { limit: 2 },
    );
    expect(sitting?.bounded).toBe(true);
    expect(
      buildStuckAlertBody(
        input({
          misses: [fullMisses[0]],
          sitting,
          diagnosis: undefined,
        }),
      ),
    ).toContain("This sitting: 0 of 1+ correct");
  });
});

describe("buildNotYetTaughtAlertBody", () => {
  test("renders a calm deterministic body with timing and optional teaching outcome", () => {
    expect(
      buildNotYetTaughtAlertBody({
        missStreak: 3,
        misses: [
          {
            nodeKey: "fractions",
            skillLabel: "Unit fractions",
            stemSnapshot: "Shade one fourth.",
            elapsedMs: 14_000,
            isDontKnow: true,
          },
          {
            nodeKey: "division",
            skillLabel: "Division as sharing",
            stemSnapshot: "Share 15 among 3 groups.",
            elapsedMs: 72_000,
            teachOutcome: "hint",
            isDontKnow: true,
          },
          {
            nodeKey: "remainders",
            skillLabel: "Interpret remainders",
            isDontKnow: true,
          },
        ],
        sitting: {
          correct: 0,
          total: 3,
          startedAt: NOW - 2 * 60_000,
          bounded: false,
        },
        now: NOW,
      }),
    ).toBe(
      [
        `Tapped "I haven't learned this yet" on 3 practice items in a row. This reads as material not yet taught, rather than a misconception to unpick.`,
        "This sitting: 0 of 3 correct, over 2 min.",
        "",
        "• *Unit fractions* (14s on this one)",
        "   `Shade one fourth.`",
        "• *Division as sharing* (1 min on this one)",
        "   `Share 15 among 3 groups.`",
        "   ↳ Teaching follow-up: finished with a hint.",
        "• *Interpret remainders*",
      ].join("\n"),
    );
  });

  test("never renders a model diagnosis line", () => {
    const body = buildNotYetTaughtAlertBody({
      missStreak: 3,
      misses: fullMisses.map((miss) => ({ ...miss, isDontKnow: true })),
      now: NOW,
    });
    expect(body).not.toContain("_AI read:_");
  });
});
