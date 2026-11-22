import { createElement, type ComponentType } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: "Text",
  View: "View",
  useWindowDimensions: () => ({ width: 820, height: 1180 }),
}));

vi.mock("react-native-svg", () => ({
  __esModule: true,
  default: "Svg",
  Circle: "Circle",
  Path: "Path",
  Rect: "Rect",
  Text: "SvgText",
}));

vi.mock("../kit", () => ({ selectionTick: vi.fn() }));

vi.mock("@/theme", () => {
  const shades = new Proxy({}, { get: () => "#888888" });
  return {
    fonts: { bold: "bold", medium: "medium", regular: "regular", semibold: "semibold" },
    palette: new Proxy({ white: "#ffffff" }, {
      get: (target, key) => (key in target ? target[key as "white"] : shades),
    }),
    useColors: () => ({
      bg: "#fff",
      border: "#ddd",
      charcoalSubtle: "#666",
      fg: "#222",
      gray50: "#eee",
      gray200: "#ccc",
      navy: "#111",
      violet: "#7048e8",
      violetSubtle: "#f3eefe",
    }),
  };
});

import type { FunctionMachineSpec } from "../../../../vendor/manipulative/types";
import { FunctionMachineNative } from "../FunctionMachine.native";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const CHALLENGE: FunctionMachineSpec = {
  kind: "functionMachine",
  id: "fm-two-step",
  concept: "Two steps",
  prompt: "This one does two things. Send 5 through.",
  rule: { op: "affine", m: 3, b: 1 },
  examples: [
    { in: 1, out: 4 },
    { in: 2, out: 7 },
  ],
  queryInput: 5,
  answer: { value: 16, prompt: "What comes out when 5 goes in?" },
};

const EXPLORE: FunctionMachineSpec = {
  ...CHALLENGE,
  id: "fm-explore",
  answer: undefined,
};

function mount(spec: FunctionMachineSpec) {
  const onStateChange = vi.fn((_state: unknown) => {});
  const onSolvedChange = vi.fn((_solved: boolean) => {});
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(createElement(FunctionMachineNative, { spec, onStateChange, onSolvedChange }));
  });
  const press = (label: string) =>
    act(() => {
      renderer.root.findByProps({ accessibilityLabel: label }).props.onPress();
    });
  return { renderer, onStateChange, onSolvedChange, press };
}

function visibleText(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAllByType("Text" as unknown as ComponentType)
    .flatMap((node) => node.children)
    .filter((child): child is string => typeof child === "string")
    .join(" ");
}

describe("native function machine number boxes", () => {
  it("runs a typed test input without reporting it as the prediction", () => {
    const { renderer, onStateChange, press } = mount(CHALLENGE);
    press("key 2");
    press("Run");
    expect(visibleText(renderer)).toContain("2 → 7");
    expect(onStateChange).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it("runs a negative test input typed with the ± key", () => {
    const { renderer, press } = mount(CHALLENGE);
    press("key toggle negative sign");
    press("key 3");
    press("Run");
    expect(visibleText(renderer)).toContain("−3 → −8");
    act(() => renderer.unmount());
  });

  it("reports the typed prediction, and null again once the box is cleared", () => {
    const { renderer, onStateChange, onSolvedChange, press } = mount(CHALLENGE);
    press("Your prediction");
    press("key 1");
    press("key 6");
    expect(onStateChange).toHaveBeenLastCalledWith({ predicted: 16 });
    expect(onSolvedChange).toHaveBeenLastCalledWith(true);

    press("key backspace");
    expect(onStateChange).toHaveBeenLastCalledWith({ predicted: 1 });
    expect(onSolvedChange).toHaveBeenLastCalledWith(false);

    press("key backspace");
    expect(onStateChange).toHaveBeenLastCalledWith(null);
    act(() => renderer.unmount());
  });

  it("keeps the test box and the prediction box separate", () => {
    const { renderer, onStateChange, press } = mount(CHALLENGE);
    press("key 4");
    press("Your prediction");
    press("key 9");
    press("Test input");
    press("key 1");
    press("Run");
    expect(visibleText(renderer)).toContain("41 → 124");
    expect(onStateChange).toHaveBeenLastCalledWith({ predicted: 9 });
    act(() => renderer.unmount());
  });

  it("shows no prediction box on an explore machine", () => {
    const { renderer } = mount(EXPLORE);
    expect(renderer.root.findAllByProps({ accessibilityLabel: "Your prediction" })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ accessibilityLabel: "Test input" })).toHaveLength(1);
    act(() => renderer.unmount());
  });
});
