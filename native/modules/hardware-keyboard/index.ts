import { requireOptionalNativeModule } from "expo-modules-core";
import { useEffect, useState } from "react";

import type {
  HardwareKeyboardChangeEvent,
  HardwareKeyboardModule,
  KeyProbeEvent,
  WatchedCommandEvent,
  WatchedKeyEvent,
  WatchedPressEvent,
} from "./src/HardwareKeyboard.types";

export type {
  HardwareKeyboardChangeEvent,
  KeyProbeEvent,
  WatchedCommandEvent,
  WatchedKeyEvent,
  WatchedPressEvent,
} from "./src/HardwareKeyboard.types";

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

function keyEventsSupported(): boolean {
  try {
    return nativeModule?.supportsKeyEvents?.() ?? false;
  } catch {
    return false;
  }
}

/**
 * Subscribe to presses of specific keys (raw HID usages on the keyboard page),
 * delivered through GameController so they arrive whatever has focus. Returns
 * an unsubscribe. A no-op on a dev client built before key events existed.
 */
export function watchHardwareKeys(
  hidUsages: number[],
  onKey: (event: WatchedKeyEvent) => void,
): () => void {
  if (!nativeModule || !keyEventsSupported()) return () => {};
  const subscription = nativeModule.addListener("onWatchedKey", onKey);
  nativeModule.setWatchedKeys?.(hidUsages);
  return () => {
    nativeModule.setWatchedKeys?.([]);
    subscription.remove();
  };
}

/**
 * Subscribe to system-button presses that carry no key code (UIPress types),
 * such as the Folio's mic key (504). Returns an unsubscribe. A no-op on a dev
 * client built before press events existed.
 */
export function watchHardwarePresses(
  pressTypes: number[],
  onPress: (event: WatchedPressEvent) => void,
): () => void {
  let supported = false;
  try {
    supported = nativeModule?.supportsPressEvents?.() ?? false;
  } catch {
    supported = false;
  }
  if (!nativeModule || !supported) return () => {};
  const subscription = nativeModule.addListener("onWatchedPress", onPress);
  nativeModule.setWatchedPressTypes?.(pressTypes);
  return () => {
    nativeModule.setWatchedPressTypes?.([]);
    subscription.remove();
  };
}

/**
 * Keep keyless presses of these types (UIPress types) from UIKit, so a focused
 * text field never acts on them: the Folio's mic key (504) is otherwise the
 * Dictation key there. Pass [] to hand them back. Watching is separate
 * (watchHardwarePresses). A no-op on a dev client built before claims existed.
 */
export function claimHardwarePresses(pressTypes: number[]): void {
  try {
    if (!nativeModule?.supportsPressClaims?.()) return;
    nativeModule.setClaimedPressTypes?.(pressTypes);
  } catch {
    // An older dev client: presses stay UIKit's too.
  }
}

/**
 * Subscribe to app-wide key commands such as "cmd+/" (modifiers, then one
 * character). Unlike watchHardwareKeys these consume the key, so a focused text
 * field never types it. Returns an unsubscribe. A no-op on a dev client built
 * before command events existed.
 */
export function watchKeyCommands(
  chords: string[],
  onCommand: (event: WatchedCommandEvent) => void,
): () => void {
  let supported = false;
  try {
    supported = nativeModule?.supportsCommandEvents?.() ?? false;
  } catch {
    supported = false;
  }
  if (!nativeModule || !supported) return () => {};
  const subscription = nativeModule.addListener("onWatchedCommand", onCommand);
  nativeModule.setWatchedCommands?.(chords);
  return () => {
    nativeModule.setWatchedCommands?.([]);
    subscription.remove();
  };
}

/**
 * Whether anything has keyboard focus for typing, as UIKit sees it: a React
 * Native field or an input inside a web view. False when unknown.
 */
export async function isEditingText(): Promise<boolean> {
  try {
    return (await nativeModule?.isEditingText?.()) ?? false;
  } catch {
    return false;
  }
}

/** Resign keyboard focus wherever it is, web views included. */
export function endEditing(): void {
  try {
    void nativeModule?.endEditing?.()?.catch(() => {});
  } catch {
    // An older dev client: nothing to resign through.
  }
}

/** Dev-only: log every key from both delivery channels. */
export function probeHardwareKeys(
  onEvent: (event: KeyProbeEvent) => void,
): () => void {
  if (!nativeModule || !keyEventsSupported()) return () => {};
  const subscription = nativeModule.addListener("onKeyProbe", onEvent);
  nativeModule.setProbe?.(true);
  return () => {
    nativeModule.setProbe?.(false);
    subscription.remove();
  };
}

export function hardwareKeyEventsAvailable(): boolean {
  return keyEventsSupported();
}
