import { createContext, useContext } from "react";

import type { AsamController } from "@/hooks/useAsamController";
import type { FrozenBy } from "@/lib/asam/freezeMode";

type PresentationAsamController = Pick<
  AsamController,
  "releaseForSystemUI" | "restoreAfterSystemUI" | "rearmLock" | "isLockSettled"
> & {
  /**
   * Opens the SAME Rabbithole Lock modal the hidden 4-finger-hold gesture
   * opens (AsamParentGate) — the visible "Teacher unlock" entry point, not a
   * second modal. The NOOP default below is a genuine no-op: only
   * AsamHybridHost's Provider wires this to real state.
   */
  openTeacherUnlock: () => void;
  /**
   * True only when AsamHybridHost (and therefore the gate) is actually
   * mounted — i.e. ASAM_HYBRID_ENABLED in app/_layout.tsx. A visible entry
   * point must check this before rendering: there is nothing to open when
   * the gate isn't mounted.
   */
  isTeacherUnlockAvailable: boolean;
  /**
   * Freeze Mode's end (epoch ms) or null. Read by `FreezableModal` so the
   * freeze overlay also covers content shown in a `<Modal>`, which iOS
   * presents in its own window above the in-tree overlay.
   */
  frozenUntil: number | null;
  /** Who set the freeze, for the overlay's wording. */
  frozenBy: FrozenBy;
};

const NOOP_CONTROLLER: PresentationAsamController = {
  releaseForSystemUI: () => {},
  restoreAfterSystemUI: () => {},
  rearmLock: () => {},
  isLockSettled: () => true,
  openTeacherUnlock: () => {},
  isTeacherUnlockAvailable: false,
  frozenUntil: null,
  frozenBy: null,
};

export const AsamControllerContext =
  createContext<PresentationAsamController>(NOOP_CONTROLLER);

export function usePresentationAsam() {
  return useContext(AsamControllerContext);
}
