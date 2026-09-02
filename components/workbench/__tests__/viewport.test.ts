import { describe, expect, it } from "vitest";

import {
  AMBIENT_BOB_CYCLE_MS,
  AMBIENT_BOB_HALF_CYCLE_MS,
  AMBIENT_BOB_PX,
} from "@/lib/simulator/helpers";
import {
  automatonLayout,
  BANNED_DIAGNOSIS_WORDS,
  clientDragToViewBox,
  clientPointToViewBox,
  INVALID_ACTION_LABEL,
  isNeutralLabel,
  isPointInViewBox,
  launchGateDecision,
  pointerPan,
  stablePhase,
  wordDiff,
} from "../viewport";

describe("bob never displaces recorded truth (review Finding 1)", () => {
  it("derives the bob phase from stable identity, not position", () => {
    const before = automatonLayout({ id: "swimmer-7", size: 0.4 });
    const after = automatonLayout({ id: "swimmer-7", size: 1.2 });
    expect(after.bob.delaySeconds).toBe(before.bob.delaySeconds);
  });

  it("bob is bounded and sprite radius follows size", () => {
    const layout = automatonLayout({ id: "x", size: 0.8 });
    expect(layout.bob.durationSeconds).toBe(AMBIENT_BOB_CYCLE_MS / 1000);
    expect(AMBIENT_BOB_CYCLE_MS).toBe(AMBIENT_BOB_HALF_CYCLE_MS * 2);
    expect(AMBIENT_BOB_PX).toBe(1.6);
    expect(layout.radius).toBe(0.4);
    expect(stablePhase("x")).toBeGreaterThanOrEqual(0);
    expect(stablePhase("x")).toBeLessThan(1);
    expect(stablePhase("x")).toBe(stablePhase("x")); // deterministic
  });
});

describe("SVG pointer coordinates honor xMidYMid meet letterboxing", () => {
  const viewBox = { width: 100, height: 50 };

  it("removes horizontal margins in a wide SVG rect", () => {
    const rect = { left: 10, top: 20, width: 300, height: 100 };
    expect(clientPointToViewBox({ x: 110, y: 45 }, rect, viewBox)).toEqual({
      x: 25,
      y: 12.5,
    });
  });

  it("removes vertical margins in a tall SVG rect", () => {
    const rect = { left: 10, top: 20, width: 100, height: 200 };
    expect(clientPointToViewBox({ x: 35, y: 95 }, rect, viewBox)).toEqual({
      x: 25,
      y: 0,
    });
  });

  it("uses the same SVG rect and uniform scale for pan and selection", () => {
    const rect = { left: 30, top: 40, width: 300, height: 100 };
    const start = { x: 130, y: 65 };
    const current = { x: 170, y: 85 };
    const selectedPoint = clientPointToViewBox(current, rect, viewBox);
    const drag = clientDragToViewBox(start, current, rect, viewBox);
    expect(selectedPoint).toEqual({ x: 45, y: 22.5 });
    expect(drag).toEqual({ dx: 20, dy: 10 });
  });

  it("rejects letterbox-margin points that fall outside the viewBox", () => {
    // Inside the content region (inclusive of the edges) is selectable.
    expect(isPointInViewBox({ x: 0, y: 0 }, viewBox)).toBe(true);
    expect(isPointInViewBox({ x: 50, y: 25 }, viewBox)).toBe(true);
    expect(isPointInViewBox({ x: 100, y: 50 }, viewBox)).toBe(true);
    // Points in the centered letterbox margin map outside the viewBox — an
    // inverse projection could still fold them onto an edge cell, so they must
    // be rejected before hit-testing.
    expect(isPointInViewBox({ x: -1, y: 25 }, viewBox)).toBe(false);
    expect(isPointInViewBox({ x: 25, y: -1 }, viewBox)).toBe(false);
    expect(isPointInViewBox({ x: 101, y: 25 }, viewBox)).toBe(false);
    expect(isPointInViewBox({ x: 25, y: 51 }, viewBox)).toBe(false);
  });
});

describe("pointer pan preserves the click (QB walkthrough W1)", () => {
  it("does NOT pan while the press stays under the threshold", () => {
    // A 1–2px click jitter must not pan — panning shifts the automaton out from
    // under the pointer, so the browser never synthesizes a click on it.
    expect(pointerPan({ dx: 0, dy: 0, moved: false })).toEqual({ moved: false, pan: false });
    expect(pointerPan({ dx: 2, dy: 1, moved: false })).toEqual({ moved: false, pan: false });
    expect(pointerPan({ dx: 4, dy: 0, moved: false })).toEqual({ moved: false, pan: false });
  });

  it("pans once the drag clearly engages, and stays engaged", () => {
    expect(pointerPan({ dx: 5, dy: 0, moved: false })).toEqual({ moved: true, pan: true });
    expect(pointerPan({ dx: 20, dy: 30, moved: false })).toEqual({ moved: true, pan: true });
    // Sticky: once moved, small subsequent deltas keep panning (no jitter back).
    expect(pointerPan({ dx: 1, dy: 0, moved: true })).toEqual({ moved: true, pan: true });
  });
});

describe("hypothesis light-gate (review PASS-after-fix)", () => {
  it("launches a zero-run bench as baseline exploration", () => {
    expect(
      launchGateDecision({ hasCompletedRun: false, gateOpen: false, prediction: null }),
    ).toBe("launch");
  });

  it("requires a later run to open the gate and choose a prediction", () => {
    expect(
      launchGateDecision({ hasCompletedRun: true, gateOpen: false, prediction: null }),
    ).toBe("open-gate");
    expect(
      launchGateDecision({ hasCompletedRun: true, gateOpen: true, prediction: null }),
    ).toBe("await-prediction");
    expect(
      launchGateDecision({ hasCompletedRun: true, gateOpen: true, prediction: "worse" }),
    ).toBe("launch");
  });
});

describe("invalid-action marker stays neutral (review Finding 6 / plan §4.3)", () => {
  it("names the fact without diagnosing the scholar", () => {
    expect(INVALID_ACTION_LABEL).toContain("invalid action");
    expect(isNeutralLabel(INVALID_ACTION_LABEL)).toBe(true);
  });

  it("flags any diagnosing language as non-neutral", () => {
    for (const word of BANNED_DIAGNOSIS_WORDS) {
      expect(isNeutralLabel(`your prompt was ${word}`)).toBe(false);
    }
    expect(isNeutralLabel("⚠ invalid action this day — view that day")).toBe(true);
  });
});

describe("deck word diff (review Finding 3 / plan §7.3)", () => {
  it("tags added / removed / same tokens and reconstructs each side", () => {
    const tokens = wordDiff("graze near algae", "graze far from algae");
    expect(tokens.some((token) => token.kind === "removed" && token.text === "near")).toBe(true);
    expect(tokens.some((token) => token.kind === "added" && token.text === "far")).toBe(true);
    const before = tokens.filter((token) => token.kind !== "added").map((token) => token.text).join("");
    const after = tokens.filter((token) => token.kind !== "removed").map((token) => token.text).join("");
    expect(before).toBe("graze near algae");
    expect(after).toBe("graze far from algae");
  });

  it("reports no changes when the decks are identical", () => {
    const tokens = wordDiff("hold the reef", "hold the reef");
    expect(tokens.every((token) => token.kind === "same")).toBe(true);
  });
});
