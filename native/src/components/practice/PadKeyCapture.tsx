/**
 * The hardware-keyboard sinks for the practice answer editors: the native
 * `KeyCapture` first responder when the binary has it, and an off-screen text
 * field otherwise. Shared by the number pad (NativePracticeControls) and the
 * algebra pad (AlgebraAnswer).
 */

import { useEffect, useRef } from "react";
import type { TextInput } from "react-native";

import { AppTextInput } from "@/components/AppTextInput";
import { KeyCaptureView, isKeyCaptureAvailable } from "@/lib/keyCapture";
import { sanitizePadInput, type PadAnswerType } from "@/lib/practicePad";

/**
 * Off-screen hardware-key capture. It is the fallback for the 2-D editor when
 * the native `KeyCapture` module is absent, and it also catches edit intent
 * during first-miss feedback after iOS has blurred the visible answer field.
 *
 * NOTE: Tab and the arrow keys never reach this field — RN's iOS `onKeyPress`
 * only fires for text-producing keys (plus Backspace); UIKit consumes Tab and
 * the arrows for its own focus/selection handling and RN surfaces no event. Box
 * MOVEMENT here is tap-to-focus. The native `KeyCapture` module (preferred path,
 * see `@/lib/keyCapture`) closes that gap with a `pressesBegan`-based first
 * responder; this field remains only so an un-rebuilt binary still gets digits.
 */
export function TextKeyCapture({
  enabled,
  onKey,
  onSubmit,
  flatAnswerType,
  allowUnit = false,
}: {
  enabled: boolean;
  onKey: (key: string) => void;
  onSubmit: () => void;
  flatAnswerType?: PadAnswerType;
  allowUnit?: boolean;
}) {
  const ref = useRef<TextInput>(null);
  useEffect(() => {
    if (!enabled) return;
    const t = setTimeout(() => ref.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [enabled]);
  if (!enabled) return null;
  return (
    <AppTextInput
      ref={ref}
      value=""
      onKeyPress={(e) => {
        const k = e.nativeEvent.key;
        if (k === "Backspace") return onKey("⌫");
        if (k === "Enter") return;
        if (flatAnswerType) {
          if ([...k].length !== 1) return;
          const normalized = sanitizePadInput(flatAnswerType, k, { allowUnit });
          if (normalized) onKey(normalized);
          return;
        }
        if (/^[0-9]$/.test(k)) return onKey(k);
        if (k === "/" || k === "^") return onKey(k);
        if (k === "x" || k === "X") return onKey("x");
        // Algebra characters. The constrained number-pad model refuses every
        // one of these itself, so forwarding them is harmless there.
        if ([...k].length === 1 && /^[A-Za-z+\-*()|,;.±×÷−]$/.test(k)) return onKey(k);
        // Hardware-keyboard box navigation — parity with the web editor, where
        // Tab / arrows move between boxes.
        //
        // ⚠️ MEASURED ON DEVICE (iPad sim, iOS 26): these branches never fire.
        // RN's iOS `onKeyPress` is driven by the text field's
        // shouldChangeCharactersInRange, so only TEXT-producing keys (plus
        // Backspace, which we do receive) reach it; UIKit consumes Tab and the
        // arrows for its own focus/selection handling and RN surfaces no event.
        // Digits, "/", "^" and Backspace all work from a hardware keyboard; box
        // MOVEMENT on iPad is tap-to-focus (what the hint text tells the scholar).
        // Kept because they're free and correct if RN ever delivers these keys;
        // closing the gap for real needs a UIKeyCommand-based native module.
        // (Shift-Tab can't be distinguished here either — RN onKeyPress exposes
        // no modifier state.)
        if (k === "Tab" || k === "\t") return onKey("Tab");
        if (k === "ArrowRight" || k === "UIKeyInputRightArrow") return onKey("ArrowRight");
        if (k === "ArrowLeft" || k === "UIKeyInputLeftArrow") return onKey("ArrowLeft");
        if (k === "ArrowUp" || k === "UIKeyInputUpArrow") return onKey("ArrowUp");
        if (k === "ArrowDown" || k === "UIKeyInputDownArrow") return onKey("ArrowDown");
      }}
      onChangeText={() => {}}
      onSubmitEditing={onSubmit}
      showSoftInputOnFocus={false}
      autoComplete="off"
      textContentType="none"
      // No contextMenuHidden here, unlike the visible answer box below: this
      // field is a 1×1 sink parked off-screen, so there is no way to tap it and
      // the AutoFill edit menu can never be summoned on it. (Programmatic focus
      // alone does not raise that menu — measured alongside the box below.)
      autoCorrect={false}
      spellCheck={false}
      autoFocus
      submitBehavior="submit"
      returnKeyType="done"
      caretHidden
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ position: "absolute", width: 1, height: 1, left: -1000, top: 0 }}
    />
  );
}

/**
 * The hardware-key capture for the 2-D editor. Prefers the native `KeyCapture`
 * first responder (which delivers Tab / Shift-Tab / arrows — full parity with
 * the web editor's keyboard navigation), and falls back to the text-field-based
 * `TemplateKeyCapture` (digits + Backspace only, tap-to-move) when that native
 * module isn't in the running binary. Only one is ever mounted, since both
 * become first responder while the editor is answering.
 */
export function TemplateKeyCaptureHost({
  enabled,
  onKey,
  onSubmit,
}: {
  enabled: boolean;
  onKey: (key: string) => void;
  onSubmit: () => void;
}) {
  if (isKeyCaptureAvailable) {
    return <KeyCaptureView active={enabled} onKey={onKey} onSubmit={onSubmit} />;
  }
  return <TextKeyCapture enabled={enabled} onKey={onKey} onSubmit={onSubmit} />;
}
