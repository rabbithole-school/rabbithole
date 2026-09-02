import { describe, expect, test } from "vitest";
import { applyGeoMapOps } from "../patch";
import type { GeoMapSpec } from "../types";

function routeSpec(): GeoMapSpec {
  return {
    v: 1,
    id: "map-1",
    title: "A long journey",
    camera: { center: [-20, 15], zoom: 1 },
    base: "political",
    globe: true,
    interactions: { pan: true, zoom: true },
    layers: [
      {
        id: "route-1",
        label: "First route",
        source: {
          geojson: {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                geometry: {
                  type: "LineString",
                  coordinates: [
                    [-77, -10],
                    [12.5, 42.5],
                  ],
                },
              },
            ],
          },
        },
        paint: "arrows",
        tint: "red",
      },
      {
        id: "route-2",
        label: "Second route",
        source: {
          geojson: {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                geometry: {
                  type: "LineString",
                  coordinates: [
                    [12.5, 42.5],
                    [100, 20],
                    [179, 21],
                    [-179, 21],
                    [-157.9, 21.3],
                  ],
                },
              },
            ],
          },
        },
        paint: "arrows",
        tint: "green",
        initiallyVisible: false,
      },
    ],
    markers: [
      { id: "origin", lngLat: [-77, -10], label: "Origin" },
      { id: "destination", lngLat: [-157.9, 21.3], label: "Destination" },
    ],
  };
}

describe("applyGeoMapOps", () => {
  test("camera and visibility patches preserve unrelated route geometry", () => {
    const original = routeSpec();
    const originalLayers = structuredClone(original.layers);

    const result = applyGeoMapOps(original, [
      { op: "patchCamera", camera: { zoom: 0.75 } },
      {
        op: "setLayerVisibility",
        layerId: "route-2",
        visible: true,
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.camera).toEqual({ center: [-20, 15], zoom: 0.75 });
    expect(result.spec.layers?.[0]).toEqual(originalLayers?.[0]);
    expect(result.spec.layers?.[1].source).toEqual(
      originalLayers?.[1].source,
    );
    expect(result.spec.layers?.[1].initiallyVisible).toBe(true);
    expect(result.spec.markers).toEqual(original.markers);
    expect(original.layers).toEqual(originalLayers);
  });

  test("upsert replaces only the addressed layer and keeps its position", () => {
    const original = routeSpec();
    const replacement = {
      ...original.layers![1],
      tint: "violet" as const,
    };

    const result = applyGeoMapOps(original, [
      { op: "upsertLayer", layer: replacement },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.layers).toEqual([original.layers![0], replacement]);
  });

  test("camera patches can clear optional orientation without replacing center", () => {
    const original = routeSpec();
    original.camera = {
      center: [-20, 15],
      zoom: 1,
      pitch: 45,
      bearing: 20,
    };

    const result = applyGeoMapOps(original, [
      { op: "patchCamera", camera: { pitch: null, bearing: null } },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.camera).toEqual({ center: [-20, 15], zoom: 1 });
  });

  test("bad operations fail without mutating the input", () => {
    const original = routeSpec();
    const snapshot = structuredClone(original);

    const result = applyGeoMapOps(original, [
      {
        op: "setLayerVisibility",
        layerId: "missing",
        visible: true,
      },
    ]);

    expect(result).toEqual({ ok: false, error: 'unknown layer "missing"' });
    expect(original).toEqual(snapshot);
  });
});
