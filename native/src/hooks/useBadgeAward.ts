/**
 * Detects a newly-awarded badge for the signed-in scholar and exposes the LIVE
 * badge row for the celebratory overlay. "New" means: appeared in the live
 * Convex result after this hook mounted (i.e. arrived *after* the initial
 * snapshot).
 *
 * Uses `myEarnedBadges` — an authed reactive query — so it fires the moment
 * Convex pushes the insert to the client. Because it returns the live row (not
 * a one-time snapshot), the overlay's art + remix state update in place: the
 * generative art appears when it finishes minting, and a remix's new art +
 * decremented reroll count flow straight through. Guards against
 * unauthenticated state (the query throws when not logged in, so we skip it
 * until auth is ready).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { useConvexAuth } from "@convex-dev/auth/react";

import { api } from "@/lib/convex";

/** A single hydrated row from `scholarUnitBadges.myEarnedBadges` (live). */
export type EarnedBadge = NonNullable<
  ReturnType<typeof useEarnedBadges>
>[number];

function useEarnedBadges() {
  const { isAuthenticated } = useConvexAuth();
  // Skip the query when not authenticated to avoid throwing an unhandled error.
  return useQuery(
    api.scholarUnitBadges.myEarnedBadges,
    isAuthenticated ? {} : "skip",
  );
}

type HookResult = {
  /** The live row for a newly-awarded badge, or null when there's nothing to show. */
  badge: EarnedBadge | null;
  /** Dismiss the overlay (marks the badge as seen so it doesn't re-appear). */
  dismiss: () => void;
};

export function useBadgeAward(): HookResult {
  // All earned badges for the calling scholar, newest first.
  const badges = useEarnedBadges();

  // The set of badge IDs that were present on mount (initial snapshot). We
  // never show those — only badges that appear *after* the snapshot fire the
  // celebration. null = not yet initialised.
  const seenIds = useRef<Set<string> | null>(null);

  // IDs that the user has explicitly dismissed (in this session).
  const dismissedIds = useRef<Set<string>>(new Set());

  const [newBadgeId, setNewBadgeId] = useState<string | null>(null);

  useEffect(() => {
    if (badges === undefined) return; // still loading

    const currentIds = new Set(badges.map((b) => String(b._id)));

    if (seenIds.current === null) {
      // First snapshot — seed the seen set; nothing to celebrate yet.
      seenIds.current = currentIds;
      return;
    }

    // Find the first badge that wasn't in the initial snapshot and hasn't been
    // dismissed yet.
    const unseen = badges.find(
      (b) =>
        !seenIds.current!.has(String(b._id)) &&
        !dismissedIds.current.has(String(b._id)),
    );

    if (unseen && String(unseen._id) !== newBadgeId) {
      setNewBadgeId(String(unseen._id));
    }
  }, [badges, newBadgeId]);

  const dismiss = useCallback(() => {
    if (newBadgeId) {
      dismissedIds.current.add(newBadgeId);
      // Also add to seenIds so a re-mount doesn't re-trigger.
      seenIds.current?.add(newBadgeId);
    }
    setNewBadgeId(null);
  }, [newBadgeId]);

  // Resolve the detected id to its LIVE row every render, so art-generation and
  // remix updates pushed by Convex re-render the open overlay in place.
  const badge =
    (newBadgeId && badges?.find((b) => String(b._id) === newBadgeId)) || null;

  return { badge, dismiss };
}
