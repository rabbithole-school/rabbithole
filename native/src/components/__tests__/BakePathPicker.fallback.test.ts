import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Convex client queues an action behind a dead socket and never rejects
// it, so `suggestBakePaths` can simply never answer. The picker must not sit on
// its loading placeholders forever: past its deadline it shows the same
// fallback paths its error path already uses.

const mocks = vi.hoisted(() => ({ suggest: vi.fn() }));

vi.mock("react-native", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  const element =
    (tag: string) =>
    ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
      react.createElement(tag, props as never, children);
  return {
    ActivityIndicator: () => react.createElement("spinner"),
    Pressable: element("button"),
    StyleSheet: { create: <T,>(styles: T) => styles },
    Text: element("text"),
    View: element("view"),
  };
});
vi.mock("convex/react", () => ({ useAction: () => mocks.suggest }));
vi.mock("@/lib/convex", () => ({
  api: { bakePaths: { suggestBakePaths: "bakePaths.suggestBakePaths" } },
}));
vi.mock("@/theme", () => ({ fonts: {}, useColors: () => ({}) }));

import { BakePathPicker } from "../BakePathPicker";

function textOf(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : textOf(child)))
    .join("");
}

describe("BakePathPicker when path suggestions never arrive", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("falls back to the default paths after 15s", async () => {
    mocks.suggest.mockImplementation(() => new Promise<never>(() => {}));
    const onSelect = vi.fn();
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        createElement(BakePathPicker, {
          source: { kind: "topic", topic: "Why is the sky blue?" },
          onSelect,
        }),
      );
    });
    expect(renderer.root.findAllByType("spinner")).toHaveLength(1);
    expect(onSelect).toHaveBeenLastCalledWith(null);
    // While loading, only the loading line + placeholders: the fixed cards
    // arrive together with the suggestions.
    expect(textOf(renderer.root)).not.toContain("Endless chat");
    expect(textOf(renderer.root)).not.toContain("Build a simulation");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(renderer.root.findAllByType("spinner")).toHaveLength(0);
    expect(textOf(renderer.root)).toContain("Get to the bottom of it");
    expect(textOf(renderer.root)).toContain("Endless chat");
    expect(textOf(renderer.root)).toContain("Build a simulation");
    expect(onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Get to the bottom of it" }),
    );
  });
});
