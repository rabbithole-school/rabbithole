"use client";

/**
 * useActiveRoomCues — subscribes to this scholar's live room cues (see
 * convex/roomCues.ts) and layers on LOCAL, non-persisted dismissal for
 * message/transition banners: dismissing only hides the banner in this tab's
 * state. The cue itself still expires server-side, so a reload (or the same
 * cue reaching a second device/tab) shows it again — dismiss is a courtesy,
 * not a receipt. `rest` is never locally dismissible: only the teacher's
 * "screens up" (clearRoomCue) or the cue's own clearing removes it — see
 * shared/roomCueCopy.ts's `pickCuesByKind`, which native's twin hook also
 * calls so the two platforms can never disagree on which cue wins.
 *
 * Pass `enabled={false}` to skip the subscription entirely — this is a
 * scholar-only surface for now (teacher remote-view/test-drive/preview
 * should not subscribe as if they were the scholar).
 */

import { useCallback, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { pickCuesByKind } from "@/shared/roomCueCopy";

export type ActiveRoomCue = NonNullable<
  ReturnType<typeof useQuery<typeof api.roomCues.activeRoomCuesForSelf>>
>[number];

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
