import { useCallback, useEffect, useRef, useState } from "react";
import { useConvex, useMutation } from "convex/react";
import { useRouter } from "expo-router";
import { Alert } from "react-native";
import * as Haptics from "expo-haptics";

import { ChoosePathDialog } from "@/components/ChoosePathDialog";
import {
  ENDLESS_CHAT,
  type PathChoice,
} from "@/components/BakePathPicker";
import { api, type Id } from "@/lib/convex";
import { serverErrorMessage } from "../../vendor/shared/serverErrorMessage";

export type ExploreSeedOptions = {
  skipMenu?: boolean;
  title?: string;
};

/** Launches a quest from a seed, prompting for a bake path on topic seeds. */
export function useExploreSeed() {
  const router = useRouter();
  const convex = useConvex();
  const createFromSeed = useMutation(api.sessions.createFromSeed);
  const [exploringSeedId, setExploringSeedId] = useState<string | null>(null);
  const [pathDialog, setPathDialog] = useState<{
    seedId: Id<"seeds">;
    topic: string | null;
    domain: string | null;
    title: string;
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

  const showLaunchError = useCallback((error: unknown) => {
    const message = serverErrorMessage(error, "Couldn't start that quest");
    if (message === "This quest isn't available right now.") {
      Alert.alert(message);
      return;
    }
    Alert.alert(message, "Please try again.");
  }, []);

  const launchSeed = useCallback(
    async (
      seedId: Id<"seeds">,
      title: string,
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
            ? { bakePath: { title: choice.title, blurb: choice.blurb } }
            : {}),
      });
      if (!isCurrent()) return;
      router.push({
        pathname: "/session/[id]",
        params: { id: result.id, title },
      });
    },
    [createFromSeed, router],
  );

  const exploreSeed = useCallback(
    async (seedId: Id<"seeds">, opts?: ExploreSeedOptions) => {
      setExploringSeedId(String(seedId));
      try {
        Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Success,
        ).catch(() => {});
        if (opts?.skipMenu) {
          await launchSeed(seedId, opts.title ?? "Quest");
          return;
        }
        const info = await convex.query(api.seeds.getBakeLaunchInfo, { seedId });
        if (info?.isTopicSeed) {
          setPathDialog({
            seedId,
            topic: info.topic,
            domain: info.domain,
            title: opts?.title ?? info.topic,
          });
          return;
        }
        await launchSeed(seedId, opts?.title ?? info?.topic ?? "Quest");
      } catch (error) {
        console.warn("[explore-seed] start failed", error);
        showLaunchError(error);
      } finally {
        setExploringSeedId(null);
      }
    },
    [convex, launchSeed, showLaunchError],
  );

  const handlePickPath = useCallback(
    async (choice: PathChoice) => {
      if (!pathDialog) return;
      const attempt = ++pickAttemptRef.current;
      const live = () => pickAttemptRef.current === attempt;
      setPickingPath(true);
      try {
        await launchSeed(
          pathDialog.seedId,
          pathDialog.title,
          choice,
          live,
        );
        if (!live()) return;
        setPathDialog(null);
      } catch (error) {
        if (!live()) return;
        console.warn("[explore-seed] path launch failed", error);
        showLaunchError(error);
      } finally {
        if (live()) setPickingPath(false);
      }
    },
    [launchSeed, pathDialog, showLaunchError],
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
