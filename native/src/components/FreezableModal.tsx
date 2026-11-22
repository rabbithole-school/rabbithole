/**
 * The app's `<Modal>`: React Native's, plus the Freeze Mode overlay.
 *
 * iOS presents a modal in its own window above the app, so the in-tree
 * `FreezeModeOverlay` can't cover a game, a slide deck, or a sheet that was
 * already open when a teacher froze the iPad. Rendering the overlay inside
 * every modal closes that gap without dismissing anything, so the scholar's
 * work underneath survives the freeze.
 *
 * The bedtime banner and overlay ride along for the same reason (BedtimeGate).
 *
 * It also retries a presentation iOS refused because another modal was up,
 * which otherwise leaves an invisible layer that blocks every tap
 * (useModalPresentationRetry, TRA-331).
 *
 * Import `Modal` from here, not from "react-native" (lint-enforced). The
 * exceptions are the Device settings gate (it is how a teacher unfreezes) and
 * the Wi-Fi help sheet (offline recovery must stay usable).
 */
import { Modal as NativeModal, type ModalProps } from "react-native";

import { FreezeModeOverlay } from "@/components/FreezeModeOverlay";
import { useBedtimeLayers } from "@/contexts/BedtimeContext";
import { usePresentationAsam } from "@/contexts/AsamControllerContext";
import { useModalPresentationRetry } from "@/hooks/useModalPresentationRetry";

export function Modal({ children, visible = true, onShow, ...props }: ModalProps) {
  const { frozenUntil, frozenBy } = usePresentationAsam();
  const bedtimeLayers = useBedtimeLayers();
  const presentation = useModalPresentationRetry(visible);
  return (
    <NativeModal
      {...props}
      visible={presentation.visible}
      onShow={(event) => {
        presentation.markShown();
        onShow?.(event);
      }}
    >
      {children}
      {bedtimeLayers}
      <FreezeModeOverlay
        frozenUntil={frozenUntil}
        frozenBy={frozenBy}
        teacherHint="devices"
      />
    </NativeModal>
  );
}
