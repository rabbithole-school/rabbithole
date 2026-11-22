"use client";

/**
 * useExploreSeed — the shared "open a chat from a seed star" flow.
 *
 * Tapping a seed star (in the scholar Sky, a question in the queue, a teacher's
 * offer) opens its chat: a star that points at a unit lands in that unit, and
 * anything else is a plain chat with no Quest baked behind it. On success it
 * navigates to the session.
 *
 * Lifted out of app/scholar/page.tsx so the /scholar home AND the standalone
 * /scholar/map surface share ONE implementation. Consumers wire `exploreSeed`
 * into the map's `onExploreSeed`.
 */

import { useCallback, useState } from "react";
import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useRemote } from "@/hooks/useRemote";
import { toaster } from "@/lib/toaster";
import { serverErrorMessage } from "@/lib/serverErrorMessage";

export function useExploreSeed() {
  const router = useRouter();
  const { stamp } = useRemote();
  const createFromSeed = useMutation(api.sessions.createFromSeed);

  const [exploringSeedId, setExploringSeedId] = useState<string | null>(null);

  const exploreSeed = useCallback(
    async (seedId: Id<"seeds">) => {
      setExploringSeedId(seedId);
      try {
        // `endlessChat` keeps a plain topic star a chat: no unit is baked
        // behind it. A star that points at a unit still starts that unit.
        const result = await createFromSeed({ seedId, endlessChat: true });
        if (result) router.push(stamp(`/scholar/${result.id}`));
      } catch (error) {
        console.error("Error creating session from seed:", error);
        toaster.error({
          title: serverErrorMessage(error, "Couldn't start that quest"),
        });
      } finally {
        setExploringSeedId(null);
      }
    },
    [createFromSeed, router, stamp],
  );

  return { exploreSeed, exploringSeedId };
}
