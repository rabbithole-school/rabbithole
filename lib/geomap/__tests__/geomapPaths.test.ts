/**
 * How a journey is DRAWN on a flat map — `drawablePath` /
 * `drawableFeatureCollection` (lib/geomap/geo).
 *
 * Every assertion here is on GEOMETRY: where the drawn line actually goes, in
 * kilometres from named places, or in the shape of the curve itself. Nothing
 * asserts pixel counts or prompt wording.
 *
 * The fixtures are the real broken prod spec (a session where the tutor drew
 * five food-origin arrows and a grade-4 scholar spent two days correctly
 * telling it the arrows were wrong): a two-point Italy → Hawaiʻi haul, a
 * three-point Greece → Italy → Hawaiʻi chain, and a seven-waypoint basil
 * corridor the tutor had hand-routed around Africa and South America.
 *
 * The doctrine under test (see paintPresets.ts): a journey arrow is DIAGRAM.
 * It must never imply precision the author didn't specify — so the shape is a
 * uniform schematic arc, and the tests police uniformity, boundedness and the
 * author's own vertices, NOT geographic fidelity.
 */
import { describe, expect, test } from "vitest";
import { drawableFeatureCollection, drawablePath, haversineKm } from "../geo";
import type { GeoJsonFeatureCollection, LngLat } from "../types";

// Anchors, all [lng, lat].
const ITALY: LngLat = [12.5, 42.5];
const HAWAII: LngLat = [-157.9, 21.3];
const GREECE: LngLat = [22, 39];
const TOKYO: LngLat = [139.7, 35.7];

/** The seven-waypoint basil corridor, verbatim from the prod artifact. */
const BASIL: LngLat[] = [
  [78, 20],
  [60, 10],
  [20, -20],
  [-20, -30],
  [-70, -30],
  [-120, 0],
  [-157.9, 21.3],
];

const allPoints = (runs: LngLat[][]): LngLat[] => runs.flat();

/** Closest approach of a drawn path to a place, in km. */
const closestKm = (runs: LngLat[][], place: LngLat): number =>
  Math.min(...allPoints(runs).map((p) => haversineKm(p, place)));

/** Total positions across a collection's geometries. */
const totalCoords = (fc: GeoJsonFeatureCollection): number => {
  const deep = (x: unknown): number => {
    if (Array.isArray(x) && typeof x[0] === "number") return 1;
    if (Array.isArray(x)) return (x as unknown[]).reduce((n: number, i) => n + deep(i), 0);
    return 0;
  };
  return fc.features.reduce(
    (n, f) => n + deep((f.geometry as { coordinates?: unknown })?.coordinates),
    0,
  );
};

const lineFc = (coords: LngLat[]): GeoJsonFeatureCollection => ({
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } },
  ],
});

// Mercator y in the same degree units the renderer bows in — the arc is a
// screen idiom, so its shape is judged in screen space.
const mercY = (lat: number) =>
  (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

/**
 * The arc's vertical lift above the straight chord, per sample, in Mercator
 * degrees — and the longitude the straight chord would have had at the same
 * parameter. The control point is the chord midpoint lifted straight north, so
 * these two together fully characterise the shape.
 */
function liftProfile(run: LngLat[], a: LngLat, b: LngLat) {
  const x0 = a[0];
  const y0 = mercY(a[1]);
  let dx = b[0] - a[0];
  if (dx > 180) dx -= 360;
  if (dx < -180) dx += 360;
  const dy = mercY(b[1]) - y0;
  const n = run.length - 1;
  return run.map((p, i) => {
    const t = i / n;
    let px = p[0] - x0;
    if (px > 180) px -= 360;
    if (px < -180) px += 360;
    return {
      t,
      lngDrift: px - dx * t, // 0 ⇒ same longitude as the straight chord
      lift: mercY(p[1]) - (y0 + dy * t), // >0 ⇒ north of the chord
    };
  });
}

const chordLen = (a: LngLat, b: LngLat) => {
  let dx = b[0] - a[0];
  if (dx > 180) dx -= 360;
  if (dx < -180) dx += 360;
  return Math.hypot(dx, mercY(b[1]) - mercY(a[1]));
};

describe("a journey arrow is lifted NORTH, not bowed perpendicular", () => {
  // The shape rule the founder set: "the arrows in the example are skewed
  // _north_ in screenspace and are much more beautiful". A perpendicular bow
  // only coincides with north for horizontal chords; on a diagonal it slews the
  // arc sideways and a fan of arrows stops reading as one family.

  test("Italy → Hawaiʻi lifts north and keeps the author's endpoints", () => {
    const runs = drawablePath([ITALY, HAWAII], "journeyArc");
    const pts = allPoints(runs);
    expect(pts[0]).toEqual(ITALY);
    expect(pts[pts.length - 1]).toEqual(HAWAII);

    const prof = liftProfile(pts, ITALY, HAWAII);
    // Never dips below the chord: a single clean lift, not an S-curve.
    expect(Math.min(...prof.map((q) => q.lift))).toBeGreaterThan(-1e-6);
    // ...and it genuinely lifts rather than lying flat on the chord.
    expect(Math.max(...prof.map((q) => q.lift))).toBeGreaterThan(1);
  });

  test("the displacement is PURELY vertical — longitudes track the chord", () => {
    // The signature of a vertical control point: at every parameter the arc
    // shares its longitude with the straight chord and differs only in height.
    // A perpendicular bow would drift the longitudes off the chord.
    for (const [a, b] of [
      [ITALY, HAWAII],
      [GREECE, ITALY],
      // Diagonals are where perpendicular and vertical actually disagree.
      [ITALY, [10.2, 36.8]] as [LngLat, LngLat],
      [[9.1, 42.2], [12.5, 41.9]] as [LngLat, LngLat],
    ] as Array<[LngLat, LngLat]>) {
      const runs = drawablePath([a, b], "journeyArc");
      expect(runs).toHaveLength(1);
      for (const q of liftProfile(runs[0], a, b)) {
        expect(Math.abs(q.lngDrift)).toBeLessThan(1e-9);
      }
    }
  });

  test("the apex sits directly north of the chord midpoint", () => {
    const runs = drawablePath([ITALY, HAWAII], "journeyArc");
    const prof = liftProfile(runs.flat(), ITALY, HAWAII);
    const apex = prof.reduce((m, q) => (q.lift > m.lift ? q : m));
    // Peak lift lands at the middle of the chord, not off to one side.
    expect(apex.t).toBeCloseTo(0.5, 2);
    expect(Math.abs(apex.lngDrift)).toBeLessThan(1e-9);
  });

  test("the lift is bounded — a half-world haul does not balloon over the pole", () => {
    const runs = drawablePath([ITALY, HAWAII], "journeyArc");
    const lifts = liftProfile(allPoints(runs), ITALY, HAWAII).map((q) => q.lift);
    // Capped, so the arc reads as a flight path rather than a polar detour.
    expect(Math.max(...lifts)).toBeLessThanOrEqual(18 + 1e-6);
    // The true great circle reaches 82.7°N. A schematic arc must not go near
    // that: it would be asserting a polar route it was never told about.
    expect(Math.max(...allPoints(runs).map((p) => p[1]))).toBeLessThan(60);
  });

  test("a SHORT hop lifts too — uniformity is what makes it read as vocabulary", () => {
    const runs = drawablePath([GREECE, ITALY], "journeyArc");
    const pts = allPoints(runs);
    expect(pts.length).toBeGreaterThan(8);
    const lifts = liftProfile(pts, GREECE, ITALY).map((q) => q.lift);
    expect(Math.max(...lifts)).toBeGreaterThan(0.2);
    expect(Math.min(...lifts)).toBeGreaterThan(-1e-6);
  });

  test("lift scales with chord length at one ratio, until it caps", () => {
    // The uniformity claim, made numerically: short and mid hops share one
    // ratio, so no length is visually privileged.
    const liftOf = (a: LngLat, b: LngLat) =>
      Math.max(...liftProfile(allPoints(drawablePath([a, b], "journeyArc")), a, b).map((q) => q.lift));
    const short: [LngLat, LngLat] = [GREECE, ITALY];
    const mid: [LngLat, LngLat] = [
      [13.4, 52.5],
      [-9.1, 38.7],
    ];
    const shortRatio = liftOf(...short) / chordLen(...short);
    const midRatio = liftOf(...mid) / chordLen(...mid);
    expect(shortRatio).toBeCloseTo(midRatio, 2);
    expect(shortRatio).toBeGreaterThan(0.05);
    expect(shortRatio).toBeLessThan(0.25);
  });

  test("a due north/south journey comes out almost straight, with no special case", () => {
    // The control point lands nearly ON the chord, so the curve degrades to a
    // near-straight line — which is how airline maps draw such routes anyway.
    const from: LngLat = [0, 10];
    const to: LngLat = [0, 50];
    const runs = drawablePath([from, to], "journeyArc");
    expect(runs).toHaveLength(1);
    for (const [lng] of runs[0]) expect(Math.abs(lng - 0)).toBeLessThan(1e-9);
    // Monotonic in latitude: no doubling back past the endpoints.
    const lats = runs[0].map((p) => p[1]);
    for (let i = 1; i < lats.length; i++) expect(lats[i]).toBeGreaterThan(lats[i - 1]);
    expect(lats[0]).toBeCloseTo(10, 6);
    expect(lats[lats.length - 1]).toBeCloseTo(50, 6);
  });

  test("every point stays on the map — no world-wrapping line", () => {
    for (const coords of [[ITALY, HAWAII], [TOKYO, HAWAII], BASIL]) {
      for (const run of drawablePath(coords, "journeyArc")) {
        for (const [lng, lat] of run) {
          expect(lng).toBeGreaterThanOrEqual(-180);
          expect(lng).toBeLessThanOrEqual(180);
          expect(Math.abs(lat)).toBeLessThanOrEqual(90);
        }
        for (let i = 1; i < run.length; i++) {
          expect(Math.abs(run[i][0] - run[i - 1][0])).toBeLessThan(180);
        }
      }
    }
  });
});

describe("the short way round", () => {
  // Mercator lerps longitude linearly, so 139.7 → -157.9 is drawn WESTWARD
  // through 0: a 6,200 km hop rendered as a ~19,000 km detour backwards across
  // Asia, Europe, Africa and the Atlantic. Nobody authors that.
  test("Tokyo → Honolulu crosses the Pacific, not Eurasia", () => {
    const runs = drawablePath([TOKYO, HAWAII], "journeyArc");
    expect(closestKm(runs, [20, 10])).toBeGreaterThan(5000); // central Africa
    expect(closestKm(runs, [78, 20])).toBeGreaterThan(3000); // India
    expect(closestKm(runs, [-40, 30])).toBeGreaterThan(3000); // mid-Atlantic
    expect(closestKm(runs, [-170, 40])).toBeLessThan(2000); // north Pacific
  });

  test("splits at the antimeridian instead of lashing across the world", () => {
    const runs = drawablePath([TOKYO, HAWAII], "journeyArc");
    expect(runs.length).toBeGreaterThan(1);
    // The seam is met exactly and rejoined on the far side, so there is no gap.
    const ends = runs.map((r) => r[r.length - 1][0]);
    expect(ends.some((lng) => Math.abs(Math.abs(lng) - 180) < 1e-9)).toBe(true);
  });

  test("an author who hand-placed antimeridian waypoints is not mangled", () => {
    // The show_map tool text tells the model to add "points around the
    // antimeridian when crossing the Pacific". Those points stay harmless.
    const runs = drawablePath([TOKYO, [179, 30], [-179, 29], HAWAII], "journeyArc");
    expect(closestKm(runs, [179, 30])).toBeLessThan(1);
    expect(closestKm(runs, [-179, 29])).toBeLessThan(1);
    expect(closestKm(runs, [20, 10])).toBeGreaterThan(5000);
  });
});

describe("hand-routed waypoint chains are honored", () => {
  test("every authored basil waypoint is still on the drawn path", () => {
    // The tutor routed this corridor by hand around Africa and South America.
    // Those vertices are the author's actual claim.
    const runs = drawablePath(BASIL, "journeyArc");
    for (const wp of BASIL) expect(closestKm(runs, wp)).toBeLessThan(1);
  });

  test("the corridor is not flattened into one arc", () => {
    // Sample the authored polyline finely, then measure how far the drawn path
    // ever strays from it. The arcs bow off each hop by design — but only by a
    // bow, never enough to abandon the corridor the tutor routed.
    const authored: LngLat[] = [];
    for (let i = 0; i < BASIL.length - 1; i++) {
      for (let k = 0; k < 60; k++) {
        const t = k / 60;
        authored.push([
          BASIL[i][0] + (BASIL[i + 1][0] - BASIL[i][0]) * t,
          BASIL[i][1] + (BASIL[i + 1][1] - BASIL[i][1]) * t,
        ]);
      }
    }
    authored.push(BASIL[BASIL.length - 1]);
    const strayKm = (runs: LngLat[][]) =>
      Math.max(...allPoints(runs).map((p) => Math.min(...authored.map((q) => haversineKm(p, q)))));

    expect(strayKm(drawablePath(BASIL, "journeyArc"))).toBeLessThan(1200);
    // Whereas collapsing it to a single India → Hawaiʻi arc abandons the
    // corridor entirely — which is exactly what honoring waypoints prevents.
    const direct = drawablePath([BASIL[0], BASIL[BASIL.length - 1]], "journeyArc");
    expect(strayKm(direct)).toBeGreaterThan(4000);
  });

  test("a three-point chain keeps its middle vertex", () => {
    // Greece → Italy → Hawaiʻi, prod's oregano arrow.
    const runs = drawablePath([GREECE, ITALY, HAWAII], "journeyArc");
    expect(closestKm(runs, GREECE)).toBeLessThan(1);
    expect(closestKm(runs, ITALY)).toBeLessThan(1);
    expect(closestKm(runs, HAWAII)).toBeLessThan(1);
  });
});

describe("routeLine stays literal — a river is not a journey", () => {
  test("authored vertices are drawn exactly as given, with no arc", () => {
    const river: LngLat[] = [
      [-90.2, 38.6],
      [-90.1, 35.1],
      [-91.2, 30.5],
      [-89.4, 29.2],
    ];
    const runs = drawablePath(river, "shortWay");
    expect(runs).toEqual([river]);
  });

  test("a collection of literal line-work keeps its identity", () => {
    const fc = lineFc([
      [-90.2, 38.6],
      [-89.4, 29.2],
    ]);
    expect(drawableFeatureCollection(fc, "shortWay")).toBe(fc);
  });

  test("but the wrong-way-round artifact is still corrected", () => {
    // A literal Pacific route must not be drawn backwards across the world;
    // that is an interpolation bug, not the author's line.
    const runs = drawablePath([TOKYO, HAWAII], "shortWay");
    expect(closestKm(runs, [20, 10])).toBeGreaterThan(5000);
    for (const run of runs) {
      for (let i = 1; i < run.length; i++) {
        expect(Math.abs(run[i][0] - run[i - 1][0])).toBeLessThan(180);
      }
    }
  });
});

describe("surveyed geometry is never touched", () => {
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

  test("an asAuthored collection comes back by reference", () => {
    // Bending a border would redraw a country.
    expect(drawableFeatureCollection(polygonFc, "asAuthored")).toBe(polygonFc);
  });

  test("polygons survive even under a journey style", () => {
    // Belt-and-braces: geometry type alone protects a polygon, so a mis-set
    // preset still cannot corrupt a border.
    expect(drawableFeatureCollection(polygonFc, "journeyArc")).toBe(polygonFc);
  });

  test("points are untouched", () => {
    const pointFc: GeoJsonFeatureCollection = {
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: HAWAII } },
      ],
    };
    expect(drawableFeatureCollection(pointFc, "journeyArc")).toBe(pointFc);
  });

  test("an isoline is left exactly as authored", () => {
    const contour: LngLat[] = [
      [-157.9, 21.4],
      [-157.8, 21.45],
      [-157.7, 21.5],
    ];
    expect(drawablePath(contour, "asAuthored")).toEqual([contour]);
  });
});

describe("regressions found in cross-family review of #3333", () => {
  test("a two-point eastward seam crossing stays inside ±180", () => {
    // The split leaves the boundary longitude as a real ELEMENT, so for a
    // two-point crossing the middle element IS 180. Choosing the run's world
    // from it shifted [139.7, 180] to [-220.3, -180] — off the map, and the
    // pre-seam leg drawn in the next world copy.
    for (const style of ["shortWay", "journeyArc"] as const) {
      const runs = drawablePath([TOKYO, HAWAII], style);
      expect(runs.length).toBeGreaterThan(1);
      for (const run of runs) {
        for (const [lng] of run) {
          expect(lng).toBeGreaterThanOrEqual(-180);
          expect(lng).toBeLessThanOrEqual(180);
        }
      }
      // The pre-seam leg still starts at Tokyo, in Tokyo's world.
      expect(runs[0][0][0]).toBeCloseTo(TOKYO[0], 9);
    }
  });

  test("an arc whose seam falls before its first sample stays on the map", () => {
    // Same bug, reached the other way: start just west of the antimeridian so
    // the very first interpolated step crosses it, leaving a two-element run.
    const runs = drawablePath([[179.9, 10], [-150, 20]], "journeyArc");
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
    expect(runs[0][0][0]).toBeCloseTo(179.9, 9);
  });

  test("an endpoint exactly on ±180 emits no degenerate run", () => {
    // worldOf(180) is the EASTERN world, so a path that merely touches the
    // boundary still split — and the far side of that split was the boundary
    // point repeated: [[-180,0],[-180,0]], a zero-length line carried for
    // nothing, with longitudes outside the promised range on the way there.
    const cases: LngLat[][] = [
      [[170, 0], [180, 0]], // ends exactly on the seam
      [[180, 0], [170, 10]], // starts exactly on the seam, heading west
      [[180, 0], [190, 10]], // starts exactly on the seam, heading east
      [[-180, 0], [-170, 10]], // the western spelling of the same meridian
    ];
    for (const coords of cases) {
      for (const style of ["shortWay", "journeyArc"] as const) {
        for (const run of drawablePath(coords, style)) {
          // No degenerate run: at least two DISTINCT points.
          const distinct = run.some((p) => p[0] !== run[0][0] || p[1] !== run[0][1]);
          expect(distinct).toBe(true);
          for (const [lng] of run) {
            expect(lng).toBeGreaterThanOrEqual(-180);
            expect(lng).toBeLessThanOrEqual(180);
          }
        }
      }
    }
  });

  test("a path running vertically ALONG the seam is kept, not filtered away", () => {
    // The degenerate test is "are any two points different", not "does
    // longitude vary" — a due-north path sitting on ±180 is real line-work.
    const runs = drawablePath([[180, 10], [180, 40]], "shortWay");
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs.flat().length).toBeGreaterThanOrEqual(2);
    const lats = runs.flat().map((p) => p[1]);
    expect(Math.max(...lats) - Math.min(...lats)).toBeCloseTo(30, 6);
  });

  test("a journeyArc ALONG the seam stays ONE run with exact longitudes", () => {
    // The quadratic's x term collapses to x0 in exact math but rounds either
    // side of it in floats, so an arrow drawn up the antimeridian produced
    // longitudes like -180.00000000000003. The splitter read that as repeated
    // world crossings and fragmented the arrow into many runs — which also
    // restarts arrowhead placement at every fragment, so the line visibly
    // stops looking like one journey.
    const runs = drawablePath([[180, 10], [180, 40]], "journeyArc");
    expect(runs).toHaveLength(1);
    const pts = runs[0];
    expect(pts.length).toBeGreaterThanOrEqual(3);
    // Every longitude is the SAME value, exactly — not merely close.
    const lngs = new Set(pts.map((p) => p[0]));
    expect(lngs.size).toBe(1);
    expect(Math.abs(pts[0][0])).toBe(180);
    for (const [lng] of pts) {
      expect(lng).toBeGreaterThanOrEqual(-180);
      expect(lng).toBeLessThanOrEqual(180);
    }
    const lats = pts.map((p) => p[1]);
    expect(Math.min(...lats)).toBeCloseTo(10, 9);
    expect(Math.max(...lats)).toBeCloseTo(40, 9);
  });

  test("a NEAR-vertical chord on the seam does not fragment either", () => {
    // The boundary of the fix above. Longitude is interpolated with the
    // numerically stable lerp x0 + t·dx, which is exact at t = 0, yields
    // exactly x0 when dx is 0, and is monotonic in t for EVERY dx — so a chord
    // crosses the seam at most once by construction, with no epsilon anywhere.
    // The quadratic form it replaced wandered off the line by an ulp or two,
    // which only mattered at ±180 but mattered badly there.
    for (const far of [
      [-179.999999999999, 40],
      [-179.9999999, 40],
      [-179.999, 40],
      [179.9999999, 40],
      [179.999, 40],
    ] as LngLat[]) {
      const runs = drawablePath([[180, 10], far], "journeyArc");
      expect(runs).toHaveLength(1);
      for (const [lng] of runs[0]) {
        expect(lng).toBeGreaterThanOrEqual(-180);
        expect(lng).toBeLessThanOrEqual(180);
      }
    }
  });

  test("deltas below the ulp of 180 collapse to a single exact run", () => {
    // Denormal-adjacent deltas are not representable as a difference of two
    // longitudes near 180 (its ulp is ~2.8e-14), so they collapse to dx = 0 —
    // which the lerp handles exactly rather than approximately.
    for (const d of [1e-300, -1e-300, 5e-324, -5e-324, Number.MIN_VALUE, -Number.MIN_VALUE]) {
      const runs = drawablePath(
        [
          [180, 10],
          [180 + d, 40],
        ],
        "journeyArc",
      );
      expect(runs).toHaveLength(1);
      expect(new Set(runs[0].map((p) => p[0])).size).toBe(1);
      for (const [lng] of runs[0]) {
        expect(lng).toBeGreaterThanOrEqual(-180);
        expect(lng).toBeLessThanOrEqual(180);
      }
    }
  });

  test("x is monotonic in t at every dx scale, so the seam is crossed once", () => {
    // Non-monotonic x was the actual failure: a longitude that stepped back
    // over the boundary read as a SECOND crossing, so one arrow fragmented into
    // runs and its arrowheads restarted at each fragment.
    const scales = [0, 1e-14, 1e-13, 1e-12, 1e-9, 1e-6, 1e-3, 0.5, 5, 60];
    for (const anchor of [180, -180, 0, 90]) {
      for (const mag of scales) {
        for (const sign of [1, -1]) {
          let far = anchor + sign * mag;
          if (far > 180) far -= 360;
          if (far < -180) far += 360;
          for (const run of drawablePath([[anchor, -10], [far, 45]], "journeyArc")) {
            const xs = run.map((p) => p[0]);
            const inc = xs.every((v, i) => i === 0 || v >= xs[i - 1]);
            const dec = xs.every((v, i) => i === 0 || v <= xs[i - 1]);
            expect(inc || dec).toBe(true);
            for (const x of xs) {
              expect(x).toBeGreaterThanOrEqual(-180);
              expect(x).toBeLessThanOrEqual(180);
            }
          }
        }
      }
    }
  });

  test("ulp-scale chords around the seam stay in range and monotonic", () => {
    // Exhaustive at the scale that actually broke: every representable step for
    // ±120 ulps around the boundary. A chord that STARTS exactly on 180 and
    // moves a few ulps west can legitimately produce two runs — its first
    // samples round onto the seam, so the path really does run along ±180
    // before departing — but the two meet at the same meridian, and no chord
    // this narrow (~1e-13°, tens of nanometres on the ground) is expressible in
    // authored data. The invariants that matter hold everywhere.
    const buf = new DataView(new ArrayBuffer(8));
    const nextAfter = (x: number, steps: number): number => {
      buf.setFloat64(0, x);
      let bits = buf.getBigUint64(0);
      bits += x >= 0 ? BigInt(steps) : BigInt(-steps);
      buf.setBigUint64(0, bits);
      return buf.getFloat64(0);
    };
    for (let k = -120; k <= 120; k++) {
      let far = nextAfter(180, k);
      if (far > 180) far -= 360;
      const runs = drawablePath([[180, 10], [far, 40]], "journeyArc");
      expect(runs.length).toBeGreaterThanOrEqual(1);
      for (const run of runs) {
        // No degenerate run.
        expect(run.some((pt) => pt[0] !== run[0][0] || pt[1] !== run[0][1])).toBe(true);
        const xs = run.map((pt) => pt[0]);
        const inc = xs.every((v, i) => i === 0 || v >= xs[i - 1]);
        const dec = xs.every((v, i) => i === 0 || v <= xs[i - 1]);
        expect(inc || dec).toBe(true);
        for (const x of xs) {
          expect(x).toBeGreaterThanOrEqual(-180);
          expect(x).toBeLessThanOrEqual(180);
        }
      }
    }
  });

  test("any vertical journey chord has exact longitudes, seam or not", () => {
    // The same rounding existed on every due-north chord; it was only VISIBLE
    // at ±180, where the splitter reacts to it.
    for (const lng of [0, -157.9, 12.5, 179.5, -180, 180]) {
      const runs = drawablePath(
        [
          [lng, -20],
          [lng, 55],
        ],
        "journeyArc",
      );
      expect(runs).toHaveLength(1);
      expect(new Set(runs[0].map((p) => p[0])).size).toBe(1);
    }
  });

  test("a stored feature cannot forge the internal already-drawn marker", () => {
    // Inline geojson is author-controlled. When idempotence keyed on a
    // property, a spec carrying it turned its own arc off and the arrow
    // silently rendered straight.
    const forged: GeoJsonFeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { __geomapDrawn: true, id: "sneaky" },
          geometry: { type: "LineString", coordinates: [ITALY, HAWAII] },
        },
      ],
    };
    const out = drawableFeatureCollection(forged, "journeyArc");
    expect(out).not.toBe(forged);
    const coords = (out.features[0].geometry as { coordinates: LngLat[][] | LngLat[] })
      .coordinates;
    expect(coords.flat().length).toBeGreaterThan(2);
    // ...and the transform still refuses to redraw its OWN output.
    expect(drawableFeatureCollection(out, "journeyArc")).toBe(out);
  });

  test("malformed stored geometry degrades instead of throwing", () => {
    // validate.ts checks only that `features` is an array — everything inside
    // is unvalidated and reaches the transform straight from storage. On native
    // this runs during React render, where a throw is a white screen.
    const malformed = [
      { type: "FeatureCollection", features: [null] },
      { type: "FeatureCollection", features: [undefined] },
      {
        type: "FeatureCollection",
        features: [{ type: "Feature", properties: {}, geometry: null }],
      },
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
      {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: {},
            geometry: { type: "LineString", coordinates: [["a", "b"], [1, 2]] },
          },
        ],
      },
      {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: {},
            geometry: { type: "LineString", coordinates: [[NaN, 2], [1, 2]] },
          },
        ],
      },
      {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: {},
            geometry: { type: "MultiLineString", coordinates: [null] },
          },
        ],
      },
      { type: "FeatureCollection", features: "not an array" },
    ] as unknown as GeoJsonFeatureCollection[];

    for (const fc of malformed) {
      for (const style of ["journeyArc", "shortWay", "asAuthored"] as const) {
        expect(() => drawableFeatureCollection(fc, style)).not.toThrow();
        // Unrenderable input is handed on exactly as it arrived, which is what
        // the renderer received before this module existed.
        expect(drawableFeatureCollection(fc, style)).toBe(fc);
      }
    }
  });

  test("a good feature beside a malformed one still gets its arc", () => {
    const mixed = {
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [null] } },
        {
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates: [ITALY, HAWAII] },
        },
      ],
    } as unknown as GeoJsonFeatureCollection;
    const out = drawableFeatureCollection(mixed, "journeyArc");
    expect(out).not.toBe(mixed);
    // The bad one passed through untouched...
    expect(out.features[0]).toBe(mixed.features[0]);
    // ...and the good one was still drawn.
    const coords = (out.features[1].geometry as { coordinates: LngLat[] }).coordinates;
    expect(coords.length).toBeGreaterThan(2);
  });

  test("an absurd coordinate degrades instead of hanging the renderer", () => {
    // `validateSpec` checks a layer's geojson STRUCTURE but never its
    // coordinate RANGE, so a stored spec can carry 1e20. Past float integer
    // precision the world arithmetic stops being arithmetic — 360*k + 180 is
    // indistinguishable from lng, and a correction LOOP there never terminates,
    // wedging web reconciliation and, worse, native's React render. If this
    // regresses the suite hangs rather than failing, which is the point.
    const absurd = [1e20, -1e20, 1e300, Number.MAX_VALUE, -Number.MAX_VALUE, 1e16];
    for (const v of absurd) {
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
        // Out of domain ⇒ malformed ⇒ handed on exactly as it arrived.
        expect(drawableFeatureCollection(fc, style)).toBe(fc);
        // ...and the primitive is safe for direct callers too.
        expect(() => drawablePath(coords, style)).not.toThrow();
        expect(drawablePath(coords, style)).toEqual([coords]);
      }
    }
  });

  test("an absurd LATITUDE degrades the same way", () => {
    const fc: GeoJsonFeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: [
              [10, 1e20],
              [12.5, 42.5],
            ],
          },
        },
      ],
    };
    expect(drawableFeatureCollection(fc, "journeyArc")).toBe(fc);
  });

  test("the domain gate is not over-broad — wrapped world-copy values still draw", () => {
    // ±540 covers three world copies, so a legitimately wrapped longitude is
    // still ordinary input and must keep its arc.
    for (const [a, b] of [
      [
        [200, 10],
        [220, 40],
      ],
      [
        [-200, 10],
        [-260, 40],
      ],
      [
        [539, 10],
        [500, 40],
      ],
    ] as Array<[LngLat, LngLat]>) {
      const runs = drawablePath([a, b], "journeyArc");
      expect(runs.flat().length).toBeGreaterThan(2);
      for (const run of runs) {
        for (const [lng] of run) {
          expect(lng).toBeGreaterThanOrEqual(-180);
          expect(lng).toBeLessThanOrEqual(180);
        }
      }
    }
  });

  test("a dense polyline does not explode the vertex count", () => {
    // The 24-sample floor is PER SEGMENT, and a segment is every adjacent pair,
    // so the floor alone would have multiplied a dense line by 24.
    const dense: LngLat[] = [];
    for (let i = 0; i < 3000; i++) dense.push([-100 + i * 0.01, 40 + Math.sin(i / 50)]);
    const fc: GeoJsonFeatureCollection = {
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: dense } },
      ],
    };
    const out = drawableFeatureCollection(fc, "journeyArc");
    // Budgeted, not multiplied: the floor is a midpoint per segment, so ~2x.
    expect(totalCoords(out)).toBeLessThanOrEqual(dense.length * 2 + 1);
    expect(totalCoords(out)).toBeGreaterThan(dense.length); // still arced, not skipped
  });

  test("EVERY arrow of a dense MultiLineString still arcs", () => {
    // The budget counts adjacent pairs, so 1,001 separate two-point ARROWS
    // scored the same as one 1,001-point polyline — and the per-segment
    // allowance floored to a single interval, rendering every arrow dead
    // straight. Valid stored data, silently losing this module's whole point.
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
    expect(parts.length).toBeGreaterThanOrEqual(arrows.length);
    // Three points is the minimum that bows: endpoint, midpoint, endpoint.
    for (const part of parts) expect(part.length).toBeGreaterThanOrEqual(3);
  });

  test("smoothing is never abandoned — no feature comes out half-arced", () => {
    // If a ceiling ever forced some segments straight, a feature with some
    // arced and some straight segments would be the worst possible outcome.
    for (const segments of [1, 5, 50, 500, 1500, 5000]) {
      const coords: LngLat[] = [];
      for (let i = 0; i <= segments; i++) coords.push([-170 + (i * 340) / segments, 20]);
      const runs = drawablePath(coords, "journeyArc");
      const drawn = runs.flat().length;
      // Every segment contributed at least its midpoint.
      expect(drawn).toBeGreaterThanOrEqual(segments * 2 + 1);
      // ...and the total stays inside the stated envelope.
      expect(drawn).toBeLessThanOrEqual(Math.max(2200, segments * 2 + 1) + 8);
    }
  });

  test("a sparse path still gets full smoothing", () => {
    // The budget must bind only where it should — a two-point arrow is still a
    // smooth curve, not a straight line.
    const runs = drawablePath([GREECE, ITALY], "journeyArc");
    expect(runs[0].length).toBeGreaterThanOrEqual(25);
  });

  test("a high-latitude arrow lifts north rather than dipping south", () => {
    // The forward projection accepted 85° (y ≈ 179.41) while the inverse
    // clamped at 179.3 (≈ 84.99°), so interior points came back SOUTH of the
    // endpoints — an arc that dipped, contradicting the whole invariant.
    const runs = drawablePath([[-40, 85], [40, 85]], "journeyArc");
    for (const run of runs) {
      for (const [, lat] of run) {
        expect(lat).toBeGreaterThanOrEqual(85 - 1e-9);
      }
    }
  });

  test("mercator projection round-trips at its own ceiling", () => {
    // The two clamps are derived from one constant, so this holds by
    // construction rather than by a hand-copied decimal.
    const runs = drawablePath([[0, 85], [0.0001, 85]], "journeyArc");
    expect(runs[0][0][1]).toBeCloseTo(85, 9);
    expect(runs[0][runs[0].length - 1][1]).toBeCloseTo(85, 9);
  });
});

describe("collection-level behavior", () => {
  test("drawing is idempotent — a second pass changes nothing", () => {
    // The stored spec is never rewritten, but a re-render must not compound
    // the arc into a spiral.
    const once = drawableFeatureCollection(lineFc([ITALY, HAWAII]), "journeyArc");
    const twice = drawableFeatureCollection(once, "journeyArc");
    expect(twice.features.map((f) => f.geometry)).toEqual(once.features.map((f) => f.geometry));
  });

  test("feature properties survive", () => {
    const fc: GeoJsonFeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { id: "basil", label: "Basil route" },
          geometry: { type: "LineString", coordinates: BASIL },
        },
      ],
    };
    const out = drawableFeatureCollection(fc, "journeyArc");
    expect(out.features[0].properties?.label).toBe("Basil route");
    expect(out.features[0].properties?.id).toBe("basil");
  });

  test("degenerate inputs do not throw", () => {
    expect(drawablePath([], "journeyArc")).toEqual([]);
    expect(drawablePath([ITALY], "journeyArc")).toEqual([[ITALY]]);
    expect(() => drawablePath([ITALY, ITALY], "journeyArc")).not.toThrow();
    expect(() =>
      drawablePath(
        [
          [0, 0],
          [180, 0],
        ],
        "journeyArc",
      ),
    ).not.toThrow();
    // Poles: Mercator y is unbounded there, so the clamp must hold.
    for (const run of drawablePath([[0, 89], [10, -89]], "journeyArc")) {
      for (const [, lat] of run) expect(Number.isFinite(lat)).toBe(true);
    }
  });
});
