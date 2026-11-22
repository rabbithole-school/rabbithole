import { requireNativeViewManager } from "expo-modules-core";
import * as React from "react";
import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";

import type { KeyCaptureViewProps } from "./KeyCapture.types";

export type { KeyCaptureViewProps } from "./KeyCapture.types";

/**
 * Off-screen first responder that forwards hardware-keyboard keys — including
 * Tab, Shift-Tab and the arrow keys, which React Native's TextInput
 * `onKeyPress` never receives on iOS — into the 2-D editor model.
 *
 * Why native: RN's iOS `onKeyPress` is driven by the text field's
 * `shouldChangeCharactersInRange`, so only TEXT-producing keys (plus a
 * special-cased Backspace) reach JavaScript. UIKit consumes Tab and the arrows
 * for focus and cursor movement and no JS event is emitted (measured on an iPad
 * simulator, iOS 26). A UIView that overrides `pressesBegan` sees every key.
 *
 * Extracted from Rabbithole's native/modules/key-capture, without the app's
 * second "chord" mode (Escape / Cmd+Enter for a slides editor).
 */

type NativeProps = {
  active: boolean;
  onKey: (event: { nativeEvent: { key: string } }) => void;
  onSubmit: () => void;
  style?: StyleProp<ViewStyle>;
};

// `requireNativeViewManager` throws when the view isn't in the running binary
// (Expo Go, a dev client built before the package was added). Catching that
// lets callers fall back to the TextInput capture (digits + Backspace only,
// tap-to-move between boxes) instead of crashing.
let NativeView: React.ComponentType<NativeProps> | null = null;
try {
  NativeView = requireNativeViewManager<NativeProps>("MathKeypadKeyCapture");
} catch {
  NativeView = null;
}

/** True when the native KeyCapture view is present in the running binary. */
export const isKeyCaptureAvailable = NativeView != null;

export function KeyCaptureView({ active, onKey, onSubmit, style }: KeyCaptureViewProps) {
  if (!NativeView) return null;
  return (
    <NativeView
      active={active}
      onKey={(event) => onKey(event.nativeEvent.key)}
      onSubmit={() => onSubmit?.()}
      style={[styles.offscreen, style]}
    />
  );
}

const styles = StyleSheet.create({
  // A real (1px) but off-screen footprint — a zero-size or hidden view is an
  // unreliable first-responder target.
  offscreen: { position: "absolute", width: 1, height: 1, left: -1000, top: 0 },
});
