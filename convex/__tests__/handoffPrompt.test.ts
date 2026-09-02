import { describe, expect, test } from "vitest";
import {
  buildHandoffPrompt,
  buildManipulativeHandoffPrompt,
  HANDOFF_PROMPT_VERSION,
  MANIPULATIVE_HANDOFF_PROMPT_VERSION,
} from "../lib/practice/handoff";

const packet = { stem: "7 × 8 = ?", wrongAnswers: ["54", "56"] };

describe("buildHandoffPrompt spiral entry", () => {
  test("uses mode-specific framing and treats reserved game as stuck", () => {
    const stuck = buildHandoffPrompt(packet);
    const spiral = buildHandoffPrompt(packet, "spiral");
    const ladder = buildHandoffPrompt(packet, "ladder");
    const game = buildHandoffPrompt(packet, "game");

    expect(stuck).toContain("missed the same practice problem twice");
    expect(stuck).not.toContain("several different problems in a row");
    expect(spiral).toContain(
      "several different problems in a row\ndidn't land",
    );
    expect(spiral).toContain("one deliberately winnable footing");
    expect(ladder).toContain("climbed the help ladder voluntarily");
    expect(ladder).toContain("Skip consolation");
    expect(game).toContain("missed the same practice problem twice");
  });

  test("uses low-cardinality context without manufacturing memory", () => {
    const context = {
      ageBand: "6-8" as const,
      readingLevel: "4.3",
      skillStatus: "still_building" as const,
      entryMode: "spiral" as const,
    };
    const typed = buildHandoffPrompt(packet, "spiral", context);
    const manipulative = buildManipulativeHandoffPrompt(
      {
        concept: "Division as sharing",
        prompt: "Share the counters evenly",
        task: "Build equal groups",
        wrongAttemptCount: 3,
      },
      context,
    );

    for (const prompt of [typed, manipulative]) {
      expect(prompt).toContain("Age band 6-8");
      expect(prompt).toContain('Reading level "4.3"');
      expect(prompt).toContain("still being built");
      expect(prompt).toContain("our records show");
      expect(prompt).toContain('says "never mind," "can we stop,"');
      expect(prompt).toContain("human teacher");
      expect(prompt).toContain("NEVER \"I remember you");
      expect(prompt).toContain("NEVER recite");
      expect(prompt).toContain(
        "NEVER confirm or deny",
      );
      expect(prompt).toContain(
        "Method-validity is not result-correctness",
      );
      expect(prompt).toContain("CANDIDATE-");
      expect(prompt).toContain("A self-check is theirs to");
      expect(prompt).toContain("NEVER say it");
      expect(prompt).not.toContain("3rd-grade reading level");
      // The pre-C2 escape hatch that contradicted the quarantine (Opus review F1)
      expect(prompt).not.toContain("not confirming a step a kid earned");
    }
  });

  test("bumps both context-aware prompt versions", () => {
    expect(HANDOFF_PROMPT_VERSION).toBe(
      "2026-07-context-v4-landplane",
    );
    expect(MANIPULATIVE_HANDOFF_PROMPT_VERSION).toBe(
      "2026-07-manip-context-v4-landplane",
    );
  });
});

describe("handoff final-turn (land the plane)", () => {
  const manipPacket = {
    concept: "Area model",
    prompt: "Fill in the box",
    task: "Build the four partial products",
    wrongAttemptCount: 1,
  };

  test("typed handoff wraps up on the final turn, no new question", () => {
    const midChat = buildHandoffPrompt(packet, "stuck", undefined, {
      finalTurn: false,
    });
    const lastTurn = buildHandoffPrompt(packet, "stuck", undefined, {
      finalTurn: true,
    });

    // Non-final keeps the soft "about 3 exchanges" guidance and no land-the-plane block.
    expect(midChat).toContain("## Keep it short and hand back");
    expect(midChat).not.toContain("This is your LAST message");

    // Final turn tells the model the composer closes and to not ask a question.
    expect(lastTurn).toContain("This is your LAST message — land the plane");
    expect(lastTurn).toContain("CANNOT answer you");
    expect(lastTurn).toMatch(/do NOT end\s+on a question/);
    expect(lastTurn).not.toContain("## Keep it short and hand back");
    // Landing the plane never licenses revealing the answer.
    expect(lastTurn).toContain("never means revealing the answer");
  });

  test("manipulative handoff wraps up on the final turn", () => {
    const midChat = buildManipulativeHandoffPrompt(manipPacket, undefined, {
      finalTurn: false,
    });
    const lastTurn = buildManipulativeHandoffPrompt(manipPacket, undefined, {
      finalTurn: true,
    });

    expect(midChat).toContain("## Keep it short and hand back");
    expect(midChat).not.toContain("This is your LAST message");
    expect(lastTurn).toContain("This is your LAST message — land the plane");
    expect(lastTurn).toContain("CANNOT answer you");
    expect(lastTurn).not.toContain("## Keep it short and hand back");
  });

  test("omitting the option is treated as a non-final turn", () => {
    expect(buildHandoffPrompt(packet)).not.toContain("This is your LAST message");
    expect(buildManipulativeHandoffPrompt(manipPacket)).not.toContain(
      "This is your LAST message",
    );
  });
});
