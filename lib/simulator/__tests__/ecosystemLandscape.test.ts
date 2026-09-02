import { describe, expect, it } from "vitest";

import type { EcosystemLandscapeConfig } from "../contract";
import {
  clampEcosystemLandscapeRegionCount,
  ECOSYSTEM_LANDSCAPE_BANDS,
  ECOSYSTEM_LANDSCAPE_CONTOUR,
  ecosystemLandscapeRegionCountLimit,
  ecosystemLandscapeFingerprint,
  ecosystemLandscapeVisualPaths,
  generateEcosystemLandscape,
  MIN_ECOSYSTEM_LANDSCAPE_REGIONS,
  validateEcosystemLandscapeConfig,
} from "../ecosystemLandscape";

const CONFIG: EcosystemLandscapeConfig = {
  version: 1,
  seed: "moli-landscape-alpha",
  regionCount: 5,
  roughness: 0.38,
  lowlandCoverage: 0.25,
  highlandCoverage: 0.25,
};

const BAND_RANK = {
  basin: 0,
  lowland: 1,
  plain: 2,
  highland: 3,
  ridge: 4,
} as const;

function landscapeFaces(width: number, height: number) {
  return Array.from({ length: width * height }, (_, index) => {
    const x = index % width;
    const y = Math.floor(index / width);
    const centerX = x - y;
    const centerY = (x + y) * 0.5;
    return {
      x,
      y,
      top: { x: centerX, y: centerY - 0.25 },
      right: { x: centerX + 0.5, y: centerY },
      bottom: { x: centerX, y: centerY + 0.25 },
      left: { x: centerX - 0.5, y: centerY },
    };
  });
}

describe("ecosystem landscape generation", () => {
  it("clamps region counts to the active grid rather than the global maximum", () => {
    expect(ecosystemLandscapeRegionCountLimit(2, 2)).toBe(4);
    expect(clampEcosystemLandscapeRegionCount(12, 2, 2)).toBe(4);
    expect(clampEcosystemLandscapeRegionCount(0, 12, 8)).toBe(
      MIN_ECOSYSTEM_LANDSCAPE_REGIONS,
    );
  });

  it("is byte-identical for the same explicit seed and config", () => {
    const first = generateEcosystemLandscape({ width: 12, height: 8, config: CONFIG });
    const second = generateEcosystemLandscape({ width: 12, height: 8, config: CONFIG });
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("locks v1 output fingerprints across representative seeds and sizes", () => {
    const cases = [
      { width: 8, height: 6, seed: "moli-landscape-alpha" },
      { width: 12, height: 8, seed: "moli-landscape-beta" },
      { width: 24, height: 16, seed: "moli-landscape-gamma" },
    ];
    expect(
      cases.map(({ width, height, seed }) =>
        ecosystemLandscapeFingerprint(
          generateEcosystemLandscape({
            width,
            height,
            config: { ...CONFIG, seed },
          }),
        ),
      ),
    ).toEqual(["c3fbfb52", "0e5c7c8f", "aed9b854"]);
  });

  it("changes coherent relief when the seed changes", () => {
    const first = generateEcosystemLandscape({ width: 12, height: 8, config: CONFIG });
    const second = generateEcosystemLandscape({
      width: 12,
      height: 8,
      config: { ...CONFIG, seed: "moli-landscape-beta" },
    });
    expect(second.cells.map((cell) => cell.band)).not.toEqual(
      first.cells.map((cell) => cell.band),
    );
  });

  it("meets authored coverage targets while preserving nested transition bands", () => {
    const landscape = generateEcosystemLandscape({ width: 10, height: 8, config: CONFIG });
    const counts = Object.fromEntries(
      ECOSYSTEM_LANDSCAPE_BANDS.map((band) => [
        band,
        landscape.cells.filter((cell) => cell.band === band).length,
      ]),
    );
    expect(counts).toEqual({
      basin: 4,
      lowland: 16,
      plain: 40,
      highland: 15,
      ridge: 5,
    });
  });

  it("never lets adjacent cells skip a surface band across representative seeds", () => {
    for (let index = 0; index < 64; index += 1) {
      const landscape = generateEcosystemLandscape({
        width: 12,
        height: 8,
        config: {
          ...CONFIG,
          seed: `adjacency-${index}`,
          roughness: (index % 11) / 10,
        },
      });
      const byPosition = new Map(
        landscape.cells.map((cell) => [`${cell.x}:${cell.y}`, cell]),
      );
      for (const cell of landscape.cells) {
        for (const [dx, dy] of [
          [1, 0],
          [0, 1],
        ] as const) {
          const neighbor = byPosition.get(`${cell.x + dx}:${cell.y + dy}`);
          if (neighbor) {
            expect(Math.abs(BAND_RANK[cell.band] - BAND_RANK[neighbor.band])).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it("keeps zero roughness spatial instead of falling back to row-order ties", () => {
    const landscape = generateEcosystemLandscape({
      width: 12,
      height: 8,
      config: { ...CONFIG, seed: "roughness-zero", roughness: 0 },
    });
    const glyph = { basin: "B", lowland: "l", plain: ".", highland: "h", ridge: "R" };
    const rows = Array.from({ length: 8 }, (_, y) =>
      landscape.cells
        .slice(y * 12, (y + 1) * 12)
        .map((cell) => glyph[cell.band])
        .join(""),
    );
    expect(rows).toEqual([
      "llllllllllll",
      "lBBllllll...",
      "lll.........",
      "............",
      ".hhhhh......",
      "hRRRRh......",
      "hRRRRRh.....",
      "hhhhhh......",
    ]);
  });

  it("owns each shared transition edge exactly once", () => {
    const landscape = generateEcosystemLandscape({ width: 12, height: 8, config: CONFIG });
    const byPosition = new Map(
      landscape.cells.map((cell) => [`${cell.x}:${cell.y}`, cell]),
    );
    for (const cell of landscape.cells) {
      const east = byPosition.get(`${cell.x + 1}:${cell.y}`);
      if (east) {
        const owners =
          Number((cell.contourMask & ECOSYSTEM_LANDSCAPE_CONTOUR.east) !== 0) +
          Number((east.contourMask & ECOSYSTEM_LANDSCAPE_CONTOUR.west) !== 0);
        expect(owners).toBe(cell.band === east.band ? 0 : 1);
      }
      const south = byPosition.get(`${cell.x}:${cell.y + 1}`);
      if (south) {
        const owners =
          Number((cell.contourMask & ECOSYSTEM_LANDSCAPE_CONTOUR.south) !== 0) +
          Number((south.contourMask & ECOSYSTEM_LANDSCAPE_CONTOUR.north) !== 0);
        expect(owners).toBe(cell.band === south.band ? 0 : 1);
      }
    }
  });

  it("returns one bounded row-major cell for every grid position", () => {
    const landscape = generateEcosystemLandscape({ width: 7, height: 5, config: CONFIG });
    expect(landscape.cells).toHaveLength(35);
    expect(landscape.cells.map(({ x, y }) => `${x}:${y}`)).toEqual(
      Array.from({ length: 35 }, (_, index) => `${index % 7}:${Math.floor(index / 7)}`),
    );
    expect(
      landscape.cells.every((cell) =>
        ECOSYSTEM_LANDSCAPE_BANDS.includes(cell.band),
      ),
    ).toBe(true);
  });

  it("builds a fixed, deterministic vector layer set with biome-specific marks", () => {
    const landscape = generateEcosystemLandscape({ width: 12, height: 8, config: CONFIG });
    const input = {
      landscape,
      seed: CONFIG.seed,
      faces: landscapeFaces(12, 8),
      physicsTerrainPositions: new Set<string>(),
    };
    const meadow = ecosystemLandscapeVisualPaths({ ...input, biomeId: "meadow" });
    const reef = ecosystemLandscapeVisualPaths({ ...input, biomeId: "reef" });

    expect(ecosystemLandscapeVisualPaths({ ...input, biomeId: "meadow" })).toEqual(meadow);
    expect(Object.values(meadow.marks).every((path) => path.length > 0)).toBe(true);
    expect(Object.values(reef.marks).every((path) => path.length > 0)).toBe(true);
    expect(reef.marks).not.toEqual(meadow.marks);
    expect(meadow.reliefShadow.length).toBeGreaterThan(0);
    expect(meadow.raisedFacet.length).toBeGreaterThan(0);
    expect(meadow.sunkenFacet.length).toBeGreaterThan(0);
    expect(meadow.contourSegmentCount).toBeGreaterThan(0);
    expect(meadow.decoratedCellCount).toBeLessThanOrEqual(landscape.cells.length);
    expect(JSON.stringify(meadow)).not.toContain("NaN");
  });

  it("removes every scenic vector mark when physics owns every cell", () => {
    const landscape = generateEcosystemLandscape({ width: 8, height: 6, config: CONFIG });
    const physicsTerrainPositions = new Set(
      landscape.cells.map((cell) => `${cell.x}:${cell.y}`),
    );
    const paths = ecosystemLandscapeVisualPaths({
      landscape,
      seed: CONFIG.seed,
      biomeId: "meadow",
      faces: landscapeFaces(8, 6),
      physicsTerrainPositions,
    });
    expect(Object.values(paths.marks).every((path) => path === "")).toBe(true);
    expect(paths.reliefShadow).toBe("");
    expect(paths.raisedFacet).toBe("");
    expect(paths.sunkenFacet).toBe("");
    expect(paths.contourSegmentCount).toBe(0);
    expect(paths.decoratedCellCount).toBe(0);
  });
});

describe("ecosystem landscape validation", () => {
  it("normalizes a valid config without inventing defaults", () => {
    expect(validateEcosystemLandscapeConfig(CONFIG, 12, 8)).toEqual(CONFIG);
  });

  it("rejects unknown versions, hidden fields, and impossible coverage", () => {
    expect(() =>
      validateEcosystemLandscapeConfig({ ...CONFIG, version: 2 }, 12, 8),
    ).toThrow("config.landscape.version must be 1");
    expect(() =>
      validateEcosystemLandscapeConfig({ ...CONFIG, threshold: 0.4 }, 12, 8),
    ).toThrow('config.landscape carries unknown field "threshold"');
    expect(() =>
      validateEcosystemLandscapeConfig(
        { ...CONFIG, lowlandCoverage: 0.45, highlandCoverage: 0.4 },
        12,
        8,
      ),
    ).toThrow("must not exceed 0.8");
  });

  it("bounds broad-region work independently of grid size", () => {
    expect(() =>
      validateEcosystemLandscapeConfig({ ...CONFIG, regionCount: 1 }, 12, 8),
    ).toThrow("config.landscape.regionCount must be from 2 through 12");
    expect(() =>
      validateEcosystemLandscapeConfig({ ...CONFIG, regionCount: 13 }, 100, 100),
    ).toThrow("config.landscape.regionCount must be from 2 through 12");
  });
});
