import { forwardRef } from "react";
import { TextInput, type TextInputProps } from "react-native";

/**
 * The app's text field. React Native's `TextInput` with iOS's **input assistant**
 * turned off — use this everywhere instead of importing `TextInput` directly.
 *
 * The input assistant is the bar iOS attaches above the keyboard. On an iPad with
 * a hardware keyboard — the fleet's standard posture, an 11" iPad in a Magic
 * Keyboard Folio — there is no keyboard to sit above, so iPadOS collapses it into
 * a floating pill parked in the bottom-RIGHT corner, over the app. Measured on the
 * pilot iPad (2026-08-13), leaving it on cost two things:
 *
 *   1. The pill itself, floating over the UI, offering a scholar only "Show
 *      Keyboard" and "Keyboard Settings" — neither of which they want. In the
 *      landscape two-pane session it sits directly over "Check my work".
 *   2. ~71pt of vertical space on the session screen, because iOS reports the
 *      bar as keyboard height and our keyboard inset dutifully made room for it.
 *      The composer's text view moved 692 -> 763 once the bar was gone.
 *
 * RN's `disableKeyboardShortcuts` empties `inputAssistantItem`'s leading and
 * trailing bar-button groups, which removes both. iOS-only; inert elsewhere.
 *
 * What it does NOT remove — tested on the device, so don't re-derive it: the
 * "AutoFill" callout iOS floats over the app when you tap an EMPTY field. That
 * one rides the system edit menu, so a field that must never show it needs
 * `contextMenuHidden` too (the session composer and the practice answer box each
 * pass it). The cost of THAT prop is the field's whole edit menu, ⌘A included, so
 * it stays opt-in per field rather than being folded in here.
 *
 * What this one costs, deliberately accepted: with the SOFT keyboard up (Folio
 * detached) the undo/redo/paste row above the keyboard goes too. Long-press still
 * gives Select All / Copy / Paste on any field that has not also opted into
 * `contextMenuHidden`, and the hardware ⌘ shortcuts are unaffected by this prop.
 *
 * Pass `disableKeyboardShortcuts={false}` to opt a specific field back in.
 */
export const AppTextInput = forwardRef<TextInput, TextInputProps>(
  function AppTextInput(props, ref) {
    return <TextInput ref={ref} disableKeyboardShortcuts {...props} />;
  },
);
