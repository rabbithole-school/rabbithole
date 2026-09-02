import { describe, expect, it } from "vitest";
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
