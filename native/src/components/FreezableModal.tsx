/**
 * The app's `<Modal>`: React Native's, plus the Freeze Mode overlay.
 *
 * iOS presents a modal in its own window above the app, so the in-tree
 * `FreezeModeOverlay` can't cover a game, a slide deck, or a sheet that was
 * already open when a teacher froze the iPad. Rendering the overlay inside
 * every modal closes that gap without dismissing anything, so the scholar's
 * work underneath survives the freeze.
 *
 * Import `Modal` from here, not from "react-native" (lint-enforced). The
 * exceptions are the Device settings gate (it is how a teacher unfreezes) and
 * the Wi-Fi help sheet (offline recovery must stay usable).
 */
import { Modal as NativeModal, type ModalProps } from "react-native";

import { FreezeModeOverlay } from "@/components/FreezeModeOverlay";
import { usePresentationAsam } from "@/contexts/AsamControllerContext";

export function Modal({ children, ...props }: ModalProps) {
  const { frozenUntil } = usePresentationAsam();
  return (
    <NativeModal {...props}>
      {children}
      <FreezeModeOverlay frozenUntil={frozenUntil} teacherHint="devices" />
    </NativeModal>
  );
}
