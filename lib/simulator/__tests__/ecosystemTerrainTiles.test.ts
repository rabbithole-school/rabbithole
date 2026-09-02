import { describe, expect, it } from "vitest";

import { ECOSYSTEM_LANDSCAPE_BANDS } from "../ecosystemLandscape";
import { CURRENT_LANE_TILES, TERRAIN_TILES_BY_ID } from "../terrainTiles";
import {
  ECOSYSTEM_BIOME_IDS,
  ECOSYSTEM_BIOMES,
  ECOSYSTEM_CARDINAL_TO_ISO_DIRECTION,
  ECOSYSTEM_DEFAULT_FLOOR_TILE,
  ecosystemBiome,
  ecosystemCurrentScreenVector,
  ecosystemDefaultFloorTile,
  ecosystemFloorTile,
  ecosystemTerrainKindHasPhysics,
  ecosystemTerrainSurfaceColor,
  ecosystemTerrainTile,
  type EcosystemCardinalDirection,
} from "../ecosystemTerrainTiles";

// Manifest-driven: every expectation below is derived FROM the terrain tile
// manifest (TERRAIN_TILES_BY_ID / CURRENT_LANE_TILES), never a hand-copied
// second list of ids -- so a manifest change (a renamed/added tile) surfaces
// here without this file needing a parallel edit.

describe("ecosystemTerrainTile", () => {
  it("maps shelter to the rock-shelter tile", () => {
    expect(ecosystemTerrainTile("shelter")).toBe(TERRAIN_TILES_BY_ID["sea-rock-shelter"]);
  });

  it("maps shallows to the shallow-water tile", () => {
    expect(ecosystemTerrainTile("shallows")).toBe(TERRAIN_TILES_BY_ID["sea-shallow-water"]);
  });

  it.each(Object.entries(ECOSYSTEM_CARDINAL_TO_ISO_DIRECTION))(
    "maps current_%s to the manifest's %s current-lane tile",
    (cardinal, isoDirection) => {
      const expected = CURRENT_LANE_TILES[isoDirection];
      expect(expected).toBeDefined();
      expect(ecosystemTerrainTile(`current_${cardinal}`)).toBe(expected);
    },
  );

  it("covers all four cardinal directions with no gaps", () => {
    const cardinals = Object.keys(ECOSYSTEM_CARDINAL_TO_ISO_DIRECTION).sort();
    expect(cardinals).toEqual(["east", "north", "south", "west"]);
  });

  it("assigns each cardinal a distinct iso direction (a bijection)", () => {
    const directions = Object.values(ECOSYSTEM_CARDINAL_TO_ISO_DIRECTION);
    expect(new Set(directions).size).toBe(directions.length);
    expect(new Set(directions)).toEqual(new Set(Object.keys(CURRENT_LANE_TILES)));
  });

  it("returns undefined for a kind outside ecosystemGrid's vocabulary", () => {
    expect(ecosystemTerrainTile("resource")).toBeUndefined();
    expect(ecosystemTerrainTile("public-pool")).toBeUndefined();
    expect(ecosystemTerrainTile("current_northeast")).toBeUndefined();
    expect(ecosystemTerrainTile("")).toBeUndefined();
  });
});

describe("ecosystem terrain standard library", () => {
  it("keeps omitted biome byte-for-byte compatible with reef rendering", () => {
    expect(ecosystemBiome(undefined)).toBe(ECOSYSTEM_BIOMES.reef);
    expect(ecosystemDefaultFloorTile(undefined)).toBe(ECOSYSTEM_DEFAULT_FLOOR_TILE);
    expect(ecosystemFloorTile("shelter")).toBe(ecosystemFloorTile("shelter", "reef"));
  });

  it("falls back to reef for an unrecognized snapshot biome", () => {
    expect(ecosystemBiome("future-biome")).toBe(ECOSYSTEM_BIOMES.reef);
  });

  it("maps the playable meadow to land art while preserving directional current cues", () => {
    expect(ecosystemDefaultFloorTile("meadow")).toBe(TERRAIN_TILES_BY_ID["land-grass"]);
    expect(ecosystemTerrainTile("shelter", "meadow")).toBe(TERRAIN_TILES_BY_ID["land-forest"]);
    expect(ecosystemTerrainTile("shallows", "meadow")).toBe(TERRAIN_TILES_BY_ID["land-freshwater"]);
    for (const [cardinal, isoDirection] of Object.entries(ECOSYSTEM_CARDINAL_TO_ISO_DIRECTION)) {
      expect(ecosystemTerrainTile(`current_${cardinal}`, "meadow")).toBe(
        CURRENT_LANE_TILES[isoDirection],
      );
    }
    expect(ECOSYSTEM_BIOMES.meadow.resource).toMatchObject({
      label: "Forage",
      markerColor: "#3F2815",
    });
  });

  it("references only tiles in the shared web/native manifest", () => {
    for (const biomeId of ECOSYSTEM_BIOME_IDS) {
      const biome = ECOSYSTEM_BIOMES[biomeId];
      expect(TERRAIN_TILES_BY_ID[biome.floorTileId]).toBeDefined();
      expect(TERRAIN_TILES_BY_ID[biome.terrainTileIds.shelter]).toBeDefined();
      expect(TERRAIN_TILES_BY_ID[biome.terrainTileIds.shallows]).toBeDefined();
      for (const tileId of Object.values(biome.terrainTileIds.current)) {
        expect(TERRAIN_TILES_BY_ID[tileId]).toBeDefined();
      }
    }
  });

  it("owns deterministic shared-edge surface colors for every supported terrain kind", () => {
    for (const biomeId of ECOSYSTEM_BIOME_IDS) {
      expect(ecosystemTerrainSurfaceColor(undefined, biomeId)).toBe(
        ECOSYSTEM_BIOMES[biomeId].rendering.surface.floor,
      );
      expect(ecosystemTerrainSurfaceColor("resource", biomeId)).toBe(
        ECOSYSTEM_BIOMES[biomeId].rendering.surface.floor,
      );
      expect(ecosystemTerrainSurfaceColor("shelter", biomeId)).toBe(
        ECOSYSTEM_BIOMES[biomeId].rendering.surface.shelter,
      );
      expect(ecosystemTerrainSurfaceColor("shallows", biomeId)).toBe(
        ECOSYSTEM_BIOMES[biomeId].rendering.surface.shallows,
      );
      expect(ecosystemTerrainSurfaceColor("current_north", biomeId)).toBe(
        ECOSYSTEM_BIOMES[biomeId].rendering.surface.current,
      );
      for (const band of ECOSYSTEM_LANDSCAPE_BANDS) {
        const color = ECOSYSTEM_BIOMES[biomeId].rendering.surface.landscape[band];
        expect(ecosystemTerrainSurfaceColor(undefined, biomeId, band)).toBe(color);
        expect(ecosystemTerrainSurfaceColor("resource", biomeId, band)).toBe(color);
        expect(ecosystemTerrainSurfaceColor("shelter", biomeId, band)).toBe(
          ECOSYSTEM_BIOMES[biomeId].rendering.surface.shelter,
        );
      }
    }
    expect(ecosystemTerrainSurfaceColor("public-pool")).toBeUndefined();
  });

  it("identifies only terrain kinds backed by ecosystem physics", () => {
    expect(ecosystemTerrainKindHasPhysics("shelter")).toBe(true);
    expect(ecosystemTerrainKindHasPhysics("shallows")).toBe(true);
    expect(ecosystemTerrainKindHasPhysics("current_west")).toBe(true);
    expect(ecosystemTerrainKindHasPhysics("resource")).toBe(false);
    expect(ecosystemTerrainKindHasPhysics(undefined)).toBe(false);
  });

  it("keeps every current lane direction-visible in the shared SVG overlay", () => {
    const vectors = ["north", "south", "east", "west"].map((direction) =>
      ecosystemCurrentScreenVector(`current_${direction}`),
    );
    expect(vectors).not.toContain(undefined);
    expect(new Set(vectors.map((vector) => `${vector!.dx}:${vector!.dy}`)).size).toBe(4);
    expect(ecosystemCurrentScreenVector("shallows")).toBeUndefined();
  });
});

describe("ecosystemFloorTile", () => {
  it("uses the default open-water floor for a resource-only cell", () => {
    expect(ecosystemFloorTile("resource")).toBe(ECOSYSTEM_DEFAULT_FLOOR_TILE);
  });

  it("uses the default open-water floor when there is no cell at all", () => {
    expect(ecosystemFloorTile(undefined)).toBe(ECOSYSTEM_DEFAULT_FLOOR_TILE);
  });

  it.each(["shelter", "shallows", "current_north", "current_south", "current_east", "current_west"])(
    "resolves %s to a real tile, not the default floor",
    (kind) => {
      const tile = ecosystemFloorTile(kind);
      expect(tile).toBeDefined();
      expect(tile).not.toBe(ECOSYSTEM_DEFAULT_FLOOR_TILE);
    },
  );

  it("leaves a genuinely unrecognized kind undefined (the renderer's neutral-fallback signal)", () => {
    expect(ecosystemFloorTile("public-pool")).toBeUndefined();
    expect(ecosystemFloorTile("some-future-template-kind")).toBeUndefined();
  });
});

// A drift guard: if a future manifest edit ever renames/removes one of the
// specific tiles this module reaches for by id, this fails loudly instead of
// silently returning undefined everywhere.
describe("required manifest entries", () => {
  it.each(["sea-open-water", "sea-rock-shelter", "sea-shallow-water"] as const)(
    "manifest still has %s",
    (id) => {
      expect(TERRAIN_TILES_BY_ID[id]).toBeDefined();
    },
  );
});

// Type-level sanity: EcosystemCardinalDirection stays exactly the four
// cardinals the ecosystemGrid template emits.
const _typeCheck: EcosystemCardinalDirection[] = ["north", "south", "east", "west"];
void _typeCheck;
