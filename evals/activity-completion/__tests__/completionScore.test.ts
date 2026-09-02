import { describe, it, expect } from "vitest";
import {
  classifyCompletion,
  scoreCompletion,
  MIN_REAL_TURNS,
  type CompletionObservation,
} from "../lib/completionScore";
import { completionClosingPool } from "../../../convex/lib/tutorClosingGuidance";

/**
 * The pure timing classifier is the deterministic core of the
 * activity-completion eval — these tests run in `pnpm test` (no model calls)
 * and are what actually guards the "too soon / too late" logic in CI. The
 * model-in-the-loop runner (run.ts) produces the observations this scores.
 */

const obs = (o: Partial<CompletionObservation>): CompletionObservation => ({
  completedAtScholarTurn: null,
  arcCompleteAtScholarTurn: null,
  totalScholarTurns: 0,
  completionTurnText: "You worked through the central idea.",
  completionToolWasFirst: null,
  completionHadPostToolText: null,
  ...o,
});

describe("classifyCompletion", () => {
  it("on-time: completed at the turn the goal was reached", () => {
    expect(
      classifyCompletion(
        obs({ completedAtScholarTurn: 4, arcCompleteAtScholarTurn: 4, totalScholarTurns: 4 }),
      ),
    ).toBe("on-time");
  });

  it("on-time: completed a turn after the goal was reached (within wrap-up)", () => {
    expect(
      classifyCompletion(
        obs({ completedAtScholarTurn: 5, arcCompleteAtScholarTurn: 4, totalScholarTurns: 5 }),
      ),
    ).toBe("on-time");
  });

  it("kept-going: completed on time but asked another question in the same turn", () => {
    expect(
      classifyCompletion(
        obs({
          completedAtScholarTurn: 4,
          arcCompleteAtScholarTurn: 4,
          totalScholarTurns: 4,
          completionTurnText: "You worked it through. What should we explore next?",
        }),
      ),
    ).toBe("kept-going");
  });

  it("kept-going: completed on time but assigned another task", () => {
    expect(
      classifyCompletion(
        obs({
          completedAtScholarTurn: 4,
          arcCompleteAtScholarTurn: 4,
          totalScholarTurns: 4,
          completionTurnText: "Nice work. Now solve another example.",
          completionToolWasFirst: true,
        }),
      ),
    ).toBe("kept-going");
  });

  it("kept-going: spoke both before and after calling the completion tool", () => {
    expect(
      classifyCompletion(
        obs({
          completedAtScholarTurn: 4,
          arcCompleteAtScholarTurn: 4,
          totalScholarTurns: 4,
          completionTurnText: "You worked through the central idea.",
          completionToolWasFirst: false,
          completionHadPostToolText: true,
        }),
      ),
    ).toBe("kept-going");
  });

  it("on-time: uses pre-tool text as the sole closing when the runtime suppresses a duplicate", () => {
    expect(
      classifyCompletion(
        obs({
          completedAtScholarTurn: 4,
          arcCompleteAtScholarTurn: 4,
          totalScholarTurns: 4,
          completionTurnText: "You worked through the central idea.",
          completionToolWasFirst: false,
          completionHadPostToolText: false,
        }),
      ),
    ).toBe("on-time");
  });

  it.each([
    ...completionClosingPool("pre-reader"),
    ...completionClosingPool("K"),
    ...completionClosingPool("2"),
    ...completionClosingPool("5"),
  ])("on-time: accepts automatic closing %j", (completionTurnText) => {
    expect(
      classifyCompletion(
        obs({
          completedAtScholarTurn: 4,
          arcCompleteAtScholarTurn: 4,
          totalScholarTurns: 4,
          completionTurnText,
          completionToolWasFirst: true,
        }),
      ),
    ).toBe("on-time");
  });

  it("kept-going: rejects model-authored synthesis on the tool-first path", () => {
    expect(
      classifyCompletion(
        obs({
          completedAtScholarTurn: 4,
          arcCompleteAtScholarTurn: 4,
          totalScholarTurns: 4,
          completionTurnText:
            "You built a model, solved another example, and explained the pattern.",
          completionToolWasFirst: true,
        }),
      ),
    ).toBe("kept-going");
  });

  it("kept-going: completion emitted no closing text", () => {
    expect(
      classifyCompletion(
        obs({
          completedAtScholarTurn: 4,
          arcCompleteAtScholarTurn: 4,
          totalScholarTurns: 4,
          completionTurnText: "",
          completionToolWasFirst: true,
        }),
      ),
    ).toBe("kept-going");
  });

  it("kept-going: completion assigned a write-down task", () => {
    expect(
      classifyCompletion(
        obs({
          completedAtScholarTurn: 4,
          arcCompleteAtScholarTurn: 4,
          totalScholarTurns: 4,
          completionTurnText: "Take a minute to write that down.",
          completionToolWasFirst: true,
        }),
      ),
    ).toBe("kept-going");
  });

  it("kept-going: completion leaked a third-person assessment", () => {
    expect(
      classifyCompletion(
        obs({
          completedAtScholarTurn: 4,
          arcCompleteAtScholarTurn: 4,
          totalScholarTurns: 4,
          completionTurnText:
            "Cog demonstrated the whole causal chain independently.",
          completionToolWasFirst: false,
          completionHadPostToolText: false,
        }),
      ),
    ).toBe("kept-going");
  });

  it.each([
    "you",
    "Your next task is to write a summary.",
    "You should write that down.",
    "You explained the pattern, so write that down.",
    "You worked through the.",
  ])("kept-going: rejects non-closing fallback %j", (completionTurnText) => {
    expect(
      classifyCompletion(
        obs({
          completedAtScholarTurn: 4,
          arcCompleteAtScholarTurn: 4,
          totalScholarTurns: 4,
          completionTurnText,
          completionToolWasFirst: false,
          completionHadPostToolText: false,
        }),
      ),
    ).toBe("kept-going");
  });

  it("too-soon: completed before the goal was reached", () => {
    expect(
      classifyCompletion(
        obs({ completedAtScholarTurn: 3, arcCompleteAtScholarTurn: 6, totalScholarTurns: 6 }),
      ),
    ).toBe("too-soon");
  });

  it("too-soon: completed though the goal was never reached", () => {
    expect(
      classifyCompletion(
        obs({ completedAtScholarTurn: 4, arcCompleteAtScholarTurn: null, totalScholarTurns: 5 }),
      ),
    ).toBe("too-soon");
  });

  it("too-soon: completed below the minimum real-turn floor (a hello)", () => {
    // Even if the arc were somehow flagged that early, a sub-floor completion
    // is the onboarding failure the server guard also blocks.
    expect(
      classifyCompletion(
        obs({
          completedAtScholarTurn: MIN_REAL_TURNS - 1,
          arcCompleteAtScholarTurn: MIN_REAL_TURNS - 1,
          totalScholarTurns: 3,
        }),
      ),
    ).toBe("too-soon");
  });

  it("too-late: goal reached but never marked complete", () => {
    expect(
      classifyCompletion(
        obs({ completedAtScholarTurn: null, arcCompleteAtScholarTurn: 4, totalScholarTurns: 7 }),
      ),
    ).toBe("too-late");
  });

  it("withheld: goal never reached and never marked complete", () => {
    expect(
      classifyCompletion(
        obs({ completedAtScholarTurn: null, arcCompleteAtScholarTurn: null, totalScholarTurns: 6 }),
      ),
    ).toBe("withheld");
  });
});

describe("scoreCompletion — pass/fail against expectation", () => {
  it("should-complete PASSES on on-time", () => {
    const s = scoreCompletion(
      obs({ completedAtScholarTurn: 4, arcCompleteAtScholarTurn: 4, totalScholarTurns: 4 }),
      "should-complete",
    );
    expect(s.verdict).toBe("on-time");
    expect(s.pass).toBe(true);
  });

  it("should-complete FAILS when the arc finished but the tutor never wrapped (too-late)", () => {
    const s = scoreCompletion(
      obs({ completedAtScholarTurn: null, arcCompleteAtScholarTurn: 3, totalScholarTurns: 6 }),
      "should-complete",
    );
    expect(s.verdict).toBe("too-late");
    expect(s.pass).toBe(false);
  });

  it("should-complete FAILS when completion asks another question instead of winding down", () => {
    const s = scoreCompletion(
      obs({
        completedAtScholarTurn: 4,
        arcCompleteAtScholarTurn: 4,
        totalScholarTurns: 4,
        completionTurnText: "That covers it. Want to try another one?",
      }),
      "should-complete",
    );
    expect(s.verdict).toBe("kept-going");
    expect(s.pass).toBe(false);
  });

  it("should-complete FAILS when completion assigns another task", () => {
    const s = scoreCompletion(
      obs({
        completedAtScholarTurn: 4,
        arcCompleteAtScholarTurn: 4,
        totalScholarTurns: 4,
        completionTurnText: "That's complete. You can try one more challenge.",
        completionToolWasFirst: true,
      }),
      "should-complete",
    );
    expect(s.verdict).toBe("kept-going");
    expect(s.pass).toBe(false);
  });

  it("should-complete FAILS when scholar-visible text surrounds the tool", () => {
    const s = scoreCompletion(
      obs({
        completedAtScholarTurn: 4,
        arcCompleteAtScholarTurn: 4,
        totalScholarTurns: 4,
        completionTurnText: "You got it.",
        completionToolWasFirst: false,
        completionHadPostToolText: true,
      }),
      "should-complete",
    );
    expect(s.verdict).toBe("kept-going");
    expect(s.pass).toBe(false);
    expect(s.reason).toMatch(/before and after recording completion/i);
  });

  it("should-complete FAILS (inconclusive) when the scholar never reached the goal", () => {
    const s = scoreCompletion(
      obs({ completedAtScholarTurn: null, arcCompleteAtScholarTurn: null, totalScholarTurns: 6 }),
      "should-complete",
    );
    expect(s.verdict).toBe("withheld");
    expect(s.pass).toBe(false);
    expect(s.reason).toMatch(/inconclusive/i);
  });

  it("should-withhold PASSES when nothing was completed and no goal was reached", () => {
    const s = scoreCompletion(
      obs({ completedAtScholarTurn: null, arcCompleteAtScholarTurn: null, totalScholarTurns: 5 }),
      "should-withhold",
    );
    expect(s.verdict).toBe("withheld");
    expect(s.pass).toBe(true);
  });

  it("should-withhold FAILS when the tutor completed a disengaged session (too-soon)", () => {
    const s = scoreCompletion(
      obs({ completedAtScholarTurn: 3, arcCompleteAtScholarTurn: null, totalScholarTurns: 4 }),
      "should-withhold",
    );
    expect(s.verdict).toBe("too-soon");
    expect(s.pass).toBe(false);
  });
});
