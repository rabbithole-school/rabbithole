/**
 * Maps ecosystemGrid's `SimulatorSceneCellV1.kind` strings to the committed
 * terrain tile library (`./terrainTiles.ts`). This is deliberately its OWN
 * module, separate from the framework-neutral manifest: `terrainTiles.ts`
 * only names the art library, and stays usable by any future template
 * (land/social groups exist for a council/market/map world that doesn't
 * exist yet). Renderer wiring for a SPECIFIC template's kind vocabulary
 * belongs beside that vocabulary's own module -- this one, for ecosystemGrid.
 *
 * Framework-free (no JSX/DOM/RN), so web imports it directly and native
 * vendors it byte-identical (`native/scripts/sync-vendor.js`), exactly like
 * `contract.ts` / `helpers.ts` / `isometricProjection.ts`.
 */

import {
  CURRENT_LANE_TILES,
  TERRAIN_TILES_BY_ID,
  type IsoDirection,
  type TerrainTile,
} from "./terrainTiles";
import type { EcosystemBiomeId, EcosystemGridConfig } from "./contract";
import type { EcosystemLandscapeBand } from "./ecosystemLandscape";

/** The cardinal directions ecosystemGrid's `config.terrain.current[].direction`
 *  and its scene cell kind (`current_<direction>`) use. */
export type EcosystemCardinalDirection = "north" | "south" | "east" | "west";

/**
 * ecosystemGrid encodes current-lane flow in GRID cardinal directions, but
 * the terrain art library's current tiles are named by the ISO SCREEN
 * diagonal the flow renders toward under this repo's one fixed dimetric
 * camera (`isometricProjection.ts`'s `projectIsometric`: screen x = (x - y) *
 * tileWidth/2, screen y = (x + y) * tileHeight/2). Working out each cardinal
 * step's screen delta: grid north (dy = -1) moves screen right + up → NE;
 * south (dy = +1) → left + down → SW; east (dx = +1) → right + down → SE;
 * west (dx = -1) → left + up → NW. This mapping is a property of the fixed
 * camera, not an authoring choice -- it must not change unless the camera
 * projection itself does.
 */
export const ECOSYSTEM_CARDINAL_TO_ISO_DIRECTION: Readonly<
  Record<EcosystemCardinalDirection, IsoDirection>
> = {
  north: "ne",
  south: "sw",
  east: "se",
  west: "nw",
};

const REEF_CURRENT_TILE_IDS: Readonly<Record<EcosystemCardinalDirection, string>> =
  Object.fromEntries(
    Object.entries(ECOSYSTEM_CARDINAL_TO_ISO_DIRECTION).map(([cardinal, direction]) => [
      cardinal,
      CURRENT_LANE_TILES[direction].id,
    ]),
  ) as Record<EcosystemCardinalDirection, string>;

const CURRENT_KIND_PATTERN = /^current_(north|south|east|west)$/;
const CURRENT_SCREEN_VECTORS: Readonly<Record<EcosystemCardinalDirection, { dx: number; dy: number }>> = {
  north: { dx: 0.18, dy: -0.09 },
  south: { dx: -0.18, dy: 0.09 },
  east: { dx: 0.18, dy: 0.09 },
  west: { dx: -0.18, dy: -0.09 },
};

/**
 * The code-owned terrain standard library for ecosystemGrid.
 *
 * The underlying grid is physics-neutral: an unmarked cell is traversable and
 * can grow a resource, not inherently water. `reef` preserves the established
 * water rendering; `meadow` makes that same deterministic grid a land ecosystem.
 * These entries deliberately own rendering and resource vocabulary only.
 * Passability and species-habitat rules remain absent until modeled as explicit,
 * validated physics rather than implied by a visual tile.
 */
export interface EcosystemBiome {
  readonly id: EcosystemBiomeId;
  readonly label: string;
  readonly floorTileId: string;
  readonly terrainTileIds: {
    readonly shelter: string;
    readonly shallows: string;
    readonly current: Readonly<Record<EcosystemCardinalDirection, string>>;
  };
  readonly resource: {
    readonly label: string;
    readonly markerColor: string;
    /** A hosted charm icon is optional; every biome keeps a color fallback. */
    readonly iconLabel?: string;
  };
  readonly rendering: {
    readonly stageColor: string;
    readonly leftWallColor: string;
    readonly rightWallColor: string;
    readonly outlineColor: string;
    readonly hasWaterShimmer: boolean;
    /**
     * A deterministic shared-edge SVG palette. Terrain art belongs in the
     * discrete overlay layer; these fills intentionally own the continuous
     * board so independently-produced rasters can never introduce seams.
     */
    readonly surface: {
      readonly floor: string;
      readonly shelter: string;
      readonly shallows: string;
      readonly current: string;
      readonly landscape: Readonly<Record<EcosystemLandscapeBand, string>>;
    };
    readonly landscapeWalls: Readonly<
      Record<EcosystemLandscapeBand, { readonly left: string; readonly right: string }>
    >;
    readonly landscapeMarks: Readonly<Record<EcosystemLandscapeBand, string>>;
    readonly landscapeReliefShadowColor: string;
    readonly landscapeRaisedFacetColor: string;
    readonly landscapeSunkenFacetColor: string;
    /** Neutral boundary reserved for terrain whose appearance carries rules. */
    readonly physicsOutlineColor: string;
  };
}

export const DEFAULT_ECOSYSTEM_BIOME_ID: EcosystemBiomeId = "reef";
export const ECOSYSTEM_BIOME_IDS = ["reef", "meadow"] as const satisfies readonly EcosystemBiomeId[];

export const ECOSYSTEM_BIOMES: Readonly<Record<EcosystemBiomeId, EcosystemBiome>> = {
  reef: {
    id: "reef",
    label: "Reef",
    floorTileId: "sea-open-water",
    terrainTileIds: {
      shelter: "sea-rock-shelter",
      shallows: "sea-shallow-water",
      current: REEF_CURRENT_TILE_IDS,
    },
    resource: { label: "Algae", markerColor: "#22C55E", iconLabel: "algae" },
    rendering: {
      stageColor: "#E6F7FA",
      leftWallColor: "#075269",
      rightWallColor: "#063F55",
      outlineColor: "#62C9D0",
      hasWaterShimmer: true,
      surface: {
        floor: "#3192AC",
        shelter: "#173E47",
        shallows: "#9ADFE2",
        current: "#2563A8",
        landscape: {
          basin: "#1D607A",
          lowland: "#26758F",
          plain: "#359AB5",
          highland: "#55B5C2",
          ridge: "#82CFCA",
        },
      },
      landscapeWalls: {
        basin: { left: "#123F55", right: "#0A3043" },
        lowland: { left: "#17536A", right: "#0E4056" },
        plain: { left: "#1C687B", right: "#125063" },
        highland: { left: "#2D7A82", right: "#1E626E" },
        ridge: { left: "#468A86", right: "#2F706F" },
      },
      landscapeMarks: {
        basin: "#C8F3F5",
        lowland: "#B4E9F0",
        plain: "#D9FFFF",
        highland: "#D8F7E9",
        ridge: "#F0FFD9",
      },
      landscapeReliefShadowColor: "#123F55",
      landscapeRaisedFacetColor: "#145B70",
      landscapeSunkenFacetColor: "#072F46",
      physicsOutlineColor: "#F8FAFC",
    },
  },
  meadow: {
    id: "meadow",
    label: "Meadow",
    floorTileId: "land-grass",
    terrainTileIds: {
      shelter: "land-forest",
      // Existing shallows physics combines higher regrowth with a sensing
      // penalty; fresh water reads as that wet, vision-limiting terrain without
      // implying a cultivated habitat.
      shallows: "land-freshwater",
      // Current lanes keep their established directional art. The underlying
      // displacement physics is identical in either biome, so its direction
      // must remain visible until a land-specific directional tile exists.
      current: REEF_CURRENT_TILE_IDS,
    },
    resource: { label: "Forage", markerColor: "#3F2815" },
    rendering: {
      stageColor: "#F7FEE7",
      leftWallColor: "#5B3A1E",
      rightWallColor: "#3F2815",
      outlineColor: "#A3B18A",
      hasWaterShimmer: false,
      surface: {
        floor: "#76A84C",
        shelter: "#234B2C",
        shallows: "#3A9FC0",
        current: "#C77B30",
        landscape: {
          basin: "#4F773D",
          lowland: "#648F45",
          plain: "#7DAF50",
          highland: "#97BC5F",
          ridge: "#B5CF74",
        },
      },
      landscapeWalls: {
        basin: { left: "#382719", right: "#281C13" },
        lowland: { left: "#47301B", right: "#322216" },
        plain: { left: "#5B3A1E", right: "#3F2815" },
        highland: { left: "#6C4926", right: "#4C341D" },
        ridge: { left: "#7A5831", right: "#593D23" },
      },
      landscapeMarks: {
        basin: "#DCECAF",
        lowland: "#315C3B",
        plain: "#365D2E",
        highland: "#536A31",
        ridge: "#67472A",
      },
      landscapeReliefShadowColor: "#3F532C",
      landscapeRaisedFacetColor: "#58402A",
      landscapeSunkenFacetColor: "#2F3B22",
      physicsOutlineColor: "#F8FAFC",
    },
  },
};

export function ecosystemBiome(biomeId: string | undefined): EcosystemBiome {
  return ECOSYSTEM_BIOMES[biomeId as EcosystemBiomeId] ?? ECOSYSTEM_BIOMES[DEFAULT_ECOSYSTEM_BIOME_ID];
}

function tileForId(id: string): TerrainTile {
  const tile = TERRAIN_TILES_BY_ID[id];
  if (!tile) throw new Error(`Unknown ecosystem terrain tile "${id}"`);
  return tile;
}

/** The default floor every ecosystemGrid cell without a more specific terrain
 *  kind (or only a resource reading) renders as for one biome. */
export function ecosystemDefaultFloorTile(biomeId: EcosystemBiomeId | undefined): TerrainTile {
  return tileForId(ecosystemBiome(biomeId).floorTileId);
}

/** Legacy reef default retained for existing callers and snapshots. */
export const ECOSYSTEM_DEFAULT_FLOOR_TILE = ecosystemDefaultFloorTile(undefined);

/**
 * Resolve an ecosystemGrid scene cell's `kind` to its terrain tile, or
 * `undefined` for a kind this library doesn't style. Callers keep their
 * existing neutral-fallback rendering for `undefined` -- e.g. a future
 * template's own cell kind (this module only ever recognizes ecosystemGrid's
 * closed vocabulary: "shelter", "shallows", "current_<direction>") or
 * ecosystemGrid's bare "resource" pseudo-kind, which is a biomass reading
 * layered atop the biome floor rather than a terrain kind of its own.
 */
export function ecosystemTerrainTile(
  kind: string,
  biomeId?: EcosystemBiomeId,
): TerrainTile | undefined {
  const biome = ecosystemBiome(biomeId);
  if (kind === "shelter") return tileForId(biome.terrainTileIds.shelter);
  if (kind === "shallows") return tileForId(biome.terrainTileIds.shallows);
  const match = CURRENT_KIND_PATTERN.exec(kind);
  if (match) {
    const cardinal = match[1] as EcosystemCardinalDirection;
    return tileForId(biome.terrainTileIds.current[cardinal]);
  }
  return undefined;
}

/**
 * The floor tile a renderer should draw for a given cell (or absence of one):
 * the mapped terrain tile when recognized, the biome's default floor for
 * "resource" or no cell at all, and `undefined` only for a genuinely
 * unrecognized kind -- the signal a renderer's neutral fallback exists for.
 */
export function ecosystemFloorTile(
  kind: string | undefined,
  biomeId?: EcosystemBiomeId,
): TerrainTile | undefined {
  if (kind === undefined || kind === "resource") return ecosystemDefaultFloorTile(biomeId);
  return ecosystemTerrainTile(kind, biomeId);
}

/**
 * Continuous terrain is SVG geometry, not a collection of independently framed
 * images. This chooses only a semantic fill; both renderers draw the exact same
 * shared-edge diamonds and reserve artwork for discrete overlays.
 */
export function ecosystemTerrainSurfaceColor(
  kind: string | undefined,
  biomeId?: EcosystemBiomeId,
  landscapeBand?: EcosystemLandscapeBand,
): string | undefined {
  const biome = ecosystemBiome(biomeId);
  if (kind === undefined || kind === "resource") {
    return landscapeBand
      ? biome.rendering.surface.landscape[landscapeBand]
      : biome.rendering.surface.floor;
  }
  if (kind === "shelter") return biome.rendering.surface.shelter;
  if (kind === "shallows") return biome.rendering.surface.shallows;
  if (CURRENT_KIND_PATTERN.test(kind)) return biome.rendering.surface.current;
  return undefined;
}

/** True only for scene cells whose appearance represents real template rules. */
export function ecosystemTerrainKindHasPhysics(kind: string | undefined): boolean {
  return kind === "shelter" || kind === "shallows" || (kind ? CURRENT_KIND_PATTERN.test(kind) : false);
}

export function ecosystemPhysicsTerrainPositionSet(
  terrain: EcosystemGridConfig["terrain"] | undefined,
): ReadonlySet<string> {
  return new Set([
    ...(terrain?.shelter ?? []).map((cell) => `${cell.x}:${cell.y}`),
    ...(terrain?.current ?? []).map((cell) => `${cell.x}:${cell.y}`),
    ...(terrain?.shallows ?? []).map((cell) => `${cell.x}:${cell.y}`),
  ]);
}

/** Screen-space flow vector for the shared SVG current overlay. */
export function ecosystemCurrentScreenVector(
  kind: string | undefined,
): { readonly dx: number; readonly dy: number } | undefined {
  const match = kind ? CURRENT_KIND_PATTERN.exec(kind) : null;
  return match ? CURRENT_SCREEN_VECTORS[match[1] as EcosystemCardinalDirection] : undefined;
}
