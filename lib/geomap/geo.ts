/**
 * Pure geographic math for the GeoMap contract. No dependencies, no I/O —
 * plain-Vitest-testable per the test-strategy decision tree. Grading
 * (grade.ts) and validation (validate.ts) build on these.
 */
import type {
  GeoJsonFeature,
  GeoJsonFeatureCollection,
  GeoJsonGeometry,
  GeoJsonPosition,
  LngLat,
  PaintPreset,
} from "./types";

const EARTH_RADIUS_KM = 6371;

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

/** Great-circle distance between two [lng, lat] points, in kilometers. */
export function haversineKm(a: LngLat, b: LngLat): number {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Ray-cast point-in-ring test. `ring` is a closed (or implicitly closed)
 * GeoJSON linear ring in [lng, lat] order. Boundary behavior is
 * implementation-defined (standard even-odd); tolerant tasks should prefer
 * `locate` with a toleranceKm when boundary-exact answers matter.
 */
function pointInRing(pt: LngLat, ring: Array<readonly number[]>): boolean {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersects =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Point-in-polygon honoring holes: inside outer ring, outside every hole. */
function pointInPolygonRings(pt: LngLat, rings: Array<Array<readonly number[]>>): boolean {
  if (rings.length === 0) return false;
  if (!pointInRing(pt, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(pt, rings[i])) return false;
  }
  return true;
}

/** Point-in-geometry for Polygon / MultiPolygon (other geometry types: false). */
export function pointInGeometry(pt: LngLat, geom: GeoJsonGeometry): boolean {
  if (geom.type === "Polygon") return pointInPolygonRings(pt, geom.coordinates);
  if (geom.type === "MultiPolygon")
    return geom.coordinates.some((poly) => pointInPolygonRings(pt, poly));
  return false;
}

/**
 * Point-in-region over a FeatureCollection: true if the point is inside ANY
 * polygonal feature. This is the `region` GeoTask's grading primitive.
 */
export function pointInRegion(pt: LngLat, region: GeoJsonFeatureCollection): boolean {
  return region.features.some((f) => pointInGeometry(pt, f.geometry));
}

/** Basic sanity for a [lng, lat] pair (finite, in-range). */
export function isValidLngLat(v: unknown): v is LngLat {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    typeof v[0] === "number" &&
    typeof v[1] === "number" &&
    Number.isFinite(v[0]) &&
    Number.isFinite(v[1]) &&
    v[0] >= -180 &&
    v[0] <= 180 &&
    v[1] >= -90 &&
    v[1] <= 90
  );
}

// ── How a journey is DRAWN on a flat map ─────────────────────────────────────
//
// GeoJSON says nothing about how the space between two vertices is drawn
// (RFC 7946 §3.1.1: segments are straight in the coordinate reference system,
// not on the globe), so a renderer chooses — and Web Mercator's choice is a lie
// at long range. In prod the tutor drew Italy → Hawaiʻi as a two-point
// LineString; Mapbox lerped longitude westward through 0 and the "trade route
// to Hawaiʻi" visibly crossed North Africa, the Atlantic and Mexico. A grade-4
// scholar reported it for two days and was talked out of it.
//
// THE ORIGINAL SIN IS PRECISION THE AUTHOR NEVER SPECIFIED. The tutor asserted
// two endpoints and a direction of travel. Everything between them — Morocco,
// the Gulf of Mexico — is invented by the renderer. Chasing geodesic accuracy
// does not fix that, it re-commits it at higher fidelity: the true great circle
// from Rome to Honolulu reaches 82.7°N over the high Arctic and Alaska, which
// is correct on a globe and still a false story about pasta.
//
// So a journey arrow is drawn as DIAGRAM, not as terrain: a simple arc bowing
// up from the chord — the airline-route-map convention, which readers already
// parse as "these two places are connected" rather than "the vehicle went along
// this line". Two properties make that read work:
//
//   UNIFORMITY. Every journey segment arcs, short hops included, lifted NORTH
//   in screen space by an amount scaled gently to chord length. Two halves to
//   this: if only long hauls arced, the arc would become a signal that meant
//   something — a route claim again; and if the lift followed each chord's own
//   perpendicular, a fan of arrows at different bearings would bow in different
//   directions and stop reading as one designed family. One direction, every
//   length, is what keeps it vocabulary rather than assertion.
//
//   SHORT WAY ROUND. Longitude deltas are normalized into [−180, 180], so a
//   Pacific hop crosses the Pacific. Untreated, Tokyo → Honolulu is a 6,200 km
//   hop that Mercator draws as a ~19,000 km detour backwards across Eurasia,
//   Africa and the Atlantic. Nobody authors that; correcting it invents
//   nothing. Arcs running past the antimeridian are split at the seam so a path
//   can never lash back across the whole map.
//
// Applied at RENDER time, never to the stored spec: show_map op:"read" still
// round-trips the tutor's own vertices, a patch cannot compound a transformed
// path, and every existing map repairs itself on next paint with nothing to
// migrate and nothing to undo.
//
// This module is framework-free on purpose. The arc is COMPUTED here and drawn
// as an ordinary polyline by whichever renderer is mounted (web mapbox-gl,
// native @rnmapbox), so both surfaces draw the identical curve from identical
// math rather than each approximating the look with its own GPU layer.

/** How one preset's line-work is drawn. See PATH_STYLE in paintPresets.ts. */
export type PathStyle =
  /** Journeys: schematic arcs, uniformly applied (arrows). */
  | "journeyArc"
  /** Real line-work drawn the short way round the globe (routeLine). */
  | "shortWay"
  /** Surveyed data: returned exactly as authored (borders, contours, points). */
  | "asAuthored";

/**
 * WHICH PRESETS GET THE JOURNEY VOCABULARY — a closed, exhaustive record rather
 * than a predicate, so adding a preset forces the decision instead of
 * inheriting a default. Getting it backwards silently corrupts correct maps.
 *
 * This record lives HERE, in the framework-free module, because both renderers
 * must read the same one. The web renderer (components/geomap) and the native
 * renderer (native/src/components/GeoMapNative, via native/vendor/geomap) each
 * build their own concrete layer objects, but a second hand-kept copy of this
 * policy is exactly the drift the vendor-freshness CI guard exists to catch —
 * and a preset that arcs on web and not on iPad is a scholar-facing parity gap.
 *
 *   arrows — JOURNEYS: movements, migrations, trade, winds, currents. The
 *       author asserts endpoints and a direction; everything between is the
 *       renderer's invention. Drawn as uniform schematic arcs.
 *
 *   routeLine — LITERAL line-work: rivers, weather fronts, an actual surveyed
 *       route. A river is not a journey and must not be prettied into one; its
 *       shape is the content. Kept literal — every authored vertex drawn as
 *       given — with only the wrong-way-round artifact corrected.
 *
 *   regionFill / regionOutline — a border is a legal and physical line whose
 *       vertices ARE the data (Natural Earth outlines, ahupuaʻa boundaries,
 *       1914 empires). Bending one redraws a country.
 *
 *   isolines — a contour is a sampled field boundary, not a path between
 *       places.
 *
 *   points — no line geometry at all.
 */
const PATH_STYLE: Record<PaintPreset, PathStyle> = {
  arrows: "journeyArc",
  routeLine: "shortWay",
  regionFill: "asAuthored",
  regionOutline: "asAuthored",
  isolines: "asAuthored",
  points: "asAuthored",
};

/** How this preset's line-work should be drawn (see the doctrine above). */
export function pathStyleForPreset(preset: PaintPreset): PathStyle {
  return PATH_STYLE[preset] ?? "asAuthored";
}

/**
 * How far a journey arc lifts NORTH at its apex, as a fraction of chord length,
 * in Mercator degrees. Tuned to the airline-map look: pronounced enough at a
 * glance to read as a diagram, gentle enough that a short hop is not a
 * semicircle.
 */
const ARC_LIFT_RATIO = 0.12;

/**
 * Ceiling on that lift, so a half-world chord arcs like a flight path rather
 * than ballooning over the pole. Mercator degrees.
 */
const ARC_LIFT_MAX = 18;

/** Samples per arc. Enough that even a short hop reads as a smooth curve. */
const ARC_MIN_SAMPLES = 24;
const ARC_MAX_SAMPLES = 96;

/**
 * The floor the budget below may never breach: 2 intervals = 3 points =
 * endpoint, midpoint, endpoint, which is a visible bow.
 *
 * This exists because a per-feature budget alone cannot tell two very different
 * shapes apart. `featureSegments` counts adjacent pairs, so a MultiLineString
 * of 1,001 separate two-point ARROWS scores the same 1,001 as one 1,001-point
 * polyline — and when the budget floored to a single interval, every one of
 * those arrows rendered dead straight. That silently disabled this module's
 * entire reason for existing, on valid stored data, with nothing in the output
 * to show it had happened. An arc style always arcs.
 */
const ARC_MIN_SAMPLES_DENSE = 2;

/**
 * Interpolated points one FEATURE's arcs aim to add, across ALL its segments.
 *
 * ARC_MIN_SAMPLES is a per-SEGMENT floor and a segment is every adjacent pair,
 * so without this a dense authored polyline multiplies by 24: a ~60 KB inline
 * LineString would reach six figures for one layer. Scaling the per-segment
 * allowance down as segment count grows costs almost nothing visually — a
 * polyline that dense carries its shape in its own vertices, and the lift on a
 * 0.01° segment is ~130 m, well under a pixel at any zoom a child reads.
 *
 * It is a soft target, not a hard ceiling. Past ~1,000 segments the floor above
 * wins and the real total settles at ~2 coordinates per segment. That is
 * deliberate: MEASURED, the pathological inputs land at 17k–35k coordinates per
 * layer, which is smaller than admin-boundary datasets this app already renders
 * (see the measurements recorded on the PR). There is no input for which
 * smoothing is abandoned, so a feature can never come out half-arced.
 */
const ARC_SAMPLE_BUDGET = 2000;

/**
 * Mercator y is unbounded at the poles, so both directions clamp — and they
 * clamp at exactly the SAME place, which is load-bearing. When the inverse
 * clamped lower than the forward (179.3 vs mercatorY(85) = 179.41), a
 * horizontal arrow at 85°N had its endpoints projected above the inverse's
 * ceiling, so its interior points came back slightly SOUTH of them: an arc that
 * dipped instead of lifting, contradicting the north-lift invariant. Deriving
 * the ceiling from the same formula makes the round trip exact by construction.
 */
const MAX_MERCATOR_LAT = 85;
const MAX_MERCATOR_Y = toDeg(
  Math.log(Math.tan(Math.PI / 4 + toRad(MAX_MERCATOR_LAT) / 2)),
);

/**
 * The coordinate domain this module will draw.
 *
 * `validateSpec` checks a layer's geojson STRUCTURE but never its coordinate
 * range, so a stored spec can carry any finite number — including 1e20, where
 * the world arithmetic below stops being arithmetic at all (360 * k + 180 is
 * indistinguishable from lng once k passes float integer precision). Rather
 * than let that reach the seam logic on either surface, it is refused at the
 * door and the feature degrades untouched, exactly as a malformed one does.
 *
 * ±540 is three world copies, which covers every longitude a legitimately
 * wrapped value can hold — authored coordinates live in ±180, and this module's
 * own unwrapping never hands its input back out. The latitude bound is 90 plus
 * a hair, so noise from an upstream pipeline does not silently un-arc a route.
 */
const MAX_ABS_LNG = 540;
const MAX_ABS_LAT = 90.000001;

const inDrawableDomain = (lng: number, lat: number): boolean =>
  Number.isFinite(lng) &&
  Number.isFinite(lat) &&
  Math.abs(lng) <= MAX_ABS_LNG &&
  Math.abs(lat) <= MAX_ABS_LAT;

/** Take the first two ordinates of a GeoJSON position (elevation is dropped). */
const asLngLat = (p: GeoJsonPosition): LngLat => [p[0], p[1]];

/** Latitude to Web Mercator y, in the same degree-ish units as longitude. */
function mercatorY(lat: number): number {
  const clamped = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
  return toDeg(Math.log(Math.tan(Math.PI / 4 + toRad(clamped) / 2)));
}

/** Inverse of {@link mercatorY}. */
function mercatorLat(y: number): number {
  const clamped = Math.max(-MAX_MERCATOR_Y, Math.min(MAX_MERCATOR_Y, y));
  return toDeg(2 * Math.atan(Math.exp(toRad(clamped))) - Math.PI / 2);
}

/**
 * The shorter of the two ways round from `from` to `to`, in degrees, always
 * within (−180, 180]. This is what stops a Pacific hop going via Eurasia.
 */
function shortWayLngDelta(from: number, to: number): number {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/**
 * Rewrite a path's longitudes as one continuous (possibly beyond ±180) run
 * where every step takes the short way. Latitudes are untouched.
 */
function unwrapPath(pts: readonly LngLat[]): LngLat[] {
  const out: LngLat[] = [[pts[0][0], pts[0][1]]];
  for (let i = 1; i < pts.length; i++) {
    const prevX = out[i - 1][0];
    out.push([prevX + shortWayLngDelta(prevX, pts[i][0]), pts[i][1]]);
  }
  return out;
}

/**
 * One schematic journey arc between two unwrapped points: a quadratic Bézier
 * whose control point is the chord midpoint lifted STRAIGHT NORTH.
 *
 * Pure vertical lift, not perpendicular-to-chord. That distinction is what
 * makes a fan of arrows at different bearings read as one family — the founder
 * caught the earlier perpendicular version immediately: "your lines are skewed
 * perpendicular to their vector, but the arrows in the example are skewed
 * _north_ in screenspace and are much more beautiful." Perpendicular offset
 * only coincides with north for horizontal chords; on a diagonal it slews the
 * arc sideways, so neighbouring arrows bow in visibly different directions and
 * the set stops looking like a designed vocabulary.
 *
 * A pleasant consequence of the vertical control point: since C − midpoint is
 * purely vertical, every point of the curve shares its LONGITUDE with the
 * straight chord at the same parameter, and is lifted north of it by
 * 4·t·(1−t)·lift. The arc is literally the chord with a north lift applied,
 * which is exactly the reference idiom.
 *
 * A near-vertical (due north/south) chord therefore lands its control point
 * almost on the chord itself and comes out almost straight — no special case
 * needed, and it matches how airline maps draw such routes.
 *
 * Computed in MERCATOR space rather than lng/lat, because the arc is a screen
 * idiom — "north in screenspace" is only meaningful in the projection the child
 * is actually looking at.
 */
function arcSegment(a: LngLat, b: LngLat, maxSamples: number): LngLat[] {
  const x0 = a[0];
  const y0 = mercatorY(a[1]);
  const x1 = b[0];
  const y1 = mercatorY(b[1]);
  const len = Math.hypot(x1 - x0, y1 - y0);
  if (!Number.isFinite(len) || len === 0) {
    return [
      [a[0], a[1]],
      [b[0], b[1]],
    ];
  }

  const lift = Math.min(ARC_LIFT_MAX, ARC_LIFT_RATIO * len);
  // The control point is the chord midpoint lifted north. B(0.5) sits halfway
  // between chord midpoint and control point, so lifting by 2*lift puts the
  // APEX exactly `lift` north of the chord's own midpoint. Its x is the chord
  // midpoint exactly, which is what collapses the x term to a lerp below.
  const cy = (y0 + y1) / 2 + 2 * lift;

  const samples = Math.max(
    ARC_MIN_SAMPLES_DENSE,
    Math.min(
      maxSamples,
      ARC_MAX_SAMPLES,
      Math.max(ARC_MIN_SAMPLES, Math.round(len / 2)),
    ),
  );
  // LONGITUDE IS A LERP, NOT A QUADRATIC. Because the control point is lifted
  // straight north, cx is exactly the chord midpoint, and the Bézier's x term
  // reduces algebraically to u·x0 + t·x1 — a plain linear interpolation. It
  // does NOT reduce that way in floating point: evaluated as a quadratic it
  // wanders off the line by an ulp or two, which is invisible everywhere except
  // at ±180, where the splitter reads the wander as real world crossings. That
  // fragmented an arrow drawn along the antimeridian into several runs (which
  // also restarts arrowhead placement at each) and pushed coordinates outside
  // the promised range. Measured, the wander is worst within a few ulps of a
  // vertical chord — precisely the case a special-case branch on dx === 0
  // cannot cover, because it is a continuum, not a point.
  //
  // The lerp form below fixes the whole continuum at once and needs no epsilon
  // anywhere: it is exact at t = 0, yields exactly x0 when dx is 0 (t * 0 is
  // 0), and is monotonic in t for every dx — so a chord crosses the seam at
  // most once, by construction. The quadratic stays for y, where the lift is
  // the whole point and monotonicity does not matter.
  const dx = x1 - x0;
  const out: LngLat[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const u = 1 - t;
    out.push([
      x0 + t * dx,
      mercatorLat(u * u * y0 + 2 * u * t * cy + t * t * y1),
    ]);
  }
  // Land exactly on the authored vertices; the endpoints are the only thing the
  // author actually asserted, so they must not drift by float epsilon.
  out[0] = [a[0], a[1]];
  out[out.length - 1] = [b[0], b[1]];
  return out;
}

/**
 * Cut a continuous (unwrapped) run wherever it crosses ±180, and normalize
 * every longitude back into ±180. Without this a path that legitimately crosses
 * the Pacific seam draws a full-width line back across the world. The seam
 * point is duplicated on both sides, so the split leaves no visible gap.
 */
function splitAtAntimeridian(run: readonly LngLat[]): LngLat[][] {
  /**
   * Which 360°-wide copy of the world a longitude belongs to — decided by
   * COMPARISON, not by rounded division.
   *
   * Any divide-then-floor spelling is wrong at the one place it matters: for a
   * longitude one ulp below 180, both `(lng + 180) / 360` and `lng / 360 + 0.5`
   * evaluate to exactly 1, reporting a point that is demonstrably WEST of the
   * boundary as belonging to the eastern world. The splitter then noticed the
   * crossing a sample late and inserted the seam point at 180 AFTER a sample
   * already past it, producing a run whose longitudes read
   * 180 → 179.99999999999997 → 180. That non-monotonic step is a second
   * crossing as far as the next pass is concerned, so one arrow fragmented into
   * runs and its arrowheads restarted at each.
   *
   * The band edges (±180, ±540, …) are exactly representable, so comparing
   * against them directly is exact where dividing is not.
   *
   * The correction is a bounded IF, never a loop. Rounding already lands within
   * one band of the answer for any longitude in this module's domain, so one
   * step always suffices — and a loop would not terminate outside it: at
   * lng = 1e20, k exceeds the range where adding 1 changes it, so
   * `360 * k + 180 === lng` stays true forever and the render thread wedges.
   * Structure, not input validation, is what has to make that impossible here;
   * the domain gate on the way in is the other half.
   */
  const worldOf = (lng: number) => {
    let k = Math.round(lng / 360);
    if (lng < 360 * k - 180) k -= 1;
    else if (lng >= 360 * k + 180) k += 1;
    return k;
  };
  const normalize = (part: LngLat[]): LngLat[] => {
    // Choose the world from the MIDDLE OF THE RUN'S SPAN, never from a stored
    // vertex. A split leaves the boundary longitude as a real element, and for
    // a two-point eastward crossing the middle ELEMENT is that boundary: taking
    // its world shifted [139.7, 180] to [-220.3, -180], which both breaks the
    // ±180 promise and parks the pre-seam leg in the next world copy. The span
    // midpoint of a run is always strictly interior to one world.
    let lo = part[0][0];
    let hi = part[0][0];
    for (const [lng] of part) {
      if (lng < lo) lo = lng;
      if (lng > hi) hi = lng;
    }
    let shift = 360 * worldOf((lo + hi) / 2);
    // ...then VERIFY, because the midpoint can itself round onto a boundary.
    // A run lying within an ulp of ±180 sums to exactly ±360, so the midpoint
    // lands on the boundary and picks the neighbouring world, shifting the
    // whole run just outside the range this function exists to guarantee. A
    // run spans less than one world, so a single correction always suffices —
    // and enforcing the invariant beats predicting which representative is safe.
    if (hi - shift > 180) shift += 360;
    else if (lo - shift < -180) shift -= 360;
    return part.map(([lng, lat]): LngLat => [lng - shift, lat]);
  };

  const runs: LngLat[][] = [];
  let current: LngLat[] = [[run[0][0], run[0][1]]];
  for (let i = 1; i < run.length; i++) {
    const prev = run[i - 1];
    const next = run[i];
    const wPrev = worldOf(prev[0]);
    const wNext = worldOf(next[0]);
    if (wPrev === wNext || Math.abs(wNext - wPrev) !== 1 || next[0] === prev[0]) {
      current.push([next[0], next[1]]);
      continue;
    }
    const boundary = 180 + 360 * Math.min(wPrev, wNext);
    const t = (boundary - prev[0]) / (next[0] - prev[0]);
    const lat = prev[1] + (next[1] - prev[1]) * t;
    current.push([boundary, lat]);
    runs.push(normalize(current));
    current = [
      [boundary, lat],
      [next[0], next[1]],
    ];
  }
  runs.push(normalize(current));
  // Drop degenerate runs. A path whose endpoint sits EXACTLY on ±180 still
  // triggers a split (worldOf(180) is the eastern world), and the far side of
  // that split is the boundary point repeated — [[-180,0],[-180,0]], a
  // zero-length line the renderer would carry for nothing. A run that is
  // vertical ON the seam is NOT degenerate and survives: the test is whether
  // any two points differ, not whether longitude varies.
  return runs.filter(
    (r) => r.length >= 2 && r.some((p) => p[0] !== r[0][0] || p[1] !== r[0][1]),
  );
}

/**
 * Turn one authored path into the contiguous runs a flat map should draw. Every
 * longitude in the result is within ±180, and no consecutive pair ever jumps
 * the world.
 *
 * A multi-waypoint chain is honored segment by segment: when the tutor has
 * hand-routed a corridor (prod's basil route runs India → around Africa →
 * around South America → Hawaiʻi), those waypoints are the author's actual
 * claim and every one of them stays on the drawn path.
 */
export function drawablePath(
  coords: readonly GeoJsonPosition[],
  style: PathStyle,
  /**
   * Segments in the whole FEATURE this path belongs to, so a MultiLineString's
   * parts share one budget. Defaults to this path's own segment count.
   */
  featureSegments = Math.max(1, coords.length - 1),
): LngLat[][] {
  const pts = coords.map(asLngLat);
  if (style === "asAuthored") return [pts];
  if (pts.length < 2) return pts.length ? [pts] : [];
  // Outside the domain there is nothing safe to compute, so hand the path back
  // exactly as authored — the renderer's own behaviour before this module
  // existed. `drawableFeatureCollection` screens this out a layer earlier; this
  // guard covers callers that reach the primitive directly.
  for (const [lng, lat] of pts) {
    if (!inDrawableDomain(lng, lat)) return [pts];
  }

  const unwrapped = unwrapPath(pts);
  if (style === "shortWay") return splitAtAntimeridian(unwrapped);

  const perSegment = Math.max(
    ARC_MIN_SAMPLES_DENSE,
    Math.floor(ARC_SAMPLE_BUDGET / Math.max(1, featureSegments)),
  );
  const path: LngLat[] = [];
  for (let i = 0; i < unwrapped.length - 1; i++) {
    const arc = arcSegment(unwrapped[i], unwrapped[i + 1], perSegment);
    // Drop the duplicated joint so consecutive segments read as one path.
    path.push(...(i === 0 ? arc : arc.slice(1)));
  }
  return splitAtAntimeridian(path);
}

/**
 * Collections this module produced. Idempotence is keyed on OBJECT IDENTITY,
 * not on a marker property, because a property is forgeable: a stored spec's
 * inline geojson is author-controlled, so a feature carrying
 * `properties.__geomapDrawn` would have been taken for already-drawn output and
 * silently left straight — the tutor could turn an arrow's arc off by writing a
 * field. Nothing a spec can contain makes a fresh parse identical to an object
 * this module returned, so the WeakSet cannot be spoofed from storage.
 *
 * Only OUTPUTS go in. The unchanged path returns the caller's own collection,
 * and that object may legitimately be drawn again under a different PathStyle
 * (one registry dataset mounted under two presets) — admitting it here would
 * short-circuit the second style.
 */
const drawnCollections = new WeakSet<GeoJsonFeatureCollection>();

/**
 * A position array we can safely draw, or null when the input is malformed.
 *
 * The storage boundary only checks that a layer's geojson is a FeatureCollection
 * with a features ARRAY (validate.ts) — everything inside is unvalidated, so
 * `features:[null]` and `coordinates:[null,[1,2]]` both reach this module from a
 * stored spec. Eagerly dereferencing them would throw during reconciliation on
 * web and DURING REACT RENDER on native, where a throw is a white screen for a
 * child. Before this module existed a malformed feature was simply handed to
 * the renderer, so that is what it must degrade to now: render what is
 * renderable, never throw.
 */
function drawablePositions(part: unknown): LngLat[] | null {
  if (!Array.isArray(part) || part.length < 2) return null;
  const out: LngLat[] = [];
  for (const position of part) {
    if (!Array.isArray(position) || position.length < 2) return null;
    const lng = position[0];
    const lat = position[1];
    if (typeof lng !== "number" || typeof lat !== "number") return null;
    // Finite is not enough: a coordinate far outside the world breaks the seam
    // arithmetic rather than merely drawing oddly, so it counts as malformed.
    if (!inDrawableDomain(lng, lat)) return null;
    out.push([lng, lat]);
  }
  return out;
}

/**
 * Redraw every LineString / MultiLineString in a collection for a flat map.
 * Non-line geometries are returned untouched: a border or a contour is surveyed
 * data, not a journey, and bending it would redraw a country.
 *
 * Returns the INPUT COLLECTION UNCHANGED (same reference) when the style is
 * `asAuthored` or nothing needed redrawing, so callers can keep using identity
 * comparison to decide whether to push new data to the map. Idempotent: an
 * output passed back in is recognised by identity and returned as-is.
 *
 * Total defensive: a malformed feature is passed through rather than drawn, and
 * nothing here throws on author-controlled data.
 */
export function drawableFeatureCollection(
  fc: GeoJsonFeatureCollection,
  style: PathStyle,
): GeoJsonFeatureCollection {
  if (style === "asAuthored") return fc;
  if (!fc || !Array.isArray(fc.features)) return fc;
  if (drawnCollections.has(fc)) return fc;
  let changed = false;

  const features = fc.features.map((feature): GeoJsonFeature => {
    if (!feature || typeof feature !== "object") return feature;
    const geom = feature.geometry;
    if (!geom || (geom.type !== "LineString" && geom.type !== "MultiLineString")) {
      return feature;
    }

    const rawParts: unknown[] =
      geom.type === "LineString"
        ? [geom.coordinates]
        : Array.isArray(geom.coordinates)
          ? geom.coordinates
          : [];

    // Sanitize BEFORE touching anything, so one bad vertex costs this feature
    // its arc rather than costing the whole map its render.
    const parts: LngLat[][] = [];
    for (const rawPart of rawParts) {
      const clean = drawablePositions(rawPart);
      if (!clean) return feature;
      parts.push(clean);
    }
    if (parts.length === 0) return feature;

    // One sample budget for the whole feature, shared across its parts.
    const featureSegments = parts.reduce((n, part) => n + part.length - 1, 0);

    const runs: LngLat[][] = [];
    for (const part of parts) runs.push(...drawablePath(part, style, featureSegments));

    const unchanged =
      runs.length === parts.length &&
      runs.every(
        (r, i) =>
          r.length === parts[i].length &&
          r.every((p, k) => p[0] === parts[i][k][0] && p[1] === parts[i][k][1]),
      );
    if (unchanged) return feature;

    changed = true;
    return {
      ...feature,
      geometry:
        runs.length === 1
          ? { type: "LineString", coordinates: runs[0] }
          : { type: "MultiLineString", coordinates: runs },
    };
  });

  if (!changed) return fc;
  const drawn: GeoJsonFeatureCollection = { type: "FeatureCollection", features };
  drawnCollections.add(drawn);
  return drawn;
}
