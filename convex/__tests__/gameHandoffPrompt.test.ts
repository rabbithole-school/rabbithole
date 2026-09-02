import { describe, expect, test } from "vitest";
import {
  buildGameHandoffPrompt,
  GAME_HANDOFF_PROMPT_VERSION,
} from "../lib/practice/handoff";

const packet = {
  gameTitle: "Warmer or Colder (toy)",
  blurb: "Probe tiles, use the warmth signal.",
  currentPhase: "probe",
  roundSoFar: 'They predicted: "the left half" — then saw: "cool"',
};

describe("buildGameHandoffPrompt (post-C2 integration)", () => {
  test("grounds in the round and keeps the game framing", () => {
    const out = buildGameHandoffPrompt(packet);
    expect(out).toContain('playing "Warmer or Colder (toy)"');
    expect(out).toContain('tap "Hint"');
    expect(out).toContain("Where they are: probe");
    expect(out).toContain('They predicted: "the left half"');
    expect(out).toContain("never spoil the reveal");
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

  test("without scholarContext the sections degrade to the no-controls line", () => {
    const out = buildGameHandoffPrompt(packet);
    expect(out).toContain("No personalized scholar controls were supplied");
    expect(out).toContain("Land the plane");
  });

  test("skillStatus is never asserted for games (packet has no mastery input)", () => {
    const out = buildGameHandoffPrompt(packet, { ageBand: "9-11", entryMode: "game" });
    expect(out).not.toContain("Skill status:");
  });

  test("version stamp is game-specific", () => {
    expect(GAME_HANDOFF_PROMPT_VERSION).toMatch(/game/);
  });
});
