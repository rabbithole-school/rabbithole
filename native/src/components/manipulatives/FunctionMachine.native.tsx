/**
 * FunctionMachine (native) — the RN port of the web Function Machine. A hidden
 * rule (out = m·in + b) turns inputs into outputs; the scholar studies worked
 * examples, TESTS their own inputs to check a hypothesis, then COMMITS a
 * prediction for the un-worked query input. Isolates function/pattern inference
 * — "find the rule from examples," the seed of algebraic thinking.
 *
 * The web version has nothing to manipulate in-canvas — its verdict flows
 * through the shared typed-`answer` frame. The native spike has no such typed
 * frame, so (per the brief: "feed inputs, see outputs, commit a guess") this
 * adds two Steppers: a feeder that runs `applyFunctionMachineRule` on any input
 * (the query input's true output stays hidden, to preserve the challenge) and a
 * prediction the scholar commits. The verdict uses `functionMachineSolved`
 * verbatim from the shared logic layer.
 */

import { useState } from "react";
import { StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import Svg, { Circle, Path, Rect, Text as SvgText } from "react-native-svg";

import {
  applyFunctionMachineRule,
  functionMachineSolved,
  initialFunctionMachine,
} from "../../../vendor/manipulative/logic";
import type { FunctionMachineState } from "../../../vendor/manipulative/logic";
import { isChallenge, type FunctionMachineSpec } from "../../../vendor/manipulative/types";
import { lightImpact, selectionTick, type KindProps } from "./kit";
import { Stepper } from "./Stepper";
import { fonts, palette } from "@/theme";

const VBW = 520;
const VBH = 200;
const HOPPER_X = 78;
const MACHINE_X = 260;
const TRAY_X = 442;
const MID_Y = 104;

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
}: KindProps<FunctionMachineSpec, FunctionMachineState>) {
  const [width, setWidth] = useState(0);
  const [testInput, setTestInput] = useState(spec.examples[0]?.in ?? 0);
  const [ranOutput, setRanOutput] = useState<number | null>(null);
  const [testedQuery, setTestedQuery] = useState(false);
  const [guess, setGuess] = useState(0);
  const [predicted, setPredicted] = useState<number | null>(
    () => initialFunctionMachine().predicted,
  );

  const svgHeight = width > 0 ? (width * VBH) / VBW : 0;
  // Control-of-error, mirroring web: the web FunctionMachine has NO in-canvas
  // verdict — correctness flows only through the frame's Done/typed-answer
  // path. So for a challenge, committing a prediction here NEVER reveals
  // correct/incorrect inline; it just loads the guess as the state the Done
  // button submits. (A free-explore machine, if one ever exists, still shows
  // the live verdict.)
  const challenge = isChallenge(spec);

  const run = () => {
    selectionTick();
    if (testInput === spec.queryInput) {
      // Don't reveal the very output the scholar must predict.
      setRanOutput(null);
      setTestedQuery(true);
      return;
    }
    setTestedQuery(false);
    setRanOutput(applyFunctionMachineRule(spec.rule, testInput));
  };

  const check = () => {
    lightImpact();
    setPredicted(guess);
    onSolvedChange(functionMachineSolved(spec, { predicted: guess }));
    onStateChange?.({ predicted: guess });
  };

  const verdict =
    predicted == null
      ? null
      : functionMachineSolved(spec, { predicted })
        ? "correct"
        : "wrong";

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  const hopperValue =
    ranOutput != null || testedQuery ? String(testInput) : "in";
  const trayValue = testedQuery ? "?" : ranOutput != null ? String(ranOutput) : "out";

  return (
    <View style={styles.wrap}>
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
            <Text style={styles.chipIn}>{ex.in}</Text>
            <Text style={styles.arrow}>→</Text>
            <Text style={styles.chipOut}>{ex.out}</Text>
          </View>
        ))}
      </View>

      {/* test the machine on your own inputs */}
      <Text style={styles.sectionLabel}>Test the machine</Text>
      <View style={styles.testRow}>
        <Stepper value={testInput} min={-10} max={20} label="in" onChange={setTestInput} />
        <RunButton onPress={run} />
      </View>
      <Text style={styles.testResult}>
        {testedQuery
          ? `${spec.queryInput} is the one you must predict — try others.`
          : ranOutput != null
            ? `${testInput} → ${ranOutput}`
            : "Pick an input and run it."}
      </Text>

      {/* commit a prediction for the query input */}
      <Text style={styles.sectionLabel}>
        Your prediction for {spec.queryInput}
      </Text>
      <View style={styles.testRow}>
        <Stepper value={guess} min={-20} max={200} label="out" onChange={setGuess} />
        <CheckButton onPress={check} />
      </View>
      {predicted != null &&
        (challenge ? (
          <Text style={[styles.verdict, { color: palette.charcoal[400] }]}>
            Prediction set — tap Done.
          </Text>
        ) : (
          <Text
            style={[
              styles.verdict,
              { color: verdict === "correct" ? palette.green[600] : palette.orange[600] },
            ]}
          >
            {verdict === "correct"
              ? `Correct — ${spec.queryInput} → ${predicted} ✓`
              : "Not quite — study the examples again."}
          </Text>
        ))}
    </View>
  );
}

function NumberChip({ x, y, label, color }: { x: number; y: number; label: string; color: string }) {
  return (
    <>
      <Rect x={x - 26} y={y - 17} width={52} height={34} rx={9} fill={wash(color, 0.9)} stroke={palette.navy[500]} strokeWidth={1.5} />
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

function RunButton({ onPress }: { onPress: () => void }) {
  return <ActionButton onPress={onPress} label="Run ▶" tone="cyan" />;
}
function CheckButton({ onPress }: { onPress: () => void }) {
  return <ActionButton onPress={onPress} label="Check" tone="violet" />;
}

function ActionButton({ onPress, label, tone }: { onPress: () => void; label: string; tone: "cyan" | "violet" }) {
  const bg = tone === "cyan" ? palette.cyan[500] : palette.violet[500];
  return (
    <View style={styles.actionWrap}>
      <Text
        accessibilityRole="button"
        onPress={onPress}
        style={[styles.action, { backgroundColor: bg }]}
      >
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: "100%", gap: 8 },
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
  verdict: { fontFamily: fonts.bold, fontSize: 14, textAlign: "center", marginTop: 2 },
  actionWrap: { justifyContent: "center" },
  action: {
    fontFamily: fonts.bold,
    fontSize: 14,
    lineHeight: 18,
    color: palette.white,
    paddingHorizontal: 18,
    paddingVertical: 13,
    borderRadius: 12,
    overflow: "hidden",
    textAlign: "center",
    minWidth: 72,
  },
});
