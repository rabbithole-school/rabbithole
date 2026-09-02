import { describe, expect, it } from "vitest";
import { nextTeachingMove, stillStuckAvailable } from "@/shared/teachingLadder";

const NO_HINT = { hasHint: false, hintShown: false };
const HINT_UNSPENT = { hasHint: true, hintShown: false };
const HINT_SPENT = { hasHint: true, hintShown: true };

describe("nextTeachingMove", () => {
  it("a correct first answer solves cold", () => {
    expect(nextTeachingMove(true, HINT_UNSPENT)).toEqual({ kind: "solved", outcome: "solved" });
  });

  it("a correct answer after the hint records the nudge, not a cold solve", () => {
    expect(nextTeachingMove(true, HINT_SPENT)).toEqual({ kind: "solved", outcome: "hint" });
  });

  // The regression this module exists for: a wrong guess used to reveal
  // immediately, collapsing tier 1 into tier 4 and stranding the hint and tutor
  // rungs. The scholar who guesses must land on the SAME ladder as the scholar
  // who hesitates.
  it("a wrong guess drops to the hint rather than spending the reveal", () => {
    expect(nextTeachingMove(false, HINT_UNSPENT)).toEqual({ kind: "hint", outcome: "hint" });
  });

  it("reveals only once the hint has been spent", () => {
    expect(nextTeachingMove(false, HINT_SPENT)).toEqual({ kind: "reveal", outcome: "stuck" });
  });

  it("reveals on a wrong guess when the step could derive no hint", () => {
    expect(nextTeachingMove(false, NO_HINT)).toEqual({ kind: "reveal", outcome: "stuck" });
  });

  it("never reveals while a rung remains unspent", () => {
    for (const state of [HINT_UNSPENT, HINT_SPENT, NO_HINT]) {
      const move = nextTeachingMove(false, state);
      const rungLeft = state.hasHint && !state.hintShown;
      expect(move.kind === "reveal").toBe(!rungLeft);
    }
  });

  it("walks the full ladder without ever repeating a rung", () => {
    // Guess wrong, take the hint, guess wrong again — blank → hint → reveal.
    let state = { hasHint: true, hintShown: false };
    const walked: string[] = [];
    for (let i = 0; i < 4; i++) {
      const move = nextTeachingMove(false, state);
      walked.push(move.kind);
      if (move.kind === "reveal") break;
      state = { ...state, hintShown: true };
    }
    expect(walked).toEqual(["hint", "reveal"]);
  });

  it("reports a monotone outcome — depth never decreases along a path", () => {
    const depth = { solved: 0, hint: 1, stuck: 2 } as const;
    // miss → hint, then succeed → hint. Equal depth, so the stored value holds.
    expect(depth[nextTeachingMove(false, HINT_UNSPENT).outcome]).toBe(
      depth[nextTeachingMove(true, HINT_SPENT).outcome],
    );
    // miss → hint, then miss again → stuck. Strictly deeper.
    expect(depth[nextTeachingMove(false, HINT_SPENT).outcome]).toBeGreaterThan(
      depth[nextTeachingMove(false, HINT_UNSPENT).outcome],
    );
  });
});

describe("stillStuckAvailable", () => {
  it("offers the hint while it is unspent, even with no tutor", () => {
    expect(stillStuckAvailable(HINT_UNSPENT, false)).toBe(true);
  });

  it("offers the tutor once the hint is spent", () => {
    expect(stillStuckAvailable(HINT_SPENT, true)).toBe(true);
  });

  it("hides itself when the ladder is exhausted and there is no tutor", () => {
    expect(stillStuckAvailable(HINT_SPENT, false)).toBe(false);
    expect(stillStuckAvailable(NO_HINT, false)).toBe(false);
  });

  it("still offers the tutor for a step that could derive no hint", () => {
    expect(stillStuckAvailable(NO_HINT, true)).toBe(true);
  });
});
