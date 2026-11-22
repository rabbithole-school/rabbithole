"use client";

/**
 * Launch an External App from the scholar's home launcher.
 *
 * Opens the app's web URL in a new tab. (No activity / assignment, no
 * "all done?" completion prompt — it's a standing app.) A first-party tile
 * that opens as a session (`opensAsSession`, convex/lib/tileSessions.ts)
 * instead opens the scholar's latest session of it in the Workshop, in this
 * tab; if that call fails, the tile falls back to the new tab.
 */

import { useCallback, useState } from "react";
import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { haptic } from "@/lib/native";
import { toaster } from "@/lib/toaster";

export type LaunchExternalAppArgs = {
  appId: Id<"externalApps">;
  name: string;
  webUrl: string;
  webAllowedHosts?: string[] | null;
  /** The tap opens a Workshop session (vibecode.openTileForSelf). */
  opensAsSession?: boolean;
};

export function useExternalApp() {
  const [launchingId, setLaunchingId] = useState<Id<"externalApps"> | null>(
    null,
  );

  const router = useRouter();
  const openTile = useMutation(api.vibecode.openTileForSelf);

  const launch = useCallback(
    async (app: LaunchExternalAppArgs) => {
      if (launchingId) return;
      setLaunchingId(app.appId);
      haptic("light");
      if (app.opensAsSession) {
        try {
          const { sessionId } = await openTile({ externalAppId: app.appId });
          // The tile stays in its launching state until the Workshop replaces
          // this page.
          router.push(`/scholar/${sessionId}`);
          return;
        } catch (err) {
          console.error("Tile session open failed; opening the app:", err);
        }
      }
      try {
        window.open(app.webUrl, "_blank", "noopener,noreferrer");
      } catch (err) {
        console.error("External app launch failed:", err);
        toaster.error({ title: "Couldn't open the app. Try again." });
      } finally {
        setLaunchingId(null);
      }
    },
    [launchingId, openTile, router],
  );

  return { launch, launchingId };
}
