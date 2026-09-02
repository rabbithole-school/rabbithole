/**
 * GeoMapSpec validation — the governance gate. Every spec entering the system
 * (the show_map tool, seeded activities, geoLocate manipulative specs) passes
 * through `validateSpec` BEFORE storage. Pure: registry membership is injected
 * as a key set so this file imports no data and tests stay trivial.
 *
 * Philosophy: reject loudly with a human-readable reason (the tool result
 * surfaces it to the model, which can self-correct), never silently strip.
 */
import { isValidLngLat } from "./geo";
import {
  GEOMAP_MAX_INLINE_GEOJSON_BYTES,
  GEOMAP_MAX_LAYERS,
  GEOMAP_MAX_MARKERS,
  GEOMAP_MAX_SCHOLAR_PINS,
  GEOMAP_MAX_STEPS,
  GEOMAP_MAX_TASK_TARGETS,
  type GeoBase,
  type GeoMapSpec,
  type PaintPreset,
  type PaintTint,
  type ScholarPin,
} from "./types";

const BASES: ReadonlySet<string> = new Set<GeoBase>([
  "satellite",
  "terrain",
  "political",
  "politicalUnlabeled",
]);
const PRESETS: ReadonlySet<string> = new Set<PaintPreset>([
  "regionFill",
  "regionOutline",
  "isolines",
  "arrows",
  "routeLine",
  "points",
]);
const TINTS: ReadonlySet<string> = new Set<PaintTint>([
  "blue",
  "green",
  "amber",
  "red",
  "violet",
  "gray",
]);

export type ValidationResult = { ok: true } | { ok: false; reason: string };

const fail = (reason: string): ValidationResult => ({ ok: false, reason });

export function validateSpec(
  spec: GeoMapSpec,
  opts: {
    registryKeys: ReadonlySet<string>;
    /** Curated hosted-era-style keys (lib/geomap/historicalBasemaps). */
    historicalBasemapKeys?: ReadonlySet<string>;
  },
): ValidationResult {
  if (!spec || typeof spec !== "object") return fail("spec must be an object");
  if (spec.v !== 1) return fail(`unsupported spec version ${String((spec as { v?: unknown }).v)}`);
  if (typeof spec.id !== "string" || !spec.id.trim()) return fail("spec.id is required");

  // Camera
  const cam = spec.camera;
  if (!cam || !isValidLngLat(cam.center)) return fail("camera.center must be a valid [lng, lat]");
  if (typeof cam.zoom !== "number" || cam.zoom < 0 || cam.zoom > 22)
    return fail("camera.zoom must be 0–22");
  if (cam.pitch !== undefined && (cam.pitch < 0 || cam.pitch > 85))
    return fail("camera.pitch must be 0–85");
  if (cam.bearing !== undefined && !Number.isFinite(cam.bearing))
    return fail("camera.bearing must be finite");

  if (!BASES.has(spec.base)) return fail(`unknown base "${String(spec.base)}"`);

  if (spec.historicalBasemap !== undefined) {
    if (!(opts.historicalBasemapKeys?.has(spec.historicalBasemap) ?? false))
      return fail(
        `unknown historicalBasemap "${String(spec.historicalBasemap)}" — omit it or use a curated key`,
      );
  }

  // Layers
  const layers = spec.layers ?? [];
  if (layers.length > GEOMAP_MAX_LAYERS) return fail(`too many layers (max ${GEOMAP_MAX_LAYERS})`);
  const layerIds = new Set<string>();
  for (const layer of layers) {
    if (typeof layer.id !== "string" || !layer.id.trim()) return fail("every layer needs an id");
    if (layerIds.has(layer.id)) return fail(`duplicate layer id "${layer.id}"`);
    layerIds.add(layer.id);
    if (typeof layer.label !== "string" || !layer.label.trim())
      return fail(`layer "${layer.id}" needs a label`);
    if (!PRESETS.has(layer.paint)) return fail(`layer "${layer.id}": unknown paint preset`);
    if (layer.tint !== undefined && !TINTS.has(layer.tint))
      return fail(`layer "${layer.id}": unknown tint`);
    const src = layer.source as { registry?: unknown; geojson?: unknown };
    if (typeof src?.registry === "string") {
      if (!opts.registryKeys.has(src.registry))
        return fail(`layer "${layer.id}": unknown registry key "${src.registry}"`);
    } else if (src?.geojson) {
      const gj = src.geojson as { type?: unknown; features?: unknown };
      if (gj.type !== "FeatureCollection" || !Array.isArray(gj.features))
        return fail(`layer "${layer.id}": inline geojson must be a FeatureCollection`);
      const bytes = JSON.stringify(src.geojson).length;
      if (bytes > GEOMAP_MAX_INLINE_GEOJSON_BYTES)
        return fail(
          `layer "${layer.id}": inline geojson is ${bytes} bytes (max ${GEOMAP_MAX_INLINE_GEOJSON_BYTES}); use a registry dataset`,
        );
    } else {
      return fail(`layer "${layer.id}": source must be { registry } or { geojson }`);
    }
  }

  // Markers
  const markers = spec.markers ?? [];
  if (markers.length > GEOMAP_MAX_MARKERS)
    return fail(`too many markers (max ${GEOMAP_MAX_MARKERS})`);
  const markerIds = new Set<string>();
  for (const m of markers) {
    if (typeof m.id !== "string" || !m.id.trim()) return fail("every marker needs an id");
    if (markerIds.has(m.id)) return fail(`duplicate marker id "${m.id}"`);
    markerIds.add(m.id);
    if (!isValidLngLat(m.lngLat)) return fail(`marker "${m.id}": invalid lngLat`);
  }

  // Steps
  const steps = spec.steps ?? [];
  if (steps.length > GEOMAP_MAX_STEPS) return fail(`too many steps (max ${GEOMAP_MAX_STEPS})`);
  for (const s of steps) {
    if (typeof s.id !== "string" || !s.id.trim()) return fail("every step needs an id");
    for (const lid of s.visibleLayerIds) {
      if (!layerIds.has(lid)) return fail(`step "${s.id}" references unknown layer "${lid}"`);
    }
    if (s.camera?.center !== undefined && !isValidLngLat(s.camera.center))
      return fail(`step "${s.id}": invalid camera.center`);
  }

  // Task
  const task = spec.task;
  if (task) {
    if (task.kind === "locate") {
      if (!isValidLngLat(task.target)) return fail("locate task: invalid target");
      if (!(task.toleranceKm > 0)) return fail("locate task: toleranceKm must be > 0");
    } else if (task.kind === "region") {
      if (!opts.registryKeys.has(task.targetRegion?.registry ?? ""))
        return fail("region task: unknown registry key");
    } else if (task.kind === "pinSet") {
      if (!Array.isArray(task.targets) || task.targets.length === 0)
        return fail("pinSet task: needs at least one target");
      if (task.targets.length > GEOMAP_MAX_TASK_TARGETS)
        return fail(`pinSet task: too many targets (max ${GEOMAP_MAX_TASK_TARGETS})`);
      for (const t of task.targets) {
        if (!isValidLngLat(t.lngLat)) return fail("pinSet task: invalid target lngLat");
        if (!(t.toleranceKm > 0)) return fail("pinSet task: toleranceKm must be > 0");
      }
    } else {
      return fail(`unknown task kind "${String((task as { kind?: unknown }).kind)}"`);
    }
    if (typeof (task as { prompt?: unknown }).prompt !== "string")
      return fail("task.prompt is required");
  }

  return { ok: true };
}

/** Validate an untrusted scholar-pins array (the scholarSetMapPins mutation). */
export function validateScholarPins(pins: unknown): ValidationResult {
  if (!Array.isArray(pins)) return fail("pins must be an array");
  if (pins.length > GEOMAP_MAX_SCHOLAR_PINS)
    return fail(`too many pins (max ${GEOMAP_MAX_SCHOLAR_PINS})`);
  for (const p of pins as ScholarPin[]) {
    if (!p || typeof p.id !== "string" || !p.id.trim()) return fail("every pin needs an id");
    if (!isValidLngLat(p.lngLat)) return fail(`pin "${p.id}": invalid lngLat`);
    if (p.label !== undefined && typeof p.label !== "string") return fail("pin label must be a string");
  }
  return { ok: true };
}
