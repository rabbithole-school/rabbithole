"use client";

/**
 * useExploreSeed — the shared "begin a quest from a seed star" flow.
 *
 * Tapping a seed star (in the scholar Sky) begins a quest: a structured seed
 * launches straight into its unit; a raw TOPIC seed first pops the
 * "Choose your path" dialog so the scholar picks the shape (deep / wide /
 * build) before it's baked. On success it navigates to the new session.
 *
 * Lifted out of app/scholar/page.tsx so the /scholar home AND the standalone
 * /scholar/map surface share ONE implementation (and one dialog). Consumers
 * render `exploreSeedDialog` somewhere in their tree and wire `exploreSeed`
 * into the map's `onExploreSeed`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useConvex, useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useRemote } from "@/hooks/useRemote";
import { toaster } from "@/lib/toaster";
import { serverErrorMessage } from "@/lib/serverErrorMessage";
import { ChoosePathDialog } from "@/components/ChoosePathDialog";
import { bakePathArg, ENDLESS_CHAT } from "@/lib/bakePaths";
import type {
  ExploreSeedOptions,
  PathChoice,
} from "@/lib/bakePaths";

export function useExploreSeed() {
  const router = useRouter();
  const { stamp } = useRemote();
  const convex = useConvex();
  const createFromSeed = useMutation(api.sessions.createFromSeed);

  const [exploringSeedId, setExploringSeedId] = useState<string | null>(null);
  // "Choose your path" menu state — a pending topic-seed launch awaiting a shape.
  const [pathDialog, setPathDialog] = useState<{
    seedId: Id<"seeds">;
    topic: string | null;
    domain: string | null;
  } | null>(null);
  const [pickingPath, setPickingPath] = useState(false);
  // Bumped when the path dialog closes (or the host unmounts) so a pick still
  // in flight is abandoned: its late result must not navigate.
  const pickAttemptRef = useRef(0);
  useEffect(
    () => () => {
      pickAttemptRef.current += 1;
    },
    [],
  );

  const launchSeed = useCallback(
    async (
      seedId: Id<"seeds">,
      choice?: PathChoice,
      isCurrent: () => boolean = () => true,
    ) => {
      const result = await createFromSeed({
        seedId,
        // "Endless chat" is sent as its own flag — an absent bakePath alone
        // still means "bake it", for the entry points that skip the menu.
        ...(choice === ENDLESS_CHAT
          ? { endlessChat: true }
          : choice
            ? { bakePath: bakePathArg(choice) }
            : {}),
      });
      if (result && isCurrent()) router.push(stamp(`/scholar/${result.id}`));
    },
    [createFromSeed, router, stamp],
  );

  const exploreSeed = useCallback(
    async (seedId: Id<"seeds">, opts?: ExploreSeedOptions) => {
      setExploringSeedId(seedId);
      try {
        // The caller picked a path inline (the star drawer) — launch it straight.
        if (opts?.path) {
          await launchSeed(seedId, opts.path);
          return;
        }
        // The caller already hosted the picker but no path was chosen (e.g. the
        // scholar hit Begin before suggestions loaded, or it's a structured
        // star) — launch directly, never re-pop the dialog.
        if (opts?.skipMenu) {
          await launchSeed(seedId);
          return;
        }
        // Non-drawer entry: a TOPIC seed gets baked → show the fallback menu. A
        // structured seed already has a unit, so start it directly.
        const info = await convex.query(api.seeds.getBakeLaunchInfo, { seedId });
        if (info?.isTopicSeed) {
          setPathDialog({ seedId, topic: info.topic, domain: info.domain });
          return;
        }
        await launchSeed(seedId);
      } catch (error) {
        console.error("Error creating session from seed:", error);
        toaster.error({
          title: serverErrorMessage(error, "Couldn't start that quest"),
        });
      } finally {
        setExploringSeedId(null);
      }
    },
    [convex, launchSeed],
  );

  const handlePickPath = useCallback(
    async (choice: PathChoice) => {
      if (!pathDialog) return;
      const attempt = ++pickAttemptRef.current;
      const live = () => pickAttemptRef.current === attempt;
      setPickingPath(true);
      try {
        await launchSeed(pathDialog.seedId, choice, live);
        // Navigation happens on success; leave the spinner up until it does.
      } catch (error) {
        if (!live()) return;
        console.error("Error starting quest:", error);
        toaster.error({
          title: serverErrorMessage(error, "Couldn't start that quest"),
        });
        setPickingPath(false);
      }
    },
    [pathDialog, launchSeed],
  );

  const exploreSeedDialog = (
    <ChoosePathDialog
      key={pathDialog?.seedId ?? "closed"}
      open={!!pathDialog}
      seedId={pathDialog?.seedId ?? null}
      topic={pathDialog?.topic ?? null}
      domain={pathDialog?.domain ?? null}
      submitting={pickingPath}
      onClose={() => {
        pickAttemptRef.current += 1;
        setPathDialog(null);
        setPickingPath(false);
      }}
      onPick={handlePickPath}
    />
  );

  return { exploreSeed, exploringSeedId, exploreSeedDialog };
}
