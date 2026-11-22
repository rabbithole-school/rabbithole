import { useCallback, useState } from "react";
import { useMutation } from "convex/react";
import { useRouter } from "expo-router";
import { Alert } from "react-native";
import * as Haptics from "expo-haptics";

import { api, type Id } from "@/lib/convex";
import { serverErrorMessage } from "../../vendor/shared/serverErrorMessage";

export type ExploreSeedOptions = {
  title?: string;
};

/** Opens the chat for a seed: a star that points at a unit lands in that unit,
 * anything else is a plain chat with no Quest baked behind it. */
export function useExploreSeed() {
  const router = useRouter();
  const createFromSeed = useMutation(api.sessions.createFromSeed);
  const [exploringSeedId, setExploringSeedId] = useState<string | null>(null);

  const showLaunchError = useCallback((error: unknown) => {
    const message = serverErrorMessage(error, "Couldn't start that quest");
    if (message === "This quest isn't available right now.") {
      Alert.alert(message);
      return;
    }
    Alert.alert(message, "Please try again.");
  }, []);

  const exploreSeed = useCallback(
    async (seedId: Id<"seeds">, opts?: ExploreSeedOptions) => {
      setExploringSeedId(String(seedId));
      try {
        Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Success,
        ).catch(() => {});
        // `endlessChat` keeps a plain topic star a chat: no unit is baked
        // behind it. A star that points at a unit still starts that unit.
        const result = await createFromSeed({ seedId, endlessChat: true });
        router.push({
          pathname: "/session/[id]",
          params: { id: result.id, title: opts?.title ?? "Quest" },
        });
      } catch (error) {
        console.warn("[explore-seed] start failed", error);
        showLaunchError(error);
      } finally {
        setExploringSeedId(null);
      }
    },
    [createFromSeed, router, showLaunchError],
  );

  return { exploreSeed, exploringSeedId };
}
