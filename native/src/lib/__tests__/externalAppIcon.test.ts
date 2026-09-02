import { describe, expect, test, vi } from "vitest";

// The real registry `require`s a Metro asset id, which only a bundler can
// produce; the resolver only ever asks whether a path is IN the registry.
vi.mock("../externalAppBundledIcons", () => ({
  BUNDLED_ICONS: { "/external-apps/catalog-app.png": 42 },
}));

import { resolveNativeAppTileMark } from "../externalAppIcon";

// The native adapter must stay a NARROWING of the shared chain, never a second
// one: same precedence (image → emoji → initial), with "image" restricted to
// what this app can actually load. A web-relative icon has no origin here, so
// it must continue down the shared chain instead of rendering broken.
describe("resolveNativeAppTileMark", () => {
  test("a bundled web-relative icon resolves to the bundled asset", () => {
    expect(
      resolveNativeAppTileMark({
        iconUrl: "/external-apps/catalog-app.png",
        emoji: "🧮",
        name: "Catalog app",
      }),
    ).toEqual({ kind: "image", source: 42 });
  });

  test("an absolute http(s) icon becomes a remote uri source", () => {
    expect(
      resolveNativeAppTileMark({
        iconUrl: "https://example.com/logo.png",
        name: "Epic",
      }),
    ).toEqual({ kind: "image", source: { uri: "https://example.com/logo.png" } });
  });

  test("an UNBUNDLED web-relative icon falls to the emoji, not a broken image", () => {
    expect(
      resolveNativeAppTileMark({
        iconUrl: "/external-apps/not-bundled.png",
        emoji: "⌨️",
        name: "TypeRacer",
      }),
    ).toEqual({ kind: "emoji", glyph: "⌨️" });
  });

  test("an unbundled web-relative icon with no emoji falls to the initial", () => {
    expect(
      resolveNativeAppTileMark({
        iconUrl: "/external-apps/not-bundled.png",
        name: "GeoQuiz",
      }),
    ).toEqual({ kind: "text", text: "G" });
  });

  test("no icon at all resolves exactly as web does", () => {
    expect(resolveNativeAppTileMark({ emoji: "📚", name: "Epic" })).toEqual({
      kind: "emoji",
      glyph: "📚",
    });
    expect(resolveNativeAppTileMark({ name: "2048" })).toEqual({
      kind: "text",
      text: "2",
    });
  });

  test("a root-relative path outside the bundled-icon namespace is not an image", () => {
    expect(
      resolveNativeAppTileMark({
        iconUrl: "/teacher/apps",
        emoji: "🧭",
        name: "World Flags",
      }),
    ).toEqual({ kind: "emoji", glyph: "🧭" });
  });

  // The bundled registry is keyed by exact web path, so a value that only LOOKS
  // like it is in the namespace must not reach the lookup at all — and a value
  // that genuinely is must survive canonicalization unchanged, or the tile
  // would lose its real logo on iPad.
  test.each([
    "/external-apps/%2e%2e/teacher/apps",
    "/external-apps/.%2e/catalog-app.png",
    "/external-apps/..\\catalog-app.png",
    "/external-apps/..%5Ccatalog-app.png",
    "/external-apps/%252e%252e/catalog-app.png",
    "//evil.example.com/catalog-app.png",
    "/\\evil.example.com/catalog-app.png",
  ])("a traversal-shaped %s never reaches the bundled registry", (iconUrl) => {
    expect(
      resolveNativeAppTileMark({ iconUrl, emoji: "🧭", name: "Catalog app" }),
    ).toEqual({ kind: "emoji", glyph: "🧭" });
  });

  test("a canonical spelling of a bundled path still finds the asset", () => {
    expect(
      resolveNativeAppTileMark({
        iconUrl: "  /external-apps/./catalog-app.png  ",
        emoji: "🧮",
        name: "Catalog app",
      }),
    ).toEqual({ kind: "image", source: 42 });
  });

  // The shared resolver keeps a bundled path's ?query/#hash — it is part of the
  // URL the web fetches, and it is what keys the runtime-failure comparison.
  // The bundle holds one asset per PATH, so a cache-buster must not read as a
  // registry miss and silently cost the iPad a logo the web still shows.
  test.each([
    "/external-apps/catalog-app.png?v=2",
    "/external-apps/catalog-app.png#x",
    "/external-apps/catalog-app.png?v=2#x",
    "  /external-apps/./catalog-app.png?v=2#x  ",
  ])("a bundled icon with a query/hash (%s) still finds the asset", (iconUrl) => {
    expect(
      resolveNativeAppTileMark({ iconUrl, emoji: "🧮", name: "Catalog app" }),
    ).toEqual({ kind: "image", source: 42 });
  });

  test("a query/hash does not smuggle an UNBUNDLED path into the registry", () => {
    expect(
      resolveNativeAppTileMark({
        iconUrl: "/external-apps/not-bundled.png?v=2#x",
        emoji: "⌨️",
        name: "TypeRacer",
      }),
    ).toEqual({ kind: "emoji", glyph: "⌨️" });
  });

  test("a remote uri keeps its query and hash verbatim", () => {
    expect(
      resolveNativeAppTileMark({
        iconUrl: "https://example.com/logo.png?v=2#x",
        name: "Epic",
      }),
    ).toEqual({
      kind: "image",
      source: { uri: "https://example.com/logo.png?v=2#x" },
    });
  });

  // Identity stays keyed on the FULL normalized src, so trimming the query for
  // the registry lookup must not leak into the runtime-failure comparison.
  test("a failed bundled icon with a query falls past the image rung", () => {
    expect(
      resolveNativeAppTileMark({
        iconUrl: "/external-apps/catalog-app.png?v=2",
        name: "Catalog app",
        unusableImageSrc: "/external-apps/catalog-app.png?v=2",
      }),
    ).toEqual({ kind: "text", text: "C" });
  });

  test("a failure at an OLD query gets a fresh chance at the new one", () => {
    expect(
      resolveNativeAppTileMark({
        iconUrl: "/external-apps/catalog-app.png?v=2",
        emoji: "🧮",
        name: "Catalog app",
        unusableImageSrc: "/external-apps/catalog-app.png?v=1",
      }),
    ).toEqual({ kind: "image", source: 42 });
  });

  test("a non-image scheme never reaches the platform", () => {
    expect(
      resolveNativeAppTileMark({
        iconUrl: "javascript:alert(1)",
        emoji: "🧭",
        name: "World Flags",
      }),
    ).toEqual({ kind: "emoji", glyph: "🧭" });
  });

  // The runtime rung: an iPad that is offline, or a host that ATS blocks,
  // resolves a fine-looking uri that never produces pixels. The renderer
  // reports it back and the chain continues, so the tile is never blank.
  test("a remote icon that failed to load falls to the emoji", () => {
    expect(
      resolveNativeAppTileMark({
        iconUrl: "https://example.com/logo.png",
        emoji: "⌨️",
        name: "TypeRacer",
        unusableImageSrc: "https://example.com/logo.png",
      }),
    ).toEqual({ kind: "emoji", glyph: "⌨️" });
  });

  test("a failed BUNDLED icon still falls to the initial", () => {
    expect(
      resolveNativeAppTileMark({
        iconUrl: "/external-apps/catalog-app.png",
        name: "Catalog app",
        unusableImageSrc: "/external-apps/catalog-app.png",
      }),
    ).toEqual({ kind: "text", text: "C" });
  });

  test("a failure recorded for another icon does not suppress this one", () => {
    expect(
      resolveNativeAppTileMark({
        iconUrl: "https://example.com/logo.png",
        emoji: "⌨️",
        name: "TypeRacer",
        unusableImageSrc: "https://example.com/previous.png",
      }),
    ).toEqual({
      kind: "image",
      source: { uri: "https://example.com/logo.png" },
    });
  });
});
