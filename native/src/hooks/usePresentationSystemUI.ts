// Reaching Screen Mirroring from inside the Rabbithole lock. Control Center is
// out of reach while the iPad sits in Autonomous Single App Mode, so a "Connect
// TV" tap releases the lock for the system UI, and the lock comes back as soon
// as the scholar returns to the app (or after a timeout, so a tap that never
// reaches Control Center can't leave the iPad unlocked).
//
// Shared by both presenting surfaces: slides (SlidesPresentationNative) and a
// live app (AppPresentControls).

import { useCallback, useEffect, useRef } from "react";
import { AppState } from "react-native";

import { usePresentationAsam } from "@/contexts/AsamControllerContext";

const SYSTEM_UI_RELEASE_TIMEOUT_MS = 30_000;

export function usePresentationSystemUI() {
  const { releaseForSystemUI, restoreAfterSystemUI } = usePresentationAsam();
  const awaitingSystemUIReturn = useRef(false);
  const systemUIBecameInactive = useRef(false);
  const systemUIReleaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const restoreSystemUI = useCallback(() => {
    awaitingSystemUIReturn.current = false;
    systemUIBecameInactive.current = false;
    if (systemUIReleaseTimer.current) {
      clearTimeout(systemUIReleaseTimer.current);
      systemUIReleaseTimer.current = null;
    }
    restoreAfterSystemUI();
  }, [restoreAfterSystemUI]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (!awaitingSystemUIReturn.current) return;
      if (state === "inactive" || state === "background") {
        systemUIBecameInactive.current = true;
      } else if (state === "active" && systemUIBecameInactive.current) {
        restoreSystemUI();
      }
    });
    return () => {
      subscription.remove();
      restoreSystemUI();
    };
  }, [restoreSystemUI]);

  const requestSystemUI = useCallback(() => {
    awaitingSystemUIReturn.current = true;
    systemUIBecameInactive.current = false;
    releaseForSystemUI();
    if (systemUIReleaseTimer.current) clearTimeout(systemUIReleaseTimer.current);
    systemUIReleaseTimer.current = setTimeout(
      restoreSystemUI,
      SYSTEM_UI_RELEASE_TIMEOUT_MS,
    );
  }, [releaseForSystemUI, restoreSystemUI]);

  return { requestSystemUI, restoreSystemUI };
}
