import { createElement, type ReactNode } from "react";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

const { routerPush, selectionAsync } = vi.hoisted(() => ({
  routerPush: vi.fn(),
  selectionAsync: vi.fn(),
}));

vi.mock("react-native", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  const passthrough = ({ children }: { children?: ReactNode }) => children ?? null;
  const Pressable = ({
    children,
    ...props
  }: {
    children?: ReactNode;
    [key: string]: unknown;
  }) => react.createElement("button", props as never, children);

  return {
    Pressable,
    StyleSheet: { create: <T,>(styles: T) => styles },
    Text: passthrough,
    View: passthrough,
  };
});
vi.mock("convex/react", () => ({
  useQuery: () => ({ subtitle: "You explored fractions today." }),
}));
vi.mock("expo-router", () => ({ router: { push: routerPush } }));
vi.mock("expo-haptics", () => ({ selectionAsync }));
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("@/lib/convex", () => ({
  api: { metaChat: { myReflectionSnippet: "metaChat.myReflectionSnippet" } },
}));
vi.mock("@/components/PrepIcons", () => ({
  SunHorizonIcon: () => null,
  ToolboxIcon: () => null,
}));
vi.mock("@/theme", () => ({
  fonts: { bold: "bold", regular: "regular" },
  useColors: () => ({
    bg: "#fff",
    border: "#ddd",
    charcoal: "#222",
    charcoalMuted: "#666",
    danger: "#a40",
    gray50: "#fafafa",
    gray300: "#aaa",
    navy: "#123",
    orange: "#f90",
    orangeMuted: "#fed",
    orangeSubtle: "#fff8ed",
    violetSubtle: "#f8f0ff",
  }),
}));

import {
  PrepActivityCards,
  PrepEntryCard,
} from "./ScholarPrepCards";

describe("Scholar's Prep cards", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders reflection and The Workshop as separate choices", () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(createElement(PrepActivityCards));
    });
    const buttons = renderer.root.findAllByType("button");

    expect(buttons.map((button) => button.props.accessibilityLabel)).toEqual([
      "Today's reflection",
      "The Workshop",
    ]);
  });

  it("opens reflection from its own card", () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(createElement(PrepActivityCards));
    });
    const reflection = renderer.root.findByProps({
      accessibilityLabel: "Today's reflection",
    });

    act(() => reflection.props.onPress());

    expect(selectionAsync).toHaveBeenCalledTimes(1);
    expect(routerPush).toHaveBeenCalledWith("/reflection");
  });

  it("opens the Prep tab from the sunset doorway", () => {
    const onOpen = vi.fn();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(createElement(PrepEntryCard, { onOpen }));
    });
    const entry = renderer.root.findByProps({
      accessibilityLabel: "Open Scholar’s Prep",
    });

    act(() => entry.props.onPress());

    expect(selectionAsync).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
