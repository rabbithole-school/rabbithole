/**
 * The locate-target gazetteer — a typed TS list (NOT GeoJSON) of well-known
 * points a `geoLocate` manipulative can ask a scholar to find on a real map:
 * the 50 US state capitals, Washington DC, the five oceans (as generous-
 * tolerance points), and Honolulu + the eight main Hawaiian islands.
 *
 * This is a lightweight, hand-authored companion to the geomap dataset registry
 * (../index.ts). It is NOT a registry entry (those are GeoJSON overlays/regions);
 * it's the source for the pure `makeLocateItem` generator that emits a graded
 * `GeoLocateSpec` (a manipulative) with an honest target coordinate + a
 * sensible great-circle tolerance. No LLM, fully deterministic.
 *
 * Coordinates are [longitude, latitude] (GeoJSON axis order), rounded to a
 * pedagogy-appropriate precision (city-block, not survey). Tolerances are tuned
 * to the zoom a target is naturally asked at: capitals ~120 km (country view),
 * oceans ~1500 km (a whole basin), islands ~60 km, a single city ~40 km.
 */
import type { GeoCamera, GeoMapSpec, GeoTask, LngLat } from "../../types";
import type { GeoLocateSpec } from "../../../manipulative/types";

/** A single locate target. `suggestedToleranceKm` is the great-circle radius a
 *  tap must land within to count as correct at this target's natural zoom. */
export interface GazetteerEntry {
  /** Stable kebab-case key (`capital-hi`, `ocean-pacific`, `island-oahu`). */
  id: string;
  /** Kid-facing name ("Honolulu", "Pacific Ocean", "Oʻahu"). */
  label: string;
  lngLat: LngLat;
  kind: "capital" | "city" | "ocean" | "island";
  suggestedToleranceKm: number;
}

const CAPITAL_TOLERANCE_KM = 120;
const OCEAN_TOLERANCE_KM = 1500;
const ISLAND_TOLERANCE_KM = 60;
const CITY_TOLERANCE_KM = 40;

/** The 50 US state capitals, keyed by state postal abbreviation. */
const STATE_CAPITALS: Array<{ abbr: string; city: string; lngLat: LngLat }> = [
  { abbr: "al", city: "Montgomery", lngLat: [-86.3, 32.377] },
  { abbr: "ak", city: "Juneau", lngLat: [-134.417, 58.302] },
  { abbr: "az", city: "Phoenix", lngLat: [-112.074, 33.448] },
  { abbr: "ar", city: "Little Rock", lngLat: [-92.289, 34.746] },
  { abbr: "ca", city: "Sacramento", lngLat: [-121.494, 38.576] },
  { abbr: "co", city: "Denver", lngLat: [-104.984, 39.739] },
  { abbr: "ct", city: "Hartford", lngLat: [-72.685, 41.764] },
  { abbr: "de", city: "Dover", lngLat: [-75.524, 39.158] },
  { abbr: "fl", city: "Tallahassee", lngLat: [-84.281, 30.438] },
  { abbr: "ga", city: "Atlanta", lngLat: [-84.388, 33.749] },
  { abbr: "hi", city: "Honolulu", lngLat: [-157.857, 21.307] },
  { abbr: "id", city: "Boise", lngLat: [-116.202, 43.617] },
  { abbr: "il", city: "Springfield", lngLat: [-89.65, 39.798] },
  { abbr: "in", city: "Indianapolis", lngLat: [-86.162, 39.768] },
  { abbr: "ia", city: "Des Moines", lngLat: [-93.603, 41.591] },
  { abbr: "ks", city: "Topeka", lngLat: [-95.689, 39.048] },
  { abbr: "ky", city: "Frankfort", lngLat: [-84.873, 38.201] },
  { abbr: "la", city: "Baton Rouge", lngLat: [-91.14, 30.457] },
  { abbr: "me", city: "Augusta", lngLat: [-69.765, 44.307] },
  { abbr: "md", city: "Annapolis", lngLat: [-76.491, 38.979] },
  { abbr: "ma", city: "Boston", lngLat: [-71.058, 42.36] },
  { abbr: "mi", city: "Lansing", lngLat: [-84.555, 42.733] },
  { abbr: "mn", city: "Saint Paul", lngLat: [-93.094, 44.954] },
  { abbr: "ms", city: "Jackson", lngLat: [-90.184, 32.299] },
  { abbr: "mo", city: "Jefferson City", lngLat: [-92.173, 38.579] },
  { abbr: "mt", city: "Helena", lngLat: [-112.036, 46.589] },
  { abbr: "ne", city: "Lincoln", lngLat: [-96.675, 40.808] },
  { abbr: "nv", city: "Carson City", lngLat: [-119.754, 39.164] },
  { abbr: "nh", city: "Concord", lngLat: [-71.538, 43.207] },
  { abbr: "nj", city: "Trenton", lngLat: [-74.764, 40.22] },
  { abbr: "nm", city: "Santa Fe", lngLat: [-105.964, 35.687] },
  { abbr: "ny", city: "Albany", lngLat: [-73.757, 42.652] },
  { abbr: "nc", city: "Raleigh", lngLat: [-78.638, 35.78] },
  { abbr: "nd", city: "Bismarck", lngLat: [-100.779, 46.808] },
  { abbr: "oh", city: "Columbus", lngLat: [-82.999, 39.961] },
  { abbr: "ok", city: "Oklahoma City", lngLat: [-97.534, 35.468] },
  { abbr: "or", city: "Salem", lngLat: [-123.035, 44.939] },
  { abbr: "pa", city: "Harrisburg", lngLat: [-76.875, 40.269] },
  { abbr: "ri", city: "Providence", lngLat: [-71.422, 41.824] },
  { abbr: "sc", city: "Columbia", lngLat: [-81.035, 34.0] },
  { abbr: "sd", city: "Pierre", lngLat: [-100.351, 44.367] },
  { abbr: "tn", city: "Nashville", lngLat: [-86.784, 36.166] },
  { abbr: "tx", city: "Austin", lngLat: [-97.743, 30.267] },
  { abbr: "ut", city: "Salt Lake City", lngLat: [-111.891, 40.761] },
  { abbr: "vt", city: "Montpelier", lngLat: [-72.576, 44.262] },
  { abbr: "va", city: "Richmond", lngLat: [-77.436, 37.541] },
  { abbr: "wa", city: "Olympia", lngLat: [-122.893, 47.038] },
  { abbr: "wv", city: "Charleston", lngLat: [-81.633, 38.336] },
  { abbr: "wi", city: "Madison", lngLat: [-89.384, 43.075] },
  { abbr: "wy", city: "Cheyenne", lngLat: [-104.802, 41.14] },
];

/** The five oceans as generous-tolerance basin-center points. */
const OCEANS: Array<{ id: string; label: string; lngLat: LngLat }> = [
  { id: "ocean-pacific", label: "Pacific Ocean", lngLat: [-160, 0] },
  { id: "ocean-atlantic", label: "Atlantic Ocean", lngLat: [-30, 0] },
  { id: "ocean-indian", label: "Indian Ocean", lngLat: [80, -20] },
  { id: "ocean-southern", label: "Southern Ocean", lngLat: [0, -65] },
  { id: "ocean-arctic", label: "Arctic Ocean", lngLat: [0, 88] },
];

/** The eight main Hawaiian islands, by island center. */
const HAWAIIAN_ISLANDS: Array<{ id: string; label: string; lngLat: LngLat }> = [
  { id: "island-hawaii", label: "Hawaiʻi (the Big Island)", lngLat: [-155.5, 19.6] },
  { id: "island-maui", label: "Maui", lngLat: [-156.33, 20.8] },
  { id: "island-oahu", label: "Oʻahu", lngLat: [-157.98, 21.46] },
  { id: "island-kauai", label: "Kauaʻi", lngLat: [-159.5, 22.05] },
  { id: "island-molokai", label: "Molokaʻi", lngLat: [-157.02, 21.13] },
  { id: "island-lanai", label: "Lānaʻi", lngLat: [-156.92, 20.83] },
  { id: "island-niihau", label: "Niʻihau", lngLat: [-160.16, 21.9] },
  { id: "island-kahoolawe", label: "Kahoʻolawe", lngLat: [-156.61, 20.55] },
];

/** The full gazetteer, in presentation order (capitals → DC → oceans →
 *  Honolulu the city → the eight islands). */
export const GAZETTEER: GazetteerEntry[] = [
  ...STATE_CAPITALS.map(
    (c): GazetteerEntry => ({
      id: `capital-${c.abbr}`,
      label: c.city,
      lngLat: c.lngLat,
      kind: "capital",
      suggestedToleranceKm: CAPITAL_TOLERANCE_KM,
    }),
  ),
  {
    id: "washington-dc",
    label: "Washington, DC",
    lngLat: [-77.037, 38.907],
    kind: "capital",
    suggestedToleranceKm: CAPITAL_TOLERANCE_KM,
  },
  ...OCEANS.map(
    (o): GazetteerEntry => ({
      id: o.id,
      label: o.label,
      lngLat: o.lngLat,
      kind: "ocean",
      suggestedToleranceKm: OCEAN_TOLERANCE_KM,
    }),
  ),
  {
    id: "city-honolulu",
    label: "Honolulu",
    lngLat: [-157.857, 21.307],
    kind: "city",
    suggestedToleranceKm: CITY_TOLERANCE_KM,
  },
  ...HAWAIIAN_ISLANDS.map(
    (i): GazetteerEntry => ({
      id: i.id,
      label: i.label,
      lngLat: i.lngLat,
      kind: "island",
      suggestedToleranceKm: ISLAND_TOLERANCE_KM,
    }),
  ),
];

const GAZETTEER_BY_ID = new Map(GAZETTEER.map((e) => [e.id, e]));

if (GAZETTEER_BY_ID.size !== GAZETTEER.length) {
  // Duplicate keys are an authoring error — fail at module load, like the
  // geomap registry's own duplicate-id guard.
  throw new Error("gazetteer: duplicate entry id");
}

export function getGazetteerEntry(id: string): GazetteerEntry | undefined {
  return GAZETTEER_BY_ID.get(id);
}

/** A reasonable starting camera per target kind — a regional view that shows
 *  the target's neighborhood WITHOUT centering the map on the answer. */
function defaultCameraFor(kind: GazetteerEntry["kind"]): GeoCamera {
  switch (kind) {
    case "ocean":
      return { center: [0, 15], zoom: 0.8 };
    case "island":
    case "city":
      // The Hawaiian chain in one frame (Honolulu + every island live here).
      return { center: [-157.5, 20.9], zoom: 6.1 };
    case "capital":
      // Continental US view; Honolulu/Juneau are reachable by panning.
      return { center: [-96, 38], zoom: 3.3 };
  }
}

export interface MakeLocateItemOptions {
  /** Override the generated spec id (defaults to `geo-locate-<gazetteerId>`). */
  id?: string;
  /** Override the great-circle tolerance (defaults to the entry's suggestion). */
  toleranceKm?: number;
  /** Override the starting camera (defaults to a kind-appropriate regional view). */
  camera?: GeoCamera;
  /** Override the map base (defaults to "political"). */
  base?: GeoMapSpec["base"];
  /** Globe projection (defaults on for ocean targets). */
  globe?: boolean;
  /** Override the eyebrow concept line. */
  concept?: string;
  /** Override the prominent one-line invitation. */
  prompt?: string;
}

function conceptFor(kind: GazetteerEntry["kind"]): string {
  switch (kind) {
    case "capital":
      return "US state capitals";
    case "ocean":
      return "The world's oceans";
    case "island":
      return "The Hawaiian Islands";
    case "city":
      return "Cities on the map";
  }
}

/**
 * Build a graded `GeoLocateSpec` (a manipulative) that asks the scholar to tap
 * where the given gazetteer target is. Pure + deterministic — the same id always
 * yields the same spec, so it's reproducible for tests, dev, and authoring.
 * Throws on an unknown id (an authoring error, surfaced loudly like a bad
 * registry key).
 */
export function makeLocateItem(gazetteerId: string, opts: MakeLocateItemOptions = {}): GeoLocateSpec {
  const entry = getGazetteerEntry(gazetteerId);
  if (!entry) {
    throw new Error(`makeLocateItem: unknown gazetteer id "${gazetteerId}".`);
  }
  const specId = opts.id ?? `geo-locate-${entry.id}`;
  const toleranceKm = opts.toleranceKm ?? entry.suggestedToleranceKm;
  const task: GeoTask = {
    kind: "locate",
    prompt: `Tap where ${entry.label} is.`,
    target: entry.lngLat,
    toleranceKm,
  };
  const map: GeoMapSpec & { task: GeoTask } = {
    v: 1,
    id: `${specId}-map`,
    camera: opts.camera ?? defaultCameraFor(entry.kind),
    // Unlabeled by default — a labeled political map answers its own locate
    // question (the no-spoilers rule; labels are the reveal, never the hunt).
    base: opts.base ?? "politicalUnlabeled",
    globe: opts.globe ?? entry.kind === "ocean",
    interactions: {
      tapToPin: true,
      baseToggle: false,
      rotate: false,
      pitch: false,
    },
    task,
  };
  return {
    kind: "geoLocate",
    id: specId,
    concept: opts.concept ?? conceptFor(entry.kind),
    prompt: opts.prompt ?? `Find ${entry.label} on the map.`,
    map,
  };
}
