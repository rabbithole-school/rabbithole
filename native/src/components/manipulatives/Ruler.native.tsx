/**
 * Ruler (native) — the RN port of the web Ruler. Drag the free end of a bar
 * along a printed scale until the BAR measures the stated length. With a
 * non-zero `startAt` the bar begins partway along the ruler, so the number its
 * end lands on is NOT its length — the broken-ruler case the kind exists for
 * (see the `RulerSpec` doc comment in vendor/manipulative/types.ts).
 *
 * The drag is a single-axis snap, so this uses the shared kit's
 * `useMovableHandle` with `snapIncrement` directly — the same feel (grab
 * squish, per-gradation tick, release thud) every other linear kind has. All
 * the math is reused verbatim from the shared logic layer; this file owns only
 * pixels.
 */

import { useCallback, useMemo, useState } from "react";
import { StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import Svg, { Line, Rect, Text as SvgText } from "react-native-svg";

import {
  initialRuler,
  liveReadoutPolicy,
  rulerPrecision,
  rulerSnapEnd,
  rulerSolved,
  rulerStart,
} from "../../../vendor/manipulative/logic";
import type { RulerState } from "../../../vendor/manipulative/logic";
import type { RulerSpec } from "../../../vendor/manipulative/types";
import { CoordinatePlane, MovableHandleView, useMovableHandle, type KindProps, type Vec2 } from "./kit";
import { fonts, palette } from "@/theme";

/** Fixed internal x-span (web parity) so every ruler renders identically. */
const SCALE = 10;
const RULE_Y = 0;
const BAR_Y = 1.35;
const PAD = 0.55;
const HEIGHT = 200;
const VIEW_Y: [number, number] = [-1.5, 2.4];

export function RulerNative({ spec, onSolvedChange, onStateChange }: KindProps<RulerSpec, RulerState>) {
  const [width, setWidth] = useState(0);
  const precision = rulerPrecision(spec);
  const start = rulerStart(spec);

  const scaleLength = spec.length;
  const toInternal = useCallback((v: number) => (v / scaleLength) * SCALE, [scaleLength]);

  const [end, setEnd] = useState(() => initialRuler(spec).end);

  const viewBox = useMemo(() => ({ x: [-PAD, SCALE + PAD] as [number, number], y: VIEW_Y }), []);
  const plane = useMemo(() => new CoordinatePlane(viewBox, { width, height: HEIGHT }), [viewBox, width]);

  // The gradation expressed in the internal 0..SCALE space, so the kit's linear
  // snap ticks once per mark the shared `rulerSnapEnd` would land on.
  const snapInternal = (precision / scaleLength) * SCALE;

  // The worklet derives its own bounds from the three PRIMITIVES off the spec
  // rather than from the two locals above. Depending on a value computed by
  // another hook trips the React Compiler's "existing memoization could not be
  // preserved" check (React Compiler is ON for native), which silently opts the
  // whole component out of compilation.
  const constrain = useCallback(
    (p: Vec2): Vec2 => {
      "worklet";
      const min = (start / scaleLength) * SCALE;
      const step = (precision / scaleLength) * SCALE;
      let ix = p.x;
      if (ix < min) ix = min;
      if (ix > SCALE) ix = SCALE;
      const snapped = Math.round(ix / step) * step;
      return { x: snapped < min ? min : snapped > SCALE ? SCALE : snapped, y: BAR_Y };
    },
    [start, precision, scaleLength],
  );

  const report = useCallback(
    (p: Vec2) => {
      const next = rulerSnapEnd(spec, (p.x / SCALE) * scaleLength);
      setEnd(next);
      onSolvedChange(rulerSolved(spec, { end: next }));
      onStateChange?.({ end: next });
    },
    [spec, scaleLength, onSolvedChange, onStateChange],
  );

  const handle = useMovableHandle({
    plane,
    initial: { x: toInternal(initialRuler(spec).end), y: BAR_Y },
    constrain,
    snapIncrement: snapInternal,
    snapAxis: "x",
    onChange: report,
    onSettled: report,
  });

  const wholeTicks = useMemo(() => {
    const out: number[] = [];
    for (let v = 0; v <= spec.length + 1e-9; v += 1) out.push(Math.round(v));
    return out;
  }, [spec.length]);
  const subTicks = useMemo(() => {
    const out: Array<{ v: number; major: boolean }> = [];
    if (precision >= 1) return out;
    for (let v = precision; v < spec.length - 1e-9; v += precision) {
      const rounded = Math.round(v / precision) * precision;
      if (Math.abs(rounded - Math.round(rounded)) < 1e-9) continue;
      out.push({ v: rounded, major: Math.abs(((rounded * 2) % 2) - 1) < 1e-9 });
    }
    return out;
  }, [precision, spec.length]);

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);
  const px = (v: number) => plane.x(toInternal(v));
  const length = end - start;
  const showLength = liveReadoutPolicy(spec).showValue;

  return (
    <View style={styles.wrap}>
      <View style={[styles.stage, { height: HEIGHT }]} onLayout={onLayout}>
        {width > 0 && (
          <>
            <Svg width={width} height={HEIGHT}>
              {/* the ruler's body */}
              <Rect
                x={plane.x(0)}
                y={plane.y(RULE_Y)}
                width={plane.x(SCALE) - plane.x(0)}
                height={plane.y(RULE_Y - 0.75) - plane.y(RULE_Y)}
                fill={palette.white}
                stroke={palette.gray[200]}
                strokeWidth={2}
              />
              <Line
                x1={plane.x(0)}
                y1={plane.y(RULE_Y)}
                x2={plane.x(SCALE)}
                y2={plane.y(RULE_Y)}
                stroke={palette.navy[500]}
                strokeWidth={2.5}
              />
              {subTicks.map(({ v, major }) => (
                <Line
                  key={`sub-${v}`}
                  x1={px(v)}
                  y1={plane.y(RULE_Y)}
                  x2={px(v)}
                  y2={plane.y(RULE_Y - (major ? 0.3 : 0.19))}
                  stroke={palette.charcoal[500]}
                  strokeWidth={1.4}
                />
              ))}
              {wholeTicks.map((v) => (
                <Line
                  key={`whole-${v}`}
                  x1={px(v)}
                  y1={plane.y(RULE_Y)}
                  x2={px(v)}
                  y2={plane.y(RULE_Y - 0.46)}
                  stroke={palette.navy[500]}
                  strokeWidth={2}
                />
              ))}
              {wholeTicks.map((v) => (
                <SvgText
                  key={`label-${v}`}
                  x={px(v)}
                  y={plane.y(RULE_Y - 1.1)}
                  fontSize={15}
                  fontFamily={fonts.medium}
                  fill={palette.charcoal[500]}
                  textAnchor="middle"
                >
                  {String(v)}
                </SvgText>
              ))}

              {/* the bar being measured, laid ALONGSIDE the ruler */}
              <Line
                x1={px(start)}
                y1={plane.y(BAR_Y)}
                x2={px(end)}
                y2={plane.y(BAR_Y)}
                stroke={palette.violet[500]}
                strokeWidth={16}
                opacity={0.28}
              />
              <Line
                x1={px(start)}
                y1={plane.y(BAR_Y)}
                x2={px(end)}
                y2={plane.y(BAR_Y)}
                stroke={palette.violet[500]}
                strokeWidth={3}
              />
              <Line
                x1={px(start)}
                y1={plane.y(BAR_Y - 0.34)}
                x2={px(start)}
                y2={plane.y(BAR_Y + 0.34)}
                stroke={palette.violet[500]}
                strokeWidth={3}
              />
              {/* drop lines to the scale, so the pinned start is unmissable */}
              <Line
                x1={px(start)}
                y1={plane.y(RULE_Y)}
                x2={px(start)}
                y2={plane.y(BAR_Y)}
                stroke={palette.violet[500]}
                strokeWidth={1.2}
                opacity={0.5}
              />
              <Line
                x1={px(end)}
                y1={plane.y(RULE_Y)}
                x2={px(end)}
                y2={plane.y(BAR_Y)}
                stroke={palette.violet[500]}
                strokeWidth={1.2}
                opacity={0.5}
              />
            </Svg>
            <MovableHandleView
              handle={handle}
              color={palette.violet[500]}
              ringColor={palette.white}
              accessibilityLabel="ruler bar end"
            />
          </>
        )}
      </View>
      {/* The readout states the SUBTRACTION, never just the answer — it is the
          sentence the broken ruler is teaching (web parity). */}
      {/* The subtraction FRAME with its result withheld when the goal names the
          length — printing it performs the `end − start` the scholar was asked
          to do. Web parity; see `liveReadoutPolicy`. */}
      <Text style={styles.readout}>
        {trim(end)} − {trim(start)} = {showLength ? trim(length) : "?"} {spec.unit} long
      </Text>
    </View>
  );
}

function trim(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

const styles = StyleSheet.create({
  wrap: { width: "100%", gap: 6 },
  stage: { width: "100%", position: "relative", overflow: "visible" },
  readout: {
    fontFamily: fonts.bold,
    fontSize: 15,
    color: palette.charcoal[500],
    textAlign: "center",
    backgroundColor: palette.gray[50],
    borderRadius: 10,
    paddingVertical: 6,
  },
});
