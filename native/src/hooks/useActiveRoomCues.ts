/**
 * useActiveRoomCues — native twin of hooks/useActiveRoomCues.ts (web). Same
 * job: subscribe to `roomCues.activeRoomCuesForSelf` and layer on LOCAL,
 * non-persisted dismissal for message/transition, via the SAME
 * `pickCuesByKind` selector (vendored from shared/roomCueCopy.ts) the web
 * hook calls — so the two platforms can never disagree on which cue wins or
 * what's dismissible.
 *
 * Pass `enabled={false}` to skip the subscription (teacher test-drive/
 * remote-view/preview — this is a scholar-only surface for now).
 */

import { useCallback, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/lib/convex";
import { pickCuesByKind } from "../../vendor/shared/roomCueCopy";

export function useActiveRoomCues(enabled: boolean) {
  const cues = useQuery(
    api.roomCues.activeRoomCuesForSelf,
    enabled ? {} : "skip",
  );
  const [dismissedIds, setDismissedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const dismiss = useCallback((cueId: string) => {
    setDismissedIds((prev) => {
      if (prev.has(cueId)) return prev;
      const next = new Set(prev);
      next.add(cueId);
      return next;
    });
  }, []);

  const picked = useMemo(
    () => pickCuesByKind(cues, dismissedIds),
    [cues, dismissedIds],
  );

  return { ...picked, dismiss };
}
