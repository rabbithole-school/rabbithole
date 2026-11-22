import { describe, expect, it } from "vitest";
import { scoreCompletion } from "../lib/completionScore";
import { runCompletionSession } from "../lib/driver";
import type { CompletionCase } from "../lib/types";

const scriptedCase: CompletionCase = {
  id: "scripted-offline",
  expectation: "should-withhold",
  note: "Minimal scripted fixture for deterministic driver coverage.",
  activity: {
    title: "Tiny chat",
    kind: "online",
    systemPrompt:
      "Ask the scholar to name a curiosity and turn it into a question.",
    learningGoal:
      "Name a curiosity and turn it into a question worth exploring.",
    durationMinutes: 5,
  },
  profile: {
    name: "Bolt",
    readingLevel: "Grade 2",
    dossier: "7 years old. New to the app and tries to leave immediately.",
    traits: ["answers briefly", "tries to be done without engaging"],
    archetype: "hello-and-bail",
  },
  script: ["hi", "ok im done", "idk"],
};

describe("runCompletionSession scripted scholar", () => {
  it("replays fixed scholar turns verbatim and never marks the arc complete", async () => {
    const result = await runCompletionSession(scriptedCase, { offline: true });

    expect(
      result.turns.filter((turn) => turn.role === "scholar").map((turn) => turn.content),
    ).toEqual(scriptedCase.script);
    expect(result.observation.totalScholarTurns).toBe(scriptedCase.script?.length);
    expect(result.observation.completedAtScholarTurn).toBeNull();
    expect(result.observation.arcCompleteAtScholarTurn).toBeNull();
  });
});

describe("runCompletionSession scripted scholar with goal evidence", () => {
  const goalCase = (openQuestionTurns: number[]): CompletionCase => ({
    ...scriptedCase,
    id: "scripted-goal-offline",
    expectation: "should-complete",
    goalEvidencePatterns: ["\\bpressure\\b"],
    openQuestionTurns,
    script: ["hi", "the gas pressure pushes it out, but why?", "ok", "cool"],
  });

  it("reaches the goal from the fixture's evidence and stops at completion", async () => {
    const result = await runCompletionSession(goalCase([]), { offline: true });

    expect(result.observation.arcCompleteAtScholarTurn).toBe(2);
    expect(result.observation.completedAtScholarTurn).toBe(2);
    expect(result.observation.totalScholarTurns).toBe(2);
    expect(scoreCompletion(result.observation, "should-complete").verdict).toBe(
      "on-time",
    );
  });

  it("scores completing on an open-question turn as too soon", async () => {
    const result = await runCompletionSession(goalCase([2]), { offline: true });

    expect(result.observation.completedOnOpenQuestion).toBe(true);
    const score = scoreCompletion(result.observation, "should-complete");
    expect(score.verdict).toBe("too-soon");
    expect(score.reason).toContain("asked a real question");
  });
});
