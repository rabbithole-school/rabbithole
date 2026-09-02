import { describe, expect, test } from "vitest";
import { haversineKm, pointInRegion } from "../geo";
import { isSolved, parseTaskState } from "../grade";
import { validateSpec, validateScholarPins } from "../validate";
import { redactTaskForClient, type GeoJsonFeatureCollection, type GeoMapSpec, type GeoTask } from "../types";
import { registryKeys, resolveRegion, listRegistryEntries } from "../registry";
import { OAHU_WIND_OVERLAY_ID } from "../registry/keys";
import { HISTORICAL_BASEMAPS, historicalBasemapKeys } from "../historicalBasemaps";

// Known anchors (lng, lat)
const HONOLULU: [number, number] = [-157.8583, 21.3069];
const KANEOHE: [number, number] = [-157.8036, 21.4097];
const DC: [number, number] = [-77.0369, 38.9072];
const NYC: [number, number] = [-74.006, 40.7128];

describe("haversineKm", () => {
  test("zero distance to self", () => {
    expect(haversineKm(DC, DC)).toBe(0);
  });
  test("DC to NYC ≈ 328 km", () => {
    const d = haversineKm(DC, NYC);
    expect(d).toBeGreaterThan(310);
    expect(d).toBeLessThan(345);
  });
  test("Honolulu to Kāneʻohe ≈ 13 km", () => {
    const d = haversineKm(HONOLULU, KANEOHE);
    expect(d).toBeGreaterThan(10);
    expect(d).toBeLessThan(16);
  });
  test("antimeridian-adjacent points stay finite and sane", () => {
    const d = haversineKm([179.9, 0], [-179.9, 0]);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(30); // ~22 km across the seam, not half the planet
  });
});

const square = (west: number, south: number, east: number, north: number) =>
  [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ] as [number, number][];

const regionWithHole: GeoJsonFeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [square(0, 0, 10, 10), square(4, 4, 6, 6)],
      },
      properties: {},
    },
  ],
};

describe("pointInRegion", () => {
  test("inside outer ring", () => {
    expect(pointInRegion([2, 2], regionWithHole)).toBe(true);
  });
  test("inside a hole counts as outside", () => {
    expect(pointInRegion([5, 5], regionWithHole)).toBe(false);
  });
  test("outside entirely", () => {
    expect(pointInRegion([20, 20], regionWithHole)).toBe(false);
  });
  test("multipolygon: any part matches", () => {
    const multi: GeoJsonFeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "MultiPolygon",
            coordinates: [[square(0, 0, 1, 1)], [square(10, 10, 11, 11)]],
          },
          properties: {},
        },
      ],
    };
    expect(pointInRegion([10.5, 10.5], multi)).toBe(true);
    expect(pointInRegion([5, 5], multi)).toBe(false);
  });
});

describe("isSolved", () => {
  const locate: GeoTask = { kind: "locate", prompt: "Find DC", target: DC, toleranceKm: 50 };

  test("locate: last pin within tolerance", () => {
    expect(isSolved(locate, { pins: [{ id: "a", lngLat: [-77.1, 38.95] }] })).toBe(true);
  });
  test("locate: last pin outside tolerance", () => {
    expect(isSolved(locate, { pins: [{ id: "a", lngLat: NYC }] })).toBe(false);
  });
  test("locate: LAST pin is the answer (earlier correct pin doesn't count)", () => {
    expect(
      isSolved(locate, {
        pins: [
          { id: "right", lngLat: DC },
          { id: "wrong", lngLat: NYC },
        ],
      }),
    ).toBe(false);
  });
  test("locate: no pins → unsolved", () => {
    expect(isSolved(locate, { pins: [] })).toBe(false);
  });

  test("region: resolver-backed point-in-polygon; unresolvable never solves", () => {
    const region: GeoTask = {
      kind: "region",
      prompt: "Tap inside the square",
      targetRegion: { registry: "test-square" },
    };
    const resolver = (k: string) => (k === "test-square" ? regionWithHole : undefined);
    expect(isSolved(region, { pins: [{ id: "a", lngLat: [2, 2] }] }, resolver)).toBe(true);
    expect(isSolved(region, { pins: [{ id: "a", lngLat: [5, 5] }] }, resolver)).toBe(false);
    expect(isSolved(region, { pins: [{ id: "a", lngLat: [2, 2] }] }, () => undefined)).toBe(false);
  });

  test("pinSet: needs a DISTINCT pin per target (greedy-trap case solved by backtracking)", () => {
    // Target A tolerance covers both pins; target B only covers pin 1. A
    // greedy matcher that gives pin 1 to target A would wrongly fail.
    const task: GeoTask = {
      kind: "pinSet",
      prompt: "Pin both",
      targets: [
        { lngLat: [0, 0], toleranceKm: 500 }, // A: generous
        { lngLat: [1, 0], toleranceKm: 60 }, // B: tight, only near pin 1
      ],
    };
    const pins = [
      { id: "p1", lngLat: [1.1, 0] as [number, number] }, // near B (and inside A's radius)
      { id: "p2", lngLat: [0.5, 0.5] as [number, number] }, // only inside A
    ];
    expect(isSolved(task, { pins })).toBe(true);
  });
  test("pinSet: one pin can't claim two targets", () => {
    const task: GeoTask = {
      kind: "pinSet",
      prompt: "Pin both",
      targets: [
        { lngLat: [0, 0], toleranceKm: 100 },
        { lngLat: [0.1, 0], toleranceKm: 100 },
      ],
    };
    expect(isSolved(task, { pins: [{ id: "only", lngLat: [0.05, 0] }] })).toBe(false);
  });
});

describe("parseTaskState", () => {
  test("round-trips clean pins and drops junk", () => {
    const parsed = parseTaskState(
      JSON.stringify({ pins: [{ id: "a", lngLat: [1, 2] }, { id: "bad", lngLat: [999, 0] }, null] }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.pins).toHaveLength(1);
    expect(parsed!.pins[0].lngLat).toEqual([1, 2]);
  });
  test("garbage → null", () => {
    expect(parseTaskState("not json")).toBeNull();
    expect(parseTaskState('{"nope":true}')).toBeNull();
  });
});

const baseSpec = (): GeoMapSpec => ({
  v: 1,
  id: "m1",
  camera: { center: HONOLULU, zoom: 9 },
  base: "satellite",
});

describe("validateSpec", () => {
  const keys = registryKeys();

  test("minimal valid spec passes", () => {
    expect(validateSpec(baseSpec(), { registryKeys: keys })).toEqual({ ok: true });
  });
  test("rejects unknown base and bad camera", () => {
    expect(
      validateSpec({ ...baseSpec(), base: "watercolor" as never }, { registryKeys: keys }).ok,
    ).toBe(false);
    expect(
      validateSpec(
        { ...baseSpec(), camera: { center: [200, 0], zoom: 5 } },
        { registryKeys: keys },
      ).ok,
    ).toBe(false);
  });
  test("historicalBasemap: accepts curated era keys, rejects unknown", () => {
    const eraKeys = historicalBasemapKeys();
    expect(eraKeys.has("europe-1914")).toBe(true);
    expect(
      validateSpec(
        { ...baseSpec(), historicalBasemap: "europe-1914" },
        { registryKeys: keys, historicalBasemapKeys: eraKeys },
      ),
    ).toEqual({ ok: true });
    expect(
      validateSpec(
        { ...baseSpec(), historicalBasemap: "atlantis-9000" },
        { registryKeys: keys, historicalBasemapKeys: eraKeys },
      ).ok,
    ).toBe(false);
    // Every era's datasetId must resolve in the registry (data ↔ style pairing).
    for (const entry of Object.values(HISTORICAL_BASEMAPS)) {
      expect(keys.has(entry.datasetId), `dataset ${entry.datasetId}`).toBe(true);
    }
  });

  test("rejects unknown registry key; accepts a real one", () => {
    const withLayer = (key: string): GeoMapSpec => ({
      ...baseSpec(),
      layers: [{ id: "l1", label: "L", source: { registry: key }, paint: "arrows" }],
    });
    expect(validateSpec(withLayer("no-such-key"), { registryKeys: keys }).ok).toBe(false);
    expect(validateSpec(withLayer(OAHU_WIND_OVERLAY_ID), { registryKeys: keys }).ok).toBe(true);
  });
  test("rejects oversize inline geojson", () => {
    const big: GeoMapSpec = {
      ...baseSpec(),
      layers: [
        {
          id: "l1",
          label: "big",
          paint: "points",
          source: {
            geojson: {
              type: "FeatureCollection",
              features: Array.from({ length: 2000 }, (_, i) => ({
                type: "Feature" as const,
                geometry: { type: "Point" as const, coordinates: [i % 180, 0] as [number, number] },
                properties: { filler: "x".repeat(40) },
              })),
            },
          },
        },
      ],
    };
    const res = validateSpec(big, { registryKeys: keys });
    expect(res.ok).toBe(false);
  });
  test("step referencing unknown layer fails", () => {
    const spec: GeoMapSpec = {
      ...baseSpec(),
      steps: [{ id: "s1", label: "S", visibleLayerIds: ["ghost"] }],
    };
    expect(validateSpec(spec, { registryKeys: keys }).ok).toBe(false);
  });
});

describe("validateScholarPins", () => {
  test("accepts clean pins, rejects invalid coords", () => {
    expect(validateScholarPins([{ id: "a", lngLat: [1, 2] }]).ok).toBe(true);
    expect(validateScholarPins([{ id: "a", lngLat: [181, 2] }]).ok).toBe(false);
    expect(validateScholarPins("nope").ok).toBe(false);
  });
});

describe("redactTaskForClient", () => {
  test("locate target is blanked", () => {
    const r = redactTaskForClient({ kind: "locate", prompt: "p", target: DC, toleranceKm: 5 });
    expect((r as { target: [number, number] }).target).toEqual([0, 0]);
  });
  test("region key is blanked", () => {
    const r = redactTaskForClient({
      kind: "region",
      prompt: "p",
      targetRegion: { registry: "secret" },
    });
    expect((r as { targetRegion: { registry: string } }).targetRegion.registry).toBe("");
  });
});

describe("registry", () => {
  test("every entry carries provenance and resolves", () => {
    for (const e of listRegistryEntries()) {
      expect(e.source.length).toBeGreaterThan(0);
      expect(e.license.length).toBeGreaterThan(0);
      expect(e.notes.length).toBeGreaterThan(0);
      expect(e.data.type).toBe("FeatureCollection");
    }
  });
  test("resolveRegion only resolves region-kind entries", () => {
    expect(resolveRegion(OAHU_WIND_OVERLAY_ID)).toBeUndefined(); // overlay, not region
    expect(resolveRegion("region-usa")).toBeDefined();
  });
  test("every key the seeded quests reference exists (drift guard)", () => {
    const keys = registryKeys();
    for (const k of [
      OAHU_WIND_OVERLAY_ID,
      "oahu-rainfall",
      "europe-1914",
      "ww1-blocs-entente",
      "ww1-blocs-alliance",
      "europe-today",
      "region-usa",
    ]) {
      expect(keys.has(k), `registry key ${k}`).toBe(true);
    }
  });
});
