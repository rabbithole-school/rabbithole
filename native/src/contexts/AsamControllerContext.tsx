import { createContext, useContext } from "react";

import type { AsamController } from "@/hooks/useAsamController";

type PresentationAsamController = Pick<
  AsamController,
  "releaseForSystemUI" | "restoreAfterSystemUI"
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
};

const NOOP_CONTROLLER: PresentationAsamController = {
  releaseForSystemUI: () => {},
  restoreAfterSystemUI: () => {},
  openTeacherUnlock: () => {},
  isTeacherUnlockAvailable: false,
};

export const AsamControllerContext =
  createContext<PresentationAsamController>(NOOP_CONTROLLER);

export function usePresentationAsam() {
  return useContext(AsamControllerContext);
}
