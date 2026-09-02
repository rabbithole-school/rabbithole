import { useQuery } from "convex/react";

import { api } from "@/lib/convex";
import { FORCE_ALL_HOME_CARDS } from "@/lib/homeDevForce";

/**
 * useMapGates — the scholar's OWN Sky/Tree map visibility + reveal state
 * (the milestone-reveal design, f6). Native twin of hooks/useMapGates.ts on web.
 *
 * Both maps stay out of the scholar's nav (and the pull-to-Sky gesture) until
 * each first has real data. The gate is evidence-derived server-side
 * (convex/mapGates.ts); this is the client read. Scholar-self only.
 */
export type MapGatesState = {
  sky: boolean;
  tree: boolean;
  skyRevealPending: boolean;
  treeRevealPending: boolean;
  isLoading: boolean;
  anyUnlocked: boolean;
};

export function useMapGates(enabled: boolean = true): MapGatesState {
  const gates = useQuery(api.mapGates.mine, enabled ? {} : "skip");
  // Spacing harness only: both maps unlocked and both reveals pending, which
  // lands the map card on the richest rung of its ladder (the once-ever
  // unlock). The rungs are mutually exclusive by design — to walk the others,
  // see FORCE_MAP_HOME_STATE in lib/homeDevForce.ts.
  if (FORCE_ALL_HOME_CARDS) {
    return {
      sky: true,
      tree: true,
      skyRevealPending: true,
      treeRevealPending: true,
      isLoading: false,
      anyUnlocked: true,
    };
  }
  return {
    sky: gates?.sky ?? false,
    tree: gates?.tree ?? false,
    skyRevealPending: gates?.skyRevealPending ?? false,
    treeRevealPending: gates?.treeRevealPending ?? false,
    isLoading: enabled && gates === undefined,
    anyUnlocked: !!(gates && (gates.sky || gates.tree)),
  };
}
