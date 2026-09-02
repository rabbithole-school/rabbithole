// The NATIVE adapter over the shared App Launcher tile mark.
//
// The fallback chain itself — image → emoji → the name's initial — and the tile
// tint live in one framework-agnostic module (`shared/appTileMark.ts`, vendored
// here), so web and iPad can never disagree about what a tile shows. This file
// adds only what is genuinely native: turning a resolved image location into an
// `ImageSourcePropType`.
//
// That platform difference is real. A catalog icon is either an absolute
// http(s) URL or a path in the app's own bundled-icon namespace
// ("/external-apps/*.png"), and such a path has no origin inside the native
// app. Known ones are bundled (see ./externalAppBundledIcons) so the tile shows
// the real logo offline; an unbundled one is treated as absent and continues
// down the SAME shared chain rather than rendering broken.
//
// Both native surfaces that draw an app — the launcher grid and the unlock
// modal — resolve through here, so the scholar sees the same mark on the tile
// they tapped and on the modal that opens it.

import type { ImageSourcePropType } from "react-native";

import {
  appTileFallbackMark,
  appTileTint,
  resolveAppTileMark,
  type AppTileMarkInput,
} from "../../vendor/shared/appTileMark";
import { BUNDLED_ICONS } from "./externalAppBundledIcons";

/** The shared mark, with its image rung carrying a React Native image source. */
export type NativeAppTileMark =
  | { kind: "image"; source: ImageSourcePropType }
  | { kind: "emoji"; glyph: string }
  | { kind: "text"; text: string };

/**
 * The bundled registry's key for an already-resolved src: its path, with any
 * query or hash removed.
 *
 * The shared resolver deliberately PRESERVES `?query`/`#hash` on a bundled
 * path — a cache-busting `?v=2` is part of the URL the web fetches, and it is
 * also what keys the runtime-failure comparison, so a re-pointed icon gets a
 * fresh chance. The iPad bundle, though, ships ONE asset per path: without
 * this, a bundled icon with `?v=2` would miss the registry and drop
 * a tile that has a real bundled logo down to its emoji, on native only. The
 * src reaching here is already canonical (pathname, then search, then hash),
 * so the first `?`/`#` is exactly where the path ends.
 */
function bundledIconKey(src: string): string {
  const cut = src.search(/[?#]/);
  return cut === -1 ? src : src.slice(0, cut);
}

/** An image this app can actually load, or null when it can't. */
function nativeImageSource(src: string): ImageSourcePropType | null {
  // A root-relative src has already been proven to sit inside the bundled-icon
  // namespace by the shared resolver; it has no origin here, so the bundle is
  // the only place it can come from.
  if (src.startsWith("/")) return BUNDLED_ICONS[bundledIconKey(src)] ?? null;
  return /^https?:\/\//i.test(src) ? { uri: src } : null;
}

/**
 * Resolve what goes inside an app's squircle on iPad. Same precedence as web —
 * a usable image, then the staff-chosen emoji, then the name's initial — with
 * "usable image" narrowed to what this app can actually load.
 */
export function resolveNativeAppTileMark(
  input: AppTileMarkInput,
): NativeAppTileMark {
  const mark = resolveAppTileMark(input);
  if (mark.kind !== "image") return mark;

  const source = nativeImageSource(mark.src);
  return source ? { kind: "image", source } : appTileFallbackMark(input);
}

export { appTileTint };
export type { AppTileMarkInput };
