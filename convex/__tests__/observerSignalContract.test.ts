import { describe, expect, test } from "vitest";
import { buildObserverSystemPrompt } from "../prompts";

describe("observer session-signal contract", () => {
  const prompt = buildObserverSystemPrompt();

  test("signals are affirmative evidence rather than neutral behavior bins", () => {
    expect(prompt).toContain(
      "Session signals are AFFIRMING evidence of how this person thinks and works",
    );
    expect(prompt).toContain("Do NOT turn counterevidence into praise");
    expect(prompt).toContain(
      "task avoidance, off-task deflection, reward-seeking, refusal, or frustration",
    );
    expect(prompt).toContain(
      "Intensity is never a positive/negative valence scale",
    );
  });

  test("signal evidence must cite a scholar message", () => {
    expect(prompt).toContain(
      "Return sourceMessageId for the exact SCHOLAR line supporting the signal",
    );
    expect(prompt).toContain(
      "transcriptExcerpt must be the SCHOLAR's own words from that line",
    );
  });
});
