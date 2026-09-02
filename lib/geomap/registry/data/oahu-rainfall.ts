/**
 * Approximate annual-rainfall isolines for the Oʻahu wet-side/dry-side quest.
 *
 * These hand-authored lines follow the broad pattern shown by the Rainfall
 * Atlas of Hawaiʻi: maxima along the windward Koʻolau crest, a smaller wet
 * pocket around Mt. Kaʻala, and much drier conditions toward leeward ʻEwa.
 * They are teaching geometry, not measurements or a replacement for the atlas.
 */
import type { RegistryEntry } from "../index";
import type { LngLat } from "../../types";

const isoline = (
  id: string,
  label: string,
  coordinates: LngLat[],
): {
  type: "Feature";
  geometry: { type: "LineString"; coordinates: LngLat[] };
  properties: { id: string; label: string };
} => ({
  type: "Feature",
  geometry: { type: "LineString", coordinates },
  properties: { id, label },
});

export const oahuRainfall: RegistryEntry = {
  id: "oahu-rainfall",
  label: "Annual rainfall",
  kind: "overlay",
  source:
    "Original simplified geometry informed by the public Rainfall Atlas of Hawaiʻi (Giambelluca et al.) and public-domain island reference geography",
  license: "original work (this repo); reference atlas data attribution requested",
  notes:
    "Approximate bands after the Rainfall Atlas of Hawaiʻi; pedagogical simplification, not data. Labels indicate broad annual totals, not surveyed contours.",
  data: {
    type: "FeatureCollection",
    features: [
      isoline("rain-1000", "~1000 mm", [
        [-158.25, 21.32],
        [-158.2, 21.3],
        [-158.13, 21.29],
        [-158.06, 21.3],
        [-158.0, 21.32],
        [-157.95, 21.35],
        [-157.9, 21.38],
        [-157.84, 21.42],
        [-157.79, 21.45],
        [-157.74, 21.48],
        [-157.69, 21.5],
        [-157.64, 21.51],
      ]),
      isoline("rain-2000", "~2000 mm", [
        [-158.19, 21.41],
        [-158.13, 21.39],
        [-158.07, 21.38],
        [-158.01, 21.39],
        [-157.96, 21.42],
        [-157.91, 21.46],
        [-157.87, 21.49],
        [-157.82, 21.51],
        [-157.78, 21.51],
        [-157.74, 21.49],
        [-157.7, 21.45],
        [-157.67, 21.41],
        [-157.64, 21.36],
      ]),
      isoline("rain-4000", "~4000 mm", [
        [-157.98, 21.56],
        [-157.94, 21.56],
        [-157.9, 21.54],
        [-157.86, 21.51],
        [-157.83, 21.48],
        [-157.8, 21.45],
        [-157.78, 21.42],
        [-157.76, 21.39],
        [-157.74, 21.36],
        [-157.72, 21.33],
        [-157.7, 21.3],
      ]),
      isoline("rain-6000", "~6000 mm", [
        [-157.94, 21.55],
        [-157.91, 21.54],
        [-157.88, 21.52],
        [-157.85, 21.49],
        [-157.82, 21.46],
        [-157.8, 21.43],
        [-157.78, 21.4],
        [-157.76, 21.37],
        [-157.74, 21.34],
        [-157.72, 21.31],
      ]),
      isoline("rain-kaala-4000", "~4000 mm", [
        [-158.2, 21.5],
        [-158.19, 21.53],
        [-158.17, 21.55],
        [-158.14, 21.56],
        [-158.11, 21.55],
        [-158.09, 21.53],
        [-158.09, 21.5],
        [-158.11, 21.48],
        [-158.14, 21.47],
        [-158.17, 21.48],
        [-158.2, 21.5],
      ]),
    ],
  },
};
