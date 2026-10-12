import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

/**
 * ArtifactChipStrip is the native document switcher (TRA-274). These assert the
 * semantics the design fixes: one `tab` per artifact, the active chip reports
 * `selected`, tapping an idle chip switches (with a haptic) while tapping the
 * active one is a no-op, and each chip carries the icon for its type.
 */

const { selectionAsync } = vi.hoisted(() => ({ selectionAsync: vi.fn() }));
vi.mock("expo-haptics", () => ({ selectionAsync }));

vi.mock("expo-symbols", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  return {
    SymbolView: ({ name }: { name: string }) =>
      react.createElement("symbol", { name }),
  };
});

vi.mock("@/theme", () => ({
  fonts: { semibold: "semibold" },
  useColors: () => ({
    violetSolid: "#9148a3",
    white: "#ffffff",
    charcoal: "#222656",
    charcoalMuted: "#6b7280",
    bg: "#ffffff",
    border: "#e5e7eb",
  }),
}));

vi.mock("react-native", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  type Props = { children?: unknown; [key: string]: unknown };
  const host =
    (name: string) =>
    ({ children, ...props }: Props) =>
      react.createElement(name, props as never, children as never);
  return {
    Pressable: host("pressable"),
    ScrollView: host("scrollview"),
    Text: host("text"),
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  };
});

import { ArtifactChipStrip } from "./ArtifactChipStrip";

type Artifact = Parameters<typeof ArtifactChipStrip>[0]["artifacts"][number];

function makeArtifacts(): Artifact[] {
  return [
    { _id: "memoir", title: "Birthday candles", type: "text" },
    { _id: "counter", title: "Counter", type: "code" },
  ] as unknown as Artifact[];
}

function render(props: Parameters<typeof ArtifactChipStrip>[0]) {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(createElement(ArtifactChipStrip, props));
  });
  return tree;
}

function tabs(tree: ReturnType<typeof create>) {
  return tree.root.findAll(
    (node) =>
      typeof node.type === "string" &&
      node.props.accessibilityRole === "tab",
  );
}

describe("ArtifactChipStrip", () => {
  it("renders one tab per artifact with the active one selected", () => {
    const tree = render({
      artifacts: makeArtifacts(),
      activeArtifactId: "counter" as never,
      onSelect: vi.fn(),
    });
    const chips = tabs(tree);
    expect(chips).toHaveLength(2);
    expect(chips.map((c) => c.props.accessibilityLabel)).toEqual([
      "Birthday candles",
      "Counter",
    ]);
    expect(chips.map((c) => c.props.accessibilityState.selected)).toEqual([
      false,
      true,
    ]);
  });

  it("switches to an idle chip on tap, with a haptic", () => {
    const onSelect = vi.fn();
    selectionAsync.mockClear();
    const tree = render({
      artifacts: makeArtifacts(),
      activeArtifactId: "counter" as never,
      onSelect,
    });
    const memoirChip = tabs(tree).find(
      (c) => c.props.accessibilityLabel === "Birthday candles",
    )!;
    act(() => memoirChip.props.onPress());
    expect(onSelect).toHaveBeenCalledWith("memoir");
    expect(selectionAsync).toHaveBeenCalledOnce();
  });

  it("does nothing when the active chip is tapped", () => {
    const onSelect = vi.fn();
    selectionAsync.mockClear();
    const tree = render({
      artifacts: makeArtifacts(),
      activeArtifactId: "counter" as never,
      onSelect,
    });
    const counterChip = tabs(tree).find(
      (c) => c.props.accessibilityLabel === "Counter",
    )!;
    act(() => counterChip.props.onPress());
    expect(onSelect).not.toHaveBeenCalled();
    expect(selectionAsync).not.toHaveBeenCalled();
  });

  it("uses the code glyph for code artifacts and a doc glyph otherwise", () => {
    const tree = render({
      artifacts: makeArtifacts(),
      activeArtifactId: "memoir" as never,
      onSelect: vi.fn(),
    });
    const icons = tabs(tree).map(
      (c) => c.findByType("symbol" as never).props.name,
    );
    expect(icons).toEqual([
      "doc.text",
      "chevron.left.forwardslash.chevron.right",
    ]);
  });
});
