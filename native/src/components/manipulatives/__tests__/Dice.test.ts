import { createElement, type ComponentType } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  StyleSheet: { create: <T,>(styles: T) => styles, absoluteFill: {}, absoluteFillObject: {} },
  Text: "Text",
  View: "View",
}));
vi.mock("react-native-gesture-handler", () => {
  const chain: Record<string, unknown> = new Proxy({}, { get: () => () => chain });
  return {
    Gesture: new Proxy({}, { get: () => () => chain }),
    GestureDetector: ({ children }: { children: unknown }) => children,
  };
});
vi.mock("react-native-reanimated", () => ({ runOnJS: (fn: unknown) => fn }));
vi.mock("../../../../modules/scene-dice", () => ({ SceneDiceView: "SceneDiceView" }));
vi.mock("../kit", async () => {
  const { createContext } = await import("react");
  return {
    lightImpact: vi.fn(),
    mediumImpact: vi.fn(),
    ManipulativeScrollContext: createContext(null),
  };
});
vi.mock("../NumberPad", () => ({ NumberPad: "NumberPad" }));
vi.mock("@/theme", () => {
  const shades = new Proxy({}, { get: () => "#888888" });
  return {
    fonts: new Proxy({}, { get: () => "font" }),
    palette: shades,
    useColors: () => shades,
  };
});

import { DiceNative } from "../Dice.native";
import type { DiceSpec } from "../../../../vendor/manipulative/types";

const spec: DiceSpec = {
  kind: "dice",
  id: "prob-d6-atleast-2",
  concept: "Likelihood",
  prompt: "Predict it.",
  diceType: "d6",
  prediction: { type: "probability", event: { type: "atLeast", value: 2 } },
};

function press(renderer: ReactTestRenderer, key: string) {
  const pad = renderer.root.findByType("NumberPad" as unknown as ComponentType);
  act(() => (pad.props as { onKey: (k: string) => void }).onKey(key));
}

describe("DiceNative — what it reports for Done", () => {
  it("reports a state only while a prediction is committed", () => {
    const onStateChange = vi.fn();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        createElement(DiceNative, { spec, onSolvedChange: vi.fn(), onStateChange }),
      );
    });
    for (const k of ["5", "/", "6"]) press(renderer, k);
    // Typing alone commits nothing.
    expect(onStateChange.mock.calls.every(([s]) => s === null)).toBe(true);

    const commit = renderer.root
      .findAll((n) => typeof n.props.onPress === "function" && n.props.label === "Commit fraction")[0];
    act(() => (commit.props as { onPress: () => void }).onPress());
    expect(onStateChange).toHaveBeenLastCalledWith({ rollCount: 0, predicted: { num: 5, den: 6 } });

    // Editing after a commit withdraws it: Done must not submit the stale value.
    press(renderer, "1");
    expect(onStateChange).toHaveBeenLastCalledWith(null);
  });
});
