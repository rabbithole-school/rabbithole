/**
 * "Which of these ids just arrived on THIS surface?" — the one piece of React
 * state the earned-flair arrival choreography needs, shared by the transcript
 * notice lane and the deliverable chips on both frontends.
 *
 * The rule, in two sentences: a surface keeps one set of ids it must never
 * animate, seeded from its own first RESOLVED snapshot, and an id joins that set
 * in the same transition that hands it out as arriving. Hydration, a Convex
 * reconnect, a remount, a list recycle, a window expansion, an orientation flip,
 * and opening a drawer all fall out of those two sentences — none of them needs
 * a timer, a clock read, or a message between the two surfaces.
 *
 * Imports `react` and `./flairMotion` only; `native/scripts/sync-vendor.js`
 * vendors both, so the iPad runs this exact code rather than a drift copy.
 */
import { useState } from "react";

import { flairArrivingIds } from "./flairMotion";

const NONE: readonly string[] = [];

/** A joined key, so identity tracks CONTENT and survives re-render churn. */
const ID_SEPARATOR = "\u0000";

type FlairArrivalBaseline = {
  resetKey: string | undefined;
  idsKey: string | undefined;
  /** Null until this surface's first resolved snapshot seeds it. */
  inert: ReadonlySet<string> | null;
  arriving: readonly string[];
};

/**
 * @param ids The ids this surface currently shows, in display order, or
 *   `undefined` while the query behind them is still unresolved. The two are
 *   different: `flairEarned` is written only when non-empty, so "no flair yet"
 *   and "still loading" both arrive as an absent field, and treating loading as
 *   a baseline would replay a session's existing flair.
 * @param resetKey Changes when the surface starts showing a different subject
 *   (a different session, a different artifact) and its baseline must be retaken.
 * @returns The arriving ids, in display order, stable until the id set changes
 *   again — so an entrance runs to completion across the re-renders a live
 *   stream causes.
 */
export function useFlairArrivals(
  ids: readonly string[] | undefined,
  resetKey?: string,
): readonly string[] {
  const [baseline, setBaseline] = useState<FlairArrivalBaseline>(() => ({
    resetKey,
    idsKey: undefined,
    inert: null,
    arriving: NONE,
  }));

  const idsKey = ids?.join(ID_SEPARATOR);
  if (baseline.resetKey !== resetKey || baseline.idsKey !== idsKey) {
    // React's "adjust state during render" pattern — the same one the chat
    // window's session reset uses. It re-renders before paint, so an arriving
    // chip is never painted settled and then animated, and it is idempotent
    // under StrictMode's double invoke because the next baseline is computed
    // from the current one rather than mutated in place.
    const inert = baseline.resetKey === resetKey ? baseline.inert : null;
    const arriving = flairArrivingIds(inert, ids);
    setBaseline({
      resetKey,
      idsKey,
      inert: ids ? new Set(inert ? [...inert, ...ids] : ids) : inert,
      arriving: arriving.length > 0 ? arriving : NONE,
    });
  }

  return baseline.arriving;
}
