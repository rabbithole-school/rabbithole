import { useEffect, useRef } from "react";
import { TextInput } from "react-native";

const OFFSCREEN = { position: "absolute", width: 1, height: 1, left: -1000, top: 0 } as const;

/**
 * Fallback hardware-key capture for the 2-D editor when the native KeyCapture
 * view is not in the binary (Expo Go, an un-rebuilt dev client). A focused,
 * off-screen TextInput with the soft keyboard suppressed: iOS still routes
 * physical keys to it.
 *
 * What it can't do: Tab and the arrow keys never reach `onKeyPress` on iOS
 * (UIKit consumes them; measured on an iPad simulator, iOS 26), and Shift-Tab
 * can't be told apart (no modifier state). So in this mode box MOVEMENT is
 * tap-to-focus, and the hint line says so. The Tab/arrow branches below are
 * kept because they cost nothing and are right if RN ever delivers those keys.
 */
export function TextKeyCapture({
  enabled,
  onKey,
  onSubmit,
}: {
  enabled: boolean;
  onKey: (key: string) => void;
  onSubmit: () => void;
}) {
  const ref = useRef<TextInput>(null);
  useEffect(() => {
    if (!enabled) return;
    // Focus after the current commit so the field exists natively first;
    // autoFocus alone is flaky on remount.
    const t = setTimeout(() => ref.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [enabled]);
  if (!enabled) return null;
  return (
    <TextInput
      ref={ref}
      value=""
      onKeyPress={(e) => {
        const k = e.nativeEvent.key;
        if (k === "Backspace") return onKey("⌫");
        if (k === "Enter") return;
        if (/^[0-9]$/.test(k)) return onKey(k);
        if (k === "/" || k === "^") return onKey(k);
        if (k === "x" || k === "X") return onKey("x");
        if (k === "Tab" || k === "\t") return onKey("Tab");
        if (k === "ArrowRight" || k === "UIKeyInputRightArrow") return onKey("ArrowRight");
        if (k === "ArrowLeft" || k === "UIKeyInputLeftArrow") return onKey("ArrowLeft");
        if (k === "ArrowUp" || k === "UIKeyInputUpArrow") return onKey("ArrowUp");
        if (k === "ArrowDown" || k === "UIKeyInputDownArrow") return onKey("ArrowDown");
      }}
      onChangeText={() => {}}
      onSubmitEditing={onSubmit}
      showSoftInputOnFocus={false}
      disableKeyboardShortcuts
      autoComplete="off"
      textContentType="none"
      autoCorrect={false}
      spellCheck={false}
      autoFocus
      submitBehavior="submit"
      returnKeyType="done"
      caretHidden
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={OFFSCREEN}
    />
  );
}

/**
 * Captures a hardware-keyboard Return on a screen with NO answer field — a
 * feedback card's "Next", "Try again", "Continue". The instant an answer is
 * submitted its field unmounts, so a keyboard-only learner would otherwise have
 * to reach for the screen just to continue. Mount this beside the button; Return
 * fires `onReturn` exactly like a tap.
 *
 * Shape notes: it must really become first responder or iOS never delivers the
 * key, and a zero-size or `opacity: 0` field is unreliable at that, so it gets
 * a real 1px footprint pushed off-screen. Hidden from accessibility and
 * caret-free, so touch and VoiceOver users never meet it.
 */
export function HardwareReturnAdvance({
  onReturn,
  disabled,
}: {
  onReturn: () => void;
  disabled?: boolean;
}) {
  const ref = useRef<TextInput>(null);

  useEffect(() => {
    if (disabled) return;
    const t = setTimeout(() => ref.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [disabled]);

  if (disabled) return null;
  return (
    <TextInput
      ref={ref}
      value=""
      // Swallow stray keystrokes so the buffer stays empty; only Return matters.
      onChangeText={() => {}}
      showSoftInputOnFocus={false}
      disableKeyboardShortcuts
      autoFocus
      submitBehavior="submit"
      returnKeyType="done"
      onSubmitEditing={() => onReturn()}
      caretHidden
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={OFFSCREEN}
    />
  );
}
