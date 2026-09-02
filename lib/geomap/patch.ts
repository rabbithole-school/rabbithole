import type {
  GeoBase,
  GeoCamera,
  GeoInteractions,
  GeoLayer,
  GeoMapSpec,
  GeoMarker,
  GeoStep,
  GeoTask,
} from "./types";

export const GEOMAP_MAX_OPS_PER_BATCH = 24;

type NullableInteractionPatch = {
  [K in keyof GeoInteractions]?: GeoInteractions[K] | null;
};

type GeoCameraPatch = Pick<Partial<GeoCamera>, "center" | "zoom"> & {
  pitch?: number | null;
  bearing?: number | null;
};

export type GeoMapOp =
  | { op: "patchCamera"; camera: GeoCameraPatch }
  | {
      op: "patchView";
      title?: string | null;
      base?: GeoBase;
      terrain3d?: boolean | null;
      globe?: boolean | null;
      hideBaseBoundaries?: boolean | null;
      historicalBasemap?: string | null;
    }
  | { op: "patchInteractions"; interactions: NullableInteractionPatch | null }
  | { op: "upsertLayer"; layer: GeoLayer }
  | { op: "removeLayer"; layerId: string }
  | { op: "setLayerVisibility"; layerId: string; visible: boolean }
  | { op: "upsertMarker"; marker: GeoMarker }
  | { op: "removeMarker"; markerId: string }
  | { op: "replaceSteps"; steps: GeoStep[] }
  | { op: "setTask"; task: GeoTask | null };

export type ApplyGeoMapOpsResult =
  | { ok: true; spec: GeoMapSpec }
  | { ok: false; error: string };

const BASES = new Set<GeoBase>([
  "satellite",
  "terrain",
  "political",
  "politicalUnlabeled",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): string[] {
  return Object.keys(value).filter((key) => !allowed.has(key));
}

function nonEmptyId(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value
    : null;
}

function patchOptionalBoolean(
  target: GeoMapSpec,
  key: "terrain3d" | "globe" | "hideBaseBoundaries",
  value: unknown,
): string | null {
  if (value === null) {
    delete target[key];
    return null;
  }
  if (typeof value !== "boolean") return `${key} must be boolean or null`;
  target[key] = value;
  return null;
}

/**
 * Apply a small, id-addressed operation batch to a map spec.
 *
 * Whole-spec updates are intentionally absent: a camera or visibility change
 * cannot rewrite route geometry, markers, or task state the model did not mean
 * to touch. The batch is all-or-nothing.
 */
export function applyGeoMapOps(
  spec: GeoMapSpec,
  ops: GeoMapOp[],
): ApplyGeoMapOpsResult {
  if (!Array.isArray(ops) || ops.length === 0) {
    return { ok: false, error: "no operations supplied" };
  }
  if (ops.length > GEOMAP_MAX_OPS_PER_BATCH) {
    return {
      ok: false,
      error: `too many operations (${ops.length} > ${GEOMAP_MAX_OPS_PER_BATCH})`,
    };
  }

  const next = JSON.parse(JSON.stringify(spec)) as GeoMapSpec;

  for (const rawOp of ops as unknown[]) {
    if (!isRecord(rawOp) || typeof rawOp.op !== "string") {
      return { ok: false, error: "every operation needs an op" };
    }

    switch (rawOp.op) {
      case "patchCamera": {
        const camera = rawOp.camera;
        if (!isRecord(camera)) {
          return { ok: false, error: "patchCamera.camera must be an object" };
        }
        const unknown = invalidKeys(
          camera,
          new Set(["center", "zoom", "pitch", "bearing"]),
        );
        if (unknown.length > 0) {
          return {
            ok: false,
            error: `patchCamera: unknown field "${unknown[0]}"`,
          };
        }
        if (Object.keys(camera).length === 0) {
          return { ok: false, error: "patchCamera needs at least one field" };
        }
        const patchedCamera: GeoCamera = { ...next.camera };
        if ("center" in camera) {
          patchedCamera.center = camera.center as GeoCamera["center"];
        }
        if ("zoom" in camera) {
          patchedCamera.zoom = camera.zoom as number;
        }
        for (const key of ["pitch", "bearing"] as const) {
          if (!(key in camera)) continue;
          if (camera[key] === null) delete patchedCamera[key];
          else patchedCamera[key] = camera[key] as number;
        }
        next.camera = patchedCamera;
        break;
      }

      case "patchView": {
        const unknown = invalidKeys(
          rawOp,
          new Set([
            "op",
            "title",
            "base",
            "terrain3d",
            "globe",
            "hideBaseBoundaries",
            "historicalBasemap",
          ]),
        );
        if (unknown.length > 0) {
          return {
            ok: false,
            error: `patchView: unknown field "${unknown[0]}"`,
          };
        }
        const fields = Object.keys(rawOp).filter((key) => key !== "op");
        if (fields.length === 0) {
          return { ok: false, error: "patchView needs at least one field" };
        }
        if ("title" in rawOp) {
          if (rawOp.title === null) delete next.title;
          else if (typeof rawOp.title === "string") next.title = rawOp.title;
          else return { ok: false, error: "title must be string or null" };
        }
        if ("base" in rawOp) {
          if (!BASES.has(rawOp.base as GeoBase)) {
            return { ok: false, error: `unknown base "${String(rawOp.base)}"` };
          }
          next.base = rawOp.base as GeoBase;
        }
        for (const key of [
          "terrain3d",
          "globe",
          "hideBaseBoundaries",
        ] as const) {
          if (!(key in rawOp)) continue;
          const error = patchOptionalBoolean(next, key, rawOp[key]);
          if (error) return { ok: false, error };
        }
        if ("historicalBasemap" in rawOp) {
          if (rawOp.historicalBasemap === null) {
            delete next.historicalBasemap;
          } else if (typeof rawOp.historicalBasemap === "string") {
            next.historicalBasemap = rawOp.historicalBasemap;
          } else {
            return {
              ok: false,
              error: "historicalBasemap must be string or null",
            };
          }
        }
        break;
      }

      case "patchInteractions": {
        const patch = rawOp.interactions;
        if (patch === null) {
          delete next.interactions;
          break;
        }
        if (!isRecord(patch)) {
          return {
            ok: false,
            error: "patchInteractions.interactions must be an object or null",
          };
        }
        const allowed = new Set([
          "pan",
          "zoom",
          "rotate",
          "pitch",
          "baseToggle",
          "tapToPin",
        ]);
        const unknown = invalidKeys(patch, allowed);
        if (unknown.length > 0) {
          return {
            ok: false,
            error: `patchInteractions: unknown field "${unknown[0]}"`,
          };
        }
        if (Object.keys(patch).length === 0) {
          return {
            ok: false,
            error: "patchInteractions needs at least one field",
          };
        }
        const interactions: Record<string, unknown> = {
          ...(next.interactions ?? {}),
        };
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) {
            delete interactions[key];
            continue;
          }
          if (key === "baseToggle") {
            if (
              value !== false &&
              (!Array.isArray(value) ||
                value.some((base) => !BASES.has(base as GeoBase)))
            ) {
              return {
                ok: false,
                error:
                  "baseToggle must be false, null, or an array of known bases",
              };
            }
          } else if (typeof value !== "boolean") {
            return {
              ok: false,
              error: `${key} must be boolean or null`,
            };
          }
          interactions[key] = value;
        }
        next.interactions = interactions as GeoInteractions;
        break;
      }

      case "upsertLayer": {
        if (!isRecord(rawOp.layer)) {
          return { ok: false, error: "upsertLayer.layer must be an object" };
        }
        const id = nonEmptyId(rawOp.layer.id);
        if (!id) return { ok: false, error: "upsertLayer needs layer.id" };
        const layers = [...(next.layers ?? [])];
        const index = layers.findIndex((layer) => layer.id === id);
        const layer = rawOp.layer as unknown as GeoLayer;
        if (index === -1) layers.push(layer);
        else layers[index] = layer;
        next.layers = layers;
        break;
      }

      case "removeLayer": {
        const id = nonEmptyId(rawOp.layerId);
        if (!id) return { ok: false, error: "removeLayer needs layerId" };
        const layers = next.layers ?? [];
        if (!layers.some((layer) => layer.id === id)) {
          return { ok: false, error: `unknown layer "${id}"` };
        }
        next.layers = layers.filter((layer) => layer.id !== id);
        break;
      }

      case "setLayerVisibility": {
        const id = nonEmptyId(rawOp.layerId);
        if (!id) {
          return {
            ok: false,
            error: "setLayerVisibility needs layerId",
          };
        }
        if (typeof rawOp.visible !== "boolean") {
          return {
            ok: false,
            error: "setLayerVisibility.visible must be boolean",
          };
        }
        const layers = [...(next.layers ?? [])];
        const index = layers.findIndex((layer) => layer.id === id);
        if (index === -1) {
          return { ok: false, error: `unknown layer "${id}"` };
        }
        layers[index] = {
          ...layers[index],
          initiallyVisible: rawOp.visible,
        };
        next.layers = layers;
        break;
      }

      case "upsertMarker": {
        if (!isRecord(rawOp.marker)) {
          return { ok: false, error: "upsertMarker.marker must be an object" };
        }
        const id = nonEmptyId(rawOp.marker.id);
        if (!id) return { ok: false, error: "upsertMarker needs marker.id" };
        const markers = [...(next.markers ?? [])];
        const index = markers.findIndex((marker) => marker.id === id);
        const marker = rawOp.marker as unknown as GeoMarker;
        if (index === -1) markers.push(marker);
        else markers[index] = marker;
        next.markers = markers;
        break;
      }

      case "removeMarker": {
        const id = nonEmptyId(rawOp.markerId);
        if (!id) return { ok: false, error: "removeMarker needs markerId" };
        const markers = next.markers ?? [];
        if (!markers.some((marker) => marker.id === id)) {
          return { ok: false, error: `unknown marker "${id}"` };
        }
        next.markers = markers.filter((marker) => marker.id !== id);
        break;
      }

      case "replaceSteps": {
        if (!Array.isArray(rawOp.steps)) {
          return { ok: false, error: "replaceSteps.steps must be an array" };
        }
        next.steps = rawOp.steps as GeoStep[];
        break;
      }

      case "setTask": {
        if (rawOp.task === null) {
          delete next.task;
        } else if (isRecord(rawOp.task)) {
          next.task = rawOp.task as unknown as GeoTask;
        } else {
          return { ok: false, error: "setTask.task must be an object or null" };
        }
        break;
      }

      default:
        return { ok: false, error: `unknown map operation "${rawOp.op}"` };
    }
  }

  return { ok: true, spec: next };
}
