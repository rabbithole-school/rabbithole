/**
 * Metro static-require map for the isometric terrain tile library on native.
 *
 * WHY this file exists: Metro can only bundle an asset whose `require()` takes a
 * LITERAL string path — it cannot resolve a runtime-composed path like
 * `require(`../../../assets/simulator/terrain/${id}.png`)`. The web app resolves a
 * tile by URL (`terrainTileWebPath` in `lib/simulator/terrainTiles.ts`, served from
 * `public/`), but native has no URL server for bundled assets, so every tile
 * needs a literal `require()` entry here, keyed by its manifest id. This is the
 * same static-require pattern the app already uses for bundled images
 * (`AppLauncher`'s `BUNDLED_ICONS`, `GeoMapNative`'s `LABEL_IMAGES`).
 *
 * Kept in lockstep with the manifest: `lib/simulator/__tests__/terrainTiles.test.ts`
 * reads this file's source and asserts its keys ↔ `TERRAIN_TILES` ids match
 * exactly (and that each key equals its own require path's basename), so a tile
 * added to the manifest but not wired here — or a typo'd path — fails loudly
 * instead of shipping a missing tile to iPad.
 *
 * This module lives under `native/` (not `lib/simulator/`) on purpose: the
 * `require()` calls are Metro asset ids that only resolve inside the native
 * bundle, and metro cannot crawl outside the native project root.
 */

import type { ImageSourcePropType } from "react-native";

/* eslint-disable @typescript-eslint/no-require-imports -- Metro asset ids must be literal require() calls. */
export const TERRAIN_TILE_ASSETS: Record<string, ImageSourcePropType> = {
  // sea
  "sea-open-water": require("../../../assets/simulator/terrain/sea-open-water.png"),
  "sea-shallow-water": require("../../../assets/simulator/terrain/sea-shallow-water.png"),
  "sea-algae-sparse": require("../../../assets/simulator/terrain/sea-algae-sparse.png"),
  "sea-algae-medium": require("../../../assets/simulator/terrain/sea-algae-medium.png"),
  "sea-algae-dense": require("../../../assets/simulator/terrain/sea-algae-dense.png"),
  "sea-rock-shelter": require("../../../assets/simulator/terrain/sea-rock-shelter.png"),
  "sea-coral": require("../../../assets/simulator/terrain/sea-coral.png"),
  "sea-current-ne": require("../../../assets/simulator/terrain/sea-current-ne.png"),
  "sea-current-nw": require("../../../assets/simulator/terrain/sea-current-nw.png"),
  "sea-current-se": require("../../../assets/simulator/terrain/sea-current-se.png"),
  "sea-current-sw": require("../../../assets/simulator/terrain/sea-current-sw.png"),
  // land
  "land-grass": require("../../../assets/simulator/terrain/land-grass.png"),
  "land-forest": require("../../../assets/simulator/terrain/land-forest.png"),
  "land-hill": require("../../../assets/simulator/terrain/land-hill.png"),
  "land-sand": require("../../../assets/simulator/terrain/land-sand.png"),
  "land-freshwater": require("../../../assets/simulator/terrain/land-freshwater.png"),
  "land-farmland": require("../../../assets/simulator/terrain/land-farmland.png"),
  // social
  "social-village": require("../../../assets/simulator/terrain/social-village.png"),
  "social-market": require("../../../assets/simulator/terrain/social-market.png"),
  "social-meeting-circle": require("../../../assets/simulator/terrain/social-meeting-circle.png"),
  "social-road": require("../../../assets/simulator/terrain/social-road.png"),
  "social-district": require("../../../assets/simulator/terrain/social-district.png"),
  "social-district-blue": require("../../../assets/simulator/terrain/social-district-blue.png"),
  "social-district-green": require("../../../assets/simulator/terrain/social-district-green.png"),
};
/* eslint-enable @typescript-eslint/no-require-imports */

/** Resolve a tile id to its bundled native asset, or undefined if unmapped. */
export function terrainTileAsset(id: string): ImageSourcePropType | undefined {
  return TERRAIN_TILE_ASSETS[id];
}
