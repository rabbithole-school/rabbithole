/**
 * The committed isometric terrain tile library — a versioned art set, NOT
 * runtime generation. Each tile is a single 2:1 dimetric isometric DIAMOND
 * rendered from one fixed three-quarter top-down camera, on a transparent
 * background, capped at 256px on the longer edge (retina-crisp at the ~64–96px
 * a tile renders on-screen). Sprites (species icons) sit at a tile's center.
 *
 * The tiles were curated offline with the same Gemini image pipeline the live
 * theme-icon layer uses (chroma-key green screen → flood-fill strip to real
 * transparency); the generator is scratch-only. What ships is the PNGs below +
 * this manifest.
 *
 * ─── Asset home (BOTH bundles consume it) ────────────────────────────────────
 * The web app serves static images from `public/` (by URL) and the native Expo
 * app bundles them from `native/assets/` (via metro `require`, which cannot
 * reach outside the native project root). Neither bundle can read the other's
 * directory, so — exactly as the repo already ships genuinely-shared rasters
 * like the external-app tile icons — every tile is DUAL-HOMED at the SAME
 * relative path under both roots:
 *   • web    → public/simulator/terrain/<file>          (URL, `terrainTileWebPath`)
 *   • native → native/assets/simulator/terrain/<file>   (a LITERAL `require()` per
 *              tile in `native/src/components/workbench/terrainTileAssets.ts` —
 *              Metro cannot bundle a runtime-composed asset path, so a static
 *              require map is mandatory, not a convenience)
 * `terrainTiles.test.ts` asserts every manifest entry's file exists under BOTH
 * roots AND is wired into the native require map, keeping the mirrors in
 * lockstep. This manifest is framework-free so both surfaces import it directly.
 *
 * Renderer integration (wiring these into the ISO ecosystem grid) is a separate
 * piece of work; this module only names the library and its metadata.
 */

/** The three curated groups. Sea serves the ecosystem worlds; land + social are
 *  seeded for future worlds (council / market / map). */
export type TerrainCategory = "sea" | "land" | "social";

/** The four isometric grid directions a current-lane tile can flow toward,
 *  named for the diamond edge the flow points at in screen space. */
export type IsoDirection = "ne" | "nw" | "se" | "sw";

export interface TerrainTile {
  /** Stable kind string + basename of the PNG (without extension). */
  readonly id: string;
  readonly category: TerrainCategory;
  /** Sentence-case human label for galleries / editors. */
  readonly label: string;
  /** For current-lane tiles: the iso grid direction the flow points toward. */
  readonly direction?: IsoDirection;
  /** For graded tiles (algae beds): coverage density. */
  readonly density?: "sparse" | "medium" | "dense";
  /** For district tiles: the neutral tint name. */
  readonly tint?: "neutral" | "cool" | "verdant";
}

/** Directory the tiles live in under each bundle root. */
export const TERRAIN_TILE_DIR = "simulator/terrain";

const tile = (
  id: string,
  category: TerrainCategory,
  label: string,
  extra: Omit<TerrainTile, "id" | "category" | "label"> = {},
): TerrainTile => ({ id, category, label, ...extra });

/**
 * The manifest. Order is gallery order: sea set (serves ecosystemGrid), then
 * land, then political/social.
 */
export const TERRAIN_TILES: readonly TerrainTile[] = [
  // ── sea ──────────────────────────────────────────────────────────────────
  tile("sea-open-water", "sea", "Open water"),
  tile("sea-shallow-water", "sea", "Shallow water"),
  tile("sea-algae-sparse", "sea", "Algae bed, sparse", { density: "sparse" }),
  tile("sea-algae-medium", "sea", "Algae bed, medium", { density: "medium" }),
  tile("sea-algae-dense", "sea", "Algae bed, dense", { density: "dense" }),
  tile("sea-rock-shelter", "sea", "Rock shelter"),
  tile("sea-coral", "sea", "Coral"),
  tile("sea-current-ne", "sea", "Current, northeast", { direction: "ne" }),
  tile("sea-current-nw", "sea", "Current, northwest", { direction: "nw" }),
  tile("sea-current-se", "sea", "Current, southeast", { direction: "se" }),
  tile("sea-current-sw", "sea", "Current, southwest", { direction: "sw" }),
  // ── land ─────────────────────────────────────────────────────────────────
  tile("land-grass", "land", "Grass"),
  tile("land-forest", "land", "Forest"),
  tile("land-hill", "land", "Hill"),
  tile("land-sand", "land", "Sand"),
  tile("land-freshwater", "land", "Fresh water"),
  tile("land-farmland", "land", "Farmland"),
  // ── political / social ─────────────────────────────────────────────────────
  tile("social-village", "social", "Village"),
  tile("social-market", "social", "Market square"),
  tile("social-meeting-circle", "social", "Meeting circle"),
  tile("social-road", "social", "Road"),
  tile("social-district", "social", "District, neutral", { tint: "neutral" }),
  tile("social-district-blue", "social", "District, cool", { tint: "cool" }),
  tile("social-district-green", "social", "District, verdant", { tint: "verdant" }),
];

/** Lookup by kind string. */
export const TERRAIN_TILES_BY_ID: Readonly<Record<string, TerrainTile>> =
  Object.fromEntries(TERRAIN_TILES.map((t) => [t.id, t]));

/** The bare PNG filename for a tile. */
export function terrainTileFile(tile: TerrainTile): string {
  return `${tile.id}.png`;
}

/** Web URL for a tile (served from `public/`). */
export function terrainTileWebPath(tile: TerrainTile): string {
  return `/${TERRAIN_TILE_DIR}/${terrainTileFile(tile)}`;
}

/** All directional current-lane variants, keyed by iso grid direction. */
export const CURRENT_LANE_TILES: Readonly<Record<IsoDirection, TerrainTile>> =
  Object.fromEntries(
    TERRAIN_TILES.filter((t) => t.direction).map((t) => [t.direction, t]),
  ) as Record<IsoDirection, TerrainTile>;
