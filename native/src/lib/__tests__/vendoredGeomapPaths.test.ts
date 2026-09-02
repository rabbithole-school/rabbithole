import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  drawableFeatureCollection,
  drawablePath,
  pathStyleForPreset,
} from "../../../vendor/geomap/geo";
import type { GeoJsonFeatureCollection, LngLat } from "../../../vendor/geomap/types";

// A journey arrow MUST be drawn the same way on web and iPad. The web renderer
// (components/geomap/MapCanvas) and the native one (GeoMapNative) each build
// their own concrete layer objects — mapbox-gl vs @rnmapbox — but both take the
// GEOMETRY and the per-preset policy from this one framework-free module, so
// neither surface reimplements the curve. Native can't import repo-root lib/
// directly (metro never crawls outside the project root), so it consumes a
// vendored copy refreshed by `npm run sync:vendor`. This pins that copy to its
// source: if lib/geomap/geo.ts changes and the vendor copy isn't re-synced, this
// fails instead of a scholar's iPad quietly drawing different arrows.
const repoRoot = path.resolve(__dirname, "../../../..");

const ITALY: LngLat = [12.5, 42.5];
const HAWAII: LngLat = [-157.9, 21.3];
const GREECE: LngLat = [22, 39];
const TOKYO: LngLat = [139.7, 35.7];

const mercY = (lat: number) =>
  (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

describe("vendored geomap path drawing", () => {
  it("is byte-identical to the lib/ source web and convex use", () => {
    const source = readFileSync(path.join(repoRoot, "lib/geomap/geo.ts"), "utf8");
    const vendored = readFileSync(
      path.join(repoRoot, "native/vendor/geomap/geo.ts"),
      "utf8",
    );
    expect(vendored).toBe(source);
  });

  it("gives iPad the same per-preset policy web uses", () => {
    // A preset that arced on web and ran straight on iPad would be a
    // scholar-facing parity gap by construction.
    expect(pathStyleForPreset("arrows")).toBe("journeyArc");
    expect(pathStyleForPreset("routeLine")).toBe("shortWay");
    expect(pathStyleForPreset("regionOutline")).toBe("asAuthored");
    expect(pathStyleForPreset("regionFill")).toBe("asAuthored");
    expect(pathStyleForPreset("isolines")).toBe("asAuthored");
    expect(pathStyleForPreset("points")).toBe("asAuthored");
  });

  it("lifts a journey arrow straight north, exactly as web does", () => {
    const runs = drawablePath([ITALY, HAWAII], "journeyArc");
    expect(runs).toHaveLength(1);
    const pts = runs[0];
    expect(pts[0]).toEqual(ITALY);
    expect(pts[pts.length - 1]).toEqual(HAWAII);

    // The signature of a vertical control point: every sample shares its
    // longitude with the straight chord and differs only in height.
    // Short way round: Italy → Hawaiʻi is 170.4° WESTWARD, not east.
    let dx = HAWAII[0] - ITALY[0];
    if (dx > 180) dx -= 360;
    if (dx < -180) dx += 360;
    const dy = mercY(HAWAII[1]) - mercY(ITALY[1]);
    const n = pts.length - 1;
    let maxLift = 0;
    pts.forEach((p, i) => {
      const t = i / n;
      let px = p[0] - ITALY[0];
      if (px > 180) px -= 360;
      if (px < -180) px += 360;
      expect(Math.abs(px - dx * t)).toBeLessThan(1e-8);
      maxLift = Math.max(maxLift, mercY(p[1]) - (mercY(ITALY[1]) + dy * t));
    });
    expect(maxLift).toBeGreaterThan(1);
    expect(maxLift).toBeLessThanOrEqual(18 + 1e-6);
  });

  it("takes the short way round and splits at the antimeridian", () => {
    // Untreated, Tokyo → Honolulu is a 6,200 km hop drawn as a ~19,000 km
    // detour backwards across Eurasia — on iPad just as on web.
    const runs = drawablePath([TOKYO, HAWAII], "journeyArc");
    expect(runs.length).toBeGreaterThan(1);
    for (const run of runs) {
      for (const [lng] of run) {
        expect(lng).toBeGreaterThanOrEqual(-180);
        expect(lng).toBeLessThanOrEqual(180);
      }
      for (let i = 1; i < run.length; i++) {
        expect(Math.abs(run[i][0] - run[i - 1][0])).toBeLessThan(180);
      }
    }
  });

  it("honors a hand-routed waypoint chain", () => {
    const basil: LngLat[] = [
      [78, 20],
      [60, 10],
      [20, -20],
      [-20, -30],
      [-70, -30],
      [-120, 0],
      [-157.9, 21.3],
    ];
    const pts = drawablePath(basil, "journeyArc").flat();
    for (const wp of basil) {
      const nearest = Math.min(
        ...pts.map((p) => Math.hypot(p[0] - wp[0], p[1] - wp[1])),
      );
      expect(nearest).toBeLessThan(0.01);
    }
  });

  it("leaves a river literal — routeLine is not a journey", () => {
    const river: LngLat[] = [
      [-90.2, 38.6],
      [-90.1, 35.1],
      [-91.2, 30.5],
      [-89.4, 29.2],
    ];
    expect(drawablePath(river, "shortWay")).toEqual([river]);
  });

  it("returns surveyed collections by reference, so borders can't be bent", () => {
    const polygonFc: GeoJsonFeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name: "Somewhere" },
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [-120, 20],
                [20, 20],
                [20, 60],
                [-120, 60],
                [-120, 20],
              ],
            ],
          },
        },
      ],
    };
    expect(drawableFeatureCollection(polygonFc, "asAuthored")).toBe(polygonFc);
    expect(drawableFeatureCollection(polygonFc, "journeyArc")).toBe(polygonFc);
  });

  it("never throws on malformed stored geometry — this runs during render", () => {
    // GeoMapNative resolves source data INSIDE render, so a throw here is a
    // white screen on a child's iPad rather than a caught error. The storage
    // boundary validates only that `features` is an array, so `features:[null]`
    // and `coordinates:[null,[1,2]]` arrive intact from a stored spec.
    const malformed = [
      { type: "FeatureCollection", features: [null] },
      {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: {},
            geometry: { type: "LineString", coordinates: [null, [1, 2]] },
          },
        ],
      },
      { type: "FeatureCollection", features: "not an array" },
    ] as unknown as GeoJsonFeatureCollection[];

    for (const fc of malformed) {
      for (const style of ["journeyArc", "shortWay", "asAuthored"] as const) {
        expect(() => drawableFeatureCollection(fc, style)).not.toThrow();
        expect(drawableFeatureCollection(fc, style)).toBe(fc);
      }
    }
  });

  it("keeps a seam-crossing arc inside ±180 on iPad too", () => {
    // A run whose middle ELEMENT is the +180 boundary point used to normalize
    // to [-220.3, -180] — off the map entirely.
    for (const style of ["journeyArc", "shortWay"] as const) {
      for (const run of drawablePath([TOKYO, HAWAII], style)) {
        for (const [lng] of run) {
          expect(lng).toBeGreaterThanOrEqual(-180);
          expect(lng).toBeLessThanOrEqual(180);
        }
      }
    }
  });

  it("cannot have its arc turned off by a stored property", () => {
    const forged: GeoJsonFeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { __geomapDrawn: true },
          geometry: { type: "LineString", coordinates: [ITALY, HAWAII] },
        },
      ],
    };
    const out = drawableFeatureCollection(forged, "journeyArc");
    expect(out).not.toBe(forged);
  });

  it("budgets interpolation so a dense polyline cannot blow up a ShapeSource", () => {
    const dense: LngLat[] = [];
    for (let i = 0; i < 3000; i++) dense.push([-100 + i * 0.01, 40 + Math.sin(i / 50)]);
    const fc: GeoJsonFeatureCollection = {
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: dense } },
      ],
    };
    const out = drawableFeatureCollection(fc, "journeyArc");
    const coords = (out.features[0].geometry as { coordinates: LngLat[] }).coordinates;
    // ~2x, not the 24x the per-segment smoothing floor would have produced.
    expect(coords.length).toBeLessThanOrEqual(dense.length * 2 + 1);
  });

  it("still arcs EVERY arrow of a dense MultiLineString on iPad", () => {
    // The budget counts adjacent pairs, so 1,001 separate two-point arrows
    // scored like one 1,001-point polyline and every arrow rendered straight —
    // the whole feature silently losing its arcs on a child's iPad.
    const arrows: LngLat[][] = Array.from({ length: 1001 }, (_, i) => [
      [-170 + (i % 300) * 0.5, -40 + (i % 70)],
      [-170 + (i % 300) * 0.5 + 60, -40 + (i % 70) + 20],
    ]);
    const fc: GeoJsonFeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: { type: "MultiLineString", coordinates: arrows },
        },
      ],
    };
    const out = drawableFeatureCollection(fc, "journeyArc");
    const parts = (out.features[0].geometry as { coordinates: LngLat[][] }).coordinates;
    for (const part of parts) expect(part.length).toBeGreaterThanOrEqual(3);
  });

  it("degrades an absurd coordinate instead of hanging the React render", () => {
    // This transform runs INSIDE GeoMapNative's render, so a non-terminating
    // loop in the world arithmetic is a frozen iPad for a child, not a caught
    // error. Coordinate range is not validated at the storage boundary, so 1e20
    // can arrive from a stored spec.
    for (const v of [1e20, -1e20, 1e300, Number.MAX_VALUE]) {
      for (const style of ["journeyArc", "shortWay"] as const) {
        const coords: LngLat[] = [
          [v, 10],
          [12.5, 42.5],
        ];
        const fc: GeoJsonFeatureCollection = {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: {},
              geometry: { type: "LineString", coordinates: coords },
            },
          ],
        };
        expect(drawableFeatureCollection(fc, style)).toBe(fc);
        expect(drawablePath(coords, style)).toEqual([coords]);
      }
    }
  });

  it("keeps a journey drawn ALONG the seam as one contiguous run", () => {
    // Float rounding in the Bézier's x term made a due-north arrow on ±180
    // fragment into several runs, which on @rnmapbox restarts arrowhead
    // placement at every fragment — one journey rendered as several.
    const runs = drawablePath([[180, 10], [180, 40]], "journeyArc");
    expect(runs).toHaveLength(1);
    expect(new Set(runs[0].map((p) => p[0])).size).toBe(1);
    for (const [lng] of runs[0]) {
      expect(lng).toBeGreaterThanOrEqual(-180);
      expect(lng).toBeLessThanOrEqual(180);
    }
  });

  it("emits no degenerate run for an endpoint sitting on ±180", () => {
    for (const coords of [
      [[170, 0], [180, 0]],
      [[180, 0], [170, 10]],
    ] as LngLat[][]) {
      for (const run of drawablePath(coords, "journeyArc")) {
        expect(run.some((p) => p[0] !== run[0][0] || p[1] !== run[0][1])).toBe(true);
        for (const [lng] of run) {
          expect(lng).toBeGreaterThanOrEqual(-180);
          expect(lng).toBeLessThanOrEqual(180);
        }
      }
    }
  });

  it("is idempotent, so a re-render cannot compound the arc", () => {
    // GeoMapNative resolves inside render; a second pass must be a no-op.
    const fc: GeoJsonFeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates: [ITALY, GREECE] },
        },
      ],
    };
    const once = drawableFeatureCollection(fc, "journeyArc");
    const twice = drawableFeatureCollection(once, "journeyArc");
    expect(twice.features.map((f) => f.geometry)).toEqual(
      once.features.map((f) => f.geometry),
    );
  });
});
