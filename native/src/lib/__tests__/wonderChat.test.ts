import { describe, expect, it } from "vitest";

import type { Id } from "@/lib/convex";
import { wonderChatRoute, wonderFirstTurn } from "@/lib/wonderChat";

const SESSION = "session123" as Id<"sessions">;

describe("wonderChatRoute → wonderFirstTurn", () => {
  it("hands the box's words to the session screen as its first turn", () => {
    const { params } = wonderChatRoute(SESSION, "Do fish get thirsty?", "typed");
    expect(params.id).toBe(SESSION);
    expect(params.title).toBe("Do fish get thirsty?");
    expect(wonderFirstTurn(params.wonder, params.wonderBy)).toEqual({
      text: "Do fish get thirsty?",
      inputModality: "typed",
    });
  });

  it("keeps a dictated question marked as spoken", () => {
    const { params } = wonderChatRoute(SESSION, "Why is the sky blue?", "spoken");
    expect(wonderFirstTurn(params.wonder, params.wonderBy)?.inputModality).toBe(
      "spoken",
    );
  });
});

describe("wonderFirstTurn", () => {
  it("is no turn for a chat not opened from the box", () => {
    expect(wonderFirstTurn(undefined, undefined)).toBeNull();
  });

  it("is no turn for blank words", () => {
    expect(wonderFirstTurn("   ", "typed")).toBeNull();
  });

  it("treats anything but spoken as typed", () => {
    expect(wonderFirstTurn("Who invented zero?", "keyboard")?.inputModality).toBe(
      "typed",
    );
  });

  it("reads the first value of a repeated param", () => {
    expect(wonderFirstTurn(["Who invented zero?", "x"], ["spoken"])).toEqual({
      text: "Who invented zero?",
      inputModality: "spoken",
    });
  });
});
