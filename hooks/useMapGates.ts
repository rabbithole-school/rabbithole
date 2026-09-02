"use client";

/**
 * useMapGates — the scholar's OWN Sky/Tree map visibility + reveal state.
 *
 * Both maps are hidden from a scholar's nav until each first has real data
 * (the milestone-reveal design, f6). The gate is evidence-derived server-side
 * (convex/mapGates.ts); this hook is the client read.
 *
 * Only meaningful for a scholar viewing their OWN maps. A teacher/parent/
 * observer viewing a scholar (remote mode) always sees every map, so callers
 * pass `enabled = false` there and never gate.
 */

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

export type MapGatesState = {
  /** Sky lens unlocked for this scholar. */
  sky: boolean;
  /** Tree lens unlocked for this scholar. */
  tree: boolean;
  /** Sky reveal not yet shown (unlocked + un-acknowledged). */
  skyRevealPending: boolean;
  /** Tree reveal not yet shown (unlocked + un-acknowledged). */
  treeRevealPending: boolean;
  /** True until the gate query resolves (only while enabled). */
  isLoading: boolean;
  /** At least one map unlocked → the "Your Map" nav entry may appear. */
  anyUnlocked: boolean;
};

export function useMapGates(enabled: boolean = true): MapGatesState {
  const gates = useQuery(api.mapGates.mine, enabled ? {} : "skip");
  return {
    sky: gates?.sky ?? false,
    tree: gates?.tree ?? false,
    skyRevealPending: gates?.skyRevealPending ?? false,
    treeRevealPending: gates?.treeRevealPending ?? false,
    isLoading: enabled && gates === undefined,
    anyUnlocked: !!(gates && (gates.sky || gates.tree)),
  };
}
