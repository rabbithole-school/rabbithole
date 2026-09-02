import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

/**
 * The one native tile mark, tested for the property the shared chain exists to
 * guarantee at RUNTIME: a logo that resolves to a fine-looking URL and then
 * fails to load (offline iPad, deleted asset, ATS-blocked host) must continue
 * to the emoji/initial instead of leaving a blank white squircle. And because
 * the failure is keyed on the icon location, pointing the tile at a different
 * image must give that image a fresh chance.
 */

// The real registry `require`s a Metro asset id, which only a bundler can
// produce; the resolver only ever asks whether a path is IN the registry.
vi.mock("../lib/externalAppBundledIcons", () => ({
  BUNDLED_ICONS: { "/external-apps/catalog-app.png": 42 },
}));
vi.mock("@/theme", () => ({
  fonts: { bold: "bold" },
  palette: { white: "#ffffff" },
}));
vi.mock("react-native", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  type Props = { children?: unknown; [key: string]: unknown };
  const host =
    (name: string) =>
    ({ children, ...props }: Props) =>
      react.createElement(name, props as never, children as never);
  return {
    Image: host("image"),
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
    Text: host("text"),
    View: host("view"),
  };
});

import { AppTileMark } from "./AppTileMark";

const CATALOG_APP = {
  name: "Catalog app",
  iconUrl: "https://cdn.example.com/catalog-app.png",
  iconEmoji: "🧮",
  color: null,
  markFontSize: 28,
};

function render(props: Parameters<typeof AppTileMark>[0]) {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(createElement(AppTileMark, props));
  });
  return tree;
}

function tileView(tree: ReturnType<typeof create>) {
  return tree.root.findByType("view" as never);
}

function tileBackground(tree: ReturnType<typeof create>): unknown {
  const style = tileView(tree).props.style as Array<Record<
    string,
    unknown
  > | null>;
  return style.find((s) => s && "backgroundColor" in s)?.backgroundColor;
}

describe("AppTileMark", () => {
  it("draws the logo, then falls to the emoji when it fails to load", () => {
    const tree = render({ ...CATALOG_APP });
    const image = tree.root.findByType("image" as never);
    expect(image.props.source).toEqual({ uri: CATALOG_APP.iconUrl });
    // A real logo is drawn on white; the tint is for the fallback rungs.
    expect(tileBackground(tree)).toBe("#ffffff");

    act(() => {
      image.props.onError();
    });

    expect(tree.root.findAllByType("image" as never)).toHaveLength(0);
    const text = tree.root.findByType("text" as never);
    expect(text.props.children).toBe("🧮");
    expect(tileBackground(tree)).not.toBe("#ffffff");
  });

  it("falls all the way to the initial when there is no emoji", () => {
    const tree = render({ ...CATALOG_APP, iconEmoji: null });
    act(() => {
      tree.root.findByType("image" as never).props.onError();
    });
    expect(tree.root.findByType("text" as never).props.children).toBe("C");
  });

  it("gives a NEW icon a fresh chance after the old one failed", () => {
    const tree = render({ ...CATALOG_APP });
    act(() => {
      tree.root.findByType("image" as never).props.onError();
    });
    expect(tree.root.findAllByType("image" as never)).toHaveLength(0);

    act(() => {
      tree.update(
        createElement(AppTileMark, {
          ...CATALOG_APP,
          iconUrl: "https://cdn.example.com/replacement.png",
        }),
      );
    });

    expect(tree.root.findByType("image" as never).props.source).toEqual({
      uri: "https://cdn.example.com/replacement.png",
    });
  });

  it("announces the app on every rung when it stands on its own", () => {
    const tree = render({ ...CATALOG_APP });
    const labelled = {
      accessible: true,
      accessibilityRole: "image",
      accessibilityLabel: "Catalog app icon",
    };
    expect(tileView(tree).props).toMatchObject(labelled);

    // The emoji and the initial mean the same thing as the logo, so they are
    // announced the same way rather than as an unlabeled image or a stray
    // letter.
    act(() => {
      tree.root.findByType("image" as never).props.onError();
    });
    expect(tileView(tree).props).toMatchObject(labelled);
    expect(tree.root.findByType("text" as never).props.children).toBe("🧮");

    const initial = render({ ...CATALOG_APP, iconUrl: null, iconEmoji: null });
    expect(tileView(initial).props).toMatchObject(labelled);
  });

  it("stays silent when the caller's own element already names the app", () => {
    // Both real call sites wrap it in a labeled element — the launcher's
    // Pressable and the unlock modal's status group — so
    // a label here would compete with theirs, not add to it.
    const tree = render({ ...CATALOG_APP, decorative: true });
    expect(tileView(tree).props).toMatchObject({
      accessibilityElementsHidden: true,
      importantForAccessibility: "no-hide-descendants",
    });
    expect(tileView(tree).props.accessibilityLabel).toBeUndefined();
  });
});
