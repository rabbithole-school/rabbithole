import { useCallback, useEffect, useRef } from "react";
import * as Haptics from "expo-haptics";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import Reanimated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import Svg, { Path, Rect, Text as SvgText } from "react-native-svg";

import { useHardwareKeyboard } from "@/lib/hardwareKeyboard";
import { KeyCaptureView, isKeyCaptureAvailable } from "@/lib/keyCapture";
import { useColors } from "@/theme";
import {
  createExpressionTemplateState,
  expressionTemplateSeedFromSkeleton,
  type ExpressionTemplateState,
} from "@/lib/expressionTemplateInput";
import { useExpressionTemplateController } from "@/lib/useExpressionTemplateController";
import {
  applyUnitKey,
  padGridKeys,
  padShowFraction,
  padShowRemainder,
  padShowSign,
  sanitizePadInput,
  unitKeyFamily,
  UNIT_MISSING_NUDGE,
  type PadAnswerType,
} from "@/lib/practicePad";
import { superscriptExponents } from "../../../vendor/shared/mathNotation";
import {
  RADICAL_KEYPAD_PATH,
  RADICAL_KEYPAD_VIEWBOX,
  radicalMetrics,
} from "@/lib/radicalGeometry";
import { ExpressionEditor } from "./ExpressionEditor";
import { HardwareReturnAdvance } from "./HardwareReturnAdvance";
import { AppTextInput } from "@/components/AppTextInput";

/** Digits + variable for the template editor's on-screen number pad. */
const TEMPLATE_GRID = ["7", "8", "9", "4", "5", "6", "1", "2", "3", "x", "0", "⌫"];

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
function TextKeyCapture({
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
function TemplateKeyCaptureHost({
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

/** A key face that LOOKS like a stacked fraction (two boxes + a bar) — the
 *  redesign's rule that structural keys depict what they insert, not ASCII. */
function GlyphFraction({ color }: { color: string }) {
  return (
    <View style={{ alignItems: "center" }}>
      <View style={[glyphStyles.miniBox, { borderColor: color }]} />
      <View style={[glyphStyles.miniBar, { backgroundColor: color }]} />
      <View style={[glyphStyles.miniBox, { borderColor: color }]} />
    </View>
  );
}

/** A key face that LOOKS like a base box with a raised exponent box. */
function GlyphPower({ color }: { color: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
      <View style={[glyphStyles.miniBox, { borderColor: color }]} />
      <View style={[glyphStyles.miniBox, { borderColor: color, marginTop: -6, marginLeft: 1 }]} />
    </View>
  );
}

function GlyphSquareRoot({ color }: { color: string }) {
  const metrics = radicalMetrics(26);
  return (
    <Svg accessible={false} height={28} viewBox={RADICAL_KEYPAD_VIEWBOX} width={40}>
      <Path
        d={RADICAL_KEYPAD_PATH}
        fill="none"
        stroke={color}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={metrics.strokeWidth}
      />
      <Rect
        fill="none"
        height={18}
        rx={3}
        stroke={color}
        strokeWidth={1.6}
        width={16}
        x={21}
        y={4}
      />
    </Svg>
  );
}

function GlyphIndexedRoot({ color }: { color: string }) {
  const metrics = radicalMetrics(26, true);
  return (
    <Svg accessible={false} height={28} viewBox={RADICAL_KEYPAD_VIEWBOX} width={40}>
      <Path d={RADICAL_KEYPAD_PATH} fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth={metrics.strokeWidth} />
      <SvgText fill={color} fontSize={9} fontWeight="600" x={1} y={9}>n</SvgText>
      <Rect fill="none" height={18} rx={3} stroke={color} strokeWidth={1.6} width={16} x={19} y={7} />
    </Svg>
  );
}

const glyphStyles = StyleSheet.create({
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    justifyContent: "space-between",
  },
  key: { width: "48%" },
  miniBox: { width: 13, height: 11, borderWidth: 1.5, borderRadius: 3 },
  miniBar: { width: 15, height: 2, marginVertical: 2, borderRadius: 1 },
});

export interface PracticePrimaryActionStyles {
  primaryBtn: ViewStyle;
  primaryBtnDisabled: ViewStyle;
  primaryBtnText: TextStyle;
}

export interface PracticeControlStyles extends PracticePrimaryActionStyles {
  inputBox: TextStyle;
  inputText: TextStyle;
  keyboardHint: TextStyle;
  /** The under-card miss line — reused verbatim for the unit nudge so a
   *  "you're not done yet" line looks the same wherever it appears. Already on
   *  every caller's styles (the shared practice shell defines it). */
  noteMiss: TextStyle;
  padWrap: ViewStyle;
  padGrid: ViewStyle;
  padKey: ViewStyle;
  padKeyHidden: ViewStyle;
  padKeyPressed: ViewStyle;
  padKeyText: TextStyle;
  padWide: ViewStyle;
}

/**
 * Prevents a tap and hardware Return from firing the same primary action twice
 * before React commits the resulting disabled/phase state.
 */
export function useGuardedPracticeAction(
  onAction: () => void,
  enabled: boolean,
  resetKey: string,
) {
  const firedRef = useRef(false);

  useEffect(() => {
    if (enabled) firedRef.current = false;
  }, [enabled, resetKey]);

  return useCallback(() => {
    if (!enabled || firedRef.current) return;
    firedRef.current = true;
    onAction();
  }, [enabled, onAction]);
}

const AnimatedPressable = Reanimated.createAnimatedComponent(Pressable);

/**
 * One keypad key. `springy` (the "Fast math" tactile mode) gives it a quick
 * press-in scale-down that springs back on release — a satisfying, physical
 * feel for the bare-fact retrieval beat on iPad. Off (or when the scholar has
 * reduce-motion enabled) ⇒ a plain Pressable with the existing pressed-state
 * styling; the animation state allocated by the hooks below remains unused.
 * The key-press haptic still lives in the caller's `onKey`, so this never
 * double-fires one.
 */
function PadKey({
  label,
  disabled,
  hidden,
  springy,
  styles,
  onPress,
}: {
  label: string;
  disabled: boolean;
  hidden: boolean;
  springy: boolean;
  styles: PracticeControlStyles;
  onPress: () => void;
}) {
  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));
  const reduceMotion = useReducedMotion();
  const a11yLabel = hidden ? undefined : label === "⌫" ? "key backspace" : `key ${label}`;

  // Ordinary practice — OR reduce-motion is on: a plain Pressable, unchanged
  // down to the pressed-state background. The springy press-in/spring-back is a
  // pure animation, so a scholar who asked for reduced motion gets the calm,
  // byte-identical branch (matching how the rest of this surface — StemCard, the
  // verdict stamp — drops its animations under reduceMotion).
  if (!springy || reduceMotion) {
    return (
      <Pressable
        disabled={disabled}
        onPress={onPress}
        style={({ pressed }) => [
          styles.padKey,
          hidden && styles.padKeyHidden,
          pressed && !hidden && styles.padKeyPressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel={a11yLabel}
      >
        <Text style={styles.padKeyText}>{label}</Text>
      </Pressable>
    );
  }

  // "Fast math": a springy key. Press-in scales it down fast; release springs
  // it back with a hair of overshoot — a physical, satisfying tap on iPad. The
  // key-press haptic still lives in the caller's onKey, so this never adds a
  // second one.
  return (
    <AnimatedPressable
      disabled={disabled}
      onPressIn={() => {
        if (!hidden) scale.set(withTiming(0.88, { duration: 55 }));
      }}
      onPressOut={() => {
        scale.set(withSpring(1, { damping: 12, stiffness: 340, mass: 0.5 }));
      }}
      onPress={onPress}
      style={[styles.padKey, hidden && styles.padKeyHidden, animStyle]}
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
    >
      <Text style={styles.padKeyText}>{label}</Text>
    </AnimatedPressable>
  );
}

export function PracticePadAnswer({
  answerType,
  answerShape,
  answerFormat,
  answerUnit,
  value,
  enabled,
  focusKey,
  controlsHidden = false,
  unitNudge = false,
  tactile = false,
  fieldStyle,
  placeholderColor,
  styles,
  onChange,
  onKey,
  onSubmit,
  onRetryIntent,
}: {
  answerType: PadAnswerType;
  /** "twoD" ⇒ a genuine fraction/power/root answer that uses the 2-D box editor.
   *  Absent ⇒ a plain/remainder expression that uses the ordinary keypad. */
  answerShape?: "twoD";
  /** L1 scaffold: a NON-LEAKY answer skeleton (numbers → boxes, e.g. `F(_/_)`)
   *  the server sends only while the skill isn't fluent yet. Pre-builds a locked
   *  structure the scholar just fills in. */
  answerFormat?: string;
  /** The measurement unit this item must be answered in, DISPLAY form ("cm³").
   *  Present ⇒ the unit is part of the answer: the field stops filtering
   *  letters out and the pad grows a row of unit keys. Absent ⇒ every
   *  behaviour below is byte-identical to a unit-free item. */
  answerUnit?: string;
  value: string;
  enabled: boolean;
  focusKey: string;
  controlsHidden?: boolean;
  /** The caller's pre-submit gate fired (a unit item was submitted without a
   *  unit) — render the nudge under the field until the next input change. */
  unitNudge?: boolean;
  /** "Fast math" tactile mode — give the number keys a springy press-in/
   *  release-out scale so a bare-fact sprint feels physical on iPad. Default
   *  off ⇒ plain keys, unchanged for all ordinary practice. */
  tactile?: boolean;
  fieldStyle?: StyleProp<TextStyle>;
  placeholderColor: string;
  styles: PracticeControlStyles;
  onChange: (value: string) => void;
  onKey: (key: string) => void;
  onSubmit: () => void;
  /** Present only for first-miss feedback; tapping or editing retries in place. */
  onRetryIntent?: () => void;
}) {
  const colors = useColors();
  const hardwareKeyboard = useHardwareKeyboard();
  const inputRef = useRef<TextInput>(null);
  // The 2-D box editor serves genuine fraction/power/root ("twoD") answers, whether
  // the item is typed "fraction" (the dedicated single-fraction answer most
  // real fraction word problems carry) or "expression" (the general grammar:
  // nested/complex fractions, powers, roots). Every other answer — whole-number
  // division's "7 R 1" remainder form, a sum, a plain number — stays on the
  // ordinary keypad, which carries the keys (R, −, …) the box editor lacks.
  const usesTemplateEditor =
    (answerType === "expression" || answerType === "fraction") &&
    answerShape === "twoD";
  const retryable = !enabled && !!onRetryIntent;
  const retryStartedRef = useRef(false);
  const pendingTemplateRetryKeysRef = useRef<string[]>([]);

  const makeTemplateState = useCallback((): ExpressionTemplateState => {
    if (answerFormat) {
      const seeded = expressionTemplateSeedFromSkeleton(answerFormat);
      if (seeded) return seeded;
    }
    return createExpressionTemplateState("");
  }, [answerFormat]);

  // The controller owns the document AND the ref discipline that makes a BURST
  // of keystrokes compose like a slow one (shared with web — see its module
  // comment; typing "1", "/", "6" fast used to drop the "1" here).
  const {
    state: templateState,
    reset: resetTemplate,
    applyKey: onTemplateKey,
    setCaret: onSetCaret,
    insertFraction: onInsertFraction,
    insertPower: onInsertPower,
    insertSquareRoot: onInsertSquareRoot,
    insertRoot: onInsertRoot,
  } = useExpressionTemplateController({ onSubmissionChange: onChange, initialize: makeTemplateState });

  // Rebuild the editor only when we (re)ENTER an answering phase — a new item
  // (an L1 item arrives with a locked skeleton; an L3 item starts from a single
  // empty box), or a retry / fresh-variant of the current one (both clear the
  // input). Crucially we must NOT rebuild on the answering→feedback transition:
  // the built answer has to stay visible under the verdict tint. focusKey is
  // `${itemId}:${phase}`, so keying the rebuild on the phase suffix gives us
  // exactly that. (Keying on itemId alone would wrongly preserve a retry, which
  // clears the input; keying on `enabled` is fooled by the busy flag during a
  // fresh-variant swap — so we key on the phase itself.)
  const phaseIsAnswering = focusKey.endsWith(":answering");
  useEffect(() => {
    if (!usesTemplateEditor || !phaseIsAnswering) return;
    resetTemplate(makeTemplateState());
  }, [focusKey, makeTemplateState, phaseIsAnswering, resetTemplate, usesTemplateEditor]);

  useEffect(() => {
    if (!retryable) return;
    retryStartedRef.current = false;
    pendingTemplateRetryKeysRef.current = [];
  }, [focusKey, retryable]);

  const beginImplicitRetry = useCallback(() => {
    if (!retryable || !onRetryIntent) return false;
    if (!retryStartedRef.current) {
      retryStartedRef.current = true;
      onRetryIntent();
    }
    return true;
  }, [onRetryIntent, retryable]);

  const onImplicitRetryKey = useCallback(
    (key: string) => {
      if (!beginImplicitRetry()) return;
      if (usesTemplateEditor) pendingTemplateRetryKeysRef.current.push(key);
      else onKey(key);
    },
    [beginImplicitRetry, onKey, usesTemplateEditor],
  );

  useEffect(() => {
    if (!enabled || !usesTemplateEditor) return;
    const pending = pendingTemplateRetryKeysRef.current.splice(0);
    pending.forEach(onTemplateKey);
  }, [enabled, focusKey, onTemplateKey, usesTemplateEditor]);

  // Plain-path autofocus (unchanged) — skipped while the box editor owns the
  // surface, since it has no text field to focus.
  useEffect(() => {
    if (!enabled || usesTemplateEditor) return;
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [enabled, focusKey, usesTemplateEditor]);

  if (usesTemplateEditor) {
    const locked = !!templateState.structureLocked;
    // A hardware keyboard supplies the digits in normal use. The unattended
    // autologin lane deliberately keeps the grid visible: Appium can press the
    // same controller keys without pretending to be UIKit hardware input.
    const showNumberPad =
      !hardwareKeyboard || (__DEV__ && process.env.EXPO_PUBLIC_DEV_AUTOLOGIN === "1");
    const showGlyphKeys = !locked;
    const showRootKeys = answerType === "expression";
    const editorField = (
      <View
        style={[
          // inputBox/fieldStyle are box styles (border/padding/tints) declared
          // as TextStyle for the plain-path TextInput; RN's TextStyle/ViewStyle
          // are mutually unassignable (cursor/userSelect), so cast for a View.
          styles.inputBox as StyleProp<ViewStyle>,
          // The editor's outer container is a passive canvas, not a focus
          // target: neutralize the cyan border + teal fill that inputBox uses
          // to signal focus on the single-field path. Focus (cyan) belongs to
          // exactly one thing here — the active box inside ExpressionEditor —
          // and the active box's cyanSubtle fill only reads if the surround is
          // transparent. Feedback tints (fieldStyle) still apply last.
          {
            borderColor: colors.border,
            borderWidth: 1,
            backgroundColor: "transparent",
            justifyContent: "center",
            alignItems: "center",
            minHeight: 76,
          },
          fieldStyle as StyleProp<ViewStyle>,
        ]}
        accessibilityLabel="Answer builder"
      >
        <ExpressionEditor
          state={templateState}
          onSetCaret={onSetCaret}
          interactive={enabled}
        />
      </View>
    );
    return (
      <>
        {retryable ? (
          <Pressable
            onPress={beginImplicitRetry}
            style={{ width: "100%" }}
            accessibilityRole="button"
            accessibilityLabel="Edit answer and try again"
          >
            {editorField}
          </Pressable>
        ) : (
          editorField
        )}

        <TemplateKeyCaptureHost
          enabled={hardwareKeyboard && enabled && !controlsHidden}
          onKey={onTemplateKey}
          onSubmit={onSubmit}
        />
        <TextKeyCapture
          enabled={hardwareKeyboard && retryable}
          onKey={onImplicitRetryKey}
          onSubmit={beginImplicitRetry}
        />

        <View
          style={{ width: "100%", opacity: controlsHidden ? 0 : 1 }}
          pointerEvents={enabled && !controlsHidden ? "auto" : "none"}
          accessibilityElementsHidden={controlsHidden}
          importantForAccessibility={controlsHidden ? "no-hide-descendants" : "auto"}
        >
          <View style={styles.padWrap}>
            {showNumberPad ? (
              <View style={styles.padGrid}>
                {TEMPLATE_GRID.map((key, index) => (
                  <Pressable
                    key={index}
                    disabled={!enabled || key === ""}
                    onPress={() => key && onTemplateKey(key)}
                    style={({ pressed }) => [
                      styles.padKey,
                      key === "" && styles.padKeyHidden,
                      pressed && key !== "" && styles.padKeyPressed,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={
                      key === "⌫" ? "key backspace" : `key ${key}`
                    }
                  >
                    <Text style={styles.padKeyText}>{key}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            {showGlyphKeys ? (
              <View style={glyphStyles.grid}>
                <Pressable
                  disabled={!enabled}
                  onPress={onInsertFraction}
                  style={({ pressed }) => [
                    styles.padKey,
                    glyphStyles.key,
                    pressed && styles.padKeyPressed,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="insert fraction"
                >
                  <GlyphFraction color={colors.charcoal} />
                </Pressable>
                <Pressable
                  disabled={!enabled}
                  onPress={onInsertPower}
                  style={({ pressed }) => [
                    styles.padKey,
                    glyphStyles.key,
                    pressed && styles.padKeyPressed,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="insert exponent"
                >
                  <GlyphPower color={colors.charcoal} />
                </Pressable>
                {showRootKeys ? (
                  <>
                    <Pressable
                      disabled={!enabled}
                      onPress={onInsertSquareRoot}
                      style={({ pressed }) => [
                        styles.padKey,
                        glyphStyles.key,
                        pressed && styles.padKeyPressed,
                      ]}
                      accessibilityRole="button"
                      accessibilityLabel="insert a square root"
                    >
                      <GlyphSquareRoot color={colors.charcoal} />
                    </Pressable>
                    <Pressable
                      disabled={!enabled}
                      onPress={onInsertRoot}
                      style={({ pressed }) => [
                        styles.padKey,
                        glyphStyles.key,
                        pressed && styles.padKeyPressed,
                      ]}
                      accessibilityRole="button"
                      accessibilityLabel="insert a root with an index"
                    >
                      <GlyphIndexedRoot color={colors.charcoal} />
                    </Pressable>
                  </>
                ) : null}
              </View>
            ) : null}
            {hardwareKeyboard ? (
              <Text style={styles.keyboardHint}>
                {isKeyCaptureAvailable
                  ? "Type to fill a box. Tab or the arrow keys move between boxes. Return to check."
                  : "Tap a box to select it, then type. Return to check."}
              </Text>
            ) : null}
          </View>
        </View>
      </>
    );
  }

  // A unit-bearing item's pad keys: the whole dimension family of the served
  // unit (cm / cm² / cm³), because choosing length vs. area vs. volume IS part
  // of the answer — a single pre-filled key would type it for the scholar. A tap
  // REPLACES any trailing unit token (`applyUnitKey`), so switching cm² → cm³ is
  // one tap. It rides `onChange` rather than `onKey`: the pad's `applyKey`
  // vocabulary only ever appends, and this key doesn't.
  const unitKeys = answerUnit ? unitKeyFamily(answerUnit) : [];
  const unitKeyRow =
    unitKeys.length > 0 ? (
      <View style={styles.padGrid}>
        {unitKeys.map((unit) => (
          <Pressable
            key={unit}
            disabled={!enabled}
            onPress={() => {
              Haptics.selectionAsync().catch(() => {});
              onChange(applyUnitKey(value, unit));
            }}
            style={({ pressed }) => [styles.padKey, pressed && styles.padKeyPressed]}
            accessibilityRole="button"
            accessibilityLabel={`key unit ${unit}`}
          >
            <Text style={styles.padKeyText}>{unit}</Text>
          </Pressable>
        ))}
      </View>
    ) : null;
  const unitNudgeLine =
    unitNudge && !controlsHidden ? (
      <Text style={styles.noteMiss}>{UNIT_MISSING_NUDGE}</Text>
    ) : null;

  return (
    <>
      <AppTextInput
        ref={inputRef}
        style={[
          styles.inputBox,
          styles.inputText,
          { textAlign: "center" as const },
          fieldStyle,
        ]}
        value={value}
        onChangeText={(raw) => {
          if (enabled) {
            const sanitized = sanitizePadInput(answerType, raw, {
              allowUnit: !!answerUnit,
            });
            onChange(answerUnit ? superscriptExponents(sanitized) : sanitized);
          }
        }}
        onKeyPress={
          retryable
            ? (event) => {
                const rawKey = event.nativeEvent.key;
                if (rawKey === "Backspace") {
                  onImplicitRetryKey("⌫");
                  return;
                }
                if ([...rawKey].length !== 1) return;
                const key = sanitizePadInput(answerType, rawKey, {
                  allowUnit: !!answerUnit,
                });
                if (key) onImplicitRetryKey(key);
              }
            : undefined
        }
        onPressIn={retryable ? beginImplicitRetry : undefined}
        placeholder="type your answer"
        placeholderTextColor={placeholderColor}
        showSoftInputOnFocus={false}
        autoComplete="off"
        textContentType="none"
        // Tapping the EMPTY answer box made iOS float its edit-menu callout
        // offering "AutoFill" — a credential affordance landing on top of the
        // problem stem the scholar is reading. MEASURED on an iPad sim (iOS 26,
        // landscape): the two props above do NOT suppress it, because it is
        // UIEditMenuInteraction (an XCUIElementTypeMenuItem in the system's own
        // collection view), not content-type autofill; nor does
        // showSoftInputOnFocus={false}, since the callout is independent of the
        // keyboard. contextMenuHidden is what removes it. Cost: Cut/Copy/Paste
        // on this field — cheap here, because the answer is a number the
        // scholar computes on the keypad above, not text they'd paste in. Same
        // trade accepted for the session composer on 2026-08-13 (PR #2207).
        contextMenuHidden
        autoCorrect={false}
        spellCheck={false}
        autoFocus={enabled}
        submitBehavior="submit"
        onSubmitEditing={onSubmit}
        editable={enabled || retryable}
        returnKeyType="done"
        accessibilityLabel={retryable ? "Answer field, edit to try again" : "Answer field"}
        accessibilityValue={{ text: value || "empty" }}
      />
      <TextKeyCapture
        enabled={hardwareKeyboard && retryable}
        flatAnswerType={answerType}
        allowUnit={!!answerUnit}
        onKey={onImplicitRetryKey}
        onSubmit={beginImplicitRetry}
      />

      {unitNudgeLine}

      {hardwareKeyboard ? (
        <>
          {/* A hardware keyboard hides the pad — but the unit keys stay, since a
              superscript is awkward to type (the same reason the 2-D editor keeps
              its structural glyph keys). Typing "cm3"/"cm^3" grades identically. */}
          {unitKeyRow ? (
            <View
              style={{ width: "100%", opacity: controlsHidden ? 0 : 1 }}
              pointerEvents={enabled && !controlsHidden ? "auto" : "none"}
              accessibilityElementsHidden={controlsHidden}
              importantForAccessibility={controlsHidden ? "no-hide-descendants" : "auto"}
            >
              <View style={styles.padWrap}>{unitKeyRow}</View>
            </View>
          ) : null}
          <Text
            style={[styles.keyboardHint, controlsHidden && { opacity: 0 }]}
            accessibilityElementsHidden={controlsHidden}
            importantForAccessibility={controlsHidden ? "no-hide-descendants" : "auto"}
          >
            Type your answer, then press Return
          </Text>
        </>
      ) : (
        <View
          style={{ width: "100%", opacity: controlsHidden ? 0 : 1 }}
          pointerEvents={enabled && !controlsHidden ? "auto" : "none"}
          accessibilityElementsHidden={controlsHidden}
          importantForAccessibility={controlsHidden ? "no-hide-descendants" : "auto"}
        >
          <View style={styles.padWrap}>
            <View style={styles.padGrid}>
              {padGridKeys(answerType).map((key, index) => (
                <PadKey
                  key={index}
                  label={key}
                  disabled={!enabled || key === ""}
                  hidden={key === ""}
                  springy={tactile}
                  styles={styles}
                  onPress={() => key && onKey(key)}
                />
              ))}
            </View>
            {padShowFraction(answerType) ? (
              <Pressable
                disabled={!enabled}
                onPress={() => onKey("/")}
                style={({ pressed }) => [
                  styles.padWide,
                  pressed && styles.padKeyPressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel="key fraction slash"
              >
                <Text style={styles.padKeyText}>/ (fraction)</Text>
              </Pressable>
            ) : null}
            {padShowRemainder(answerType) ? (
              <Pressable
                disabled={!enabled}
                onPress={() => onKey("R")}
                style={({ pressed }) => [
                  styles.padWide,
                  pressed && styles.padKeyPressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel="key remainder"
              >
                <Text style={styles.padKeyText}>R (remainder)</Text>
              </Pressable>
            ) : null}
            {padShowSign(answerType) ? (
              <Pressable
                disabled={!enabled}
                onPress={() => onKey("±")}
                style={({ pressed }) => [
                  styles.padWide,
                  pressed && styles.padKeyPressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel="key toggle negative sign"
              >
                <Text style={styles.padKeyText}>± (negative)</Text>
              </Pressable>
            ) : null}
            {unitKeyRow}
          </View>
        </View>
      )}
    </>
  );
}

export function PracticePrimaryAction({
  label,
  accessibilityLabel,
  disabled = false,
  loading = false,
  captureReturn = false,
  styles,
  indicatorColor,
  onAction,
  style,
}: {
  label: string;
  accessibilityLabel: string;
  disabled?: boolean;
  loading?: boolean;
  captureReturn?: boolean;
  styles: PracticePrimaryActionStyles;
  indicatorColor: string;
  onAction: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const unavailable = disabled || loading;

  return (
    <>
      <Pressable
        disabled={unavailable}
        onPress={onAction}
        style={({ pressed }) => [
          styles.primaryBtn,
          style,
          unavailable && styles.primaryBtnDisabled,
          pressed && !unavailable && { opacity: 0.85 },
        ]}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
      >
        {loading ? (
          <ActivityIndicator color={indicatorColor} />
        ) : (
          <Text style={styles.primaryBtnText}>{label}</Text>
        )}
      </Pressable>
      {captureReturn ? (
        <HardwareReturnAdvance onReturn={onAction} disabled={unavailable} />
      ) : null}
    </>
  );
}
