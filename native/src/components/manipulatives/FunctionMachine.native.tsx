/**
 * FunctionMachine (native) — the RN port of the web Function Machine. A hidden
 * rule (out = m·in + b) turns inputs into outputs; the scholar studies worked
 * examples, TESTS their own inputs to check a hypothesis, then types a
 * prediction for the un-worked query input. Isolates function/pattern inference
 * — "find the rule from examples," the seed of algebraic thinking.
 *
 * Both numbers are TYPED, in two tap-to-choose boxes filled by the shared
 * manipulative `NumberPad` (the practice pad's keys, with `± (negative)`):
 *
 *   • the input box feeds Run, which applies `applyFunctionMachineRule` (the
 *     query input's true output stays hidden, to preserve the challenge);
 *   • the prediction box (challenge machines only, as on web; an explore machine
 *     has nothing to predict) echoes into `onStateChange` through
 *     `functionMachineStateFromTypedAnswer`, the same mapping the web frame
 *     uses. An empty box reports `null`, which keeps the frame's Done disabled,
 *     so an untouched default can never be submitted. Done is the commit, as on
 *     web; there is no in-canvas verdict.
 *
 * One pad feeds both boxes, so the box it types into is drawn like a focused
 * text field (violet border and tint), and the other is plainly at rest.
 *
 * These were +/− Steppers until a scholar asked for a text box: reaching an
 * answer of 16 took 16 taps, and an untouched stepper submitted 0.
 */

import { useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
} from "react-native";
import Svg, { Circle, Path, Rect, Text as SvgText } from "react-native-svg";

import {
  applyFunctionMachineRule,
  functionMachineSolved,
  functionMachineStateFromTypedAnswer,
} from "../../../vendor/manipulative/logic";
import type { FunctionMachineState } from "../../../vendor/manipulative/logic";
import { isChallenge, type FunctionMachineSpec } from "../../../vendor/manipulative/types";
import { selectionTick, type KindProps } from "./kit";
import { NumberPad } from "./NumberPad";
import {
  parseFunctionMachineNumber,
  typeFunctionMachineKey,
} from "./functionMachineEntry";
import { fonts, palette, useColors } from "@/theme";

const VBW = 520;
const VBH = 200;
const HOPPER_X = 78;
const MACHINE_X = 260;
const TRAY_X = 442;
const MID_Y = 104;

type Field = "test" | "guess";

/** Every number on the card shows its sign as a true minus. */
function displayNumber(value: string | number): string {
  return String(value).replace("-", "−");
}

function wash(hex: string, alpha: number): string {
  const a = Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex}${a}`;
}

export function FunctionMachineNative({
  spec,
  onSolvedChange,
  onStateChange,
}: KindProps<FunctionMachineSpec, FunctionMachineState | null>) {
  const colors = useColors();
  const window = useWindowDimensions();
  // BunnyPads sit in landscape, where the practice card is short: the pad goes
  // beside the machine and boxes instead of below them, so it is never below
  // the fold when a box is tapped. Portrait has the height to stack them.
  const sideBySide = window.width > window.height;
  const [width, setWidth] = useState(0);
  const [testText, setTestText] = useState("");
  const [guessText, setGuessText] = useState("");
  const [active, setActive] = useState<Field>("test");
  // The input that was actually run, so the readout stays true while the
  // scholar edits the box for the next test.
  const [ranInput, setRanInput] = useState<number | null>(null);
  const [ranOutput, setRanOutput] = useState<number | null>(null);
  const [testedQuery, setTestedQuery] = useState(false);

  const svgHeight = width > 0 ? (width * VBH) / VBW : 0;
  const testInput = parseFunctionMachineNumber(testText);

  const run = () => {
    if (testInput == null) return;
    selectionTick();
    setRanInput(testInput);
    if (testInput === spec.queryInput) {
      // Don't reveal the very output the scholar must predict.
      setRanOutput(null);
      setTestedQuery(true);
      return;
    }
    setTestedQuery(false);
    setRanOutput(applyFunctionMachineRule(spec.rule, testInput));
  };

  const onKey = (key: string) => {
    if (active === "test") {
      setTestText((prev) => typeFunctionMachineKey(prev, key));
      return;
    }
    const next = typeFunctionMachineKey(guessText, key);
    setGuessText(next);
    const state = functionMachineStateFromTypedAnswer(next);
    onSolvedChange(state != null && functionMachineSolved(spec, state));
    onStateChange?.(state);
  };

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  const hopperValue = ranInput != null ? displayNumber(ranInput) : "in";
  const trayValue = testedQuery ? "?" : ranOutput != null ? displayNumber(ranOutput) : "out";
  // An explore machine (no answer to give) has nothing to predict; web shows no
  // answer field for one either.
  const predicts = isChallenge(spec);

  const box = (field: Field, text: string, label: string) => {
    const isActive = active === field;
    return (
      <Pressable
        onPress={() => setActive(field)}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected: isActive }}
        accessibilityValue={{ text: text === "" ? "empty" : displayNumber(text) }}
        style={[
          styles.box,
          {
            borderColor: isActive ? colors.violet : colors.border,
            backgroundColor: isActive ? colors.violetSubtle : colors.bg,
          },
        ]}
      >
        <Text
          style={[
            styles.boxText,
            { color: colors.navy },
            text === "" && [styles.boxPlaceholder, { color: colors.charcoalSubtle }],
          ]}
        >
          {text === "" ? "Tap a number" : displayNumber(text)}
        </Text>
      </Pressable>
    );
  };

  return (
    <View style={[styles.wrap, sideBySide && styles.wrapSideBySide]}>
      <View style={[styles.main, sideBySide && styles.mainSideBySide]}>
        <View style={styles.stage} onLayout={onLayout}>
          {svgHeight > 0 && (
            <Svg width={width} height={svgHeight} viewBox={`0 0 ${VBW} ${VBH}`}>
              {/* conveyor */}
              <Path
                d={`M ${HOPPER_X + 34} ${MID_Y} L ${MACHINE_X - 58} ${MID_Y}`}
                stroke={palette.gray[200]}
                strokeWidth={6}
                strokeLinecap="round"
              />
              <Path
                d={`M ${MACHINE_X + 58} ${MID_Y} L ${TRAY_X - 34} ${MID_Y}`}
                stroke={palette.gray[200]}
                strokeWidth={6}
                strokeLinecap="round"
              />
              {/* hopper */}
              <Path
                d={`M ${HOPPER_X - 44},${MID_Y - 58} L ${HOPPER_X + 44},${MID_Y - 58} L ${HOPPER_X + 20},${MID_Y} L ${HOPPER_X - 20},${MID_Y} Z`}
                fill={wash(palette.cyan[500], 0.35)}
                stroke={palette.navy[500]}
                strokeWidth={2}
              />
              <NumberChip x={HOPPER_X} y={MID_Y - 74} label={hopperValue} color={palette.cyan[500]} />
              {/* machine */}
              <Rect
                x={MACHINE_X - 58}
                y={MID_Y - 54}
                width={116}
                height={108}
                rx={18}
                fill={wash(palette.violet[500], 0.14)}
                stroke={palette.navy[500]}
                strokeWidth={2.5}
              />
              <Gear cx={MACHINE_X - 16} cy={MID_Y - 2} r={16} color={wash(palette.orange[500], 0.9)} />
              <Gear cx={MACHINE_X + 20} cy={MID_Y + 20} r={11} color={wash(palette.violet[500], 0.85)} teeth={6} />
              <Circle cx={MACHINE_X} cy={MID_Y - 38} r={13} fill={palette.navy[500]} />
              <SvgText x={MACHINE_X} y={MID_Y - 33} textAnchor="middle" fontSize={15} fontFamily={fonts.bold} fill={palette.white}>
                ?
              </SvgText>
              {/* tray */}
              <Path
                d={`M ${TRAY_X - 20},${MID_Y} L ${TRAY_X + 20},${MID_Y} L ${TRAY_X + 40},${MID_Y + 42} L ${TRAY_X - 40},${MID_Y + 42} Z`}
                fill={wash(palette.green[500], 0.3)}
                stroke={palette.navy[500]}
                strokeWidth={2}
              />
              <NumberChip x={TRAY_X} y={MID_Y - 74} label={trayValue} color={palette.green[500]} />
            </Svg>
          )}
        </View>

        <Text style={styles.hint}>Study the examples. What does the machine always do?</Text>
        <View style={styles.chips}>
          {spec.examples.map((ex, i) => (
            <View key={`ex-${i}`} style={styles.chip}>
              <Text style={styles.chipIn}>{displayNumber(ex.in)}</Text>
              <Text style={styles.arrow}>→</Text>
              <Text style={styles.chipOut}>{displayNumber(ex.out)}</Text>
            </View>
          ))}
        </View>

        {/* test the machine on your own inputs */}
        <Text style={styles.sectionLabel}>Test the machine</Text>
        <View style={styles.testRow}>
          {box("test", testText, "Test input")}
          <ActionButton onPress={run} label="Run ▶" accessibilityLabel="Run" disabled={testInput == null} />
        </View>
        <Text style={styles.testResult}>
          {testedQuery
            ? `${spec.queryInput} is the one you must predict — try others.`
            : ranOutput != null && ranInput != null
              ? `${displayNumber(ranInput)} → ${displayNumber(ranOutput)}`
              : "Type an input and run it."}
        </Text>

        {/* type a prediction for the query input; Done submits it */}
        {predicts ? (
          <>
            <Text style={styles.sectionLabel}>
              Your prediction for {displayNumber(spec.queryInput)}
            </Text>
            <View style={styles.testRow}>{box("guess", guessText, "Your prediction")}</View>
          </>
        ) : null}
      </View>

      <NumberPad
        padType="integer"
        allowNegative
        onKey={onKey}
        style={[styles.pad, sideBySide && styles.padSideBySide]}
      />
    </View>
  );
}

function NumberChip({ x, y, label, color }: { x: number; y: number; label: string; color: string }) {
  // Wide enough for a typed four-digit input or the larger output it makes.
  const w = Math.max(52, 16 + label.length * 10);
  return (
    <>
      <Rect x={x - w / 2} y={y - 17} width={w} height={34} rx={9} fill={wash(color, 0.9)} stroke={palette.navy[500]} strokeWidth={1.5} />
      <SvgText x={x} y={y + 6} textAnchor="middle" fontSize={16} fontFamily={fonts.bold} fill={palette.navy[500]}>
        {label}
      </SvgText>
    </>
  );
}

function Gear({ cx, cy, r, color, teeth = 8 }: { cx: number; cy: number; r: number; color: string; teeth?: number }) {
  const toothNodes = Array.from({ length: teeth }, (_, i) => {
    const a = (i / teeth) * 360;
    return (
      <Rect
        key={i}
        x={cx - r * 0.22}
        y={cy - r * 1.28}
        width={r * 0.44}
        height={r * 0.32}
        rx={2}
        fill={color}
        transform={`rotate(${a}, ${cx}, ${cy})`}
      />
    );
  });
  return (
    <>
      {toothNodes}
      <Circle cx={cx} cy={cy} r={r} fill={color} stroke={palette.navy[500]} strokeWidth={1.5} />
      <Circle cx={cx} cy={cy} r={r * 0.36} fill={palette.navy[500]} opacity={0.18} />
    </>
  );
}

function ActionButton({
  onPress,
  label,
  accessibilityLabel,
  disabled,
}: {
  onPress: () => void;
  label: string;
  accessibilityLabel: string;
  disabled: boolean;
}) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.action,
        disabled && styles.actionDisabled,
        pressed && !disabled && styles.actionPressed,
      ]}
    >
      <Text style={styles.actionText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { width: "100%", gap: 8 },
  wrapSideBySide: { flexDirection: "row", alignItems: "center", gap: 16 },
  main: { width: "100%", gap: 8 },
  mainSideBySide: { width: undefined, flex: 1 },
  stage: { width: "100%" },
  hint: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: palette.charcoal[400],
    textAlign: "center",
    marginTop: 2,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 8 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: palette.gray[200],
    backgroundColor: palette.white,
  },
  chipIn: { fontFamily: fonts.bold, fontSize: 15, color: palette.charcoal[500] },
  chipOut: { fontFamily: fonts.bold, fontSize: 15, color: palette.darkCyan[500] },
  arrow: { fontFamily: fonts.regular, fontSize: 14, color: palette.charcoal[300] },
  sectionLabel: {
    fontFamily: fonts.bold,
    fontSize: 11.5,
    letterSpacing: 1,
    color: palette.charcoal[400],
    textTransform: "uppercase",
    textAlign: "center",
    marginTop: 6,
  },
  testRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    flexWrap: "wrap",
  },
  testResult: {
    fontFamily: fonts.medium,
    fontSize: 13,
    color: palette.charcoal[400],
    textAlign: "center",
  },
  box: {
    minWidth: 150,
    minHeight: 54,
    borderWidth: 2,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  boxText: { fontFamily: fonts.bold, fontSize: 26 },
  boxPlaceholder: { fontFamily: fonts.regular, fontSize: 18 },
  pad: { maxWidth: 360, alignSelf: "center", marginTop: 4 },
  padSideBySide: { width: "44%", maxWidth: 300, marginTop: 0 },
  action: {
    justifyContent: "center",
    minWidth: 72,
    paddingHorizontal: 18,
    paddingVertical: 13,
    borderRadius: 12,
    backgroundColor: palette.cyan[500],
  },
  actionDisabled: { opacity: 0.4 },
  actionPressed: { transform: [{ scale: 0.96 }] },
  actionText: {
    fontFamily: fonts.bold,
    fontSize: 14,
    lineHeight: 18,
    color: palette.white,
    textAlign: "center",
  },
});
