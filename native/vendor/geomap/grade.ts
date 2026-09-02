/**
 * GeoTask grading — pure, server-authoritative (the manipulative rule: the
 * client's own check is optimistic UI only; convex re-runs THIS function on
 * the submitted state). No answer string exists anywhere: the task's target
 * lives in the server-held spec, the kid submits pins.
 */
import { haversineKm, isValidLngLat, pointInRegion } from "./geo";
import type { GeoJsonFeatureCollection, GeoTask, GeoTaskState } from "./types";

/** Resolves a registry key to its dataset (injected so grade.ts stays pure). */
export type RegionResolver = (registryKey: string) => GeoJsonFeatureCollection | undefined;

/**
 * Optimal pin↔target matching for pinSet: every target must be claimed by a
 * DISTINCT pin within that target's tolerance. Exact backtracking — target
 * counts are capped small (GEOMAP_MAX_TASK_TARGETS), so this is trivial work,
 * and greedy matching has real failure cases two overlapping tolerances away.
 */
function pinSetSolved(
  targets: Array<{ lngLat: [number, number]; toleranceKm: number }>,
  pins: GeoTaskState["pins"],
): boolean {
  if (targets.length === 0) return true;
  if (pins.length < targets.length) return false;
  const usedPins = new Set<number>();
  const assign = (ti: number): boolean => {
    if (ti === targets.length) return true;
    const t = targets[ti];
    for (let pi = 0; pi < pins.length; pi++) {
      if (usedPins.has(pi)) continue;
      if (!isValidLngLat(pins[pi].lngLat)) continue;
      if (haversineKm(pins[pi].lngLat, t.lngLat) <= t.toleranceKm) {
        usedPins.add(pi);
        if (assign(ti + 1)) return true;
        usedPins.delete(pi);
      }
    }
    return false;
  };
  return assign(0);
}

/**
 * The GREEN/RED verdict for a graded map task.
 *
 * `locate` and `region` grade the MOST RECENT pin (the kid's current answer —
 * task UIs run single-pin mode, but a re-tap replaces rather than accumulates,
 * so "last pin wins" is the honest read either way).
 */
export function isSolved(
  task: GeoTask,
  state: GeoTaskState,
  resolveRegion?: RegionResolver,
): boolean {
  const pins = Array.isArray(state?.pins) ? state.pins : [];
  switch (task.kind) {
    case "locate": {
      const last = pins[pins.length - 1];
      if (!last || !isValidLngLat(last.lngLat)) return false;
      return haversineKm(last.lngLat, task.target) <= task.toleranceKm;
    }
    case "region": {
      const last = pins[pins.length - 1];
      if (!last || !isValidLngLat(last.lngLat)) return false;
      const region = resolveRegion?.(task.targetRegion.registry);
      if (!region) return false; // unresolvable region can never green-light
      return pointInRegion(last.lngLat, region);
    }
    case "pinSet":
      return pinSetSolved(task.targets, pins);
  }
}

/** Parse an untrusted submitted state string into a GeoTaskState (or null). */
export function parseTaskState(raw: string): GeoTaskState | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const pins = (parsed as { pins?: unknown }).pins;
    if (!Array.isArray(pins)) return null;
    const clean = pins
      .filter(
        (p): p is { id: unknown; lngLat: unknown } =>
          !!p && typeof p === "object" && "lngLat" in p,
      )
      .filter((p) => isValidLngLat(p.lngLat))
      .map((p, i) => ({
        id: typeof p.id === "string" ? p.id : `pin-${i}`,
        lngLat: p.lngLat as [number, number],
      }));
    return { pins: clean };
  } catch {
    return null;
  }
}
