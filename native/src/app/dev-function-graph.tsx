/**
 * Function-graph gallery on iPad — reach it at the `/dev-function-graph` route
 * (deep link `native:///dev-function-graph`). Mounts every `functionGraph`
 * demo spec (two per goal, a flip, a hole) through the real native renderer, with the live
 * state JSON and the optimistic solved flag under each board, then the
 * display-only `functionPlot` prompt visuals and a complex-plane coordinate
 * plane. The quickest way to review the kind on a simulator.
 *
 * Deliberately Convex-FREE (no useQuery / no auth) so it renders even when
 * sign-in fails. The scroll view is gesture-handler's, wired into
 * ManipulativeScrollContext like the practice card, so a drag on a handle never
 * scrolls the page.
 */

import { useMemo, useRef, useState } from "react";
import { Stack } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { ScrollView } from "react-native-gesture-handler";

import { NativeManipulative } from "@/components/manipulatives/NativeManipulative";
import { ManipulativeScrollContext } from "@/components/manipulatives/kit";
import { PromptVisual } from "@/components/practice/PromptVisual";
import { fonts, useColors } from "@/theme";
import { FUNCTION_GRAPH_EXAMPLES } from "../../vendor/manipulative/functionGraphExamples";
import { goalText } from "../../vendor/manipulative/logic";
import type { ManipulativeSpec } from "../../vendor/manipulative/types";
import type { PracticePromptVisual } from "../../vendor/shared/practicePromptVisual";

const COMPLEX_PLANE: ManipulativeSpec = {
  kind: "coordinatePlane",
  id: "dev-complex-plane",
  concept: "The complex plane",
  prompt: "Plot 3 − 2i on the complex plane.",
  xMin: -5,
  xMax: 5,
  yMin: -5,
  yMax: 5,
  gridStep: 1,
  axisLabels: { x: "Re", y: "Im" },
  draggable: [{ start: { x: -1, y: 2 } }],
  goal: { type: "placePoint", x: 3, y: -2 },
};

const PLOTS: { label: string; spec: PracticePromptVisual }[] = [
  {
    label: "Two transforms, labelled points (vertex, intercept)",
    spec: {
      kind: "functionPlot",
      xMin: -6,
      xMax: 6,
      yMin: -6,
      yMax: 6,
      curves: [
        { form: "transform", parent: "quadratic", a: -1, h: 1, k: 4, label: "f" },
        { form: "transform", parent: "abs", a: 1, h: -2, k: -3, label: "g" },
      ],
      points: [
        { x: 1, y: 4, label: "V" },
        { x: 3, y: 0, label: "A" },
      ],
    },
  },
  {
    label: "Polynomial from zeros (real values), shaded interval",
    spec: {
      kind: "functionPlot",
      xMin: -5,
      xMax: 5,
      yMin: -8,
      yMax: 8,
      curves: [
        {
          form: "polynomial",
          zeros: [
            { x: -2, multiplicity: 1 },
            { x: 1, multiplicity: 2 },
          ],
          leading: 0.5,
        },
      ],
      shadeX: { from: -2, to: 1 },
    },
  },
  {
    label: "Rational with dashed asymptotes",
    spec: {
      kind: "functionPlot",
      xMin: -6,
      xMax: 6,
      yMin: -6,
      yMax: 6,
      curves: [{ form: "rational", rational: { vertical: [2], horizontal: 1, scale: 3 } }],
      asymptotes: { vertical: [2], horizontal: [1] },
    },
  },
  {
    label: "Inverses with the y = x mirror line (referenceLine)",
    spec: {
      kind: "functionPlot",
      xMin: -4,
      xMax: 8,
      yMin: -4,
      yMax: 8,
      curves: [
        { form: "transform", parent: "exp2", a: 1, h: 0, k: 0, label: "2^x" },
        { form: "transform", parent: "log2", a: 1, h: 0, k: 0, label: "log₂x" },
      ],
      referenceLine: "y=x",
    },
  },
  {
    label: "Flip left–right (b = −1): √x and √(−x), 2^(−x)",
    spec: {
      kind: "functionPlot",
      xMin: -6,
      xMax: 6,
      yMin: -2,
      yMax: 6,
      curves: [
        { form: "transform", parent: "sqrt", a: 1, h: 0, k: 0, label: "√x" },
        { form: "transform", parent: "sqrt", a: 1, h: 0, k: 0, b: -1, label: "√(−x)" },
        { form: "transform", parent: "exp2", a: 1, h: 0, k: 0, b: -1, label: "2^(−x)" },
      ],
    },
  },
  {
    label: "Domain endpoints: closed at −2, open at 3; arrows only where it keeps going",
    spec: {
      kind: "functionPlot",
      xMin: -6,
      xMax: 6,
      yMin: -6,
      yMax: 6,
      curves: [
        { form: "transform", parent: "quadratic", a: 0.5, h: 0, k: -3, domain: { from: -2, to: 3 } },
        { form: "transform", parent: "linear", a: -1, h: 0, k: 4 },
      ],
      points: [
        { x: -2, y: -1 },
        { x: 3, y: 1.5, open: true },
      ],
    },
  },
  {
    label: "Piecewise, three pieces (curves with domains + open/closed joins)",
    spec: {
      kind: "functionPlot",
      xMin: -6,
      xMax: 6,
      yMin: -4,
      yMax: 6,
      curves: [
        { form: "transform", parent: "linear", a: 1, h: 0, k: 3, domain: { to: -1 } },
        { form: "transform", parent: "quadratic", a: 1, h: 0, k: 0, domain: { from: -1, to: 2 } },
        { form: "transform", parent: "linear", a: 0, h: 0, k: -2, domain: { from: 2 } },
      ],
      points: [
        { x: -1, y: 2, open: true },
        { x: -1, y: 1 },
        { x: 2, y: 4 },
        { x: 2, y: -2, open: true },
      ],
    },
  },
  {
    label: "Polynomial sketch of y = (1/8)(x + 3)(x − 1)²(x − 4): no y numbers",
    spec: {
      kind: "functionPlot",
      xMin: -6,
      xMax: 6,
      yMin: -6,
      yMax: 6,
      curves: [
        {
          form: "polynomial",
          zeros: [
            { x: -3, multiplicity: 1 },
            { x: 1, multiplicity: 2 },
            { x: 4, multiplicity: 1 },
          ],
          leading: 0.125,
          sketch: true,
        },
      ],
    },
  },
  {
    label: "Rational with a removable hole at x = −1",
    spec: {
      kind: "functionPlot",
      xMin: -6,
      xMax: 6,
      yMin: -6,
      yMax: 6,
      curves: [{ form: "rational", rational: { vertical: [2], horizontal: 0, scale: 1, holes: [-1] } }],
      asymptotes: { vertical: [2], horizontal: [0] },
    },
  },
  {
    label: "Complex plane (coordinatePlane visual with Re / Im axes)",
    spec: {
      kind: "coordinatePlane",
      xMin: -5,
      xMax: 5,
      yMin: -5,
      yMax: 5,
      gridStep: 1,
      points: [{ x: 3, y: -2, label: "z" }],
      axisLabels: { x: "Re", y: "Im" },
    },
  },
];

function Board({ spec, styles }: { spec: ManipulativeSpec; styles: ReturnType<typeof makeStyles> }) {
  const [state, setState] = useState<unknown>(null);
  const [solved, setSolved] = useState(false);
  const [run, setRun] = useState(0);
  return (
    <View style={styles.card}>
      <Text style={styles.caseLabel}>{spec.id}</Text>
      <Text style={styles.prompt}>{spec.prompt}</Text>
      <Text style={styles.goal}>{goalText(spec)}</Text>
      <View style={styles.render}>
        <NativeManipulative key={run} spec={spec} onSolvedChange={setSolved} onStateChange={setState} />
      </View>
      <View style={styles.row}>
        <Text style={[styles.solved, { color: solved ? "#0a8f5a" : "#9a5b00" }]}>
          {solved ? "solved: true" : "solved: false"}
        </Text>
        <Pressable onPress={() => setRun((r) => r + 1)} style={styles.reset} accessibilityRole="button" accessibilityLabel={`reset ${spec.id}`}>
          <Text style={styles.resetText}>Reset</Text>
        </Pressable>
      </View>
      <Text style={styles.mono}>{JSON.stringify(state)}</Text>
    </View>
  );
}

export default function DevFunctionGraph() {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const scrollRef = useRef<ScrollView>(null);

  return (
    <>
      <Stack.Screen options={{ title: "Function graph" }} />
      <ManipulativeScrollContext.Provider value={scrollRef}>
        <ScrollView ref={scrollRef} style={styles.screen} contentContainerStyle={styles.content}>
          <Text style={styles.h1}>functionGraph manipulative</Text>
          <Text style={styles.sub}>
            Two demo specs per goal, plus a left–right flip and a hole. Drag the handles; the state JSON and the optimistic self-check update below each board.
          </Text>
          {FUNCTION_GRAPH_EXAMPLES.map((spec) => (
            <Board key={spec.id} spec={spec} styles={styles} />
          ))}
          <Board spec={COMPLEX_PLANE} styles={styles} />

          <Text style={styles.h2}>functionPlot prompt visual</Text>
          {PLOTS.map((p) => (
            <View key={p.label} style={styles.card}>
              <Text style={styles.caseLabel}>{p.label}</Text>
              <PromptVisual spec={p.spec} />
            </View>
          ))}
        </ScrollView>
      </ManipulativeScrollContext.Provider>
    </>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.bgSubtle },
    content: { padding: 20, gap: 14, paddingBottom: 80, maxWidth: 720, width: "100%", alignSelf: "center" },
    h1: { fontFamily: fonts.bold, fontSize: 22, color: c.fg },
    h2: { fontFamily: fonts.bold, fontSize: 18, color: c.fg, marginTop: 18 },
    sub: { fontFamily: fonts.regular, fontSize: 14, color: c.fgMuted, marginBottom: 6 },
    card: {
      backgroundColor: c.bg,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: c.border,
      padding: 16,
      gap: 8,
    },
    caseLabel: { fontFamily: fonts.semibold, fontSize: 13, color: c.fgMuted },
    prompt: { fontFamily: fonts.bold, fontSize: 18, color: c.navy },
    goal: { fontFamily: fonts.regular, fontSize: 13, color: c.fgMuted },
    render: { marginTop: 6, alignItems: "center" },
    row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    solved: { fontFamily: fonts.bold, fontSize: 15 },
    reset: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, borderWidth: 1, borderColor: c.border },
    resetText: { fontFamily: fonts.semibold, fontSize: 14, color: c.fg },
    mono: { fontFamily: fonts.mono, fontSize: 12, color: c.charcoalSubtle },
  });
}
