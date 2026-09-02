import { useEffect, useRef } from "react";
import { TextInput } from "react-native";
import { AppTextInput } from "@/components/AppTextInput";

/**
 * Captures a hardware-keyboard **Return** press in practice states that have NO
 * answer field on screen — the feedback / result cards ("Keep going →",
 * "Next →", "Try again", "Start practicing →", …).
 *
 * During the *question* phase the answer field already advances on Return via
 * its own `onSubmitEditing`; but the instant an answer is submitted that field
 * unmounts, so a scholar on a hardware keyboard would have to reach for touch
 * just to continue. This mounts a focused, off-screen `TextInput` whose Return
 * fires `onReturn`, so Enter advances the primary CTA exactly like Enter
 * submitted the answer — a keyboard-only scholar never has to leave the keys.
 *
 * Implementation notes (why it's shaped this way):
 *   • It must actually become first responder or iOS never delivers the key.
 *     A zero-size / `opacity:0` field is unreliable at grabbing focus, so we
 *     give it a real 1px footprint and push it OFF-SCREEN (`left:-1000`,
 *     alpha 1) — invisible, but a legitimate focus target. We also focus
 *     imperatively on mount (autoFocus alone is flaky on remount).
 *   • `showSoftInputOnFocus={false}` keeps the on-screen keyboard down; iOS
 *     still routes physical keys to the focused field (same as the answer pad).
 *   • Hidden from the accessibility tree and caret-free, so it's a no-op for
 *     touch / VoiceOver users — the visible button stays the real affordance.
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
    // Focus after the current commit so the field is mounted natively first.
    const t = setTimeout(() => ref.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [disabled]);

  if (disabled) return null;
  return (
    <AppTextInput
      ref={ref}
      value=""
      // Swallow stray keystrokes so the buffer stays empty; only Return
      // (onSubmitEditing) is meaningful here.
      onChangeText={() => {}}
      showSoftInputOnFocus={false}
      autoFocus
      submitBehavior="submit"
      returnKeyType="done"
      onSubmitEditing={() => onReturn()}
      caretHidden
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ position: "absolute", width: 1, height: 1, left: -1000, top: 0 }}
    />
  );
}
