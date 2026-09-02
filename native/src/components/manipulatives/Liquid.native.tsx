/**
 * Liquid (native) — the RN port of the web Liquid. Pour into graduated jars by
 * dragging the surface of the liquid, which snaps to the marks printed on the
 * jar. The capacity sibling of the ruler: an amount read off a scale.
 *
 * The jars share ONE vertical scale (same px-per-unit; only the HEIGHT
 * differs), so a 4-cup jar is visibly twice a 2-cup jar and "which holds more"
 * is answerable by looking — drawing each to a uniform box would make the
 * levels incomparable and quietly destroy the measurement idea.
 *
 * Each jar owns its own vertical `useMovableHandle` over a 1-wide math plane,
 * so pouring gets the shared kit feel (grab squish, per-gradation tick, release
 * thud) that every other draggable kind has.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import Svg, { Line, Rect, Text as SvgText } from "react-native-svg";

import {
  initialLiquid,
  liquidPxPerUnit,
  liquidSnapLevel,
  liquidSolved,
  liquidStep,
  liquidTotal,
  liquidUnitLabel,
  liveReadoutPolicy,
} from "../../../vendor/manipulative/logic";
import type { LiquidState } from "../../../vendor/manipulative/logic";
import type { LiquidSpec } from "../../../vendor/manipulative/types";
import { CoordinatePlane, MovableHandleView, useMovableHandle, type KindProps, type Vec2 } from "./kit";
import { fonts, palette } from "@/theme";

/** Jar drawing box. Heights come from the SHARED per-spec scale
 *  (`liquidPxPerUnit`), never a per-jar clamp — see its doc comment. */
const JAR_WIDTH = 92;
const RIM = 14; // headroom above the "full" line, so a full jar isn't clipped

export function LiquidNative({ spec, onSolvedChange, onStateChange }: KindProps<LiquidSpec, LiquidState>) {
  const [levels, setLevels] = useState<number[]>(() => initialLiquid(spec).levels);
  // The live levels mirrored into a ref, so `setLevel` can read the previous
  // value WITHOUT a functional setState updater. React may run an updater
  // during the render phase and requires it to be pure; `onStateChange` sets
  // state on an ancestor (`NativeManipulativeItem`), so calling it from inside
  // one is the "Cannot update a component while rendering a different
  // component" hazard — and React Compiler is ON for native, which assumes
  // update-phase purity for its memoization. Web parity: the same fix in
  // `LiquidManipulative.tsx`.
  const levelsRef = useRef(levels);

  const setLevel = useCallback(
    (i: number, level: number) => {
      const prev = levelsRef.current;
      if (Math.abs((prev[i] ?? 0) - level) < 1e-9) return;
      const next = prev.map((l, j) => (j === i ? level : l));
      levelsRef.current = next;
      setLevels(next);
      onSolvedChange(liquidSolved(spec, { levels: next }));
      onStateChange?.({ levels: next });
    },
    [spec, onSolvedChange, onStateChange],
  );

  const total = liquidTotal(spec, { levels });
  const showAmounts = liveReadoutPolicy(spec).showValue;

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        {spec.vessels.map((vessel, i) => (
          <Jar
            key={i}
            spec={spec}
            index={i}
            level={levels[i] ?? 0}
            showLevel={showAmounts}
            onLevel={(v) => setLevel(i, v)}
          />
        ))}
      </View>
      {/* Withheld under a challenge — both liquid goals NAME their amount, so a
          live total turns "read the jar's marks" into "pour until the number
          matches". Web parity; see `liveReadoutPolicy`. */}
      {spec.vessels.length > 1 && showAmounts && (
        <Text style={styles.total}>
          {trim(total)} {liquidUnitLabel(spec.unit, total)} altogether
        </Text>
      )}
    </View>
  );
}

function Jar({
  spec,
  index,
  level,
  showLevel,
  onLevel,
}: {
  spec: LiquidSpec;
  index: number;
  level: number;
  /** Whether the jar may print its own level — false when the goal names it. */
  showLevel: boolean;
  onLevel: (level: number) => void;
}) {
  const vessel = spec.vessels[index];
  const step = liquidStep(spec);
  const capacity = vessel.capacity;
  // Every jar in the spec shares ONE px-per-unit, so a 4-cup jar draws exactly
  // twice a 2-cup jar (see `liquidPxPerUnit`).
  const bodyHeight = capacity * liquidPxPerUnit(spec);
  const boxHeight = bodyHeight + RIM;
  const [measuredWidth, setMeasuredWidth] = useState(JAR_WIDTH);

  // A 1-wide math plane whose y axis IS the jar's capacity, so the handle drags
  // directly in "cups" and the kit's snap increment is the jar's gradation.
  const viewBox = useMemo(
    () => ({
      x: [0, 1] as [number, number],
      // The rim headroom is expressed in capacity units so the plane and the
      // drawn SVG agree on where "full" sits.
      y: [0, capacity * (boxHeight / bodyHeight)] as [number, number],
    }),
    [capacity, boxHeight, bodyHeight],
  );
  const plane = useMemo(
    () => new CoordinatePlane(viewBox, { width: measuredWidth, height: boxHeight }),
    [viewBox, measuredWidth, boxHeight],
  );

  const constrain = useCallback(
    (p: Vec2): Vec2 => {
      "worklet";
      let v = p.y;
      if (v < 0) v = 0;
      if (v > capacity) v = capacity;
      const snapped = Math.round(v / step) * step;
      const clamped = snapped < 0 ? 0 : snapped > capacity ? capacity : snapped;
      // The handle rides at the right-hand lip of the meniscus.
      return { x: 0.94, y: clamped };
    },
    [capacity, step],
  );

  const report = useCallback(
    (p: Vec2) => onLevel(liquidSnapLevel(spec, index, p.y)),
    [onLevel, spec, index],
  );

  const handle = useMovableHandle({
    plane,
    initial: { x: 0.94, y: level },
    constrain,
    snapIncrement: step,
    snapAxis: "y",
    onChange: report,
    onSettled: report,
  });

  const marks: number[] = [];
  for (let v = step; v < capacity - 1e-9; v += step) marks.push(Math.round(v / step) * step);
  const y = (units: number) => plane.y(units);
  const fillTop = y(level);
  const base = y(0);

  const onLayout = (e: LayoutChangeEvent) => setMeasuredWidth(e.nativeEvent.layout.width);

  return (
    <View style={styles.jarCol}>
      <View style={[styles.jarStage, { width: JAR_WIDTH, height: boxHeight }]} onLayout={onLayout}>
        <Svg width={measuredWidth} height={boxHeight}>
          {/* the liquid, drawn first so the glass and marks sit over it */}
          <Rect x={4} y={fillTop} width={measuredWidth - 8} height={Math.max(0, base - fillTop)} fill={palette.cyan[100]} />
          {level > 0 && (
            <Line x1={4} y1={fillTop} x2={measuredWidth - 4} y2={fillTop} stroke={palette.darkCyan[500]} strokeWidth={3} />
          )}
          {/* the glass */}
          <Line x1={2} y1={y(capacity) - RIM * 0.6} x2={2} y2={base} stroke={palette.navy[500]} strokeWidth={2.5} />
          <Line x1={measuredWidth - 2} y1={y(capacity) - RIM * 0.6} x2={measuredWidth - 2} y2={base} stroke={palette.navy[500]} strokeWidth={2.5} />
          <Line x1={2} y1={base} x2={measuredWidth - 2} y2={base} stroke={palette.navy[500]} strokeWidth={2.5} />
          {/* gradations: every mark short, whole units long + labelled */}
          {marks.map((v) => {
            const whole = Math.abs(v - Math.round(v)) < 1e-9;
            return (
              <Line
                key={`mark-${v}`}
                x1={2}
                y1={y(v)}
                x2={2 + (whole ? 22 : 12)}
                y2={y(v)}
                stroke={palette.charcoal[500]}
                strokeWidth={whole ? 2 : 1.2}
                opacity={0.8}
              />
            );
          })}
          {marks
            .filter((v) => Math.abs(v - Math.round(v)) < 1e-9)
            .map((v) => (
              <SvgText key={`label-${v}`} x={28} y={y(v) + 4} fontSize={12} fontFamily={fonts.bold} fill={palette.charcoal[500]}>
                {String(v)}
              </SvgText>
            ))}
          {/* the FULL line, named so capacity reads as a fact of the jar */}
          <Line
            x1={2}
            y1={y(capacity)}
            x2={measuredWidth - 2}
            y2={y(capacity)}
            stroke={palette.navy[500]}
            strokeWidth={2}
            strokeDasharray="5,4"
            opacity={0.65}
          />
          <SvgText
            x={measuredWidth - 6}
            y={y(capacity) - 6}
            textAnchor="end"
            fontSize={11}
            fontFamily={fonts.bold}
            fill={palette.navy[500]}
          >
            {String(capacity)}
          </SvgText>
        </Svg>
        <MovableHandleView
          handle={handle}
          color={palette.darkCyan[500]}
          ringColor={palette.white}
          radius={11}
          accessibilityLabel={`${vessel.label ?? `jar ${index + 1}`} liquid level`}
        />
      </View>
      <Text style={styles.jarLabel}>{vessel.label ?? `Jar ${index + 1}`}</Text>
      {showLevel && <Text style={styles.jarLevel}>{trim(level)}</Text>}
    </View>
  );
}

function trim(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

const styles = StyleSheet.create({
  wrap: { width: "100%", gap: 10, alignItems: "center" },
  row: { flexDirection: "row", justifyContent: "center", alignItems: "flex-end", gap: 16 },
  jarCol: { alignItems: "center", gap: 4 },
  jarStage: { position: "relative", overflow: "visible" },
  jarLabel: { fontFamily: fonts.bold, fontSize: 13, color: palette.charcoal[400], textAlign: "center" },
  jarLevel: { fontFamily: fonts.bold, fontSize: 18, color: palette.navy[500] },
  total: { fontFamily: fonts.bold, fontSize: 16, color: palette.navy[500], textAlign: "center" },
});
