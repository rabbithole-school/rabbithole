/**
 * The ALGEBRA answer surface on iPad: the live, typeset answer box(es) and the
 * algebra keypad. Mounted by `PracticePadAnswer` for an item that declares an
 * `answerPalette`, or a `solutionSet` item.
 *
 * Built for a finger, usually with no hardware keyboard:
 *  - Every key is at least 52pt tall, in a six-column grid (layout and the
 *    reasoning behind it: `@/lib/algebraPad`).
 *  - Structures (fraction, exponent, x², roots, log, ln) are built by keys that
 *    depict them, and → steps the caret out of whatever box it is in, so
 *    leaving an exponent is always one tap. Typing + − × after a plain
 *    exponent leaves it on its own (x² + 3x reads as written).
 *  - A solution set is a row of answer boxes: "+ Another answer" opens the next
 *    box, and "No solution" replaces them with that one choice. A comma typed
 *    on a hardware keyboard does the same as "+ Another answer".
 *
 * The document model and its submission string live in shared/
 * (`algebraAnswerInput`, `expressionTemplateInput`); this file only draws them.
 */

import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";

import { useHardwareKeyboard } from "@/lib/hardwareKeyboard";
import {
  ALGEBRA_ANSWER_BOX_HEIGHT,
  ALGEBRA_KEY_GAP,
  ALGEBRA_KEY_HEIGHT,
  ALGEBRA_SET_ACTIONS_HEIGHT,
  algebraHardwareKeys,
  algebraPadPress,
  algebraPadResetKey,
  algebraPadRows,
  type AlgebraPadKey,
  type AlgebraStructureOp,
} from "@/lib/algebraPad";
import {
  expressionTemplateIsComplete,
  expressionTemplateToSubmission,
} from "@/lib/expressionTemplateInput";
import { answerToLatex } from "../../../vendor/shared/answerLatex";
import { AnswerMath } from "./AnswerMath";
import { fonts, useColors } from "@/theme";
import {
  createAlgebraAnswerState,
  type AlgebraAnswerState,
} from "../../../vendor/shared/algebraAnswerInput";
import { useAlgebraAnswerController } from "../../../vendor/shared/useAlgebraAnswerController";
import type { AnswerPalette } from "../../../vendor/shared/practiceAnswerForm";
import { ExpressionEditor } from "./ExpressionEditor";
import {
  GlyphFraction,
  GlyphIndexedRoot,
  GlyphPower,
  GlyphSquareRoot,
} from "../../../vendor/react-native-math-keypad/components/Glyphs";
import { GlyphLog, GlyphSquare } from "./PadGlyphs";
import { TemplateKeyCaptureHost, TextKeyCapture } from "./PadKeyCapture";
import type { PracticeControlStyles } from "./NativePracticeControls";

/** Keys whose label is a variable or constant, set in italic like the box. */
const ITALIC_KEYS = new Set(["x", "y", "n", "i", "e"]);

export function AlgebraPadAnswer({
  palette,
  solutionSet,
  enabled,
  focusKey,
  controlsHidden,
  fieldStyle,
  styles,
  belowField,
  onChange,
  onSubmit,
  onRetryIntent,
}: {
  palette: AnswerPalette;
  solutionSet: boolean;
  enabled: boolean;
  /** `${itemId}:${phase}` — the document is rebuilt on (re)entering answering. */
  focusKey: string;
  controlsHidden: boolean;
  fieldStyle?: StyleProp<TextStyle>;
  styles: PracticeControlStyles;
  /** The form hint / form nudge lines, drawn under the answer box. */
  belowField: ReactNode;
  onChange: (value: string) => void;
  onSubmit: () => void;
  /** Present only for first-miss feedback; tapping or editing retries in place. */
  onRetryIntent?: () => void;
}) {
  const colors = useColors();
  const hardwareKeyboard = useHardwareKeyboard();
  const makeState = useCallback((): AlgebraAnswerState => createAlgebraAnswerState(solutionSet), [solutionSet]);
  // Same lifecycle as the 2-D editor: rebuild only on (re)entering answering —
  // a new item, a retry. A form nudge never leaves answering, so the scholar's
  // answer stays in the box for them to edit. The controller owns the rebuild
  // and keeps its callbacks stable, so a host that passes an inline `onChange`
  // can no longer wipe the answer on every keystroke.
  const controller = useAlgebraAnswerController({
    onSubmissionChange: onChange,
    initialize: makeState,
    resetKey: algebraPadResetKey(focusKey),
  });
  const { state, applyKey } = controller;

  // First-miss feedback: a tap or a key starts the retry, and keys typed in the
  // meantime are replayed once answering resumes (mirrors the 2-D editor).
  const retryable = !enabled && !!onRetryIntent;
  const retryStartedRef = useRef(false);
  const pendingKeysRef = useRef<string[]>([]);
  useEffect(() => {
    if (!retryable) return;
    retryStartedRef.current = false;
    pendingKeysRef.current = [];
  }, [focusKey, retryable]);
  const beginRetry = useCallback(() => {
    if (!retryable || !onRetryIntent) return false;
    if (!retryStartedRef.current) {
      retryStartedRef.current = true;
      onRetryIntent();
    }
    return true;
  }, [onRetryIntent, retryable]);
  const onRetryKey = useCallback(
    (key: string) => {
      if (beginRetry()) pendingKeysRef.current.push(key);
    },
    [beginRetry],
  );
  useEffect(() => {
    if (!enabled) return;
    pendingKeysRef.current.splice(0).forEach(applyKey);
  }, [applyKey, enabled, focusKey]);

  const pressKey = (key: AlgebraPadKey) => algebraPadPress(controller, key);

  const interactive = enabled;
  const multi = state.multi;

  // A graded answer (feedback) is read, not edited: draw each answer as typeset
  // math (the same renderer as the revealed answer), tight, with no box chrome.
  const memberView = (member: (typeof state.members)[number], index: number, active: boolean) => {
    if (!interactive) {
      const submission = expressionTemplateIsComplete(member) ? expressionTemplateToSubmission(member) : "";
      if (submission && answerToLatex(submission)) {
        return <AnswerMath value={submission} fontSize={multi ? 22 : 26} />;
      }
    }
    return (
      <ExpressionEditor
        state={member}
        fontSize={multi ? 24 : 26}
        interactive={active}
        onSetCaret={(slotId, caret) => controller.setCaret(index, slotId, caret)}
      />
    );
  };

  const answerBoxes = (
    <View style={local.boxes} accessibilityLabel="Answer builder" testID="pad-answer">
      {state.noSolution ? (
        <View style={[local.chip, { borderColor: colors.cyan, backgroundColor: colors.cyanSubtle }]}>
          <Text style={[local.chipText, { color: colors.charcoal }]}>No solution</Text>
        </View>
      ) : (
        state.members.map((member, index) => {
          const active = interactive && index === state.active;
          return (
            <Pressable
              key={index}
              testID={`pad-answer-${index}`}
              disabled={!interactive || index === state.active}
              onPress={() => controller.setActive(index)}
              accessibilityRole="button"
              accessibilityLabel={multi ? `Answer ${index + 1}` : "Answer"}
              accessibilityState={{ selected: active }}
              style={[
                multi ? local.chip : local.single,
                {
                  borderColor: multi && active ? colors.cyan : colors.border,
                  backgroundColor: "transparent",
                },
              ]}
            >
              {memberView(member, index, active)}
            </Pressable>
          );
        })
      )}
    </View>
  );

  const field = (
    <View
      style={[
        styles.inputBox as StyleProp<ViewStyle>,
        {
          borderColor: colors.border,
          borderWidth: 1,
          backgroundColor: "transparent",
          justifyContent: "center",
          alignItems: "center",
          // Compact: the pad below is tall, and the question must stay on screen.
          minHeight: ALGEBRA_ANSWER_BOX_HEIGHT - 2,
          paddingVertical: 2,
        },
        fieldStyle as StyleProp<ViewStyle>,
      ]}
    >
      {answerBoxes}
    </View>
  );

  const setActions = multi ? (
    <View style={local.setActions} pointerEvents={interactive ? "auto" : "none"}>
      <Pressable
        testID="pad-add-answer"
        disabled={!interactive || state.noSolution}
        onPress={controller.addMember}
        style={({ pressed }) => [styles.padWide, local.setAction, pressed && styles.padKeyPressed, state.noSolution && { opacity: 0.4 }]}
        accessibilityRole="button"
        accessibilityLabel="Add another answer"
      >
        <Text style={[styles.padKeyText, local.setActionText]}>+ Another answer</Text>
      </Pressable>
      <Pressable
        testID="pad-no-solution"
        disabled={!interactive}
        onPress={controller.toggleNoSolution}
        style={({ pressed }) => [
          styles.padWide,
          local.setAction,
          state.noSolution && { borderColor: colors.cyan, backgroundColor: colors.cyanSubtle },
          pressed && styles.padKeyPressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel="No solution"
        accessibilityState={{ selected: state.noSolution }}
      >
        <Text style={[styles.padKeyText, local.setActionText]}>No solution</Text>
      </Pressable>
    </View>
  ) : null;

  const showFullPad = !hardwareKeyboard || (__DEV__ && process.env.EXPO_PUBLIC_DEV_AUTOLOGIN === "1");
  const renderKey = (key: AlgebraPadKey) => {
    if (key.kind === "spacer") return <View key={key.id} style={[local.key, local.spacer]} />;
    return (
      <Pressable
        key={key.id}
        testID={key.testID}
        disabled={!interactive}
        onPress={() => pressKey(key)}
        style={({ pressed }) => [styles.padKey, local.key, pressed && styles.padKeyPressed]}
        accessibilityRole="button"
        accessibilityLabel={key.a11y}
      >
        {key.kind === "op" ? (
          <OpFace op={key.op} color={colors.charcoal} />
        ) : (
          <Text
            style={[
              styles.padKeyText,
              ITALIC_KEYS.has(key.key) && { fontFamily: fonts.italic },
              key.key.startsWith("Arrow") && { fontSize: 24 },
            ]}
          >
            {key.label}
          </Text>
        )}
      </Pressable>
    );
  };

  // One child for the host's answer block, so its gap counts once; the
  // hardware-key sinks are zero-size and take no row.
  return (
    <View style={local.stack}>
      {retryable ? (
        <Pressable
          onPress={beginRetry}
          style={{ width: "100%" }}
          accessibilityRole="button"
          accessibilityLabel="Edit answer and try again"
        >
          {field}
        </Pressable>
      ) : (
        field
      )}
      {belowField}

      <View style={local.sink} pointerEvents="none">
        <TemplateKeyCaptureHost
          enabled={hardwareKeyboard && enabled && !controlsHidden}
          onKey={applyKey}
          onSubmit={onSubmit}
        />
        <TextKeyCapture enabled={hardwareKeyboard && retryable} onKey={onRetryKey} onSubmit={beginRetry} />
      </View>

      {/* The pad is gone while a verdict shows (not just faded): reserving its
          height pushed the feedback note below the screen. */}
      {controlsHidden ? null : (
        <View style={local.pad} pointerEvents={enabled ? "auto" : "none"}>
          {setActions}
          {showFullPad ? (
            algebraPadRows(palette, { solutionSet }).map((row, r) => (
              <View key={r} style={local.row}>
                {row.map(renderKey)}
              </View>
            ))
          ) : (
            <View style={[local.row, local.hardwareRow]}>
              {algebraHardwareKeys(palette, { solutionSet }).map(renderKey)}
            </View>
          )}
        </View>
      )}
    </View>
  );
}

function OpFace({ op, color }: { op: AlgebraStructureOp; color: string }) {
  switch (op) {
    case "fraction":
      return <GlyphFraction color={color} />;
    case "power":
      return <GlyphPower color={color} />;
    case "square":
      return <GlyphSquare color={color} />;
    case "sqrt":
      return <GlyphSquareRoot color={color} />;
    case "root":
      return <GlyphIndexedRoot color={color} />;
    case "log":
      return <GlyphLog color={color} />;
    case "ln":
      return <Text style={{ fontFamily: fonts.semibold, fontSize: 20, color }}>ln</Text>;
  }
}

const local = StyleSheet.create({
  boxes: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  single: {
    borderWidth: 0,
  },
  chip: {
    borderWidth: 2,
    borderRadius: 12,
    paddingHorizontal: 8,
    minWidth: 76,
    minHeight: 58,
    alignItems: "center",
    justifyContent: "center",
  },
  chipText: { fontFamily: fonts.semibold, fontSize: 20, paddingHorizontal: 12 },
  setActions: { flexDirection: "row", gap: 10, marginBottom: 2 },
  setAction: { flex: 1, height: ALGEBRA_SET_ACTIONS_HEIGHT },
  setActionText: { fontSize: 18 },
  row: { flexDirection: "row", justifyContent: "space-between" },
  hardwareRow: { justifyContent: "center", gap: ALGEBRA_KEY_GAP, flexWrap: "wrap" },
  // Eight to a row: 8 × 11.6% + 7 small gaps ≈ 100% of the 480pt column.
  key: { width: "11.6%", height: ALGEBRA_KEY_HEIGHT },
  spacer: { opacity: 0 },
  stack: { width: "100%", gap: 8 },
  pad: { width: "100%", gap: ALGEBRA_KEY_GAP },
  sink: { position: "absolute", width: 1, height: 1, left: 0, top: 0 },
});
