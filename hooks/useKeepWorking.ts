"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useRemote } from "@/hooks/useRemote";
import { toaster } from "@/lib/toaster";

/**
 * "Keep working on this" — re-open a scholar's FINISHED session and drop them
 * back into it, editable. Re-entry into finished work: completion lives outside
 * the session (activityCompletions + scholarUnitBadges), so `sessions.reopen`
 * only un-archives the row and never touches a completion record — the unit
 * stays complete, the badge is kept, the artifact comes along. This is the one
 * client-side seam every "Keep working" surface (the Finished list, the badge
 * detail shelf) routes through.
 */
export function useKeepWorking() {
  const router = useRouter();
  const { stamp } = useRemote();
  const reopen = useMutation(api.sessions.reopen);
  const [pendingId, setPendingId] = useState<Id<"sessions"> | null>(null);

  const keepWorking = useCallback(
    async (sessionId: Id<"sessions">) => {
      if (pendingId) return;
      setPendingId(sessionId);
      try {
        await reopen({ id: sessionId });
        // stamp() preserves a teacher's ?remote=<scholarId> context.
        router.push(stamp(`/scholar/${sessionId}`));
      } catch (error) {
        console.error("Failed to re-open session:", error);
        toaster.error({
          title: "Couldn't re-open that work",
          description: "Please try again.",
        });
        setPendingId(null);
      }
    },
    [pendingId, reopen, router, stamp],
  );

  return { keepWorking, pendingId };
}
