import { useConvexAuth, useQuery } from "convex/react";

import { api } from "@/lib/convex";
import { useMapGates } from "@/hooks/useMapGates";
import { useInstitutionDay } from "@/hooks/useInstitutionDay";
import { FORCE_ALL_HOME_CARDS, FORCE_MAP_HOME_STATE } from "@/lib/homeDevForce";
import {
  resolveMapHomeState,
  type MapHomeState,
  type MapKind,
} from "../../vendor/shared/mapHomeCard";
import {
  buildRecapLines,
  type RecapLine,
} from "../../vendor/shared/dailyRecapLines";

/**
 * useMapHomeState — which of the map card's states is live, and the day's rows.
 *
 * The Home renders the Tree card in TWO positions (elevated in the content,
 * quiet in the footer) and they must never both fill. Rather than guard that
 * with two hand-kept conditions, both call sites read this one hook and compare
 * against the single resolved state — see shared/mapHomeCard.ts.
 *
 * Calling it twice costs nothing: Convex's client dedupes subscriptions by
 * (function, args), so the two call sites share one live query each.
 */
export interface MapHomeStateResult {
  state: MapHomeState;
  /** The day's movement rows. Non-empty only when the map actually moved. */
  lines: RecapLine[];
}

// Spacing-harness content only (FORCE_ALL_HOME_CARDS); unreachable in prod.
const DEMO_LINES: RecapLine[] = [
  {
    key: "demo-1",
    text: "Add & subtract unlike fractions",
    label: "Fluent",
    mastery: "fluent",
  },
  {
    key: "demo-2",
    text: "Equivalent fractions on a number line",
    label: "Your frontier moved",
    mastery: "frontier",
  },
  {
    key: "demo-3",
    text: "Sample space",
    label: "Added to your Math Skills Tree",
    mastery: "revealed",
  },
];

export function useMapHomeState(
  map: MapKind,
  welcomeActive: boolean = false,
): MapHomeStateResult {
  const { isAuthenticated } = useConvexAuth();
  const gates = useMapGates();

  const me = useQuery(api.users.currentUser, isAuthenticated ? {} : "skip");
  const scholarId = me?._id;
  const serverDay = useQuery(
    api.institutions.currentDayForScholar,
    isAuthenticated ? {} : "skip",
  );
  const institutionDay = useInstitutionDay(serverDay);

  // Only the Tree has a daily read model; asking for one for the Sky would be
  // asking a question the backend cannot answer (shared/mapHomeCard.ts).
  const recap = useQuery(
    api.dailyRecap.forScholar,
    map === "tree" && isAuthenticated && scholarId && institutionDay
      ? { scholarId, dayKey: institutionDay.dayKey }
      : "skip",
  );

  // `undefined` = still asking (the recap query is in flight, or still waiting
  // on the institution day it is keyed to). resolveMapHomeState holds the slot
  // empty for that window rather than rendering the quiet doorway and swapping
  // it for an elevated receipt a round-trip later. The Sky has no recap query
  // at all, so it answers a definite `false`.
  let hasMovement: boolean | undefined;
  if (FORCE_ALL_HOME_CARDS && map === "tree") {
    hasMovement = true;
  } else if (map !== "tree") {
    hasMovement = false;
  } else {
    hasMovement = recap === undefined ? undefined : !!recap?.hasAny;
  }

  const lines = recap?.hasAny
    ? buildRecapLines(recap)
    : FORCE_ALL_HOME_CARDS && map === "tree"
      ? DEMO_LINES
      : [];

  // The gates hook already reports `isLoading`; a loading map is not unlocked,
  // so the ladder resolves to "hidden" and nothing flashes before its data.
  const state = resolveMapHomeState({
    map,
    unlocked: !gates.isLoading && (map === "sky" ? gates.sky : gates.tree),
    revealPending:
      map === "sky" ? gates.skyRevealPending : gates.treeRevealPending,
    hasMovement,
    welcomeActive,
  });

  // Harness only: walk the Tree's ladder one rung at a time. The rungs are
  // mutually exclusive in real data, so this pins rather than adds.
  if (FORCE_MAP_HOME_STATE && map === "tree") {
    return {
      state: FORCE_MAP_HOME_STATE,
      lines: FORCE_MAP_HOME_STATE === "quiet" ? [] : (lines.length ? lines : DEMO_LINES),
    };
  }

  return { state, lines };
}
