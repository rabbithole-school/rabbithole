import { describe, expect, test } from "vitest";

import { palette } from "./brand";
import {
  APP_TILE_TINTS,
  appTileFallbackMark,
  appTileImageSrc,
  appTileTint,
  normalizeAppTileEmoji,
  resolveAppTileMark,
} from "./appTileMark";

// The point of this module: the tile's fallback chain is defined ONCE, so
// "emoji is only ever a fallback for a real logo" holds at every render site —
// the scholar launcher, the four staff previews, and the native iPad launcher.
describe("resolveAppTileMark — the fallback chain", () => {
  test("an image url wins over both emoji and name", () => {
    expect(
      resolveAppTileMark({
        iconUrl: "https://example.com/logo.png",
        emoji: "🧮",
        name: "Catalog app",
      }),
    ).toEqual({ kind: "image", src: "https://example.com/logo.png" });
  });

  test("an app's own bundled asset path counts as an image", () => {
    expect(
      resolveAppTileMark({ iconUrl: "/external-apps/catalog-app.png" }),
    ).toEqual({ kind: "image", src: "/external-apps/catalog-app.png" });
  });

  // Root-relative is not "any path on our origin": only the bundled-icon
  // namespace holds images. Every other app route renders an HTML page, so a
  // tile pointed at one would draw nothing at all.
  test.each([
    "/teacher/apps",
    "/",
    "/favicon.ico",
    "/external-appsphoney.png",
    "/external-apps/../teacher/apps",
  ])("rejects the root-relative %s", (path) => {
    expect(resolveAppTileMark({ iconUrl: path, emoji: "🔒" })).toEqual({
      kind: "emoji",
      glyph: "🔒",
    });
  });

  // A literal prefix comparison sees the raw string; the browser and the
  // native fetch layer see the URL the spec says it is. Every value here reads
  // as "inside /external-apps/" to the former and requests something else from
  // the latter, so the candidate is canonicalized against a fixed same-origin
  // base BEFORE the namespace is checked.
  test.each([
    // Dot segments the URL spec recognizes in their encoded spellings.
    "/external-apps/%2e%2e/teacher/apps",
    "/external-apps/%2E%2E/teacher/apps",
    "/external-apps/.%2e/teacher/apps",
    "/external-apps/%2e./teacher/apps",
    // Backslash is a path separator for a special scheme.
    "/external-apps/..\\teacher/apps",
    // Encoded ones the parser deliberately leaves alone — a percent escape is
    // not part of any icon we ship, so the whole class is refused rather than
    // guessed at on behalf of whatever decodes it next.
    "/external-apps/..%5Cteacher/apps",
    "/external-apps/%252e%252e/teacher/apps",
    // An authority, not a path: both of these resolve off our origin entirely.
    "//evil.example.com/logo.png",
    "/\\evil.example.com/logo.png",
    // The namespace itself is a directory, not an image.
    "/external-apps/",
    "/external-apps//logo.png",
  ])("rejects the traversal/escape attempt %s", (path) => {
    expect(resolveAppTileMark({ iconUrl: path, emoji: "🔒" })).toEqual({
      kind: "emoji",
      glyph: "🔒",
    });
  });

  test("a real bundled path survives canonicalization byte for byte", () => {
    // The native adapter looks the src up in its bundled-asset registry by
    // exact key, so normalization must not rewrite a legitimate path.
    expect(appTileImageSrc("/external-apps/catalog-app.png")).toBe(
      "/external-apps/catalog-app.png",
    );
    expect(appTileImageSrc("/external-apps/logos/catalog-app.png")).toBe(
      "/external-apps/logos/catalog-app.png",
    );
    expect(appTileImageSrc("/external-apps/./catalog-app.png")).toBe(
      "/external-apps/catalog-app.png",
    );
  });

  test("a query or hash on a bundled path is kept", () => {
    expect(appTileImageSrc("/external-apps/logo.png?v=2#top")).toBe(
      "/external-apps/logo.png?v=2#top",
    );
  });

  test("a remote url is left exactly as entered", () => {
    expect(appTileImageSrc("https://example.com/a%2e%2eb/logo.png?v=2")).toBe(
      "https://example.com/a%2e%2eb/logo.png?v=2",
    );
    expect(appTileImageSrc("http://example.com/logo.png")).toBe(
      "http://example.com/logo.png",
    );
  });

  test("falls back to the emoji when there is no image", () => {
    expect(
      resolveAppTileMark({ iconUrl: null, emoji: "⌨️", name: "TypeRacer" }),
    ).toEqual({ kind: "emoji", glyph: "⌨️" });
  });

  test("a blank/whitespace icon url is treated as absent", () => {
    expect(resolveAppTileMark({ iconUrl: "   ", emoji: "📚", name: "Epic" })).toEqual(
      { kind: "emoji", glyph: "📚" },
    );
  });

  test("falls back to the name's initial when neither is set", () => {
    expect(resolveAppTileMark({ name: "geoquiz" })).toEqual({
      kind: "text",
      text: "G",
    });
  });

  test("a blank emoji is skipped in favor of the initial", () => {
    expect(resolveAppTileMark({ emoji: "  ", name: "2048" })).toEqual({
      kind: "text",
      text: "2",
    });
  });

  test("last resort is '?' when even the name is empty", () => {
    expect(resolveAppTileMark({})).toEqual({ kind: "text", text: "?" });
    expect(
      resolveAppTileMark({ iconUrl: "", emoji: "", name: "   " }),
    ).toEqual({ kind: "text", text: "?" });
  });

  test("the initial is grapheme safe (astral first character)", () => {
    expect(resolveAppTileMark({ name: "𝓖eoQuiz" }).kind).toBe("text");
    expect(resolveAppTileMark({ name: "🌋 Volcano Lab" })).toEqual({
      kind: "text",
      text: "🌋",
    });
  });

  test("a multi-emoji glyph is reduced to one grapheme", () => {
    expect(resolveAppTileMark({ emoji: "📚📕📗", name: "Epic" })).toEqual({
      kind: "emoji",
      glyph: "📚",
    });
  });

  test("a ZWJ-sequence emoji survives as one glyph", () => {
    expect(resolveAppTileMark({ emoji: "👩‍🚀", name: "Space" })).toEqual({
      kind: "emoji",
      glyph: "👩‍🚀",
    });
  });

  // The icon url is staff-entered free text that ends up in an <img> on a
  // child-facing surface, so anything that isn't plainly an image location
  // falls through to the next rung instead of reaching the platform.
  test.each([
    "javascript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "//evil.example.com/logo.png",
    "not a url",
  ])("rejects %s as an image source", (bad) => {
    expect(resolveAppTileMark({ iconUrl: bad, emoji: "🔒" })).toEqual({
      kind: "emoji",
      glyph: "🔒",
    });
  });
});

// A URL can be perfectly well-formed and still never produce pixels — the host
// is down, the asset was deleted, the iPad is offline, ATS blocked it. The
// renderer reports that back, and the SAME chain continues; otherwise the tile
// stops on a rung that draws nothing and the scholar gets a blank square.
describe("resolveAppTileMark — an image that failed to load", () => {
  test("a failed image falls through to the emoji", () => {
    expect(
      resolveAppTileMark({
        iconUrl: "https://example.com/logo.png",
        emoji: "🧮",
        name: "Catalog app",
        unusableImageSrc: "https://example.com/logo.png",
      }),
    ).toEqual({ kind: "emoji", glyph: "🧮" });
  });

  test("with no emoji it falls all the way to the initial", () => {
    expect(
      resolveAppTileMark({
        iconUrl: "https://example.com/logo.png",
        name: "GeoQuiz",
        unusableImageSrc: "https://example.com/logo.png",
      }),
    ).toEqual({ kind: "text", text: "G" });
  });

  test("a bundled asset path can fail too", () => {
    expect(
      resolveAppTileMark({
        iconUrl: "/external-apps/catalog-app.png",
        emoji: "🧮",
        unusableImageSrc: "/external-apps/catalog-app.png",
      }),
    ).toEqual({ kind: "emoji", glyph: "🧮" });
  });

  // The failure is keyed on the SRC, which is what makes it self-resetting: a
  // tile pointed at a new image (or a component reused for the next app) is a
  // different src, so the stale failure stops applying with nothing to clear.
  test("a failure for a DIFFERENT src does not suppress this image", () => {
    expect(
      resolveAppTileMark({
        iconUrl: "https://example.com/new.png",
        emoji: "🧮",
        name: "Catalog app",
        unusableImageSrc: "https://example.com/old.png",
      }),
    ).toEqual({ kind: "image", src: "https://example.com/new.png" });
  });

  test("both sides are normalized, so a padded report still matches", () => {
    expect(
      resolveAppTileMark({
        iconUrl: "  https://example.com/logo.png  ",
        emoji: "🧮",
        unusableImageSrc: "https://example.com/logo.png",
      }),
    ).toEqual({ kind: "emoji", glyph: "🧮" });
  });

  // Canonicalization runs on both sides, so a surface may report back either
  // the raw catalog value or the resolved src and the failure still lands on
  // the same tile.
  test("a differently spelled report of the same bundled path still matches", () => {
    expect(
      resolveAppTileMark({
        iconUrl: "/external-apps/./catalog-app.png",
        emoji: "🧮",
        unusableImageSrc: "/external-apps/catalog-app.png",
      }),
    ).toEqual({ kind: "emoji", glyph: "🧮" });
  });

  test("no reported failure leaves the image rung untouched", () => {
    expect(
      resolveAppTileMark({
        iconUrl: "https://example.com/logo.png",
        emoji: "🧮",
        unusableImageSrc: null,
      }),
    ).toEqual({ kind: "image", src: "https://example.com/logo.png" });
  });
});

// The rungs below an image, exported so the native adapter can continue the
// SAME chain when a resolved image turns out not to be loadable on iPad.
// Without this, native would need its own copy of the fallback order.
describe("appTileFallbackMark — the rungs below an image", () => {
  test("ignores the icon url entirely", () => {
    expect(
      appTileFallbackMark({
        iconUrl: "https://example.com/logo.png",
        emoji: "🧮",
        name: "Catalog app",
      }),
    ).toEqual({ kind: "emoji", glyph: "🧮" });
  });

  test("is exactly what resolveAppTileMark returns once the image is gone", () => {
    for (const input of [
      { emoji: "⌨️", name: "TypeRacer" },
      { name: "GeoQuiz" },
      {},
    ]) {
      expect(appTileFallbackMark(input)).toEqual(resolveAppTileMark(input));
    }
  });
});

describe("appTileTint", () => {
  test("an explicit catalog color always wins", () => {
    expect(appTileTint({ color: "#1f7fd0", name: "Catalog app" })).toBe(
      "#1f7fd0",
    );
  });

  test("a blank color falls through to the name-derived hue", () => {
    expect(appTileTint({ color: "   ", name: "Epic" })).toBe(
      appTileTint({ name: "Epic" }),
    );
  });

  test("the same name always gets the same hue", () => {
    expect(appTileTint({ name: "TypeRacer" })).toBe(
      appTileTint({ name: "TypeRacer" }),
    );
    expect(appTileTint({ name: "TypeRacer" })).toBe(
      appTileTint({ name: "  typeracer  " }),
    );
  });

  test("every hue comes from the shared brand palette", () => {
    const brand = new Set(
      Object.values(palette)
        .filter((scale) => typeof scale === "object")
        .flatMap((scale) => Object.values(scale as Record<string, string>)),
    );
    for (const tint of APP_TILE_TINTS) expect(brand.has(tint)).toBe(true);
  });

  // The mark drawn on the tile is white, so the tint is what makes it legible.
  test("every tint clears 4.5:1 against white", () => {
    const channel = (c: number) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (hex: string) =>
      0.2126 * channel(parseInt(hex.slice(1, 3), 16)) +
      0.7152 * channel(parseInt(hex.slice(3, 5), 16)) +
      0.0722 * channel(parseInt(hex.slice(5, 7), 16));
    for (const tint of APP_TILE_TINTS) {
      expect(1.05 / (luminance(tint) + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
  });

  // The behaviour this replaces: every un-colored app rendered the same violet.
  // Names mirror the shape of the live catalog (all staff-authored, public app
  // names — no person, no record).
  const CATALOG_NAMES = [
    "2048",
    "Aquarium Lab Book",
    "Epic",
    "GeoQuiz",
    "Google Sheets",
    "Catalog app",
    "Place Value Builder",
    "Place Value Mat: 3-Digit Regrouping",
    "PressReader",
    "TypeRacer",
    "World Flags",
  ];

  test("a catalog-shaped name set spreads across more than one hue", () => {
    const hues = new Set(CATALOG_NAMES.map((name) => appTileTint({ name })));
    expect(hues.size).toBeGreaterThan(3);
  });

  // The palette is bounded, so the derived hue is a stable identity CUE, not a
  // uniqueness guarantee: two names can land on the same hue. The catalog has a
  // real pair that does — same initial, same derived hue, no color — and what
  // separates them is the staff input this adds, which is the deterministic
  // rung. The test pins both halves so neither claim drifts.
  test("a hue collision is possible, and the staff mark is what resolves it", () => {
    const a = "Place Value Builder";
    const b = "Place Value Mat: 3-Digit Regrouping";
    expect(resolveAppTileMark({ name: a })).toEqual(
      resolveAppTileMark({ name: b }),
    );
    expect(appTileTint({ name: a })).toBe(appTileTint({ name: b }));

    expect(resolveAppTileMark({ name: a, emoji: "🔢" })).not.toEqual(
      resolveAppTileMark({ name: b, emoji: "🧮" }),
    );
    const derived = appTileTint({ name: b });
    const chosen = APP_TILE_TINTS.find((t) => t !== derived)!;
    expect(appTileTint({ name: a, color: chosen })).not.toBe(derived);
  });
});

describe("normalizeAppTileEmoji", () => {
  test("keeps a single grapheme and drops surrounding space", () => {
    expect(normalizeAppTileEmoji("  🧮  ")).toBe("🧮");
  });

  test("blank input clears the field", () => {
    expect(normalizeAppTileEmoji("   ")).toBe(undefined);
    expect(normalizeAppTileEmoji("")).toBe(undefined);
  });

  test("an absent value stays absent (patch semantics)", () => {
    expect(normalizeAppTileEmoji(undefined)).toBe(undefined);
  });

  test("a pasted string is truncated to its first grapheme", () => {
    expect(normalizeAppTileEmoji("🎯 target practice")).toBe("🎯");
  });
});
