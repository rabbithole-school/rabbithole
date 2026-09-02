/**
 * The App Launcher tile mark — the SINGLE resolution of "what goes inside an
 * app tile's squircle", shared by the web launcher, the four staff surfaces
 * that preview a tile, and the native iPad launcher.
 *
 * This is the `components/InstitutionMark.tsx` pattern applied to External
 * Apps: one pure chain — uploaded/linked image → emoji → the name's initial —
 * so "emoji is only ever a fallback for a real logo" holds by construction at
 * every call site instead of being re-implemented per surface. The chain covers
 * a link that is unusable on its face AND one that turns out not to load at
 * runtime (see `unusableImageSrc`), so a tile never lands on a rung that draws
 * nothing.
 *
 * The second half is the TINT. A tile with no image is a colored squircle, and
 * before this module every tile without an explicit `color` fell back to the
 * same violet, so a launcher of un-iconed apps was a wall of identical purple
 * squares. `appTileTint` derives a stable hue from the app's name instead, so
 * the color encodes one real variable: which app this is. A scholar learns
 * "the teal one is TypeRacer" and the tile stays that color everywhere.
 *
 * Framework-agnostic by design (no React, no Chakra, no React Native), like
 * shared/brand.ts, so web and native can never drift.
 */

import { palette } from "./brand";

export type AppTileMark =
  | { kind: "image"; src: string }
  | { kind: "emoji"; glyph: string }
  | { kind: "text"; text: string };

export interface AppTileMarkInput {
  /** Serving URL of the uploaded asset, or the staff-entered icon URL. */
  iconUrl?: string | null;
  /** The fallback emoji glyph, shown only when there is no image. */
  emoji?: string | null;
  /** The app name — its initial is the last-resort mark. */
  name?: string | null;
  /**
   * An image location that has already FAILED to load on this surface — the
   * renderer's `onError` reports it back here. A URL can be perfectly
   * well-formed and still not resolve to pixels (the host is down, the asset
   * was deleted, the iPad is offline, ATS blocked it), and without this the
   * chain would stop at a rung that draws nothing: a blank white tile with no
   * mark at all. Feeding the failure back in continues down the SAME chain to
   * the emoji/initial, so the runtime outcome matches the syntactic one.
   */
  unusableImageSrc?: string | null;
}

/**
 * The one same-origin namespace a tile icon may name: the catalog logos this
 * app ships itself, served from `public/external-apps/` on web and mirrored
 * into the iPad bundle (`native/src/lib/externalAppBundledIcons.ts`). Any other
 * root-relative value is an app ROUTE, not an image — pointing a tile at one
 * would render an HTML page into an `<img>`, i.e. nothing.
 */
const BUNDLED_ICON_PREFIX = "/external-apps/";

/**
 * A fixed, deliberately unroutable base for resolving root-relative candidates.
 * The origin itself is irrelevant — what matters is that the WHATWG URL parser
 * applies the SAME normalization the browser and the native fetch layer will:
 * dot segments in every spelling the spec recognizes (`..`, `%2e%2e`, `.%2e`,
 * `%2e.`), and — because this is a special scheme — backslash as a path
 * separator. Comparing a literal prefix against the raw string cannot see any
 * of that, so `/external-apps/%2e%2e/teacher/apps` read as being in the
 * namespace while requesting `/teacher/apps`.
 */
const TILE_ICON_BASE = "https://app.invalid/";

/**
 * What a bundled icon's normalized path may still look like: real path
 * segments of unreserved characters. Nothing the parser leaves encoded gets
 * through, which closes the case it deliberately does not touch — a
 * DOUBLE-encoded segment (`%252e%252e`) survives parsing intact and would only
 * become `..` in whatever decodes it downstream. A percent sign is not part of
 * any icon filename we ship, so rejecting the whole class costs nothing.
 */
const BUNDLED_ICON_SEGMENTS = /^[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/;

/**
 * A root-relative candidate, canonicalized, or null when it does not truly
 * land inside the bundled-icon namespace.
 */
function bundledIconSrc(src: string): string | null {
  let url: URL;
  try {
    url = new URL(src, TILE_ICON_BASE);
  } catch {
    return null;
  }
  // `//host/logo.png` — and `/\host/logo.png`, which the parser folds into it —
  // read as an AUTHORITY, not a path, so without this the prefix check would be
  // running against someone else's server.
  if (`${url.protocol}//${url.host}/` !== TILE_ICON_BASE) return null;
  if (!url.pathname.startsWith(BUNDLED_ICON_PREFIX)) return null;
  if (!BUNDLED_ICON_SEGMENTS.test(url.pathname.slice(BUNDLED_ICON_PREFIX.length))) {
    return null;
  }
  // Canonical, and stable under a second pass — which is what keeps the
  // `unusableImageSrc` comparison below keyed on one spelling of the src.
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Icon sources a tile will actually render. A tile `src` ends up in an
 * `<img>`/`<Image>` on a child-facing surface, and the value is staff-entered
 * free text, so anything that is not plainly an image location is treated as
 * absent and falls through to the emoji/initial rung rather than being handed
 * to the platform. `https:` is the real-world case; `http:` is kept because the
 * field predates this module; and a root-relative value is accepted only inside
 * the bundled-icon namespace above.
 */
export function appTileImageSrc(raw: string | null | undefined): string | null {
  const src = raw?.trim();
  if (!src) return null;
  if (src.startsWith("/")) return bundledIconSrc(src);
  return /^https?:\/\/[^\s]+$/i.test(src) ? src : null;
}

/**
 * A minimal structural type for `Intl.Segmenter`, so this module type-checks
 * under the convex tsconfig's older lib as well as the frontend/native esnext
 * ones. Same probe-at-runtime idiom as `shared/portfolioLabel.ts`; without it
 * a ZWJ sequence like 👩‍🚀 would be sliced at its first code point.
 */
type TileSegmenter = { segment(input: string): Iterable<{ segment: string }> };

const graphemeSegmenter: TileSegmenter | null = (() => {
  const maybe = (
    globalThis as {
      Intl?: {
        Segmenter?: new (
          locales?: string | string[],
          options?: { granularity?: "grapheme" | "word" | "sentence" },
        ) => TileSegmenter;
      };
    }
  ).Intl?.Segmenter;
  if (typeof maybe !== "function") return null;
  try {
    return new maybe(undefined, { granularity: "grapheme" });
  } catch {
    return null;
  }
})();

/** The first grapheme of a string, so an astral emoji or a surrogate pair
 *  isn't sliced in half. Falls back to code points where Segmenter is absent. */
function firstGrapheme(value: string): string {
  if (graphemeSegmenter) {
    for (const part of graphemeSegmenter.segment(value)) return part.segment;
    return "";
  }
  return [...value][0] ?? "";
}

/**
 * The rungs below an image: the staff-chosen emoji, else the name's initial
 * (uppercased, grapheme safe), else "?". Exported because the native adapter
 * needs exactly this when a resolved image turns out not to be loadable there
 * — the fallback order stays defined once instead of being restated per
 * platform.
 */
export function appTileFallbackMark(
  input: AppTileMarkInput,
): Exclude<AppTileMark, { kind: "image" }> {
  const emoji = input.emoji?.trim();
  if (emoji) return { kind: "emoji", glyph: firstGrapheme(emoji) };

  const name = input.name?.trim();
  const initial = name ? firstGrapheme(name).toUpperCase() : "?";
  return { kind: "text", text: initial || "?" };
}

/**
 * The fallback chain, resolved ONCE: a usable image wins; else a non-empty
 * emoji; else the name's initial (uppercased, grapheme safe), or "?" when even
 * the name is empty.
 *
 * `unusableImageSrc` is the runtime half of the same chain — an image the
 * surface already tried and failed to load is treated exactly like an absent
 * one. Both sides are normalized here, so a caller can report back either the
 * raw catalog value or the resolved src, and the comparison is keyed on the
 * SRC: pointing the tile at a different image (or a different app) makes a
 * stale failure stop applying by construction, with no reset to remember.
 */
export function resolveAppTileMark(input: AppTileMarkInput): AppTileMark {
  const src = appTileImageSrc(input.iconUrl);
  if (src && src !== appTileImageSrc(input.unusableImageSrc)) {
    return { kind: "image", src };
  }
  return appTileFallbackMark(input);
}

/**
 * The tint set for image-less tiles. Every hue is a step from the shared brand
 * palette, and every one clears 4.5:1 against white so the initial (and a
 * white spinner overlay) stays legible on it — the mark on top is the only
 * thing drawn in the tile, so its contrast is the accessibility constraint.
 * Six well-separated hues: purple, indigo, teal, green, burnt orange, slate.
 */
export const APP_TILE_TINTS = [
  palette.violet[600],
  palette.navy[400],
  palette.darkCyan[500],
  palette.green[900],
  palette.orange[900],
  palette.charcoal[500],
] as const;

/**
 * Pick a tile tint. An explicit catalog `color` always wins (a brand color a
 * staff member chose). Otherwise the app's NAME picks a stable hue: the same
 * app is the same color on every surface and across reloads, and a launcher of
 * un-iconed apps reads as distinct tiles rather than one violet wall.
 *
 * The palette is bounded, so this is an identity CUE, not a uniqueness
 * guarantee — two names can hash to the same hue. That is the right trade for
 * a scholar's launcher (a handful of tiles, so a collision is unlikely) and it
 * is why the staff-set emoji and color exist: those are the deterministic rung
 * when two specific apps need to be told apart.
 *
 * Keyed on the name rather than the row id so a tile previews in its final
 * color while it is still being typed into the "New app" form.
 */
export function appTileTint(input: {
  color?: string | null;
  name?: string | null;
}): string {
  const explicit = input.color?.trim();
  if (explicit) return explicit;

  const key = (input.name ?? "").trim().toLowerCase();
  if (!key) return APP_TILE_TINTS[0];
  // FNV-1a: tiny, dependency-free, and well spread over short strings.
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return APP_TILE_TINTS[hash % APP_TILE_TINTS.length]!;
}

/**
 * Normalize a staff-entered emoji for storage: keep a single grapheme, and
 * treat blank input as "cleared". Returning `undefined` matches the catalog's
 * "empty string clears an optional text field" convention.
 */
export function normalizeAppTileEmoji(
  raw: string | undefined,
): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return firstGrapheme(trimmed);
}
