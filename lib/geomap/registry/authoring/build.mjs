#!/usr/bin/env node

/**
 * One-shot generator for the checked-in geographic registry data.
 *
 * Source: Natural Earth 1:110m Admin-0 Countries, pinned at commit
 * ca96624a56bd078437bca8184e78163e5039ad19.
 * https://www.naturalearthdata.com/downloads/110m-cultural-vectors/110m-admin-0-countries/
 * Natural Earth data is in the public domain.
 *
 * Historical datasets are declared in HISTORICAL_DATASETS below. Adding an era
 * means vendoring its pinned world_<year>.geojson and adding one config row;
 * clipping, attribution checks, stable exports, labels, and emission are shared.
 *
 * Run from the repository root:
 *   node lib/geomap/registry/authoring/build.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const authoringDir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(authoringDir, "../data");
const sourcePath = path.join(authoringDir, "ne_110m_admin_0_countries.geojson");
const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const NATURAL_EARTH_COMMIT = "ca96624a56bd078437bca8184e78163e5039ad19";

if (!source._source?.includes(NATURAL_EARTH_COMMIT)) {
  throw new Error(`Vendored Natural Earth source is not pinned to ${NATURAL_EARTH_COMMIT}`);
}
if (!/public domain/i.test(source._license ?? "")) {
  throw new Error("Vendored Natural Earth source must declare its public-domain license");
}
const ROUND_DIGITS = 3;
const EUROPE_BOUNDS = [-25, 30, 45, 72];
const OAHU_BOUNDS = [-158.3, 21.24, -157.63, 21.73];

const roundTo = (value, digits) => Number(value.toFixed(digits));
const samePoint = (a, b) => a[0] === b[0] && a[1] === b[1];

function closeRing(ring, digits = ROUND_DIGITS) {
  const rounded = ring
    .map(([lng, lat]) => [roundTo(lng, digits), roundTo(lat, digits)])
    .filter((point, index, points) => index === 0 || !samePoint(point, points[index - 1]));
  if (rounded.length === 0) return rounded;
  return samePoint(rounded[0], rounded.at(-1)) ? rounded : [...rounded, rounded[0]];
}

function polygonsOf(geometry) {
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  throw new Error(`Unsupported Natural Earth geometry: ${geometry.type}`);
}

function normalizePolygons(polygons, digits = ROUND_DIGITS) {
  return polygons
    .map((polygon) =>
      polygon.map((ring) => closeRing(ring, digits)).filter((ring) => ring.length >= 4),
    )
    .filter((polygon) => polygon.length > 0 && polygon[0].length >= 4);
}

function removeCollinearPoints(ring) {
  const open = samePoint(ring[0], ring.at(-1)) ? ring.slice(0, -1) : ring;
  let points = open;
  let changed = true;
  while (changed && points.length >= 3) {
    changed = false;
    const retained = [];
    for (let index = 0; index < points.length; index += 1) {
      const previous = points[(index - 1 + points.length) % points.length];
      const current = points[index];
      const next = points[(index + 1) % points.length];
      const cross =
        (current[0] - previous[0]) * (next[1] - current[1]) -
        (current[1] - previous[1]) * (next[0] - current[0]);
      if (cross === 0) {
        changed = true;
      } else {
        retained.push(current);
      }
    }
    points = retained;
  }
  if (points.length < 3) return ring;
  return [...points, points[0]];
}

function simplifyRoundedPolygons(polygons, digits = ROUND_DIGITS) {
  return normalizePolygons(polygons, digits)
    .map((polygon) =>
      polygon
        .map(removeCollinearPoints)
        .filter((ring) => ring.length >= 4),
    )
    .filter((polygon) => polygon.length > 0 && polygon[0].length >= 4);
}

function sourceCountry(admin) {
  const feature = source.features.find((candidate) => candidate.properties.ADMIN === admin);
  if (!feature) throw new Error(`Natural Earth country not found: ${admin}`);
  return normalizePolygons(polygonsOf(feature.geometry));
}

function intersectAtBoundary(
  start,
  end,
  axis,
  boundary,
  snapToVertex,
  digits = ROUND_DIGITS,
) {
  const otherAxis = axis === 0 ? 1 : 0;
  const span = end[axis] - start[axis];
  const point = [0, 0];
  point[axis] = boundary;
  point[otherAxis] =
    span === 0
      ? start[otherAxis]
      : start[otherAxis] +
        ((boundary - start[axis]) / span) * (end[otherAxis] - start[otherAxis]);
  const intersection = [roundTo(point[0], digits), roundTo(point[1], digits)];
  if (!snapToVertex) return intersection;

  const squaredDistance = (candidate) =>
    (candidate[0] - intersection[0]) ** 2 + (candidate[1] - intersection[1]) ** 2;
  return squaredDistance(start) <= squaredDistance(end) ? start : end;
}

function clipRingHalfPlane(
  ring,
  axis,
  boundary,
  keepGreater,
  snapToVertex = false,
  digits = ROUND_DIGITS,
) {
  const open = samePoint(ring[0], ring.at(-1)) ? ring.slice(0, -1) : ring;
  if (open.length < 3) return [];
  const inside = (point) =>
    keepGreater ? point[axis] >= boundary : point[axis] <= boundary;
  const clipped = [];

  for (let index = 0; index < open.length; index += 1) {
    const start = open[index];
    const end = open[(index + 1) % open.length];
    const startInside = inside(start);
    const endInside = inside(end);

    if (startInside && endInside) {
      clipped.push(end);
    } else if (startInside && !endInside) {
      clipped.push(
        intersectAtBoundary(start, end, axis, boundary, snapToVertex, digits),
      );
    } else if (!startInside && endInside) {
      clipped.push(
        intersectAtBoundary(start, end, axis, boundary, snapToVertex, digits),
        end,
      );
    }
  }

  if (clipped.length < 3) return [];
  return closeRing(clipped, digits);
}

function clipPolygonsHalfPlane(
  polygons,
  axis,
  boundary,
  keepGreater,
  snapToVertex = false,
  digits = ROUND_DIGITS,
) {
  return polygons
    .map((polygon) => {
      const outer = clipRingHalfPlane(
        polygon[0],
        axis,
        boundary,
        keepGreater,
        snapToVertex,
        digits,
      );
      if (outer.length < 4) return [];
      const holes = polygon
        .slice(1)
        .map((ring) =>
          clipRingHalfPlane(
            ring,
            axis,
            boundary,
            keepGreater,
            snapToVertex,
            digits,
          ),
        )
        .filter((ring) => ring.length >= 4);
      return [outer, ...holes];
    })
    .filter((polygon) => polygon.length > 0);
}

function clipBounds(polygons, [west, south, east, north], digits = ROUND_DIGITS) {
  return [
    [0, west, true],
    [0, east, false],
    [1, south, true],
    [1, north, false],
  ].reduce(
    (result, [axis, boundary, keepGreater]) =>
      clipPolygonsHalfPlane(
        result,
        axis,
        boundary,
        keepGreater,
        false,
        digits,
      ),
    polygons,
  );
}

function geometryFrom(polygons) {
  if (polygons.length === 0) throw new Error("Cannot emit an empty geometry");
  return polygons.length === 1
    ? { type: "Polygon", coordinates: polygons[0] }
    : { type: "MultiPolygon", coordinates: polygons };
}

const pointKey = ([lng, lat]) => `${lng},${lat}`;

function sharedEdgeKey(start, end) {
  return [pointKey(start), pointKey(end)].sort().join("|");
}

function signedRingArea(ring) {
  let twiceArea = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[index + 1];
    twiceArea += x1 * y2 - x2 * y1;
  }
  return twiceArea / 2;
}

function pointInRing([x, y], ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [xi, yi] = ring[index];
    const [xj, yj] = ring[previous];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInPolygon(point, polygon) {
  return (
    pointInRing(point, polygon[0]) &&
    polygon.slice(1).every((hole) => !pointInRing(point, hole))
  );
}

function ringCentroid(ring) {
  let crossSum = 0;
  let xSum = 0;
  let ySum = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[index + 1];
    const cross = x1 * y2 - x2 * y1;
    crossSum += cross;
    xSum += (x1 + x2) * cross;
    ySum += (y1 + y2) * cross;
  }
  if (crossSum === 0) return null;
  return [xSum / (3 * crossSum), ySum / (3 * crossSum)];
}

function widestInteriorChordPoint(polygon, digits = ROUND_DIGITS) {
  const outer = polygon[0];
  const latitudes = outer.map(([, lat]) => lat);
  const minLat = Math.min(...latitudes);
  const maxLat = Math.max(...latitudes);
  let widest = null;

  for (let sample = 1; sample < 200; sample += 1) {
    const lat = minLat + ((maxLat - minLat) * sample) / 200;
    const intersections = [];
    for (const ring of polygon) {
      for (let index = 0; index < ring.length - 1; index += 1) {
        const [x1, y1] = ring[index];
        const [x2, y2] = ring[index + 1];
        if (y1 > lat !== y2 > lat) {
          intersections.push(x1 + ((lat - y1) * (x2 - x1)) / (y2 - y1));
        }
      }
    }
    intersections.sort((a, b) => a - b);
    for (let index = 0; index < intersections.length - 1; index += 1) {
      const west = intersections[index];
      const east = intersections[index + 1];
        const precisePoint = [(west + east) / 2, lat];
        const roundedPoint = precisePoint.map((value) => roundTo(value, digits));
        const point = pointInPolygon(roundedPoint, polygon)
          ? roundedPoint
          : precisePoint.map((value) => roundTo(value, 6));
        const width = east - west;
        if (width > (widest?.width ?? -Infinity) && pointInPolygon(point, polygon)) {
          widest = { point, width };
      }
    }
  }
  if (!widest) throw new Error("Could not find an interior label point");
  return widest.point;
}

function labelPointFor(polygons, digits = ROUND_DIGITS) {
  const largest = [...polygons].sort(
    (a, b) => Math.abs(signedRingArea(b[0])) - Math.abs(signedRingArea(a[0])),
  )[0];
  if (!largest) throw new Error("Cannot label empty geometry");
  const centroid = ringCentroid(largest[0]);
  if (centroid) {
    const roundedCentroid = centroid.map((value) => roundTo(value, digits));
    if (pointInPolygon(roundedCentroid, largest)) return roundedCentroid;
    const preciseCentroid = centroid.map((value) => roundTo(value, 6));
    if (pointInPolygon(preciseCentroid, largest)) return preciseCentroid;
  }
  return widestInteriorChordPoint(largest, digits);
}

function labelFeature(name, polygons, digits = ROUND_DIGITS) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: labelPointFor(polygons, digits) },
    properties: { name, labelPoint: true },
  };
}

function polygonsFromRings(rings) {
  const ordered = rings
    .map((ring) => ({ ring, area: signedRingArea(ring), parent: null, depth: 0 }))
    .sort((a, b) => Math.abs(b.area) - Math.abs(a.area));

  for (let index = 0; index < ordered.length; index += 1) {
    const candidate = ordered[index];
    for (let parentIndex = index - 1; parentIndex >= 0; parentIndex -= 1) {
      const possibleParent = ordered[parentIndex];
      if (pointInRing(candidate.ring[0], possibleParent.ring)) {
        candidate.parent = possibleParent;
        candidate.depth = possibleParent.depth + 1;
        break;
      }
    }
  }

  const polygons = [];
  const polygonForOuter = new Map();
  for (const candidate of ordered) {
    if (candidate.depth % 2 === 0) {
      const outer = candidate.area > 0 ? candidate.ring : [...candidate.ring].reverse();
      const polygon = [outer];
      polygons.push(polygon);
      polygonForOuter.set(candidate, polygon);
      continue;
    }

    let outer = candidate.parent;
    while (outer && outer.depth % 2 !== 0) outer = outer.parent;
    const polygon = polygonForOuter.get(outer);
    if (!polygon) throw new Error("Dissolve could not assign a hole to an outer ring");
    polygon.push(candidate.area < 0 ? candidate.ring : [...candidate.ring].reverse());
  }
  return polygons;
}

function normalizePolygonWinding(polygon) {
  return polygon.map((ring, index) => {
    const shouldBeCounterclockwise = index === 0;
    const isCounterclockwise = signedRingArea(ring) > 0;
    return shouldBeCounterclockwise === isCounterclockwise ? ring : [...ring].reverse();
  });
}

function dissolvePolygons(polygons, label) {
  const occurrences = new Map();
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (let index = 0; index < ring.length - 1; index += 1) {
        const start = ring[index];
        const end = ring[index + 1];
        if (samePoint(start, end)) continue;
        const key = sharedEdgeKey(start, end);
        const edges = occurrences.get(key) ?? [];
        edges.push({ start, end });
        occurrences.set(key, edges);
      }
    }
  }

  const boundaryEdges = [];
  for (const edges of occurrences.values()) {
    if (edges.length % 2 === 0) continue;
    const directions = new Map();
    for (const edge of edges) {
      const direction = `${pointKey(edge.start)}>${pointKey(edge.end)}`;
      directions.set(direction, (directions.get(direction) ?? 0) + 1);
    }
    const retained = [...edges].sort(
      (a, b) =>
        (directions.get(`${pointKey(b.start)}>${pointKey(b.end)}`) ?? 0) -
        (directions.get(`${pointKey(a.start)}>${pointKey(a.end)}`) ?? 0),
    )[0];
    boundaryEdges.push(retained);
  }

  const outgoing = new Map();
  boundaryEdges.forEach((edge, index) => {
    const key = pointKey(edge.start);
    const indexes = outgoing.get(key) ?? [];
    indexes.push(index);
    outgoing.set(key, indexes);
  });

  const unused = new Set(boundaryEdges.map((_, index) => index));
  const rings = [];
  while (unused.size > 0) {
    const firstIndex = unused.values().next().value;
    const first = boundaryEdges[firstIndex];
    unused.delete(firstIndex);
    const ring = [first.start, first.end];

    while (!samePoint(ring[0], ring.at(-1))) {
      const candidates = (outgoing.get(pointKey(ring.at(-1))) ?? []).filter((index) =>
        unused.has(index),
      );
      if (candidates.length !== 1) {
        throw new Error(
          `${label}: dissolve found ${candidates.length} continuations at ${pointKey(ring.at(-1))}`,
        );
      }
      const nextIndex = candidates[0];
      unused.delete(nextIndex);
      ring.push(boundaryEdges[nextIndex].end);
    }
    if (ring.length < 4) throw new Error(`${label}: dissolve emitted a short ring`);
    rings.push(ring);
  }

  return polygonsFromRings(rings);
}

function modernGeometry(admin) {
  return clipBounds(sourceCountry(admin), EUROPE_BOUNDS);
}

function modernFeature(name, admin) {
  return {
    type: "Feature",
    geometry: geometryFrom(modernGeometry(admin)),
    properties: { name },
  };
}

const modernCountries = [
  ["Portugal", "Portugal"],
  ["Spain", "Spain"],
  ["Ireland", "Ireland"],
  ["United Kingdom", "United Kingdom"],
  ["France", "France"],
  ["Belgium", "Belgium"],
  ["Netherlands", "Netherlands"],
  ["Luxembourg", "Luxembourg"],
  ["Germany", "Germany"],
  ["Denmark", "Denmark"],
  ["Switzerland", "Switzerland"],
  ["Italy", "Italy"],
  ["Poland", "Poland"],
  ["Czechia", "Czechia"],
  ["Slovakia", "Slovakia"],
  ["Austria", "Austria"],
  ["Hungary", "Hungary"],
  ["Slovenia", "Slovenia"],
  ["Croatia", "Croatia"],
  ["Bosnia and Herzegovina", "Bosnia and Herzegovina"],
  ["Serbia", "Republic of Serbia"],
  ["Montenegro", "Montenegro"],
  ["North Macedonia", "North Macedonia"],
  ["Albania", "Albania"],
  ["Greece", "Greece"],
  ["Romania", "Romania"],
  ["Bulgaria", "Bulgaria"],
  ["Moldova", "Moldova"],
  ["Ukraine", "Ukraine"],
  ["Belarus", "Belarus"],
  ["Lithuania", "Lithuania"],
  ["Latvia", "Latvia"],
  ["Estonia", "Estonia"],
  ["Finland", "Finland"],
  ["Sweden", "Sweden"],
  ["Norway", "Norway"],
  ["Russia (western portion)", "Russia"],
  ["Turkey", "Turkey"],
];

const europeTodayFeatures = modernCountries.map(([name, admin]) =>
  modernFeature(name, admin),
);
const europeTodayLabelFeatures = europeTodayFeatures.map((feature) =>
  labelFeature(feature.properties.name, polygonsOf(feature.geometry)),
);

export const HISTORICAL_DATASETS = [
  {
    id: "europe-1914",
    label: "Europe in 1914",
    sourceFile: "world_1914.geojson",
    sourceCommit: "62d8f1a03a71f2d3ff17f2d166f7553f256bce68",
    sourceSha256: "3909ac0c6e089efbb35919e6929f9f8936ed7a92ff99334e7b361156ef1ffe68",
    vendoredSha256: "344ba63d0bfc916fdc9e562e5d42a78d36ea42095d0cdf8c923a748b342cda5d",
    viewport: EUROPE_BOUNDS,
    dissolve: false,
    attribution: "Alexandre Ourednik and contributors",
    scopeLabel: "Europe quest",
    license:
      "GNU General Public License v3.0 (GPL-3.0), per aourednik/historical-basemaps root LICENSE; the repository README does not state CC BY-NC-SA",
    licenseHeader: [
      "GNU General Public License v3.0 (GPL-3.0), per the repository root",
      "LICENSE at the pinned commit. The repository README does not state",
      "CC BY-NC-SA.",
    ],
    notes:
      "Historical Basemaps is work in progress and asks users to verify it against other sources before academic use. All 22 quest states map directly to sourced 1914 features; no composed fallback is used. Source spelling “Kingfom of Italy” maps to Italy, “Austro-Hungarian Empire” to Austria-Hungary, and “United Kingdom of Great Britain and Ireland” to United Kingdom. Geometry is clipped to the quest viewport, rounded to 0.001 degrees, winding-normalized, and paired with one interior label point per state. Eastern Russia and Ottoman lands outside the viewport, colonial holdings, and irrelevant overseas components are omitted.",
    typeKeyOrder: [
      "germany",
      "austria-hungary",
      "russia",
      "france",
      "united-kingdom",
      "italy",
      "ottoman-empire",
      "serbia",
      "montenegro",
      "romania",
      "bulgaria",
      "greece",
      "belgium",
      "netherlands",
      "denmark",
      "switzerland",
      "spain",
      "portugal",
      "sweden",
      "norway",
      "albania",
      "luxembourg",
    ],
    assertAbsent: ["Poland", "Czechia", "Slovakia", "Yugoslavia"],
    assertContains: [
      { key: "germany", point: [7.25, 48.5], description: "Alsace-Lorraine" },
      { key: "russia", point: [21.01, 52.23], description: "Warsaw / Congress Poland" },
      {
        key: "united-kingdom",
        point: [-6.26, 53.35],
        description: "all of Ireland",
      },
      { key: "germany", point: [20.45, 54.7], description: "East Prussia" },
    ],
    states: [
      {
        key: "portugal",
        label: "Portugal",
        sourceNames: ["Portugal"],
        viewport: [-10, 36, -6, 43],
      },
      {
        key: "spain",
        label: "Spain",
        sourceNames: ["Spain"],
        viewport: [-10, 35, 4, 44],
      },
      { key: "france", label: "France", sourceNames: ["France"] },
      { key: "belgium", label: "Belgium", sourceNames: ["Belgium"] },
      { key: "netherlands", label: "Netherlands", sourceNames: ["Netherlands"] },
      { key: "luxembourg", label: "Luxembourg", sourceNames: ["Luxembourg"] },
      {
        key: "germany",
        label: "German Empire",
        sourceNames: ["German Empire"],
        empire: "German Empire",
      },
      {
        key: "denmark",
        label: "Denmark",
        sourceNames: ["Denmark"],
        viewport: [7, 54, 16, 59],
      },
      { key: "switzerland", label: "Switzerland", sourceNames: ["Switzerland"] },
      { key: "italy", label: "Italy", sourceNames: ["Kingfom of Italy"] },
      {
        key: "austria-hungary",
        label: "Austria-Hungary",
        sourceNames: ["Austro-Hungarian Empire"],
        empire: "Austria-Hungary",
      },
      {
        key: "russia",
        label: "Russian Empire",
        sourceNames: ["Russian Empire"],
        empire: "Russian Empire",
        viewport: [17, 35, 45, 72],
      },
      { key: "romania", label: "Romania", sourceNames: ["Romania"] },
      { key: "serbia", label: "Serbia", sourceNames: ["Serbia"] },
      { key: "montenegro", label: "Montenegro", sourceNames: ["Montenegro"] },
      { key: "bulgaria", label: "Bulgaria", sourceNames: ["Bulgaria"] },
      { key: "albania", label: "Albania", sourceNames: ["Albania"] },
      { key: "greece", label: "Greece", sourceNames: ["Greece"] },
      {
        key: "ottoman-empire",
        label: "Ottoman Empire",
        sourceNames: ["Ottoman Empire"],
        empire: "Ottoman Empire",
        viewport: [25, 30, 45, 43],
      },
      {
        key: "united-kingdom",
        label: "United Kingdom",
        sourceNames: ["United Kingdom of Great Britain and Ireland"],
        viewport: [-12, 49, 3, 61],
      },
      { key: "sweden", label: "Sweden", sourceNames: ["Sweden"] },
      {
        key: "norway",
        label: "Norway",
        sourceNames: ["Norway"],
        viewport: [4, 57, 32, 72],
      },
    ],
  },
  {
    id: "europe-1938",
    label: "Europe in 1938",
    sourceFile: "world_1938.geojson",
    sourceCommit: "62d8f1a03a71f2d3ff17f2d166f7553f256bce68",
    sourceSha256: "ba7689bec824144806049030be3d67132bff77562a71684ad892a4c808273870",
    vendoredSha256: "be9cf36af0288c206db7174c76cee45fca54a4d4be398245f4d6e5e7dc238281",
    viewport: EUROPE_BOUNDS,
    dissolve: false,
    attribution: "Alexandre Ourednik and contributors",
    scopeLabel: "Europe 1938 quest",
    license:
      "GNU General Public License v3.0 (GPL-3.0), per aourednik/historical-basemaps root LICENSE; the repository README does not state CC BY-NC-SA",
    licenseHeader: [
      "GNU General Public License v3.0 (GPL-3.0), per the repository root",
      "LICENSE at the pinned commit. The repository README does not state",
      "CC BY-NC-SA.",
    ],
    notes:
      "Historical Basemaps is work in progress and asks users to verify it against other sources before academic use. This source snapshot includes Austria within Germany after the March 1938 Anschluss while still showing an intact Czechoslovakia, before the September 1938 Munich settlement. Poland exists and the eastern state is named USSR, not Russian Empire. Geometry is clipped to the Europe quest viewport, rounded to 0.001 degrees, winding-normalized, and paired with one interior label point per state. Colonial holdings, irrelevant overseas components, and lands outside the viewport are omitted.",
    assertAbsent: ["Austria", "Russian Empire"],
    assertContains: [
      { key: "germany", point: [16.37, 48.21], description: "Vienna after the Anschluss" },
      { key: "poland", point: [21.01, 52.23], description: "Warsaw in Poland" },
      {
        key: "czechoslovakia",
        point: [14.42, 50.08],
        description: "Prague in intact Czechoslovakia",
      },
      { key: "ussr", point: [37.62, 55.75], description: "Moscow in the USSR" },
    ],
    states: [
      { key: "portugal", label: "Portugal", sourceNames: ["Portugal"], viewport: [-10, 36, -6, 43] },
      { key: "spain", label: "Spain", sourceNames: ["Spain"], viewport: [-10, 35, 4, 44] },
      { key: "france", label: "France", sourceNames: ["France"] },
      { key: "belgium", label: "Belgium", sourceNames: ["Belgium"] },
      { key: "netherlands", label: "Netherlands", sourceNames: ["Netherlands"] },
      { key: "luxembourg", label: "Luxembourg", sourceNames: ["Luxembourg"] },
      { key: "germany", label: "Germany", sourceNames: ["Germany"] },
      { key: "denmark", label: "Denmark", sourceNames: ["Denmark"], viewport: [7, 54, 16, 59] },
      { key: "switzerland", label: "Switzerland", sourceNames: ["Switzerland"] },
      { key: "italy", label: "Italy", sourceNames: ["Italy"] },
      { key: "poland", label: "Poland", sourceNames: ["Poland"] },
      {
        key: "czechoslovakia",
        label: "Czechoslovakia",
        sourceNames: ["Czechoslovakia"],
      },
      { key: "hungary", label: "Hungary", sourceNames: ["Hungary"] },
      {
        key: "ussr",
        label: "USSR",
        sourceNames: ["USSR"],
        empire: "USSR",
        viewport: [17, 35, 45, 72],
      },
      { key: "romania", label: "Romania", sourceNames: ["Romania"] },
      { key: "yugoslavia", label: "Yugoslavia", sourceNames: ["Yugoslavia"] },
      { key: "albania", label: "Albania", sourceNames: ["Albania"] },
      { key: "bulgaria", label: "Bulgaria", sourceNames: ["Bulgaria"] },
      { key: "greece", label: "Greece", sourceNames: ["Greece"] },
      { key: "turkey", label: "Turkey", sourceNames: ["Turkey"], viewport: [25, 35, 45, 43] },
      {
        key: "united-kingdom",
        label: "United Kingdom",
        sourceNames: ["United Kingdom"],
        viewport: [-12, 49, 3, 61],
      },
      { key: "ireland", label: "Ireland", sourceNames: ["Ireland"] },
      { key: "sweden", label: "Sweden", sourceNames: ["Sweden"] },
      { key: "norway", label: "Norway", sourceNames: ["Norway"], viewport: [4, 57, 32, 72] },
      { key: "finland", label: "Finland", sourceNames: ["Finland"] },
      { key: "estonia", label: "Estonia", sourceNames: ["Estonia"] },
      { key: "latvia", label: "Latvia", sourceNames: ["Latvia"] },
      { key: "lithuania", label: "Lithuania", sourceNames: ["Lithuania"] },
    ],
  },
  {
    id: "europe-1815",
    label: "Europe in 1815",
    sourceFile: "world_1815.geojson",
    sourceCommit: "62d8f1a03a71f2d3ff17f2d166f7553f256bce68",
    sourceSha256: "62afcd6e3f1f598a05e42550a358083bbb75e63e122ebb5a4383f019632115e9",
    vendoredSha256: "63847d8c259f847d9152a0c23784b88cac94c38bad27b4f886f7d8d974ddbe1b",
    vendoredMaxBytes: 2_500_000,
    viewport: EUROPE_BOUNDS,
    dissolve: false,
    attribution: "Alexandre Ourednik and contributors",
    scopeLabel: "post-Congress-of-Vienna Europe quest",
    license:
      "GNU General Public License v3.0 (GPL-3.0), per aourednik/historical-basemaps root LICENSE; the repository README does not state CC BY-NC-SA",
    licenseHeader: [
      "GNU General Public License v3.0 (GPL-3.0), per the repository root",
      "LICENSE at the pinned commit. The repository README does not state",
      "CC BY-NC-SA.",
    ],
    notes:
      "Historical Basemaps is work in progress and asks users to verify it against other sources before academic use. The source has no Germany or Italy: German lands remain Prussia, the Austrian Empire, and named Confederation members; Italian lands remain the Kingdom of Sardinia (Sardinia-Piedmont), the Two Sicilies, Papal States, and other named states. Warsaw is inside the Russian Empire rather than a separate Poland. Tiny source territories Cuxhaven, Fivizzano, Massa, Pontremoli, and San Marino are omitted to keep the continental map legible. Geometry is clipped to the Europe quest viewport, rounded to 0.001 degrees, winding-normalized, and paired with one interior label point per state.",
    assertAbsent: ["Germany", "Italy", "Poland"],
    assertContains: [
      { key: "prussia", point: [13.4, 52.52], description: "Berlin in Prussia" },
      {
        key: "russian-empire",
        point: [21.01, 52.23],
        description: "Warsaw / Congress Poland under the Russian Empire",
      },
      {
        key: "austrian-empire",
        point: [16.37, 48.21],
        description: "Vienna in the Austrian Empire",
      },
      {
        key: "kingdom-of-sardinia",
        point: [7.68, 45.07],
        description: "Turin in the Kingdom of Sardinia",
      },
      {
        key: "two-sicilies",
        point: [13.36, 38.12],
        description: "Palermo in the Kingdom of the Two Sicilies",
      },
      { key: "papal-states", point: [12.5, 41.9], description: "Rome in the Papal States" },
    ],
    states: [
      { key: "portugal", label: "Portugal", sourceNames: ["Portugal"], viewport: [-10, 36, -6, 43] },
      { key: "spain", label: "Spain", sourceNames: ["Spain"], viewport: [-10, 35, 4, 44] },
      { key: "france", label: "France", sourceNames: ["France"] },
      {
        key: "united-kingdom",
        label: "United Kingdom",
        sourceNames: ["United Kingdom of Great Britain and Ireland"],
        viewport: [-12, 49, 3, 61],
      },
      { key: "luxembourg", label: "Luxembourg", sourceNames: ["Luxembourg"] },
      { key: "denmark", label: "Denmark", sourceNames: ["Denmark"], viewport: [7, 54, 16, 59] },
      {
        key: "sweden-norway",
        label: "Sweden–Norway",
        sourceNames: ["Sweden–Norway"],
        viewport: [4, 55, 32, 72],
      },
      { key: "switzerland", label: "Switzerland", sourceNames: ["Switzerland"] },
      { key: "prussia", label: "Prussia", sourceNames: ["Prussia"] },
      {
        key: "austrian-empire",
        label: "Austrian Empire",
        sourceNames: ["Austrian Empire"],
        empire: "Austrian Empire",
        viewport: [9, 42, 27, 52],
      },
      { key: "baden", label: "Baden", sourceNames: ["Baden"] },
      { key: "bavaria", label: "Bavaria", sourceNames: ["Bavaria"] },
      { key: "bremen", label: "Bremen", sourceNames: ["Bremen"] },
      { key: "brunswick", label: "Brunswick", sourceNames: ["Brunswick"] },
      { key: "electoral-hesse", label: "Electoral Hesse", sourceNames: ["Electoral Hesse"] },
      {
        key: "grand-duchy-of-hesse",
        label: "Grand Duchy of Hesse",
        sourceNames: ["Grand Duchy of Hesse"],
      },
      { key: "hamburg", label: "Hamburg", sourceNames: ["Hamburg"] },
      { key: "hanover", label: "Hanover", sourceNames: ["Hanover"] },
      { key: "hohenzollern", label: "Hohenzollern", sourceNames: ["Hohenzollern"] },
      { key: "holstein", label: "Holstein", sourceNames: ["Holstein"] },
      { key: "lippe-detmold", label: "Lippe-Detmold", sourceNames: ["Lippe-Detmold"] },
      { key: "lubeck", label: "Lübeck", sourceNames: ["Lübeck"] },
      {
        key: "mecklenburg-schwerin",
        label: "Mecklenburg-Schwerin",
        sourceNames: ["Mecklenburg-Schwerin"],
      },
      {
        key: "mecklenburg-strelitz",
        label: "Mecklenburg-Strelitz",
        sourceNames: ["Mecklenburg-Strelitz"],
      },
      { key: "nassau", label: "Nassau", sourceNames: ["Nassau"] },
      { key: "oldenburg", label: "Oldenburg", sourceNames: ["Oldenburg"] },
      { key: "palatinate", label: "Palatinate", sourceNames: ["Palatinate"] },
      { key: "saxony", label: "Saxony", sourceNames: ["Saxony"] },
      {
        key: "schaumburg-lippe",
        label: "Schaumburg-Lippe",
        sourceNames: ["Schaumburg-Lippe"],
      },
      { key: "schleswig", label: "Schleswig", sourceNames: ["Schleswig"] },
      { key: "thuringia", label: "Thuringia", sourceNames: ["Thuringia"] },
      { key: "waldeck", label: "Waldeck", sourceNames: ["Waldeck"] },
      { key: "wetzlar", label: "Wetzlar", sourceNames: ["Wetzlar"] },
      { key: "wurttemberg", label: "Württemberg", sourceNames: ["Württemberg"] },
      {
        key: "kingdom-of-sardinia",
        label: "Kingdom of Sardinia",
        sourceNames: ["Kingdom of Sardinia"],
      },
      {
        key: "two-sicilies",
        label: "Kingdom of the Two Sicilies",
        sourceNames: ["Kingdom of the Two Sicilies"],
      },
      { key: "papal-states", label: "Papal States", sourceNames: ["Papal States"] },
      { key: "lombardy", label: "Lombardy", sourceNames: ["Lombardy"] },
      { key: "venetia", label: "Venetia", sourceNames: ["Venetia"] },
      { key: "tuscany", label: "Tuscany", sourceNames: ["Tuscany"] },
      { key: "parma", label: "Parma", sourceNames: ["Parma"] },
      { key: "modena", label: "Modena", sourceNames: ["Modena"] },
      { key: "lucca", label: "Lucca", sourceNames: ["Lucca"] },
      {
        key: "russian-empire",
        label: "Russian Empire",
        sourceNames: ["Russian Empire"],
        empire: "Russian Empire",
        viewport: [17, 35, 45, 72],
      },
      {
        key: "republic-of-krakow",
        label: "Republic of Kraków",
        sourceNames: ["Republic of Kraków"],
      },
      {
        key: "ottoman-empire",
        label: "Ottoman Empire",
        sourceNames: ["Ottoman Empire"],
        empire: "Ottoman Empire",
        viewport: [15, 30, 45, 49],
      },
    ],
  },
  {
    id: "mediterranean-200",
    label: "Mediterranean in 200 CE",
    sourceFile: "world_200.geojson",
    sourceCommit: "62d8f1a03a71f2d3ff17f2d166f7553f256bce68",
    sourceSha256: "11f3ef1c24a6a43b69cbbd7eeec831b6c9610a539d5b028ae5898c7a5a9f7a4c",
    vendoredSha256: "1b7bad98319846f12825149dc69d4a4893ea4451d1e600a402c5f243dc9b54e4",
    viewport: [-12, 20, 63, 60],
    dissolve: false,
    attribution: "Alexandre Ourednik and contributors",
    scopeLabel: "Mediterranean and Near East quest",
    license:
      "GNU General Public License v3.0 (GPL-3.0), per aourednik/historical-basemaps root LICENSE; the repository README does not state CC BY-NC-SA",
    licenseHeader: [
      "GNU General Public License v3.0 (GPL-3.0), per the repository root",
      "LICENSE at the pinned commit. The repository README does not state",
      "CC BY-NC-SA.",
    ],
    notes:
      "Historical Basemaps is work in progress and asks users to verify it against other sources before academic use. The 200 CE source is used honestly rather than labeling this map 117: unlike world_100, its Roman Empire includes Dacia, so it is the closer territorial match to Trajan’s high-water mark, but it places Mesopotamia in the Parthian Empire and Armenia separately because Trajan’s eastern annexations were brief. Nine named source regions are retained; unnamed tribal areas are omitted. Geometry is clipped to the Mediterranean, Europe, and Near East viewport, rounded to 0.001 degrees, winding-normalized, and paired with one interior label point per state.",
    assertAbsent: ["Dacia", "Nabataean Kingdom"],
    assertContains: [
      { key: "roman-empire", point: [12.5, 41.9], description: "Rome in the Roman Empire" },
      {
        key: "roman-empire",
        point: [24, 45.5],
        description: "Dacia within the Roman Empire by 200 CE",
      },
      {
        key: "parthian-empire",
        point: [51.4, 35.7],
        description: "the Iranian plateau in the Parthian Empire",
      },
      { key: "armenia", point: [44.5, 40], description: "Armenia as a separate kingdom" },
    ],
    states: [
      {
        key: "roman-empire",
        label: "Roman Empire",
        sourceNames: ["Roman Empire"],
        empire: "Roman Empire",
      },
      {
        key: "parthian-empire",
        label: "Parthian Empire",
        sourceNames: ["Parthian Empire"],
        empire: "Parthian Empire",
      },
      { key: "armenia", label: "Armenia", sourceNames: ["Armenia"] },
      {
        key: "bosporian-kingdom",
        label: "Bosporian Kingdom",
        sourceNames: ["Bosporian Kingdom"],
      },
      { key: "blemmyes", label: "Blemmyes", sourceNames: ["Blemmyes"] },
      { key: "boihaenum", label: "Boihaenum", sourceNames: ["Boihaenum"] },
      { key: "dumonii", label: "Dumonii", sourceNames: ["Dumonii"] },
      { key: "meroe", label: "Meroe", sourceNames: ["Meroe"] },
      {
        key: "suren-kingdom",
        label: "Suren Kingdom",
        sourceNames: ["Suren Kingdom"],
      },
    ],
  },
  {
    id: "pacific-1880",
    label: "Pacific in 1880",
    sourceFile: "world_1880.geojson",
    sourceCommit: "62d8f1a03a71f2d3ff17f2d166f7553f256bce68",
    sourceSha256: "af5cbc211a19cb7cad1ed65dc7669658dbda8d92acf0b9c16e8dc0c57de3b06b",
    vendoredSha256: "fd95736122faf136274bff8d1b40e057b59927d69aa1b0046387069004b51f85",
    viewport: [-180, 5, -110, 60],
    dissolve: false,
    maxSampledOverlap: 5,
    attribution: "Alexandre Ourednik and contributors",
    scopeLabel: "eastern Pacific and Hawaiʻi quest",
    license:
      "GNU General Public License v3.0 (GPL-3.0), per aourednik/historical-basemaps root LICENSE; the repository README does not state CC BY-NC-SA",
    licenseHeader: [
      "GNU General Public License v3.0 (GPL-3.0), per the repository root",
      "LICENSE at the pinned commit. The repository README does not state",
      "CC BY-NC-SA.",
    ],
    notes:
      "Historical Basemaps is work in progress and asks users to verify it against other sources before academic use. The source carries the Kingdom of Hawaii as its own feature, separate from the United States of America; the display label restores the ʻokina in Kingdom of Hawaiʻi. The source also names the United States, Mexico, Canada, and the Russian Empire in this eastern-Pacific frame, but its United States and Russian Empire polygons overlap in Alaska despite the 1867 transfer; that source error is retained rather than silently repaired. The non-wrapping viewport deliberately shows Hawaiʻi with the North American west coast and Alaska rather than speculatively adding antimeridian clipping. Geometry is clipped, rounded to 0.001 degrees, winding-normalized, and paired with one interior label point per state.",
    assertAbsent: ["Hawaii", "Kingdom of Hawaii"],
    assertContains: [
      {
        key: "kingdom-of-hawaii",
        point: [-157.86, 21.31],
        description: "Honolulu in the independent Kingdom of Hawaiʻi",
      },
      {
        key: "united-states",
        point: [-120.0, 37.0],
        description: "California in the United States",
      },
      { key: "mexico", point: [-115.0, 30.0], description: "Baja California in Mexico" },
    ],
    assertExcludes: [
      {
        key: "united-states",
        point: [-157.86, 21.31],
        description: "Hawaiʻi is not part of the United States",
      },
    ],
    states: [
      {
        key: "kingdom-of-hawaii",
        label: "Kingdom of Hawaiʻi",
        sourceNames: ["Kingdom of Hawaii"],
        empire: "Kingdom of Hawaiʻi",
      },
      {
        key: "united-states",
        label: "United States",
        sourceNames: ["United States of America"],
      },
      { key: "mexico", label: "Mexico", sourceNames: ["Mexico"] },
      { key: "canada", label: "Canada", sourceNames: ["Canada"] },
      {
        key: "russian-empire",
        label: "Russian Empire",
        sourceNames: ["Russian Empire"],
        empire: "Russian Empire",
      },
    ],
  },
  {
    id: "north-america-1783",
    label: "North America in 1783",
    sourceFile: "world_1783.geojson",
    sourceCommit: "62d8f1a03a71f2d3ff17f2d166f7553f256bce68",
    sourceSha256: "ad4fafe9bdc4ddd690bd009ac92fb6c10a7f6658e7709b4478ab9e710ca37bc1",
    vendoredSha256: "c3cd617268dcf83cb57d1b8958d6e47b4d4a50a12da55931edf61390e6e016d6",
    vendoredMaxBytes: 1_700_000,
    viewport: [-180, 22, -55, 72],
    dissolve: false,
    attribution: "Alexandre Ourednik and contributors",
    scopeLabel: "Treaty-of-Paris North America quest",
    license:
      "GNU General Public License v3.0 (GPL-3.0), per aourednik/historical-basemaps root LICENSE; the repository README does not state CC BY-NC-SA",
    licenseHeader: [
      "GNU General Public License v3.0 (GPL-3.0), per the repository root",
      "LICENSE at the pinned commit. The repository README does not state",
      "CC BY-NC-SA.",
    ],
    notes:
      "Historical Basemaps is work in progress and asks users to verify it against other sources before academic use. The source shows the United States as a young republic and does not name Canada as a country. Every named source feature intersecting the widened North America viewport is retained, including the indigenous regions Athabascan, Eyaq, Inupiaq, Suspiaq, T’atsaot’ine, and Yup’ik & Cup’ik; unnamed source polygons are omitted. The source itself labels Quebec and Luisiana as French in 1783, a historical inaccuracy preserved rather than silently corrected, and spells Luisiana and Vice-Royalty of New Spain as shown. It leaves St. Augustine outside every retained polygon, so this dataset cannot honestly claim a sourced Spanish Florida boundary; the in-frame Spain geometry is Caribbean. The wider-than-brief frame includes Alaska and the source’s Russian and indigenous regions. Geometry is clipped, rounded to 0.001 degrees, winding-normalized, and paired with one interior label point per named region.",
    assertAbsent: ["Canada"],
    assertContains: [
      {
        key: "united-states",
        point: [-75.17, 39.95],
        description: "Philadelphia in the young United States",
      },
      {
        key: "united-states",
        point: [-81.1, 32.08],
        description: "Savannah near the southern extent of the original states",
      },
      {
        key: "new-spain",
        point: [-118.24, 34.05],
        description: "California in the Vice-Royalty of New Spain",
      },
      {
        key: "luisiana",
        point: [-90.07, 29.95],
        description: "New Orleans in source-labeled Luisiana",
      },
      { key: "quebec", point: [-73.57, 45.5], description: "Montreal in Quebec" },
      {
        key: "russian-empire",
        point: [-175.0, 66.0],
        description: "Russian claims near the Bering Sea",
      },
    ],
    states: [
      {
        key: "united-states",
        label: "United States",
        sourceNames: ["United States of America"],
      },
      {
        key: "acadian-peninsula",
        label: "Acadian Peninsula (UK)",
        sourceNames: ["Acadian Peninsula (UK)"],
      },
      { key: "quebec", label: "Quebec", sourceNames: ["Quebec"], empire: "France" },
      {
        key: "ruperts-land",
        label: "Rupert’s Land",
        sourceNames: ["Rupert's Land"],
      },
      {
        key: "new-spain",
        label: "Vice-Royalty of New Spain",
        sourceNames: ["Vice-Royalty of New Spain"],
        empire: "Spain",
      },
      { key: "spain", label: "Spain", sourceNames: ["Spain"], empire: "Spain" },
      { key: "luisiana", label: "Luisiana", sourceNames: ["Luisiana"], empire: "France" },
      { key: "bahamas", label: "Bahamas", sourceNames: ["Bahamas"] },
      {
        key: "russian-empire",
        label: "Russian Empire",
        sourceNames: ["Russian Empire"],
        empire: "Russian Empire",
      },
      {
        key: "denmark-norway",
        label: "Denmark–Norway",
        sourceNames: ["Denmark-Norway"],
        empire: "Denmark–Norway",
      },
      { key: "athabascan", label: "Athabascan", sourceNames: ["Athabascan"] },
      { key: "eyaq", label: "Eyaq", sourceNames: ["Eyaq"] },
      { key: "inupiaq", label: "Inupiaq", sourceNames: ["Inupiaq"] },
      { key: "suspiaq", label: "Suspiaq", sourceNames: ["Suspiaq"] },
      {
        key: "tatsaotine",
        label: "T’atsaot’ine",
        sourceNames: ["T'atsaot'ine"],
      },
      {
        key: "yupik-cupik",
        label: "Yup’ik & Cup’ik",
        sourceNames: ["Yup'ik & Cup'ik"],
      },
    ],
  },
];

export const OAHU_LAND_DIVISION_DATASETS = [
  {
    id: "oahu-moku",
    label: "Oʻahu moku",
    sourceFile: "oahu-moku.geojson",
    sourceField: "moku",
    parentField: null,
    sourceItemId: "cccddcec38bf4e0ea5516b17d6b104cf",
    sourceService:
      "https://geodata.hawaii.gov/arcgis/rest/services/HistoricCultural/MapServer/3",
    sourceSha256: "30f212d1de4a328ae86175f50d3c6bdfb1e6ae360a5cbc402ed44bc5b2202b27",
    vendoredSha256: "e8e324be0b8d7231f51067662ffa259624d839effec2f611425ed1996f6732ca",
    retrieved: "2026-07-20",
    attribution:
      "Hawaiʻi State Historic Preservation Division; Office of Hawaiian Affairs; Hawaiʻi Statewide GIS Program",
    license:
      "public domain per the official State of Hawaiʻi ArcGIS item licenseInfo; no expressed warranties and not a legal-boundary dataset",
    notes:
      "Six traditional moku of Oʻahu from the State of Hawaiʻi historic-land-divisions layer. Source Ko'olaupoko is normalized to Koʻolaupoko; the other source names already carry the expected Hawaiian orthography. Boundaries are clipped to Oʻahu, rounded to 0.001 degrees, stripped only of collinear duplicate detail, winding-normalized, and paired with one interior label point per moku. Intended for regionOutline at zoom 9–11, not legal or survey use.",
    nameCorrections: { "Ko'olaupoko": "Koʻolaupoko" },
  },
  {
    id: "oahu-ahupuaa",
    label: "Oʻahu ahupuaʻa",
    sourceFile: "oahu-ahupuaa.geojson",
    sourceField: "ahupuaa",
    parentField: "moku",
    sourceItemId: "07624815fc7d42d4b23c527d20ad2f58",
    sourceService:
      "https://geodata.hawaii.gov/arcgis/rest/services/HistoricCultural/MapServer/1",
    sourceSha256: "70bca231f43476f11ad268f0591e01ab298decaaaf61993aac4dd4f61be42520",
    vendoredSha256: "a93ff56095f4edd7adfa2b5bba79f9f467d04f1f50ecdb4ffef7ddc0b9e9aaa8",
    vendoredMaxBytes: 1_800_000,
    retrieved: "2026-07-20",
    attribution: "Office of Hawaiian Affairs; Hawaiʻi Statewide GIS Program",
    license:
      "public domain per the official State of Hawaiʻi ArcGIS item licenseInfo; no expressed warranties and not a legal-boundary dataset",
    notes:
      "All 98 Oʻahu ahupuaʻa features returned by the official layer are retained. Four source features named N/A remain as unlabeled boundary polygons. Repeated source names remain separate boundary features but receive one label on the largest same-name source division, avoiding stacked duplicate labels. Boundaries are clipped to Oʻahu, normally rounded to 0.001 degrees, stripped only of collinear duplicate detail, winding-normalized, and paired with interior label points. A 0.087-acre Honouliuli polygon too small to survive ordinary rounding uses 0.0001-degree precision. This keeps the generated overlay under the registry cap and legible with Mapbox collision-managed labels at zoom 9–11; it is not legal or survey data.",
    nameCorrections: {},
  },
];

function readHistoricalSource(dataset) {
  const sourcePath = path.join(authoringDir, dataset.sourceFile);
  const rawSource = fs.readFileSync(sourcePath, "utf8");
  const vendoredSha256 = createHash("sha256").update(rawSource).digest("hex");
  if (vendoredSha256 !== dataset.vendoredSha256) {
    throw new Error(
      `${dataset.id}: vendored SHA-256 ${vendoredSha256} does not match ${dataset.vendoredSha256}`,
    );
  }
  const historicalSource = JSON.parse(rawSource);
  if (!historicalSource._source?.includes(dataset.sourceCommit)) {
    throw new Error(`${dataset.id}: source is not pinned to ${dataset.sourceCommit}`);
  }
  if (!historicalSource._attribution?.includes(dataset.sourceSha256)) {
    throw new Error(`${dataset.id}: source does not record SHA-256 ${dataset.sourceSha256}`);
  }
  if (!historicalSource._license?.includes(dataset.license.split(",")[0])) {
    throw new Error(`${dataset.id}: source license does not match its config`);
  }
  return historicalSource;
}

function historicalGeometry(dataset, historicalSource, state) {
  const sourceNames = new Set(state.sourceNames);
  const matchingFeatures = historicalSource.features.filter((feature) =>
    sourceNames.has(feature.properties.NAME),
  );
  if (matchingFeatures.length === 0) {
    throw new Error(
      `${dataset.id}/${state.key}: source names ${state.sourceNames.join(", ")} are missing`,
    );
  }
  const polygons = matchingFeatures
    .flatMap((feature) => normalizePolygons(polygonsOf(feature.geometry)))
    .flatMap((polygon) => clipBounds([polygon], state.viewport ?? dataset.viewport));
  if (polygons.length === 0) {
    throw new Error(`${dataset.id}/${state.key}: no geometry intersects its viewport`);
  }
  const normalized = polygons.map(normalizePolygonWinding);
  return dataset.dissolve
    ? dissolvePolygons(normalized, `${dataset.id}/${state.key}`)
    : normalized;
}

function buildHistoricalDataset(dataset) {
  const historicalSource = readHistoricalSource(dataset);
  const features = dataset.states.map((state) => {
    const polygons = historicalGeometry(dataset, historicalSource, state);
    return {
      type: "Feature",
      geometry: geometryFrom(polygons),
      properties: {
        key: state.key,
        name: state.label,
        empire: state.empire ?? null,
      },
    };
  });
  return {
    features,
    labelFeatures: features.map((feature) =>
      labelFeature(feature.properties.name, polygonsOf(feature.geometry)),
    ),
  };
}

function readLandDivisionSource(dataset) {
  const sourcePath = path.join(authoringDir, dataset.sourceFile);
  const rawSource = fs.readFileSync(sourcePath, "utf8");
  const vendoredSha256 = createHash("sha256").update(rawSource).digest("hex");
  if (vendoredSha256 !== dataset.vendoredSha256) {
    throw new Error(
      `${dataset.id}: vendored SHA-256 ${vendoredSha256} does not match ${dataset.vendoredSha256}`,
    );
  }
  const divisionSource = JSON.parse(rawSource);
  if (
    !divisionSource._source?.includes(dataset.sourceService) ||
    !divisionSource._source?.includes(dataset.sourceItemId)
  ) {
    throw new Error(`${dataset.id}: source service and item are not pinned`);
  }
  if (
    divisionSource._retrieved !== dataset.retrieved ||
    !divisionSource._attribution?.includes(dataset.sourceSha256)
  ) {
    throw new Error(`${dataset.id}: retrieval date or upstream SHA-256 is not pinned`);
  }
  if (!/public domain/i.test(divisionSource._license ?? "")) {
    throw new Error(`${dataset.id}: source must declare its public-domain terms`);
  }
  return divisionSource;
}

function buildLandDivisionDataset(dataset) {
  const divisionSource = readLandDivisionSource(dataset);
  const builtFeatures = divisionSource.features.map((sourceFeature, index) => {
    const rawName = sourceFeature.properties?.[dataset.sourceField];
    if (typeof rawName !== "string" || !rawName.trim()) {
      throw new Error(`${dataset.id}: feature ${index} has no ${dataset.sourceField} name`);
    }
    const name = dataset.nameCorrections[rawName] ?? rawName;
    const parentValue = dataset.parentField
      ? sourceFeature.properties?.[dataset.parentField]
      : null;
    const gisAcres = sourceFeature.properties?.gisacres;
    const sourcePolygons = polygonsOf(sourceFeature.geometry);
    let precision = ROUND_DIGITS;
    let polygons = simplifyRoundedPolygons(sourcePolygons, precision)
      .flatMap((polygon) => clipBounds([polygon], OAHU_BOUNDS, precision))
      .map(normalizePolygonWinding);
    if (polygons.length === 0) {
      precision = 4;
      polygons = simplifyRoundedPolygons(sourcePolygons, precision)
        .flatMap((polygon) => clipBounds([polygon], OAHU_BOUNDS, precision))
        .map(normalizePolygonWinding);
    }
    if (polygons.length === 0) {
      throw new Error(
        `${dataset.id}: feature ${index} does not survive reviewed rounding`,
      );
    }
    return {
      feature: {
        type: "Feature",
        geometry: geometryFrom(polygons),
        properties: {
          name,
          parentMoku: typeof parentValue === "string" ? parentValue : null,
        },
      },
      precision,
      gisAcres: typeof gisAcres === "number" ? gisAcres : 0,
      sourceIndex: index,
    };
  });
  const features = builtFeatures.map(({ feature }) => feature);
  const labelsByName = new Map();
  for (const record of builtFeatures) {
    const name = record.feature.properties.name;
    if (name === "N/A") continue;
    const prior = labelsByName.get(name);
    if (!prior || record.gisAcres > prior.gisAcres) {
      labelsByName.set(name, record);
    }
  }
  return {
    features,
    labelFeatures: [...labelsByName.values()]
      .map(({ feature, precision, sourceIndex }) => {
        try {
          return labelFeature(
            feature.properties.name,
            polygonsOf(feature.geometry),
            precision,
          );
        } catch (error) {
          throw new Error(
            `${dataset.id}/${feature.properties.name} feature ${sourceIndex}: ${error.message}`,
          );
        }
      }),
  };
}

const usaPolygons = dissolvePolygons(
  normalizePolygons(sourceCountry("United States of America")),
  "United States",
);
const regionUsaFeatures = [
  {
    type: "Feature",
    geometry: geometryFrom(usaPolygons),
    properties: { name: "United States" },
  },
];

// Big generated geometry is emitted as `JSON.parse("…")` rather than a TS array
// literal. Identical at runtime (and V8 parses JSON faster than an equivalent
// object literal), but it collapses millions of coordinate literals into one
// string token for tsc, substantially reducing typecheck work. The tradeoff is
// that the annotation is no longer *checked* against the data, so
// lib/geomap/__tests__/registryData.test.ts validates the shape at runtime
// instead.
const jsonParsed = (value) => `JSON.parse(\n  ${JSON.stringify(JSON.stringify(value))},\n)`;
const naturalEarthHeader = `/**
 * AUTO-GENERATED by authoring/build.mjs — edit the script, not this file.
 *
 * Source: Natural Earth 1:110m Admin-0 Countries, commit ${NATURAL_EARTH_COMMIT}.
 * https://www.naturalearthdata.com/downloads/110m-cultural-vectors/110m-admin-0-countries/
 * Natural Earth data is in the public domain.
 */`;
const historicalBasemapsHeader = (dataset) => `/**
 * AUTO-GENERATED by authoring/build.mjs — edit the script, not this file.
 *
 * Derived from Historical Basemaps ${dataset.sourceFile}, commit
 * ${dataset.sourceCommit}.
 * https://github.com/aourednik/historical-basemaps
 * Curated by ${dataset.attribution}.
 * Upstream SHA-256: ${dataset.sourceSha256}.
 * License: ${dataset.licenseHeader.join("\n * ")} This generated derivative is selected, clipped, rounded,
 * winding-normalized, renamed, and supplemented with label points.
 */`;
const landDivisionHeader = (dataset) => `/**
 * AUTO-GENERATED by authoring/build.mjs — edit the script, not this file.
 *
 * Source: ${dataset.sourceService}, item ${dataset.sourceItemId}.
 * Retrieved ${dataset.retrieved}; upstream query SHA-256: ${dataset.sourceSha256}.
 * Attribution: ${dataset.attribution}.
 * License: Public domain per the official ArcGIS item licenseInfo. No expressed
 * warranties; the data does not represent or confer legal boundaries or claims.
 * This generated derivative is clipped, rounded, collinear-cleaned,
 * winding-normalized, renamed where documented, and supplemented with labels.
 */`;

const camelCaseId = (id) =>
  id.replace(/-([a-z0-9])/g, (_, character) => character.toUpperCase());
const pascalCaseId = (id) => {
  const camel = camelCaseId(id);
  return camel[0].toUpperCase() + camel.slice(1);
};

function writeGenerated(filename, contents) {
  fs.writeFileSync(path.join(dataDir, filename), `${contents.trim()}\n`);
}

export function generateAll() {
writeGenerated(
  "europe-today.ts",
  `${naturalEarthHeader}
import type { RegistryEntry } from "../index";
import type { GeoJsonFeature, LngLat } from "../../types";

type ModernCountryFeature = GeoJsonFeature & {
  geometry:
    | { type: "Polygon"; coordinates: LngLat[][] }
    | { type: "MultiPolygon"; coordinates: LngLat[][][] };
  properties: { name: string };
};

const modernEuropeFeatures: ModernCountryFeature[] = ${jsonParsed(europeTodayFeatures)};
const modernEuropeLabelFeatures: GeoJsonFeature[] = ${jsonParsed(europeTodayLabelFeatures)};

export const europeToday: RegistryEntry = {
  id: "europe-today",
  label: "Europe today",
  kind: "overlay",
  source: "Natural Earth 1:110m Admin-0 Countries, commit ${NATURAL_EARTH_COMMIT}; generated from the vendored public-domain GeoJSON",
  license: "public domain (Natural Earth)",
  notes:
    "Country geometry rounded to 0.001 degrees for zoom 3.5–5. Each country has one interior label-point companion at its largest polygon. Russia is clipped near 45°E; overseas territories and land outside the Europe viewport are omitted. Kosovo remains a separately disputed boundary and is not included in this comparison set.",
  data: {
    type: "FeatureCollection",
    features: [...modernEuropeFeatures, ...modernEuropeLabelFeatures],
  },
};`,
);

for (const dataset of HISTORICAL_DATASETS) {
  const { features, labelFeatures } = buildHistoricalDataset(dataset);
  const symbol = camelCaseId(dataset.id);
  const typeName = pascalCaseId(dataset.id);
  const typeKeyOrder = dataset.typeKeyOrder ?? dataset.states.map((state) => state.key);
  const keyUnion = typeKeyOrder.map((key) => `  | "${key}"`).join("\n");

  writeGenerated(
    `${dataset.id}.ts`,
    `${historicalBasemapsHeader(dataset)}
import type { RegistryEntry } from "../index";
import type { GeoJsonFeature, LngLat } from "../../types";

export type ${typeName}CountryKey =
${keyUnion};

type HistoricalProperties = {
  key: ${typeName}CountryKey;
  name: string;
  empire: string | null;
};

export type ${typeName}CountryFeature = GeoJsonFeature & {
  geometry:
    | { type: "Polygon"; coordinates: LngLat[][] }
    | { type: "MultiPolygon"; coordinates: LngLat[][][] };
  properties: HistoricalProperties;
};

export const ${symbol}CountryFeatures: ${typeName}CountryFeature[] = ${jsonParsed(features)};
const ${symbol}LabelFeatures: GeoJsonFeature[] = ${jsonParsed(labelFeatures)};

export function select${typeName}Countries(
  keys: ReadonlySet<${typeName}CountryKey>,
): ${typeName}CountryFeature[] {
  return ${symbol}CountryFeatures.filter((feature) => keys.has(feature.properties.key));
}

export const ${symbol}: RegistryEntry = {
  id: "${dataset.id}",
  label: "${dataset.label}",
  kind: "overlay",
  source:
    "Historical Basemaps ${dataset.sourceFile} by ${dataset.attribution}, commit ${dataset.sourceCommit}; selected, clipped, rounded, winding-normalized, and renamed for the ${dataset.scopeLabel}",
  license:
    "${dataset.license}",
  notes:
    "${dataset.notes}",
  data: {
    type: "FeatureCollection",
    features: [...${symbol}CountryFeatures, ...${symbol}LabelFeatures],
  },
};`,
  );
}

for (const dataset of OAHU_LAND_DIVISION_DATASETS) {
  const { features, labelFeatures } = buildLandDivisionDataset(dataset);
  const symbol = camelCaseId(dataset.id);
  const typeName = pascalCaseId(dataset.id);
  writeGenerated(
    `${dataset.id}.ts`,
    `${landDivisionHeader(dataset)}
import type { RegistryEntry } from "../index";
import type { GeoJsonFeature, LngLat } from "../../types";

type ${typeName}DivisionFeature = GeoJsonFeature & {
  geometry:
    | { type: "Polygon"; coordinates: LngLat[][] }
    | { type: "MultiPolygon"; coordinates: LngLat[][][] };
  properties: { name: string; parentMoku: string | null };
};

export const ${symbol}DivisionFeatures: ${typeName}DivisionFeature[] = ${jsonParsed(features)};
const ${symbol}LabelFeatures: GeoJsonFeature[] = ${jsonParsed(labelFeatures)};

export const ${symbol}: RegistryEntry = {
  id: "${dataset.id}",
  label: "${dataset.label}",
  kind: "overlay",
  source:
    "State of Hawaiʻi Statewide GIS Program, ${dataset.sourceService}, item ${dataset.sourceItemId}; retrieved ${dataset.retrieved}",
  license:
    "${dataset.license}",
  notes:
    "${dataset.notes}",
  data: {
    type: "FeatureCollection",
    features: [...${symbol}DivisionFeatures, ...${symbol}LabelFeatures],
  },
};`,
  );
}

writeGenerated(
  "region-usa.ts",
  `${naturalEarthHeader}
import type { RegistryEntry } from "../index";
import type { GeoJsonFeature, LngLat } from "../../types";

type UnitedStatesFeature = GeoJsonFeature & {
  geometry:
    | { type: "Polygon"; coordinates: LngLat[][] }
    | { type: "MultiPolygon"; coordinates: LngLat[][][] };
  properties: { name: string };
};

const unitedStatesFeatures: UnitedStatesFeature[] = ${jsonParsed(regionUsaFeatures)};

export const regionUsa: RegistryEntry = {
  id: "region-usa",
  label: "United States",
  kind: "region",
  source: "Natural Earth 1:110m Admin-0 Countries, commit ${NATURAL_EARTH_COMMIT}; generated from the vendored public-domain GeoJSON",
  license: "public domain (Natural Earth)",
  notes:
    "Country-level task target using Natural Earth coastlines and international boundaries, rounded to 0.001 degrees. Includes the lower 48, Alaska, and Hawaiʻi at the detail available in the 1:110m source; not a legal boundary or local-scale dataset.",
  data: {
    type: "FeatureCollection",
    features: unitedStatesFeatures,
  },
};`,
);

for (const filename of [
  ...HISTORICAL_DATASETS.map((dataset) => `${dataset.id}.ts`),
  ...OAHU_LAND_DIVISION_DATASETS.map((dataset) => `${dataset.id}.ts`),
  "europe-today.ts",
  "region-usa.ts",
]) {
  const bytes = fs.statSync(path.join(dataDir, filename)).size;
  console.log(`${filename}: ${bytes.toLocaleString()} bytes`);
}
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  generateAll();
}
