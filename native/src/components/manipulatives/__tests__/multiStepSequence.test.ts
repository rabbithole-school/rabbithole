import { createElement, type ComponentType } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

const { nativeManipulative } = vi.hoisted(() => ({
  nativeManipulative: vi.fn((_props: unknown) => null),
}));

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: "Text",
  View: "View",
}));

vi.mock("@/theme", () => ({
  fonts: { bold: "bold", medium: "medium", regular: "regular" },
  useColors: () => ({
    bg: "#fff",
    bgSubtle: "#eee",
    border: "#ddd",
    charcoalSubtle: "#666",
    fg: "#222",
    fgMuted: "#555",
    navy: "#111",
    white: "#fff",
  }),
}));

vi.mock("../NativeManipulative", () => ({
  isNativeManipulativeKind: () => true,
  NativeManipulative: nativeManipulative,
}));

import {
  advanceSequence,
  currentSequenceStep,
  initialArray,
  isSequenceComplete,
  isSolved,
  sequenceProgress,
} from "../../../../vendor/manipulative/logic";
import type { ArraySpec, MultiStepSequenceSpec } from "../../../../vendor/manipulative/types";
import { isNativeManipulativeKind } from "../nativeManipulativeKinds";
import { MultiStepSequenceNative } from "../MultiStepSequence.native";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

// Pin both the pure step helpers and the component wiring that decides whether
// a scholar sees Done or can advance immediately.

function arrayStep(id: string, rows: number, cols: number, target: number): ArraySpec {
  return {
    kind: "array",
    id,
    concept: "Arrays",
    prompt: `Build an array that makes ${target}.`,
    rows,
    cols,
    goal: { type: "productEquals", value: target },
  };
}

function exploreArrayStep(id: string, rows: number, cols: number): ArraySpec {
  return {
    kind: "array",
    id,
    concept: "Arrays",
    prompt: "Move the counters and notice what changes.",
    rows,
    cols,
  };
}

const SEQUENCE: MultiStepSequenceSpec = {
  id: "seq-test",
  concept: "A linked sequence",
  title: "You linked both steps!",
  completeSummary: "Two arrays, two products.",
  steps: [arrayStep("s0", 2, 2, 6), arrayStep("s1", 1, 1, 4)],
};

const EXPLORE_THEN_CHALLENGE_SEQUENCE: MultiStepSequenceSpec = {
  id: "seq-explore-then-challenge",
  concept: "Explore, then solve",
  title: "You finished both steps!",
  steps: [exploreArrayStep("explore", 2, 2), arrayStep("challenge", 1, 1, 4)],
};

function button(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findByProps({ accessibilityLabel: label });
}

function visibleText(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAllByType("Text" as unknown as ComponentType)
    .flatMap((node) => node.children)
    .filter((child): child is string => typeof child === "string")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

describe("multi-step sequence progression contract", () => {
  it("reports the current step, progress, and completion via the pure helpers", () => {
    // Start on step 0.
    expect(currentSequenceStep(SEQUENCE, 0)).toBe(SEQUENCE.steps[0]);
    expect(isSequenceComplete(SEQUENCE, 0)).toBe(false);
    expect(sequenceProgress(SEQUENCE, 0)).toEqual({ current: 1, total: 2 });

    // Advance to the last step.
    const afterFirst = advanceSequence(0);
    expect(afterFirst).toBe(1);
    expect(isSequenceComplete(SEQUENCE, afterFirst)).toBe(false);
    expect(currentSequenceStep(SEQUENCE, afterFirst)).toBe(SEQUENCE.steps[1]);
    expect(sequenceProgress(SEQUENCE, afterFirst)).toEqual({ current: 2, total: 2 });

    // Advance past the last step → complete (the onComplete trigger condition).
    const afterLast = advanceSequence(afterFirst);
    expect(afterLast).toBe(2);
    expect(isSequenceComplete(SEQUENCE, afterLast)).toBe(true);
    expect(currentSequenceStep(SEQUENCE, afterLast)).toBeNull();
    // current stays capped at total once past the end.
    expect(sequenceProgress(SEQUENCE, afterLast)).toEqual({ current: 2, total: 2 });
  });

  it("gates advancement on the SAME per-step isSolved the component checks", () => {
    const step0 = SEQUENCE.steps[0] as ArraySpec;
    // Fresh state is not solved (2×2 = 4, target 6) → "Done" would show incorrect.
    expect(isSolved(step0, initialArray(step0))).toBe(false);
    // The correct build (2×3 = 6) is solved → "Done" reveals correct, "Next" unlocks.
    expect(isSolved(step0, { rows: 2, cols: 3 })).toBe(true);

    const step1 = SEQUENCE.steps[1] as ArraySpec;
    expect(isSolved(step1, initialArray(step1))).toBe(false);
    expect(isSolved(step1, { rows: 2, cols: 2 })).toBe(true);
  });

  it("classifies each step's kind for the honest native/web-only fallback gate", () => {
    for (const step of SEQUENCE.steps) {
      expect(isNativeManipulativeKind(step.kind)).toBe(true);
    }
    // A kind with no native renderer must fall back rather than render an empty stage.
    expect(isNativeManipulativeKind("geoLocate")).toBe(false);
  });

  it("advances a goal-less native EXPLORE step immediately without a solved verdict", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(createElement(MultiStepSequenceNative, { spec: EXPLORE_THEN_CHALLENGE_SEQUENCE }));
    });

    expect(() => button(renderer, "Next step")).not.toThrow();
    expect(renderer.root.findAllByProps({ accessibilityLabel: "Done" })).toHaveLength(0);
    expect(visibleText(renderer)).toContain("Step 1 of 2");
    expect(visibleText(renderer)).toContain("Have a play. There's nothing to get wrong here.");
    expect(visibleText(renderer)).not.toContain("tap Done");
    expect(visibleText(renderer)).not.toContain("That's it!");
    expect(visibleText(renderer)).not.toContain("Not quite");

    act(() => {
      button(renderer, "Next step").props.onPress();
    });

    expect(visibleText(renderer)).toContain("Build an array that makes 4.");
    expect(visibleText(renderer)).toContain("Step 2 of 2");
    expect(() => button(renderer, "Done")).not.toThrow();
    expect(renderer.root.findAllByProps({ accessibilityLabel: "Next step" })).toHaveLength(0);

    act(() => renderer.unmount());
  });

  it("keeps a goal-bearing first step behind Done until it is solved", () => {
    const callsBeforeMount = nativeManipulative.mock.calls.length;
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(createElement(MultiStepSequenceNative, { spec: SEQUENCE }));
    });

    expect(() => button(renderer, "Done")).not.toThrow();
    expect(renderer.root.findAllByProps({ accessibilityLabel: "Next step" })).toHaveLength(0);
    expect(nativeManipulative.mock.calls.length).toBeGreaterThan(callsBeforeMount);

    const manipulativeProps = nativeManipulative.mock.lastCall?.[0] as
      | {
          onSolvedChange: (solved: boolean) => void;
          onStateChange: (state: unknown) => void;
        }
      | undefined;
    expect(manipulativeProps).toBeDefined();

    act(() => {
      manipulativeProps?.onStateChange({ rows: 2, cols: 3 });
      manipulativeProps?.onSolvedChange(true);
    });
    expect(() => button(renderer, "Done")).not.toThrow();
    expect(renderer.root.findAllByProps({ accessibilityLabel: "Next step" })).toHaveLength(0);

    act(() => {
      button(renderer, "Done").props.onPress();
    });
    expect(visibleText(renderer)).toContain("That's it!");
    expect(() => button(renderer, "Next step")).not.toThrow();

    act(() => renderer.unmount());
  });
});
