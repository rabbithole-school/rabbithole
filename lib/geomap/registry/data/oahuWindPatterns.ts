/**
 * Northeast trade winds approaching Oʻahu — directional arrow lines for the
 * wet-side/dry-side quest (plan §7, quest 1 beat 3).
 *
 * source: hand-authored. Direction reflects the prevailing ENE trades
 * (~060–070°, blowing toward the WSW) that dominate Hawaiian weather most of
 * the year. Lines run from open ocean NE of Oʻahu onto and past the island so
 * the `arrows` paint preset reads as wind flowing INTO the Koʻolau range.
 * license: original work (this repo).
 * notes: schematic, not meteorological data — arrow placement/spacing is
 * pedagogical. Do not use for anything but the wind-direction idea.
 */
import type { RegistryEntry } from "../index";
import {
  OAHU_WIND_OVERLAY_ID,
  OAHU_WIND_OVERLAY_LABEL,
} from "../keys";

const arrow = (
  id: string,
  from: [number, number],
  to: [number, number],
): { type: "Feature"; geometry: { type: "LineString"; coordinates: [number, number][] }; properties: { id: string } } => ({
  type: "Feature",
  geometry: { type: "LineString", coordinates: [from, to] },
  properties: { id },
});

export const oahuWindPatterns: RegistryEntry = {
  id: OAHU_WIND_OVERLAY_ID,
  label: OAHU_WIND_OVERLAY_LABEL,
  kind: "overlay",
  source: "hand-authored (schematic prevailing ENE trades)",
  license: "original work (this repo)",
  notes:
    "Schematic arrows only — direction is the teaching point (ENE→WSW), not speed or exact tracks.",
  data: {
    type: "FeatureCollection",
    features: [
      // Five parallel streamlines, NE ocean → across the island → SW ocean.
      arrow("tw-1", [-157.35, 21.85], [-158.35, 21.35]),
      arrow("tw-2", [-157.25, 21.7], [-158.25, 21.2]),
      arrow("tw-3", [-157.15, 21.55], [-158.15, 21.05]),
      arrow("tw-4", [-157.05, 21.4], [-158.05, 20.9]),
      arrow("tw-5", [-157.45, 22.0], [-158.45, 21.5]),
    ],
  },
};
