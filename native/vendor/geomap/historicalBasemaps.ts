/**
 * Curated hosted historical basemaps — era styles authored on the Rabbithole
 * Mapbox account by scripts/geomap/author-historical-style.mjs (a fork of
 * light-v11 with the modern admin-boundary + country/state-label layers
 * REMOVED at the style level and the era's boundaries/labels rendered from a
 * hosted tileset in the identical visual treatment).
 *
 * A spec sets `historicalBasemap: "<key>"` and the whole map becomes that ERA
 * — a MODE that transforms every base, not an overlay and not a single style:
 *   · political ("Map")  → the hosted era style (borders + names baked in)
 *   · satellite          → RAW imagery (no modern streets/admin) + the era's
 *                          borders/labels injected by the renderer
 *   · terrain            → outdoors with modern human line-work + labels
 *                          stripped at runtime + the same era injection
 * The era's borders render as LINES + LABELS only — never a fill — so the
 * base's own land color / imagery shows through, exactly like a basemap.
 * Same governance shape as everything else in the contract: a closed,
 * checked-in key set; specs can never point at an arbitrary style URL.
 *
 * The KEY doubles as the registry dataset id the style was authored from
 * (e.g. "europe-1914"), keeping data ↔ style provenance one-to-one. Adding an
 * era: run the authoring script for a registry dataset, then add the entry.
 *
 * Shared (framework-free) so both the Convex validator/tool and the web/native
 * renderers read the same set. Style URLs are not secrets — they render with
 * the account's public token.
 */

export interface HistoricalBasemap {
  /** Kid-facing label ("Europe in 1914"). */
  label: string;
  /** mapbox://styles/<account>/<styleId> — the hosted political-era style. */
  styleUrl: string;
  /**
   * Registry dataset id holding the era's border polygons + labelPoint
   * companions (by convention the same string as the map key). The renderer
   * injects these as always-on lines + labels over the satellite/terrain
   * era bases.
   */
  datasetId: string;
}

export let HISTORICAL_BASEMAPS: Record<string, HistoricalBasemap> = {
  "europe-1914": {
    label: "Europe in 1914",
    styleUrl: "mapbox://styles/mapbox/light-v11",
    datasetId: "europe-1914",
  },
  "europe-1938": {
    label: "Europe in 1938",
    styleUrl: "mapbox://styles/mapbox/light-v11",
    datasetId: "europe-1938",
  },
  "europe-1815": {
    label: "Europe in 1815",
    styleUrl: "mapbox://styles/mapbox/light-v11",
    datasetId: "europe-1815",
  },
  "mediterranean-200": {
    label: "Mediterranean in 200 CE",
    styleUrl: "mapbox://styles/mapbox/light-v11",
    datasetId: "mediterranean-200",
  },
  "pacific-1880": {
    label: "Pacific in 1880",
    styleUrl: "mapbox://styles/mapbox/light-v11",
    datasetId: "pacific-1880",
  },
  "north-america-1783": {
    label: "North America in 1783",
    styleUrl: "mapbox://styles/mapbox/light-v11",
    datasetId: "north-america-1783",
  },
};


export function historicalBasemapKeys(): ReadonlySet<string> {
  return new Set(Object.keys(HISTORICAL_BASEMAPS));
}

export function resolveHistoricalBasemap(key: string): HistoricalBasemap | undefined {
  return HISTORICAL_BASEMAPS[key];
}
