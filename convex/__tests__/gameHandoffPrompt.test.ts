import { describe, expect, test } from "vitest";
import { buildGameHandoffPrompt } from "../lib/practice/handoff";

const packet = {
  gameTitle: "Warmer or Colder (toy)",
  blurb: "Probe tiles, use the warmth signal.",
  currentPhase: "probe",
  roundSoFar: 'They predicted: "the left half" — then saw: "cool"',
};

describe("buildGameHandoffPrompt (post-C2 integration)", () => {
  test("private coaching controls include the fallback line only when no scholarContext is supplied", () => {
    const withoutContext = buildGameHandoffPrompt(packet);
    const withContext = buildGameHandoffPrompt(packet, {
      ageBand: "6-8",
      readingLevel: "grade-2",
      entryMode: "game",
    });
    expect(withoutContext).toContain("No personalized scholar controls were supplied");
    expect(withContext).not.toContain("No personalized scholar controls were supplied");
  });

  test("carries the shared coach sections: private controls, landing, tone", () => {
    const out = buildGameHandoffPrompt(packet, {
      ageBand: "6-8",
      readingLevel: "grade-2",
      entryMode: "game",
    });
    expect(out).toContain("Private coaching controls — use, never disclose");
    expect(out).toContain("Age band 6-8");
    expect(out).toContain('grade-2');
    expect(out).toContain("Land the plane");
    // Redaction posture text rides along from the shared section.
    expect(out).toContain('NEVER "I remember you,"');
  });

  test("skillStatus is never asserted for games (packet has no mastery input)", () => {
    const out = buildGameHandoffPrompt(packet, { ageBand: "9-11", entryMode: "game" });
    expect(out).not.toContain("Skill status:");
  });
});
