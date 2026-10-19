import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

// When the scholar's words already describe a specific thing to make, the
// server says `specificBuild: true` and the picker hands off to its caller
// instead of revealing the menu — fresh or from the cache.

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

const PATHS = [
  { emoji: "🐕", title: "Make the dog spin", blurb: "Spin it." },
];

async function render(
  topic: string,
  props: { onSpecificBuild?: () => void } = {},
) {
  const onSelect = vi.fn();
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      createElement(BakePathPicker, {
        source: { kind: "topic", topic },
        onSelect,
        ...props,
      }),
    );
  });
  return { renderer, onSelect };
}

describe("BakePathPicker specific-build hand-off", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("hands off instead of revealing the menu, fresh and cached", async () => {
    mocks.suggest.mockResolvedValue({ paths: PATHS, specificBuild: true });
    const onSpecificBuild = vi.fn();
    const first = await render("A game called Canine rotation", {
      onSpecificBuild,
    });
    expect(onSpecificBuild).toHaveBeenCalledTimes(1);
    expect(first.renderer.root.findAllByType("spinner")).toHaveLength(1);
    expect(textOf(first.renderer.root)).not.toContain("Make the dog spin");
    expect(textOf(first.renderer.root)).not.toContain("Endless chat");
    expect(first.onSelect).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "Make the dog spin" }),
    );

    const again = await render("A game called Canine rotation", {
      onSpecificBuild,
    });
    expect(mocks.suggest).toHaveBeenCalledTimes(1);
    expect(onSpecificBuild).toHaveBeenCalledTimes(2);
    expect(again.renderer.root.findAllByType("spinner")).toHaveLength(1);
  });

  it("reveals the menu when the caller takes no hand-off", async () => {
    mocks.suggest.mockResolvedValue({ paths: PATHS, specificBuild: true });
    const { renderer } = await render("A game called Puppy parade");
    expect(renderer.root.findAllByType("spinner")).toHaveLength(0);
    expect(textOf(renderer.root)).toContain("Make the dog spin");
  });

  it("reveals the menu when the words are not a specific build", async () => {
    mocks.suggest.mockResolvedValue({ paths: PATHS, specificBuild: false });
    const onSpecificBuild = vi.fn();
    const { renderer } = await render("Why do dogs spin?", { onSpecificBuild });
    expect(onSpecificBuild).not.toHaveBeenCalled();
    expect(textOf(renderer.root)).toContain("Make the dog spin");
  });
});
