import { requireOptionalNativeModule } from "expo-modules-core";
import { useEffect, useState } from "react";

import type {
  HardwareKeyboardChangeEvent,
  HardwareKeyboardModule,
} from "./src/HardwareKeyboard.types";

export type { HardwareKeyboardChangeEvent } from "./src/HardwareKeyboard.types";

// `requireOptionalNativeModule` returns null (instead of throwing) when the
// module isn't present in the running binary — e.g. on a dev client built
// before this module was added, or any non-Apple platform. Every consumer then
// safely degrades to "no hardware keyboard", which preserves the existing
// on-screen-keypad behavior.
const nativeModule =
  requireOptionalNativeModule<HardwareKeyboardModule>("HardwareKeyboard");

/** Point-in-time check. Returns false when the native module is unavailable. */
export function isHardwareKeyboardConnected(): boolean {
  try {
    return nativeModule?.isConnected() ?? false;
  } catch {
    return false;
  }
}

/**
 * React hook that tracks whether a physical (hardware) keyboard is connected.
 * Proactive and reactive: seeds from the current state and updates live on
 * connect/disconnect. Always false when the native module is unavailable.
 */
export function useHardwareKeyboard(): boolean {
  const [connected, setConnected] = useState<boolean>(() =>
    isHardwareKeyboardConnected(),
  );

  useEffect(() => {
    if (!nativeModule) return;
    // Re-sync on mount in case the state changed before the listener attached.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronizes the native module's point-in-time state before subscribing.
    setConnected(isHardwareKeyboardConnected());
    const subscription = nativeModule.addListener(
      "onChange",
      (event: HardwareKeyboardChangeEvent) => setConnected(!!event.connected),
    );
    return () => subscription.remove();
  }, []);

  return connected;
}
