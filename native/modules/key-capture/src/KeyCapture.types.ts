import type { StyleProp, ViewStyle } from "react-native";

/** Raw native event payload — a single normalized editor key. */
export type KeyCaptureNativeKeyEvent = { nativeEvent: { key: string } };

export type KeyCaptureChord = "Escape" | "Cmd+Enter";

/** Raw native event payload — a normalized editor command chord. */
export type KeyCaptureNativeChordEvent = {
  nativeEvent: { chord: KeyCaptureChord };
};

export type KeyCaptureNativeModule = {
  /** Present only in binaries rebuilt with chord support. */
  supportsChords?: () => boolean;
};

export type KeyCaptureViewProps = {
  /**
   * While true, hardware-key capture is enabled. Without `onChord`, the
   * off-screen view becomes first responder for the 2-D editor's full key
   * vocabulary. With `onChord`, only command chords are captured and the
   * current TextInput keeps focus.
   */
  active: boolean;
  /**
   * A normalized editor key, matching the web keyboard hook's vocabulary:
   * a digit, "x", "/", "^", the "⌫" glyph, "Tab" / "ShiftTab", or "Arrow*".
   * Route straight into the shared expression-template controller's `applyKey`.
   */
  onKey: (key: string) => void;
  /** Return / Enter — submit the current answer. */
  onSubmit?: () => void;
  /**
   * Escape, or Command/Control + Enter. Both modified-Enter variants normalize
   * to "Cmd+Enter"; bare Enter is never emitted as a chord. Supplying this keeps
   * an active TextInput as first responder and captures only these chords.
   */
  onChord?: (chord: KeyCaptureChord) => void;
  style?: StyleProp<ViewStyle>;
};
