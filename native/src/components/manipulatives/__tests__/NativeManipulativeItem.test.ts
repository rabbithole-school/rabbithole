import { createElement, type ReactNode } from "react";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

const { items, NativeManipulative, Pressable, passthrough } = vi.hoisted(() => {
  const nativeManipulative = ({ spec }: { spec: { prompt: string } }) => {
    if (spec.prompt === "crash") throw new Error("renderer crash");
    return createElement("renderer", { item: spec.prompt });
  };
  const pressable = ({ children, ...props }: { children?: ReactNode }) =>
    createElement("pressable", props, children);
  return {
    items: new Map<string, { manipulativeSpec: string; stem: string; hint: string }>(),
    NativeManipulative: nativeManipulative,
    Pressable: pressable,
    passthrough: ({ children }: { children?: unknown }) => children ?? null,
  };
});

vi.mock("react-native", () => ({
  ActivityIndicator: passthrough,
  Modal: passthrough,
  Pressable,
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: passthrough,
  View: passthrough,
}));
vi.mock("react-native-gesture-handler", () => ({ ScrollView: passthrough }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0 }),
}));
vi.mock("expo-symbols", () => ({ SymbolView: passthrough }));
vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useQuery: (_query: unknown, { itemId }: { itemId: string }) => items.get(itemId),
}));
vi.mock("@/lib/convex", () => ({
  api: { practiceSkills: { getManipulativeItem: "get", submitAnswer: "submit" } },
}));
vi.mock("@/theme", () => ({
  fonts: { bold: "bold", regular: "regular", semibold: "semibold" },
  useColors: () => ({
    bg: "#fff",
    bgSubtle: "#f8f8f8",
    border: "#ddd",
    charcoalSubtle: "#666",
    cyan: "#0cc",
    cyanMuted: "#099",
    cyanSubtle: "#eff",
    fgMuted: "#666",
    gray50: "#eee",
    navy: "#111",
    orangeSubtle: "#fee",
    statusGreen: "#080",
    statusRed: "#c00",
    violet: "#808",
    violetMuted: "#606",
    violetSubtle: "#fef",
  }),
}));
vi.mock("@/components/practice/PracticeVerdictStamp", () => ({
  PracticeVerdictStamp: () => null,
}));
vi.mock("@/components/practice/NativePracticeControls", () => ({
  PracticePrimaryAction: () => null,
  useGuardedPracticeAction: (action: () => void) => action,
}));
vi.mock("@/lib/practiceShell", () => ({ makePracticeShellStyles: () => ({}) }));
vi.mock("@/lib/webEmbedConfig", () => ({
  allowedHostsForUrl: () => [],
  manipulativeEmbedUrl: () => "https://example.com/embed",
}));
vi.mock("@/lib/externalAppHost", () => ({ openManipulativeEmbed: vi.fn() }));
vi.mock("../kit", async () => {
  const { createContext } = await vi.importActual<typeof import("react")>("react");
  return {
    ManipulativeScrollContext: createContext(null),
    successNotify: vi.fn(),
    warningNotify: vi.fn(),
  };
});
vi.mock("../NativeManipulative", () => ({
  isNativeManipulativeKind: () => true,
  NativeManipulative,
}));

import { NativeManipulativeHost } from "../NativeManipulativeHost";
import {
  closeNativeManipulativeItem,
  openNativeManipulativeItem,
} from "@/lib/nativeManipulativeHost";

const scholarId = "scholar" as never;

function item(prompt: string) {
  return {
    manipulativeSpec: JSON.stringify({ kind: "partition", concept: "Fractions", prompt }),
    stem: prompt,
    hint: "Try it.",
  };
}

function open(itemId: string, requestScholarId = scholarId) {
  act(() => {
    openNativeManipulativeItem({ itemId, scholarId: requestScholarId });
  });
}

describe("NativeManipulativeItem", () => {
  afterEach(() => {
    act(() => closeNativeManipulativeItem());
    items.clear();
    vi.restoreAllMocks();
  });

  it("preserves item-local state for the same item and resets it for a new item", () => {
    items.set("one", item("first"));
    items.set("two", item("second"));

    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(createElement(NativeManipulativeHost));
    });
    open("one");

    act(() => {
      renderer.root
        .findAllByType(Pressable)
        .find((button) => button.props.accessibilityLabel !== "Close")!
        .props.onPress();
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("Hide hint");

    open("one");
    expect(JSON.stringify(renderer.toJSON())).toContain("Hide hint");

    open("two");
    expect(JSON.stringify(renderer.toJSON())).toContain("Stuck? Hint");
    act(() => renderer.unmount());
  });

  it("resets item-local state when the same item is opened for another scholar", () => {
    items.set("one", item("first"));

    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(createElement(NativeManipulativeHost));
    });
    open("one");

    act(() => {
      renderer.root
        .findAllByType(Pressable)
        .find((button) => button.props.accessibilityLabel !== "Close")!
        .props.onPress();
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("Hide hint");

    open("one", "another-scholar" as never);
    expect(JSON.stringify(renderer.toJSON())).toContain("Stuck? Hint");
    act(() => renderer.unmount());
  });

  it("remounts a crashed renderer boundary when the requested item changes", () => {
    items.set("broken", item("crash"));
    items.set("healthy", item("works"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(createElement(NativeManipulativeHost));
    });
    open("broken");
    expect(renderer.root.findAllByType(NativeManipulative)).toHaveLength(0);

    open("healthy");
    expect(renderer.root.findAllByType(NativeManipulative)).toHaveLength(1);

    act(() => renderer.unmount());
  });
});
