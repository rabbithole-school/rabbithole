import { describe, expect, test } from "vitest";
import {
  buildHandoffPrompt,
  buildManipulativeHandoffPrompt,
} from "../lib/practice/handoff";

// Branch coverage only. The wording of each branch is owned by the judged
// evals; these cases pin that the entry mode and the final-turn option select
// DIFFERENT prompts, and that the documented aliases collapse.

const packet = { stem: "7 × 8 = ?", wrongAnswers: ["54", "56"] };
const manipPacket = {
  concept: "Area model",
  prompt: "Fill in the box",
  task: "Build the four partial products",
  wrongAttemptCount: 1,
};

describe("buildHandoffPrompt entry mode", () => {
  test("each entry mode selects its own framing; the reserved game mode is stuck", () => {
    const stuck = buildHandoffPrompt(packet);
    const spiral = buildHandoffPrompt(packet, "spiral");
    const ladder = buildHandoffPrompt(packet, "ladder");
    const game = buildHandoffPrompt(packet, "game");

    expect(new Set([stuck, spiral, ladder]).size).toBe(3);
    expect(buildHandoffPrompt(packet, "stuck")).toBe(stuck);
    expect(game).toBe(stuck);
  });
});

describe("handoff final-turn (land the plane)", () => {
  test("the final turn is a distinct prompt for both handoff kinds", () => {
    const midChat = buildHandoffPrompt(packet, "stuck", undefined, { finalTurn: false });
    const lastTurn = buildHandoffPrompt(packet, "stuck", undefined, { finalTurn: true });
    expect(lastTurn).not.toBe(midChat);
    expect(lastTurn).toContain("LAST message");
    expect(midChat).not.toContain("LAST message");

    const manipMid = buildManipulativeHandoffPrompt(manipPacket, undefined, { finalTurn: false });
    const manipLast = buildManipulativeHandoffPrompt(manipPacket, undefined, { finalTurn: true });
    expect(manipLast).not.toBe(manipMid);
    expect(manipLast).toContain("LAST message");
    expect(manipMid).not.toContain("LAST message");
  });

  test("omitting the option is treated as a non-final turn", () => {
    expect(buildHandoffPrompt(packet)).toBe(
      buildHandoffPrompt(packet, "stuck", undefined, { finalTurn: false }),
    );
    expect(buildManipulativeHandoffPrompt(manipPacket)).toBe(
      buildManipulativeHandoffPrompt(manipPacket, undefined, { finalTurn: false }),
    );
  });
});
