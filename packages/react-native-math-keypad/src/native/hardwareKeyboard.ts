import { requireOptionalNativeModule, type NativeModule } from "expo-modules-core";
import { useEffect, useState } from "react";

/**
 * Is a physical keyboard attached (an iPad Magic Keyboard, a Folio, a
 * Bluetooth keyboard)? Nothing reachable from JavaScript can tell: React
 * Native's Keyboard events describe the SOFT keyboard, and an iPad with a
 * hardware keyboard simply never shows one. The optional native module
 * (ios/MathKeypadHardwareKeyboardModule.swift) asks GameController's
 * `GCKeyboard.coalesced`, which can.
 *
 * Extracted from Rabbithole's native/modules/hardware-keyboard, trimmed to the
 * connection check. The app's module also watches raw keys, a Folio mic key
 * and app-wide chords for a voice feature; none of that is keypad work.
 */

type HardwareKeyboardChangeEvent = { connected: boolean };

type HardwareKeyboardEvents = {
  onChange: (event: HardwareKeyboardChangeEvent) => void;
};

type HardwareKeyboardNativeModule = NativeModule<HardwareKeyboardEvents> & {
  isConnected(): boolean;
};

// `requireOptionalNativeModule` returns null (instead of throwing) when the
// module isn't in the running binary — Expo Go, a dev client built before the
// package was added, Android, web. Every consumer then degrades to "no
// hardware keyboard", which keeps the on-screen pad: the safe default.
const nativeModule = requireOptionalNativeModule<HardwareKeyboardNativeModule>(
  "MathKeypadHardwareKeyboard",
);

/** True when the hardware-keyboard native module is in the running binary. */
export const isHardwareKeyboardDetectionAvailable = nativeModule != null;

/** Point-in-time check. Returns false when the native module is unavailable. */
export function isHardwareKeyboardConnected(): boolean {
  try {
    return nativeModule?.isConnected() ?? false;
  } catch {
    return false;
  }
}

/**
 * React hook: whether a hardware keyboard is connected. Seeds from the current
 * state and updates live on connect/disconnect. Always false when the native
 * module is unavailable.
 *
 * Simulator caveat: toggling I/O → Keyboard → Connect Hardware Keyboard on a
 * running iOS Simulator does not post GCKeyboardDidDisconnect; only a cold
 * start reflects the change. Real hardware posts both events.
 */
export function useHardwareKeyboard(): boolean {
  const [connected, setConnected] = useState<boolean>(() => isHardwareKeyboardConnected());

  useEffect(() => {
    if (!nativeModule) return;
    // Re-sync on mount in case the state changed before the listener attached.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronizes the native module's point-in-time state before subscribing.
    setConnected(isHardwareKeyboardConnected());
    const subscription = nativeModule.addListener("onChange", (event) =>
      setConnected(!!event.connected),
    );
    return () => subscription.remove();
  }, []);

  return connected;
}
