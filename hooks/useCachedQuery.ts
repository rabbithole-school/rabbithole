"use client";

import { useEffect, useState } from "react";
import { useQuery as useRetainedQuery } from "convex-helpers/react/cache";
import type { FunctionReference, FunctionReturnType } from "convex/server";

/**
 * Perceived-speed cache (plan Part 4): stale-while-revalidate over Convex.
 *
 * Two layers, both additive to normal `useQuery` semantics:
 *  1. Subscription retention (convex-helpers ConvexQueryCacheProvider):
 *     recently-used subscriptions stay warm after unmount, so navigating
 *     back to a page renders instantly from the live client cache.
 *  2. localStorage snapshots: the last server result for boot-path queries
 *     is persisted per user; on a cold launch the UI renders from the
 *     snapshot immediately and the live subscription replaces it the
 *     moment fresh data arrives.
 *
 * Use ONLY for boot-path, non-sensitive queries (current user, project
 * list, curriculum dimension lists). Chat transcripts are deliberately
 * NOT snapshotted — message content is the most sensitive data we hold,
 * and Convex's in-session cache already makes back-nav instant.
 *
 * Snapshots are cleared on sign-out (see useSignOut), and cache keys
 * include the user id so a shared-iPad account switch can't flash another
 * kid's data.
 */

const PREFIX = "rh.cache.v1.";

/** Remove every persisted query snapshot. Called on sign-out. */
export function clearCachedQueries(): void {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    // storage unavailable — nothing to clear
  }
}

/**
 * @param cacheKey localStorage key for the snapshot layer, or null to use
 *   subscription retention only (e.g. teacher remote-mode data that should
 *   never be persisted on this device).
 */
export function useCachedQuery<Query extends FunctionReference<"query">>(
  query: Query,
  args: Query["_args"] | "skip",
  cacheKey: string | null,
): FunctionReturnType<Query> | undefined {
  const live = useRetainedQuery(query, args as never) as
    | FunctionReturnType<Query>
    | undefined;
  const [snapshot, setSnapshot] = useState<
    FunctionReturnType<Query> | undefined
  >(undefined);

  // Hydrate the snapshot once per key (client-only; localStorage is absent
  // during SSR).
  useEffect(() => {
    if (cacheKey === null) return;
    try {
      const raw = localStorage.getItem(PREFIX + cacheKey);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only cold-start hydration
      if (raw !== null) setSnapshot(JSON.parse(raw));
    } catch {
      // corrupt/unavailable snapshot — live data will arrive shortly
    }
  }, [cacheKey]);

  // Persist every fresh server result.
  useEffect(() => {
    if (cacheKey === null || live === undefined || args === "skip") return;
    try {
      localStorage.setItem(PREFIX + cacheKey, JSON.stringify(live));
    } catch {
      // quota/private mode — snapshots just won't persist
    }
  }, [live, cacheKey, args]);

  return live !== undefined ? live : snapshot;
}
