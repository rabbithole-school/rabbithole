/**
 * Riemann (native) — the RN port of the web Mafs Riemann. Speed over time
 * becomes distance as area: the left-sum bars sit a little under the speed line,
 * and adding bars shrinks the leftover gaps. The bar count is stepped (no drag —
 * a discrete count, so a Stepper matches the semantics better than a slider on a
 * touch screen), and the speed line is drawn as an Svg Path by SAMPLING
 * `speedAt` exactly as the web version graphs it.
 *
 * All the math is reused verbatim from the shared logic layer (`speedAt`,
 * `trueArea`, `leftSumArea`, `riemannSolved`, `initialRiemann`, `clamp`); this
 * file owns only pixels + the stepper.
 */

import { useMemo, useState } from "react";
import { StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import Svg, { Line, Path, Rect, Text as SvgText } from "react-native-svg";

import {
  initialRiemann,
  leftSumArea,
  riemannSolved,
  speedAt,
  trueArea,
} from "../../../vendor/manipulative/logic";
import type { KindProps } from "./kit";
import { CoordinatePlane } from "./kit";
import type { RiemannSpec } from "../../../vendor/manipulative/types";
import { Stepper } from "./Stepper";
import { fonts, palette } from "@/theme";

const HEIGHT = 260;
const PAD_X = 0.35;
const PAD_Y = 0.4;
const CURVE_SAMPLES = 48; // enough that a straight or sloped line reads smooth

export function RiemannNative({
  spec,
  onSolvedChange,
  onStateChange,
}: KindProps<RiemannSpec, { bars: number }>) {
  const minBars = spec.minBars ?? 1;
  const maxBars = spec.maxBars ?? 20;

  const [width, setWidth] = useState(0);
  const [bars, setBars] = useState(() => initialRiemann(spec).bars);

  const dt = spec.tMax / bars;
  const estimate = leftSumArea(spec, bars);
  const target = trueArea(spec);
  const yMax =
    Math.max(speedAt(spec, 0), speedAt(spec, spec.tMax), spec.intercept, 1) + 1;

  const viewBox = useMemo(
    () => ({
      x: [-PAD_X, spec.tMax + PAD_X] as [number, number],
      y: [-PAD_Y, yMax + PAD_Y] as [number, number],
    }),
    [spec.tMax, yMax],
  );
  const plane = useMemo(
    () => new CoordinatePlane(viewBox, { width, height: HEIGHT }),
    [viewBox, width],
  );

  const setBarCount = (v: number) => {
    setBars(v);
    onSolvedChange(riemannSolved(spec, { bars: v }));
    onStateChange?.({ bars: v });
  };

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  // Sample the speed line into an Svg path (the RN analogue of Mafs's
  // Line.Segment — sampling keeps it correct even if the rule ever curves).
  let curve = "";
  if (width > 0) {
    for (let i = 0; i <= CURVE_SAMPLES; i++) {
      const t = (i / CURVE_SAMPLES) * spec.tMax;
      const px = plane.x(t);
      const py = plane.y(Math.max(0, speedAt(spec, t)));
      curve += `${i === 0 ? "M" : "L"} ${px.toFixed(2)} ${py.toFixed(2)} `;
    }
  }

  const barRects: React.ReactNode[] = [];
  if (width > 0) {
    for (let i = 0; i < bars; i++) {
      const x0 = i * dt;
      const x1 = (i + 1) * dt;
      const h = Math.max(0, speedAt(spec, x0));
      barRects.push(
        <Rect
          key={`bar-${i}`}
          x={plane.x(x0)}
          y={plane.y(h)}
          width={(x1 - x0) * plane.pxPerX}
          height={h * plane.pxPerY}
          fill={palette.cyan[500]}
          fillOpacity={0.33}
          stroke={palette.cyan[600]}
          strokeWidth={1.2}
        />,
      );
    }
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.stage} onLayout={onLayout}>
        {width > 0 && (
          <Svg width={width} height={HEIGHT}>
            {/* axes */}
            <Line
              x1={plane.x(0)}
              y1={plane.y(0)}
              x2={plane.x(spec.tMax)}
              y2={plane.y(0)}
              stroke={palette.charcoal[400]}
              strokeWidth={1.5}
            />
            <Line
              x1={plane.x(0)}
              y1={plane.y(0)}
              x2={plane.x(0)}
              y2={plane.y(yMax)}
              stroke={palette.charcoal[400]}
              strokeWidth={1.5}
            />
            {barRects}
            {/* the speed line */}
            <Path
              d={curve}
              fill="none"
              stroke={palette.violet[500]}
              strokeWidth={4}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <SvgText
              x={plane.x(spec.tMax * 0.72)}
              y={plane.y(Math.min(yMax - 0.4, speedAt(spec, spec.tMax) + 0.5))}
              fontSize={15}
              fontFamily={fonts.semibold}
              fill={palette.navy[500]}
            >
              speed
            </SvgText>
            <SvgText
              x={plane.x(spec.tMax * 0.82)}
              y={plane.y(0) + 18}
              fontSize={14}
              fontFamily={fonts.medium}
              fill={palette.charcoal[500]}
            >
              time
            </SvgText>
          </Svg>
        )}
      </View>

      <View style={styles.readoutRow}>
        <Text style={styles.barCount}>{bars} left-sum bars</Text>
        <Text style={styles.estimate}>
          Distance ≈ {estimate.toFixed(1)} sq
        </Text>
      </View>
      <Text style={styles.target}>True distance = {target.toFixed(1)} sq</Text>

      <Stepper
        value={bars}
        min={minBars}
        max={maxBars}
        label="bars"
        onChange={setBarCount}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: "100%", gap: 10 },
  stage: { width: "100%", height: HEIGHT },
  readoutRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
  },
  barCount: {
    fontFamily: fonts.bold,
    fontSize: 14,
    color: palette.violet[600],
  },
  estimate: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: palette.charcoal[400],
  },
  target: {
    fontFamily: fonts.medium,
    fontSize: 12,
    color: palette.charcoal[400],
    textAlign: "center",
  },
});
