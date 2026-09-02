import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CURRENT_LANE_TILES,
  TERRAIN_TILES,
  TERRAIN_TILES_BY_ID,
  TERRAIN_TILE_DIR,
  terrainTileFile,
  terrainTileWebPath,
} from "../terrainTiles";

// The terrain library is committed art dual-homed under both bundle roots (web
// `public/`, native `native/assets/`). This guards the manifest ↔ files
// contract: every entry must resolve to a real PNG under BOTH roots, so a
// renamed/removed asset (or a manifest typo) fails loudly instead of shipping a
// missing tile to one surface. Mirrors the lockstep discipline of the
// species-icon cache-cap test.

const WEB_ROOT = new URL(`../../../public/${TERRAIN_TILE_DIR}/`, import.meta.url);
const NATIVE_ROOT = new URL(
  `../../../native/assets/${TERRAIN_TILE_DIR}/`,
  import.meta.url,
);

function fileUnder(root: URL, name: string): string {
  return fileURLToPath(new URL(name, root));
}

describe("terrain tile manifest", () => {
  it("has unique, kebab-case ids", () => {
    const ids = TERRAIN_TILES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z]+(-[a-z]+)*$/);
    }
  });

  it.each(TERRAIN_TILES.map((t) => [t.id, t] as const))(
    "%s exists under the web bundle root",
    (_id, t) => {
      expect(existsSync(fileUnder(WEB_ROOT, terrainTileFile(t)))).toBe(true);
    },
  );

  it.each(TERRAIN_TILES.map((t) => [t.id, t] as const))(
    "%s exists under the native bundle root",
    (_id, t) => {
      expect(existsSync(fileUnder(NATIVE_ROOT, terrainTileFile(t)))).toBe(true);
    },
  );

  it("resolves a stable web path", () => {
    const first = TERRAIN_TILES[0];
    expect(terrainTileWebPath(first)).toBe(
      `/${TERRAIN_TILE_DIR}/${first.id}.png`,
    );
  });

  it("indexes every tile by id", () => {
    for (const t of TERRAIN_TILES) {
      expect(TERRAIN_TILES_BY_ID[t.id]).toBe(t);
    }
  });

  it("exposes all four current-lane directions", () => {
    expect(Object.keys(CURRENT_LANE_TILES).sort()).toEqual([
      "ne",
      "nw",
      "se",
      "sw",
    ]);
  });
});

describe("native static-require map", () => {
  // Metro can't bundle a runtime-composed asset path, so the native surface
  // resolves tiles through a LITERAL require() map
  // (native/src/components/workbench/terrainTileAssets.ts). We can't import that
  // module here — its require() calls are Metro asset ids that don't resolve
  // under node/vitest — so we read its SOURCE and assert the wiring covers the
  // manifest exactly. A new tile that isn't wired (or a typo'd path) fails here.
  const source = readFileSync(
    fileURLToPath(
      new URL(
        "../../../native/src/components/workbench/terrainTileAssets.ts",
        import.meta.url,
      ),
    ),
    "utf8",
  );

  const manifestIds = TERRAIN_TILES.map((t) => t.id).sort();

  it("has a require() for every manifest tile (and no extras)", () => {
    const requiredIds = [
      ...source.matchAll(/simulator\/terrain\/([a-z0-9-]+)\.png/g),
    ]
      .map((m) => m[1])
      .sort();
    expect([...new Set(requiredIds)]).toEqual(manifestIds);
  });

  it("keys every entry by its manifest id (key matches the file basename)", () => {
    const entries = [
      ...source.matchAll(
        /"([a-z0-9-]+)":\s*require\("[^"]*simulator\/terrain\/([a-z0-9-]+)\.png"\)/g,
      ),
    ];
    const keys = entries.map((m) => m[1]).sort();
    expect(keys).toEqual(manifestIds);
    // Each key must name the file it points at — no mismatched wiring.
    for (const m of entries) {
      expect(m[1]).toBe(m[2]);
    }
  });
});
