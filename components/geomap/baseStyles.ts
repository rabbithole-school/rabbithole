/**
 * The ONE module allowed to name raw Mapbox style URLs (Lane A governance rule).
 * Every other file references bases through the closed `GeoBase` set and this
 * resolver — a spec never carries a style URL, so the whole catalog of imagery
 * a child can see traces to this one reviewable table.
 *
 * `politicalUnlabeled` reuses the plain political basemap but hides every label
 * (symbol) layer on style load — the renderer does the hiding, driven by
 * `hideSymbols` here.
 */
import type { GeoBase } from "@/lib/geomap/types";

export interface BaseStyle {
  /** The mapbox:// style URL. Never sourced from a spec. */
  styleUrl: string;
  /** Hide every symbol (label) layer once the style loads. */
  hideSymbols: boolean;
}

const BASE_STYLES: Record<GeoBase, BaseStyle> = {
  satellite: {
    styleUrl: "mapbox://styles/mapbox/satellite-streets-v12",
    hideSymbols: false,
  },
  terrain: {
    styleUrl: "mapbox://styles/mapbox/outdoors-v12",
    hideSymbols: false,
  },
  political: {
    styleUrl: "mapbox://styles/mapbox/light-v11",
    hideSymbols: false,
  },
  politicalUnlabeled: {
    styleUrl: "mapbox://styles/mapbox/light-v11",
    hideSymbols: true,
  },
};

export function baseStyle(base: GeoBase): BaseStyle {
  return BASE_STYLES[base] ?? BASE_STYLES.satellite;
}

/**
 * Era-mode base variants (a historical basemap is active). The era transforms
 * EVERY base, not just the political map: satellite drops to RAW imagery
 * (satellite-v9 — no modern streets/admin line-work at all) and terrain keeps
 * outdoors but the renderer strips its modern human line-work + labels at
 * runtime; the era's own borders/labels are injected by the renderer from the
 * era's registry dataset. The political base uses the HOSTED era style (from
 * lib/geomap/historicalBasemaps), which never routes through here.
 */
const ERA_BASE_STYLES: Partial<Record<GeoBase, BaseStyle>> = {
  satellite: {
    styleUrl: "mapbox://styles/mapbox/satellite-v9",
    hideSymbols: true,
  },
  terrain: {
    styleUrl: "mapbox://styles/mapbox/outdoors-v12",
    hideSymbols: true,
  },
};

export function eraBaseStyle(base: GeoBase): BaseStyle | undefined {
  return ERA_BASE_STYLES[base];
}

/** Kid-facing label for the base-mode toggle pill. */
export function baseLabel(base: GeoBase): string {
  switch (base) {
    case "satellite":
      return "Satellite";
    case "terrain":
      return "Terrain";
    case "political":
      return "Map";
    case "politicalUnlabeled":
      return "Plain";
  }
}
