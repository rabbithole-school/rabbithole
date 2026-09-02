"use client";

/**
 * Launch an External App from the scholar's home launcher.
 *
 * Opens the app's web URL in a new tab. (No activity / assignment, no
 * "all done?" completion prompt — it's a standing app.)
 */

import { useCallback, useState } from "react";
import type { Id } from "@/convex/_generated/dataModel";
import { haptic } from "@/lib/native";
import { toaster } from "@/lib/toaster";

export type LaunchExternalAppArgs = {
  appId: Id<"externalApps">;
  name: string;
  webUrl: string;
  webAllowedHosts?: string[] | null;
};

export function useExternalApp() {
  const [launchingId, setLaunchingId] = useState<Id<"externalApps"> | null>(
    null,
  );

  const launch = useCallback(
    async (app: LaunchExternalAppArgs) => {
      if (launchingId) return;
      setLaunchingId(app.appId);
      haptic("light");
      try {
        window.open(app.webUrl, "_blank", "noopener,noreferrer");
      } catch (err) {
        console.error("External app launch failed:", err);
        toaster.error({ title: "Couldn't open the app. Try again." });
      } finally {
        setLaunchingId(null);
      }
    },
    [launchingId],
  );

  return { launch, launchingId };
}
