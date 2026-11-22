import { createContext, useContext, type ReactNode } from "react";

/**
 * The bedtime state BedtimeGate computes once at the root, for the layers that
 * must honor it far from the root: the overlay inside every `<Modal>`, and the
 * keep-awake holders that should let the screen sleep at night.
 */
export type BedtimeView = {
  /** Overlay copy while asleep, else null. */
  asleepSubline: string | null;
  /** Banner copy during the 5 minutes before bedtime, else null. */
  warningText: string | null;
  /**
   * The banner + overlay element (BedtimeLayers) for hosts that must draw it
   * in their own window or gesture gate. Passed through context so those
   * hosts (FreezableModal, AsamHybridHost) import nothing heavier than this.
   */
  layers: ReactNode;
};

export const BedtimeContext = createContext<BedtimeView>({
  asleepSubline: null,
  warningText: null,
  layers: null,
});

/** The bedtime layers to render inside a host (null outside BedtimeGate). */
export function useBedtimeLayers(): ReactNode {
  return useContext(BedtimeContext).layers;
}

/** Whether Rabbithole is asleep right now. */
export function useIsBedtime(): boolean {
  return useContext(BedtimeContext).asleepSubline !== null;
}
