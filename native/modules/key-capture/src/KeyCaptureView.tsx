import { requireNativeView } from "expo";
import { requireOptionalNativeModule } from "expo-modules-core";
import * as React from "react";
import { StyleSheet } from "react-native";

import type {
  KeyCaptureNativeChordEvent,
  KeyCaptureNativeKeyEvent,
  KeyCaptureNativeModule,
  KeyCaptureViewProps,
} from "./KeyCapture.types";

type NativeProps = {
  active: boolean;
  onKey: (event: KeyCaptureNativeKeyEvent) => void;
  onSubmit: () => void;
  onChord?: (event: KeyCaptureNativeChordEvent) => void;
  captureChords?: boolean;
  style?: KeyCaptureViewProps["style"];
};

// `requireNativeView` throws when the native view manager isn't in the running
// binary — e.g. a dev client built before this module was added. Catching that
// lets every consumer degrade gracefully (nav keys simply don't fire; the JS
// caller keeps its text-field fallback) instead of crashing.
let NativeView: React.ComponentType<NativeProps> | null = null;
try {
  NativeView = requireNativeView("KeyCapture") as React.ComponentType<NativeProps>;
} catch {
  NativeView = null;
}

/** True when the native KeyCapture view is present in the running binary. */
export const isKeyCaptureAvailable = NativeView != null;

const nativeModule =
  requireOptionalNativeModule<KeyCaptureNativeModule>("KeyCapture");

/** True only in binaries rebuilt after chord support was added. */
export const isKeyCaptureChordAvailable = (() => {
  if (!NativeView) return false;
  try {
    return nativeModule?.supportsChords?.() ?? false;
  } catch {
    return false;
  }
})();

/**
 * Off-screen first-responder that forwards hardware-keyboard keys — including
 * the Tab / Shift-Tab / arrow keys RN's TextInput onKeyPress never receives —
 * into the shared 2-D expression-editor model. Renders nothing (and captures
 * nothing) when the native module is unavailable. When `onChord` is supplied,
 * controller-level key commands capture only editor chords so a TextInput can
 * remain first responder.
 */
export function KeyCaptureView({
  active,
  onKey,
  onSubmit,
  onChord,
  style,
}: KeyCaptureViewProps) {
  if (!NativeView || (onChord && !isKeyCaptureChordAvailable)) return null;
  return (
    <NativeView
      active={active}
      onKey={(event) => onKey(event.nativeEvent.key)}
      onSubmit={() => onSubmit?.()}
      {...(isKeyCaptureChordAvailable
        ? {
            captureChords: onChord != null,
            onChord: (event: KeyCaptureNativeChordEvent) =>
              onChord?.(event.nativeEvent.chord),
          }
        : {})}
      style={[styles.offscreen, style]}
    />
  );
}

const styles = StyleSheet.create({
  // A real (1px) but off-screen footprint — a zero-size / hidden view is an
  // unreliable first-responder target (the same trick HardwareReturnAdvance
  // uses for its off-screen TextInput).
  offscreen: { position: "absolute", width: 1, height: 1, left: -1000, top: 0 },
});
