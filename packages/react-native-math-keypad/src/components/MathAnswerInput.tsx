import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";

import {
  createExpressionTemplateState,
  expressionTemplateSeedFromSkeleton,
  type ExpressionTemplateState,
} from "../model/expressionTemplate";
import {
  applyKey,
  applyUnitKey,
  sanitizePadInput,
  superscriptExponents,
  type PadAnswerType,
} from "../model/flatPad";
import { useHardwareKeyboard } from "../native/hardwareKeyboard";
import { KeyCaptureView, isKeyCaptureAvailable } from "../native/KeyCaptureView";
import { TextKeyCapture } from "../native/TextKeyCapture";
import { useMathKeypadTheme, type MathKeypadThemeOverride } from "../theme";
import { useExpressionTemplateController } from "../useExpressionTemplateController";
import { ExpressionEditor } from "./ExpressionEditor";
import { BUILDER_GRID, NumberPad, StructureKeys } from "./Keypads";
import { makeKeyStyles } from "./keyStyles";
import { PadKey } from "./PadKey";

type CommonProps = {
  /** False renders the answer inert (e.g. under a "correct!" card): the built
   *  answer stays visible, keys and caret go away. Default true. */
  enabled?: boolean;
  /** Return on a hardware keyboard. Wire your own submit button to the same handler. */
  onSubmit?: () => void;
  /**
   * When to draw the digit keys. "auto" (default) hides them while a hardware
   * keyboard is attached, which frees ~350pt on an iPad in a keyboard case.
   * "always" is useful for UI automation, which can press on-screen keys but
   * can't pretend to be UIKit hardware input.
   */
  numberPad?: "auto" | "always" | "never";
  /** Keep the layout but hide and disable the keys (opacity 0). */
  controlsHidden?: boolean;
  /** Change this to start over: the builder reseeds, the flat field refocuses. */
  resetKey?: string | number;
  /** Fires on every ON-SCREEN key press, before the edit. Use it for haptics. */
  onKeyPress?: (key: string) => void;
  /** Override the hardware-keyboard hint line; null hides it. */
  hint?: string | null;
  theme?: MathKeypadThemeOverride;
  style?: StyleProp<ViewStyle>;
};

export type FlatAnswerInputProps = CommonProps & {
  kind?: "flat";
  answerType: PadAnswerType;
  /** Controlled value: the answer string ("42", "-3/4", "7 R 2", "112 cm³"). */
  value: string;
  onChange: (value: string) => void;
  /** Display unit the answer must carry ("cm³", "°"); adds unit keys. */
  unit?: string;
  /** Springy keys for timed fact practice. Honors Reduce Motion. */
  tactile?: boolean;
  placeholder?: string;
  /** Applied last to the field, e.g. a right/wrong tint. */
  fieldStyle?: StyleProp<TextStyle>;
};

export type BuilderAnswerInputProps = CommonProps & {
  kind: "builder";
  /** The flat submission ("2 1/2", "(2/3)/4", "√16", "12^3"); "" until every box is filled. */
  onChange: (submission: string) => void;
  /** Offer √▢ and ⁿ√▢ keys. */
  allowRoots?: boolean;
  /** A locked skeleton such as "F(_/_)" or "F(F(_/_)/_)": the structure is
   *  fixed and only the boxes fill. Omit for an empty, free builder. */
  template?: string;
  /** Base font size of the editor. Default 26. */
  fontSize?: number;
  fieldStyle?: StyleProp<ViewStyle>;
};

export type MathAnswerInputProps = FlatAnswerInputProps | BuilderAnswerInputProps;

/**
 * One component for a math answer on a tablet: a FLAT answer (a number, a
 * fraction typed as `3/4`, a remainder, a unit) edits a string; a BUILDER
 * answer (stacked fractions, mixed numbers, exponents, roots) edits a 2-D box
 * structure. Both work from the on-screen pad, a hardware keyboard, or a mix.
 *
 * Extracted from Rabbithole's `PracticePadAnswer`
 * (native/src/components/practice/NativePracticeControls.tsx).
 */
export function MathAnswerInput(props: MathAnswerInputProps) {
  if (props.kind === "builder") return <BuilderAnswerInput {...props} />;
  return <FlatAnswerInput {...props} />;
}

function useLatest<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

function controlsWrapperProps(controlsHidden: boolean, enabled: boolean) {
  return {
    style: { width: "100%", opacity: controlsHidden ? 0 : 1 } as ViewStyle,
    pointerEvents: (enabled && !controlsHidden ? "auto" : "none") as "auto" | "none",
    accessibilityElementsHidden: controlsHidden,
    importantForAccessibility: (controlsHidden ? "no-hide-descendants" : "auto") as
      | "auto"
      | "no-hide-descendants",
  };
}

export function FlatAnswerInput({
  answerType,
  value,
  onChange,
  unit,
  tactile = false,
  placeholder = "type your answer",
  fieldStyle,
  enabled = true,
  onSubmit,
  numberPad = "auto",
  controlsHidden = false,
  resetKey,
  onKeyPress,
  hint,
  theme: themeOverride,
  style,
}: FlatAnswerInputProps) {
  const theme = useMathKeypadTheme(themeOverride);
  const styles = useMemo(() => makeKeyStyles(theme), [theme]);
  const hardwareKeyboard = useHardwareKeyboard();
  const inputRef = useRef<TextInput>(null);
  const onChangeRef = useLatest(onChange);

  // A synchronous buffer, so a burst of taps (or a last tap and Return) that
  // lands before React re-renders still composes: each key applies to the
  // latest string, never to the `value` an older render captured.
  const buffer = useRef(value);
  useLayoutEffect(() => {
    buffer.current = value;
  }, [value]);
  const emit = useCallback(
    (next: string) => {
      buffer.current = next;
      onChangeRef.current(next);
    },
    [onChangeRef],
  );

  useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [enabled, resetKey]);

  const showDigits = numberPad === "always" || (numberPad === "auto" && !hardwareKeyboard);
  const hintText =
    hint === null ? null : (hint ?? (hardwareKeyboard ? "Type your answer, then press Return" : null));

  return (
    <View style={[{ width: "100%", gap: 14 }, style]}>
      <TextInput
        ref={inputRef}
        style={[styles.inputBox, styles.inputText, { textAlign: "center" as const }, fieldStyle]}
        value={value}
        onChangeText={(raw) => {
          if (!enabled) return;
          const sanitized = sanitizePadInput(answerType, raw, { allowUnit: !!unit });
          emit(unit ? superscriptExponents(sanitized) : sanitized);
        }}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.hint}
        // The pad (or a hardware keyboard) is the input; never raise the soft keyboard.
        showSoftInputOnFocus={false}
        // Removes iPadOS's floating shortcut-bar pill (and the ~71pt of fake
        // keyboard height it reports) when a hardware keyboard is attached.
        disableKeyboardShortcuts
        autoComplete="off"
        textContentType="none"
        // Tapping an EMPTY field floats an "AutoFill" edit-menu callout over the
        // problem. The two props above don't stop it (it is UIEditMenuInteraction);
        // only this does, at the cost of Cut/Copy/Paste on a number field.
        contextMenuHidden
        autoCorrect={false}
        spellCheck={false}
        autoFocus={enabled}
        submitBehavior="submit"
        onSubmitEditing={onSubmit}
        editable={enabled}
        returnKeyType="done"
        accessibilityLabel="Answer field"
        accessibilityValue={{ text: value || "empty" }}
      />
      <View {...controlsWrapperProps(controlsHidden, enabled)}>
        <NumberPad
          answerType={answerType}
          showGrid={showDigits}
          enabled={enabled && !controlsHidden}
          tactile={tactile}
          unit={unit}
          onKey={(key) => {
            if (!enabled) return;
            onKeyPress?.(key);
            emit(applyKey(buffer.current, key));
          }}
          onUnitKey={(u) => {
            if (!enabled) return;
            onKeyPress?.(u);
            emit(applyUnitKey(buffer.current, u));
          }}
          theme={themeOverride}
        />
      </View>
      {hintText ? (
        <Text
          style={[styles.keyboardHint, controlsHidden && { opacity: 0 }]}
          accessibilityElementsHidden={controlsHidden}
          importantForAccessibility={controlsHidden ? "no-hide-descendants" : "auto"}
        >
          {hintText}
        </Text>
      ) : null}
    </View>
  );
}

export function BuilderAnswerInput({
  onChange,
  allowRoots = false,
  template,
  fontSize = 26,
  fieldStyle,
  enabled = true,
  onSubmit,
  numberPad = "auto",
  controlsHidden = false,
  resetKey,
  onKeyPress,
  hint,
  theme: themeOverride,
  style,
}: BuilderAnswerInputProps) {
  const theme = useMathKeypadTheme(themeOverride);
  const styles = useMemo(() => makeKeyStyles(theme), [theme]);
  const hardwareKeyboard = useHardwareKeyboard();
  const onChangeRef = useLatest(onChange);
  const onSubmitRef = useLatest(onSubmit);

  const makeState = useCallback((): ExpressionTemplateState => {
    if (template) {
      const seeded = expressionTemplateSeedFromSkeleton(template);
      if (seeded) return seeded;
    }
    return createExpressionTemplateState("");
  }, [template]);

  // A stable publisher, so the controller's callbacks (and the reseed effect
  // below) don't churn when the caller passes an inline `onChange`.
  const publish = useCallback((submission: string) => onChangeRef.current(submission), [onChangeRef]);

  // The controller owns the document AND the ref discipline that makes a
  // BURST of keystrokes compose like a slow one ("1", "/", "6" typed fast used
  // to lose the "1").
  const {
    state,
    reset,
    applyKey: applyTemplateKey,
    setCaret,
    insertFraction,
    insertPower,
    insertSquareRoot,
    insertRoot,
  } = useExpressionTemplateController({ onSubmissionChange: publish, initialize: makeState });

  // Reseed only when the caller asks for a fresh document (or swaps the
  // template). Going inert (`enabled` false) must NOT reseed: the built answer
  // has to stay visible under the feedback.
  useEffect(() => {
    reset(makeState());
  }, [makeState, reset, resetKey]);

  const submit = useCallback(() => onSubmitRef.current?.(), [onSubmitRef]);
  const screen = (key: string, edit: () => void) => () => {
    if (!enabled) return;
    onKeyPress?.(key);
    edit();
  };

  const locked = !!state.structureLocked;
  const showDigits = numberPad === "always" || (numberPad === "auto" && !hardwareKeyboard);
  const captureEnabled = hardwareKeyboard && enabled && !controlsHidden;
  const defaultHint = isKeyCaptureAvailable
    ? "Type to fill a box. Tab or the arrow keys move between boxes. Return to submit."
    : "Tap a box to select it, then type. Return to submit.";
  const hintText = hint === null ? null : (hint ?? (hardwareKeyboard ? defaultHint : null));

  return (
    <View style={[{ width: "100%", gap: 14 }, style]}>
      <View
        style={[
          {
            borderColor: theme.colors.fieldBorder,
            borderWidth: 1,
            borderRadius: 12,
            paddingHorizontal: 16,
            paddingVertical: 10,
            justifyContent: "center",
            alignItems: "center",
            minHeight: 76,
          },
          fieldStyle,
        ]}
        accessibilityLabel="Answer builder"
      >
        <ExpressionEditor
          state={state}
          onSetCaret={setCaret}
          interactive={enabled}
          fontSize={fontSize}
          theme={themeOverride}
        />
      </View>

      {isKeyCaptureAvailable ? (
        <KeyCaptureView active={captureEnabled} onKey={applyTemplateKey} onSubmit={submit} />
      ) : (
        <TextKeyCapture enabled={captureEnabled} onKey={applyTemplateKey} onSubmit={submit} />
      )}

      <View {...controlsWrapperProps(controlsHidden, enabled)}>
        <View style={styles.padWrap}>
          {showDigits ? (
            <View style={styles.padGrid}>
              {BUILDER_GRID.map((key, index) => (
                <PadKey
                  key={index}
                  label={key}
                  disabled={!enabled}
                  styles={styles}
                  onPress={screen(key, () => applyTemplateKey(key))}
                />
              ))}
            </View>
          ) : null}
          {!locked ? (
            <StructureKeys
              enabled={enabled}
              showRoots={allowRoots}
              onInsertFraction={screen("fraction", insertFraction)}
              onInsertPower={screen("power", insertPower)}
              onInsertSquareRoot={screen("squareRoot", insertSquareRoot)}
              onInsertRoot={screen("root", insertRoot)}
              theme={themeOverride}
            />
          ) : null}
          {hintText ? <Text style={styles.keyboardHint}>{hintText}</Text> : null}
        </View>
      </View>
    </View>
  );
}
