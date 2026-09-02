/**
 * Overlay paint — the closed set of visual treatments a spec's `PaintPreset`
 * may ask for, resolved to concrete Mapbox layer specs. Specs only name the
 * intent (`regionFill`, `arrows`, …) + an optional `tint`; the concrete
 * colors/widths live here so the look stays consistent app-wide and a spec can
 * never inject arbitrary styling.
 *
 * Pure (no mapbox runtime import — the `LayerSpecification` type is erased at
 * build time), so the palette/preset logic is plain-vitest-testable.
 */
import type { LayerSpecification } from "mapbox-gl";
import type { PaintPreset, PaintTint } from "@/lib/geomap/types";

/**
 * THE DOCTRINE (founder ruling, 2026-08-31), and it replaces an earlier one.
 *
 * The rule used to be "never draw a corridor the author didn't specify", and it
 * produced a geodesically-honest renderer that elided unrouted long hauls into
 * dashed stubs. That was rejected on sight: "terrible… that geodesically
 * accurate thing is an abomination."
 *
 * The rule is now: NEVER IMPLY PRECISION THE AUTHOR DIDN'T SPECIFY.
 *
 *   "the original sin is that the map is drawn in a way that implies a false
 *    sense of precision. if we're just trying to communicate the idea of 'from
 *    italy to hawaii', a simple upward-bending arc, as in an airline route map,
 *    is probably better than anything precise."
 *
 * The two rules sound alike and are not. The old one treats the drawn line as a
 * claim to be made carefully — so it agonizes over which corridor is true, and
 * when it cannot decide it withholds. The new one denies the line is a
 * territorial claim at all: a journey arrow is DIAGRAM. Draw it in a vocabulary
 * readers already know means "connected", the way an airline route map does,
 * and the precision question stops being asked.
 *
 * The geometry and the per-preset policy both live in `lib/geomap/geo.ts`, not
 * here: the iPad renderer reads the SAME record through `native/vendor/geomap`,
 * and a preset that arcs on web but not on iPad would be a scholar-facing
 * parity gap. This file owns only the concrete Mapbox paint.
 */

/**
 * The small named palette (plan §7 + the app's accent set). A preset with no
 * tint falls back to violet — the product's primary accent.
 */
export const TINT_HEX: Record<PaintTint, string> = {
  violet: "#AD60BF",
  blue: "#2b6cb0",
  green: "#1f9d6b",
  amber: "#b45309",
  red: "#b91c1c",
  gray: "#6b7280",
};

const DEFAULT_TINT: PaintTint = "violet";

export function tintHex(tint?: PaintTint): string {
  return TINT_HEX[tint ?? DEFAULT_TINT] ?? TINT_HEX.violet;
}

/** Sublayer id scheme so the renderer can toggle a whole GeoLayer's visibility. */
export function sublayerId(layerId: string, part: string): string {
  return `geolayer::${layerId}::${part}`;
}

/**
 * Build the concrete Mapbox layer spec(s) for one overlay layer. A preset may
 * expand to several layers (fill + outline, line + label): the renderer adds
 * them all and toggles them together by id prefix.
 */
export function buildPaintLayers(
  layerId: string,
  sourceId: string,
  preset: PaintPreset,
  tint?: PaintTint,
): LayerSpecification[] {
  const color = tintHex(tint);
  const id = (part: string) => sublayerId(layerId, part);

  // Region datasets label THEMSELVES from properties.name/label (the 1914
  // empires carry their names as data). This matters pedagogically: the
  // historical overlay rides the politicalUnlabeled base — modern basemap
  // labels would spoil "find Poland (you can't)" — so the overlay's own names
  // are the only text the kid gets, and they're part of the evidence, not a
  // spoiler. Region datasets used as hidden GeoTask targets are never rendered
  // as layers, so this leaks nothing.
  // Labels render ONLY at authored labelPoint companions (one Point feature per
  // state, emitted by the registry authoring pipeline). Without the filter,
  // mapbox labels EVERY polygon part of a MultiPolygon — "United Kingdom" ×3,
  // "Denmark" ×5 — and stacked region layers (the WWI bloc tints over the 1914
  // borders) would each re-label the same states. Datasets without labelPoint
  // companions (the bloc tints, tutor-inline regions) get no labels, which is
  // the correct default: their fill IS the message.
  const regionNameLabel = (): LayerSpecification => ({
    id: id("name"),
    type: "symbol",
    source: sourceId,
    filter: ["==", ["get", "labelPoint"], true],
    layout: {
      "symbol-placement": "point",
      "text-field": ["coalesce", ["get", "name"], ["get", "label"], ""],
      "text-size": 11,
      "text-font": ["DIN Pro Medium", "Arial Unicode MS Regular"],
    },
    paint: {
      "text-color": "#374151",
      "text-halo-color": "rgba(255,255,255,0.85)",
      "text-halo-width": 1.2,
    },
  });

  switch (preset) {
    case "regionFill":
      return [
        {
          id: id("fill"),
          type: "fill",
          source: sourceId,
          paint: { "fill-color": color, "fill-opacity": 0.18 },
        },
        {
          id: id("outline"),
          type: "line",
          source: sourceId,
          paint: { "line-color": color, "line-width": 2, "line-opacity": 1 },
        },
        regionNameLabel(),
      ];

    case "regionOutline":
      return [
        {
          id: id("outline"),
          type: "line",
          source: sourceId,
          paint: { "line-color": color, "line-width": 2 },
        },
        regionNameLabel(),
      ];

    case "isolines":
      return [
        {
          id: id("line"),
          type: "line",
          source: sourceId,
          paint: { "line-color": color, "line-width": 1.5, "line-opacity": 0.9 },
        },
        {
          id: id("label"),
          type: "symbol",
          source: sourceId,
          layout: {
            "symbol-placement": "line",
            "text-field": ["coalesce", ["get", "label"], ""],
            "text-size": 12,
            "text-max-angle": 30,
          },
          paint: {
            "text-color": color,
            "text-halo-color": "#ffffff",
            "text-halo-width": 1.4,
          },
        },
      ];

    case "arrows":
      return [
        {
          id: id("line"),
          type: "line",
          source: sourceId,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": color, "line-width": 2, "line-opacity": 0.9 },
        },
        {
          // Dependency-free arrowheads: a repeated "▶" text glyph laid along the
          // line, rotated to follow it. No custom icon/sprite required.
          id: id("arrows"),
          type: "symbol",
          source: sourceId,
          layout: {
            "symbol-placement": "line",
            "symbol-spacing": 80,
            "text-field": "▶",
            "text-size": 14,
            "text-keep-upright": false,
            "text-rotation-alignment": "map",
            "text-allow-overlap": true,
          },
          paint: {
            "text-color": color,
            "text-halo-color": "#ffffff",
            "text-halo-width": 1,
          },
        },
      ];

    case "routeLine":
      return [
        {
          id: id("line"),
          type: "line",
          source: sourceId,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": color, "line-width": 3 },
        },
      ];

    case "points":
      return [
        {
          id: id("circle"),
          type: "circle",
          source: sourceId,
          paint: {
            "circle-color": color,
            "circle-radius": 5,
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 1.5,
          },
        },
        {
          id: id("label"),
          type: "symbol",
          source: sourceId,
          layout: {
            "text-field": ["coalesce", ["get", "label"], ""],
            "text-size": 12,
            "text-offset": [0, 1.1],
            "text-anchor": "top",
            "text-optional": true,
          },
          paint: {
            "text-color": "#1a202c",
            "text-halo-color": "#ffffff",
            "text-halo-width": 1.4,
          },
        },
      ];
  }
}
