import { describe, expect, test } from "vitest";
import {
  buildReplayScript,
  computeReplayStopAfter,
  type ReplayMessage,
} from "../testDriveReplay";

// A small transcript builder so cases read like a conversation.
function transcript(...turns: Array<[ReplayMessage["role"], string]>): ReplayMessage[] {
  return turns.map(([role, content], i) => ({
    _id: `m${i}`,
    role,
    content,
  }));
}

describe("buildReplayScript", () => {
  test("returns scholar turns in order, dropping the <start> greeting kick", () => {
    const msgs = transcript(
      ["user", "<start>"],
      ["assistant", "Hi! What are we exploring?"],
      ["user", "I want to learn about sharks"],
      ["assistant", "Cool — what do you already know?"],
      ["user", "they have lots of teeth"],
    );
    expect(buildReplayScript(msgs)).toEqual([
      "I want to learn about sharks",
      "they have lots of teeth",
    ]);
  });

  test("ignores assistant, system, and tool messages", () => {
    const msgs = transcript(
      ["user", "hello"],
      ["system", "context"],
      ["tool", "result"],
      ["assistant", "reply"],
      ["user", "again"],
    );
    expect(buildReplayScript(msgs)).toEqual(["hello", "again"]);
  });

  test("empty when there are no scholar turns (greeting only)", () => {
    const msgs = transcript(["user", "<start>"], ["assistant", "Hi!"]);
    expect(buildReplayScript(msgs)).toEqual([]);
  });

  test("drops empty / whitespace-only scholar turns (handleSend would no-op them)", () => {
    const msgs = transcript(
      ["user", "<start>"],
      ["assistant", "Hi!"],
      ["user", "real turn"],
      ["assistant", "ok"],
      ["user", "   "], // whitespace-only — can't be re-sent
      ["assistant", "?"],
      ["user", ""], // empty
      ["assistant", "??"],
      ["user", "another real turn"],
    );
    expect(buildReplayScript(msgs)).toEqual(["real turn", "another real turn"]);
  });
});

describe("computeReplayStopAfter", () => {
  test("no flags → replay every scholar turn", () => {
    const msgs = transcript(
      ["user", "<start>"],
      ["assistant", "a0"],
      ["user", "s1"],
      ["assistant", "a1"],
      ["user", "s2"],
      ["assistant", "a2"],
    );
    expect(computeReplayStopAfter(msgs, new Set())).toBe(2);
  });

  test("boundary lands on the scholar turn whose tutor reply was flagged", () => {
    const msgs = transcript(
      ["user", "<start>"],
      ["assistant", "a0"], // m1
      ["user", "s1"],
      ["assistant", "a1"], // m3 — flagged
      ["user", "s2"],
      ["assistant", "a2"], // m5
    );
    // Flag a1 (response to s1) → stop after 1 scholar turn.
    expect(computeReplayStopAfter(msgs, new Set(["m3"]))).toBe(1);
  });

  test("uses the LAST flagged tutor reply when several are flagged", () => {
    const msgs = transcript(
      ["user", "<start>"],
      ["assistant", "a0"], // m1 — flagged
      ["user", "s1"],
      ["assistant", "a1"], // m3 — flagged
      ["user", "s2"],
      ["assistant", "a2"], // m5
      ["user", "s3"],
      ["assistant", "a3"], // m7
    );
    expect(computeReplayStopAfter(msgs, new Set(["m1", "m3"]))).toBe(1);
  });

  test("flag on the opening greeting (no preceding scholar turn) → replay all", () => {
    const msgs = transcript(
      ["user", "<start>"],
      ["assistant", "greeting"], // m1 — flagged, but no scholar turn before it
      ["user", "s1"],
      ["assistant", "a1"],
    );
    expect(computeReplayStopAfter(msgs, new Set(["m1"]))).toBe(1);
  });

  test("empty scholar turns don't count toward the boundary (stays in sync with buildReplayScript)", () => {
    const msgs = transcript(
      ["user", "<start>"],
      ["assistant", "a0"],
      ["user", "s1"],
      ["assistant", "a1"],
      ["user", "   "], // dropped from the script — must not shift the count
      ["assistant", "a2"],
      ["user", "s2"],
      ["assistant", "a3"], // m7 — flagged
    );
    // Two real scholar turns precede the flagged reply; the empty one is ignored.
    expect(computeReplayStopAfter(msgs, new Set(["m7"]))).toBe(2);
    expect(buildReplayScript(msgs)).toEqual(["s1", "s2"]);
  });
});
