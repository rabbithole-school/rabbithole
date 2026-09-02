/**
 * Schematic journey arcs on iPad — reach it at `/dev-geomap-arcs` (deep-link),
 * or `/dev-geomap-arcs?set=short` for the short-hop set.
 *
 * The native twin of the web exhibit harness: it renders the SAME layers, from
 * the SAME real prod spec (the session where the tutor drew five food-origin
 * arrows and a grade-4 scholar spent two days correctly saying the arrows were
 * wrong), through the production `GeoMapNative` → `drawableFeatureCollection`
 * path. So "does iPad draw the same arcs as web" is an eyeball comparison
 * against the web `-v3` exhibits rather than an inference from shared code.
 *
 * Deliberately Convex-FREE (no useQuery / no auth) so a screenshot always proves
 * the render even if sign-in fails — same posture as dev-latex.tsx.
 */

import { Stack, useLocalSearchParams } from "expo-router";
import { StyleSheet, Text, View } from "react-native";

import { GeoMapNative } from "@/components/GeoMapNative";
import type { GeoMapSpec, LngLat, ScholarPin } from "../../vendor/geomap/types";
import { fonts, useColors } from "@/theme";

const MAPBOX_TOKEN = process.env.EXPO_PUBLIC_MAPBOX_TOKEN?.trim() || null;

const NO_PINS: ScholarPin[] = [];

const line = (coords: LngLat[]) => ({
  geojson: {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        properties: {},
        geometry: { type: "LineString" as const, coordinates: coords },
      },
    ],
  },
});

/** The five arrows from the real prod artifact, verbatim, plus a Pacific hop. */
const WORLD: GeoMapSpec = {
  v: 1,
  id: "dev-geomap-arcs-world",
  title: "Journey arcs — the prod spec",
  base: "political",
  camera: { center: [-60, 25], zoom: 0.6 },
  layers: [
    {
      id: "tomato-arrow-1",
      label: "Americas to Europe",
      paint: "arrows",
      tint: "red",
      source: line([
        [-77, -10],
        [12.5, 42.5],
      ]),
    },
    {
      id: "tomato-arrow-2",
      label: "Europe to Hawaiʻi",
      paint: "arrows",
      tint: "green",
      source: line([
        [12.5, 42.5],
        [-157.9, 21.3],
      ]),
    },
    {
      id: "pasta-arrow",
      label: "Italy to Hawaiʻi",
      paint: "arrows",
      tint: "amber",
      source: line([
        [12.5, 42.5],
        [-157.9, 21.3],
      ]),
    },
    {
      id: "basil-arrow",
      label: "Southeast Asia to Hawaiʻi",
      paint: "arrows",
      tint: "violet",
      source: line([
        [78, 20],
        [60, 10],
        [20, -20],
        [-20, -30],
        [-70, -30],
        [-120, 0],
        [-157.9, 21.3],
      ]),
    },
    {
      id: "oregano-arrow",
      label: "Greece to Hawaiʻi",
      paint: "arrows",
      tint: "blue",
      source: line([
        [22, 39],
        [12.5, 42.5],
        [-157.9, 21.3],
      ]),
    },
    {
      // Not in the prod spec: the Pacific crossing, so the antimeridian split
      // is visible on device too.
      id: "tokyo-arrow",
      label: "Tokyo to Hawaiʻi",
      paint: "arrows",
      tint: "gray",
      source: line([
        [139.7, 35.7],
        [-157.9, 21.3],
      ]),
    },
  ],
  markers: [
    { id: "americas", lngLat: [-77, -10], label: "Americas" },
    { id: "italy", lngLat: [12.5, 42.5], label: "Italy" },
    { id: "hawaii", lngLat: [-157.9, 21.3], label: "Hawaiʻi" },
    { id: "basil", lngLat: [78, 20], label: "India" },
    { id: "greece", lngLat: [22, 39], label: "Greece" },
    { id: "tokyo", lngLat: [139.7, 35.7], label: "Tokyo" },
  ],
  interactions: { tapToPin: false },
};

/** Short hops + a literal river: the uniformity claim and the routeLine exemption. */
const SHORT: GeoMapSpec = {
  v: 1,
  id: "dev-geomap-arcs-short",
  title: "Short hops — uniform lift, literal river",
  base: "political",
  camera: { center: [14, 40], zoom: 3.6 },
  layers: [
    {
      id: "greece-italy",
      label: "Greece to Italy",
      paint: "arrows",
      tint: "blue",
      source: line([
        [22, 39],
        [12.5, 42.5],
      ]),
    },
    {
      id: "italy-tunis",
      label: "Italy to Tunis",
      paint: "arrows",
      tint: "amber",
      source: line([
        [12.5, 42.5],
        [10.2, 36.8],
      ]),
    },
    {
      id: "corsica-rome",
      label: "Corsica to Rome",
      paint: "arrows",
      tint: "violet",
      source: line([
        [9.1, 42.2],
        [12.5, 41.9],
      ]),
    },
    {
      // routeLine is LITERAL: a river's shape is the content, so this must come
      // out unbent — the exemption is visible in the same frame as the arcs.
      id: "tiber",
      label: "A river (routeLine)",
      paint: "routeLine",
      tint: "green",
      source: line([
        [12.23, 42.42],
        [12.35, 42.1],
        [12.47, 41.93],
        [12.28, 41.74],
      ]),
    },
  ],
  markers: [
    { id: "greece", lngLat: [22, 39], label: "Greece" },
    { id: "italy", lngLat: [12.5, 42.5], label: "Italy" },
    { id: "tunis", lngLat: [10.2, 36.8], label: "Tunis" },
    { id: "corsica", lngLat: [9.1, 42.2], label: "Corsica" },
  ],
  interactions: { tapToPin: false },
};

export default function DevGeomapArcs() {
  const colors = useColors();
  const { set } = useLocalSearchParams<{ set?: string }>();
  const spec = set === "short" ? SHORT : WORLD;

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <Stack.Screen options={{ title: "Journey arcs", headerShown: false }} />
      {MAPBOX_TOKEN ? (
        <GeoMapNative spec={spec} scholarPins={NO_PINS} token={MAPBOX_TOKEN} />
      ) : (
        <View style={styles.empty}>
          <Text style={[styles.emptyText, { color: colors.charcoal }]}>
            No EXPO_PUBLIC_MAPBOX_TOKEN in native/.env — add one, then restart
            Metro (EXPO_PUBLIC_* values inline at bundle time).
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  emptyText: { fontFamily: fonts.regular, fontSize: 15, textAlign: "center" },
});
