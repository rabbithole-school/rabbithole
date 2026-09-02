/**
 * AsamHybridHost — the mount point for the ASAM "best of both" hybrid.
 *
 * Runs the `useAsamController` state machine (which locks/unlocks the app into
 * Single App Mode based on connectivity + the remote desired state) and renders
 * the hidden
 * `AsamParentGate` wrapping the app subtree so the 4-finger hold gesture is
 * detectable anywhere on screen.
 *
 * Mounted only when the MDM-delivered `asamEnabled` configuration is `"1"` (see
 * app/_layout.tsx). The Stable binary therefore remains safe on personal installs.
 *
 * NATIVE-ONLY BY DESIGN — the web app never runs in Single App Mode, so there is
 * no web counterpart.
 *
 * REBOOT NOTE: iOS cannot auto-relaunch a normal (non-MDM-App-Lock) app after a
 * reboot, so we deliberately do NOT try. After a reboot the device lands back in
 * the locked multi-app kiosk (MDM behavior) and the scholar taps Rabbithole,
 * which then re-enters ASAM here on foreground. Only hard MDM App Lock
 * auto-relaunches — the mode this hybrid is moving away from.
 *
 * The gate's modal visibility is OWNED here (not inside AsamParentGate)
 * so a visible "Teacher unlock" entry elsewhere in the tree (the account
 * menu) can open the exact same modal the 4-finger hold opens, via
 * `openTeacherUnlock` on AsamControllerContext — never a second modal.
 */
import { useKeepAwake } from "expo-keep-awake";
import { useMemo, useState } from "react";

import { useAsamController } from "@/hooks/useAsamController";
import { useAsamDisplayPolicy } from "@/hooks/useAsamDisplayPolicy";
import { AsamParentGate } from "@/components/AsamParentGate";
import { AsamControllerContext } from "@/contexts/AsamControllerContext";

function AsamKeepAwake() {
  useKeepAwake("asam-display-activity");
  return null;
}

export function AsamHybridHost({ children }: { children: React.ReactNode }) {
  const asam = useAsamController();
  const displayPolicy = useAsamDisplayPolicy(asam.inSam);
  const [gateVisible, setGateVisible] = useState(false);

  const presentationValue = useMemo(
    () => ({
      releaseForSystemUI: asam.releaseForSystemUI,
      restoreAfterSystemUI: asam.restoreAfterSystemUI,
      openTeacherUnlock: () => setGateVisible(true),
      isTeacherUnlockAvailable: true,
    }),
    [asam.releaseForSystemUI, asam.restoreAfterSystemUI],
  );

  return (
    <AsamControllerContext.Provider value={presentationValue}>
      {displayPolicy.keepAwake ? <AsamKeepAwake /> : null}
      <AsamParentGate
        lockState={asam.lockState}
        qrCodeUrl={asam.qrCodeUrl}
        deviceSettingsUrl={asam.deviceSettingsUrl}
        busy={asam.busy}
        isAsamActive={asam.inSam}
        isOfflineBypass={asam.offlineBypass}
        error={asam.error}
        onUserActivity={displayPolicy.recordActivity}
        visible={gateVisible}
        onVisibleChange={setGateVisible}
      >
        {children}
      </AsamParentGate>
    </AsamControllerContext.Provider>
  );
}
