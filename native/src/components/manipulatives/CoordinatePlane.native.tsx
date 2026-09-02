/**
 * CoordinatePlane (native) — the RN port of the web Mafs CoordinatePlane: drag
 * 1-3 points onto a real x/y grid (first-quadrant or four-quadrant), snapped
 * to `gridStep` on BOTH axes. The 2D sibling of NumberLine.native — same kit
 * vocabulary (CoordinatePlane pixel mapping + useMovableHandle), but genuinely
 * 2D rather than a squished 1D axis.
 *
 * Up to 3 draggable points are supported, so `useMovableHandle` (a hook) is
 * called an UNCONDITIONAL fixed 3 times (rules of hooks) — only the first
 * `spec.draggable.length` are rendered/reported, the rest sit inert. Each
 * handle snaps on BOTH axes, so (like Array.native) the kit's built-in
 * single-axis snap-tick can't drive it: a `useAnimatedReaction` per handle
 * watches its rounded (x,y) pair and fires the SAME shared selection tick
 * (`handle.snapTick()`) on any crossing — haptics + the audio tick from the
 * kit, no bespoke per-kind feel.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import Svg, { Circle, Line, Text as SvgText } from "react-native-svg";
import { runOnJS, useAnimatedReaction } from "react-native-reanimated";

import {
  coordinatePlaneSolved,
  initialCoordinatePlane,
} from "../../../vendor/manipulative/logic";
import type { CoordinatePlaneState } from "../../../vendor/manipulative/logic";
import type { CoordinatePlaneSpec } from "../../../vendor/manipulative/types";
import {
  CoordinatePlane as MathPlane,
  MovableHandleView,
  useMovableHandle,
  type KindProps,
  type Vec2,
} from "./kit";
import { fonts, palette } from "@/theme";

const MAX_SIZE = 340; // cap the plane so side-by-side layout stays sane
const HANDLE_COLORS = [palette.violet[500], palette.orange[500], palette.cyan[600]] as const;

export function CoordinatePlaneNative({
  spec,
  onSolvedChange,
  onStateChange,
}: KindProps<CoordinatePlaneSpec, CoordinatePlaneState>) {
  const { xMin, xMax, yMin, yMax, gridStep } = spec;
  const count = spec.draggable.length;

  const [boxW, setBoxW] = useState(0);
  // Not React state — this component never re-renders off it (the SVG reads
  // live handle positions directly); a ref just carries the last-reported
  // point set forward so `reportAt` can update ONE index immutably.
  const stateRef = useRef<CoordinatePlaneState>(initialCoordinatePlane(spec));

  const pad = gridStep * 0.75;
  const unitsX = xMax - xMin + 2 * pad;
  const unitsY = yMax - yMin + 2 * pad;
  const cap = boxW > 0 ? Math.min(boxW, MAX_SIZE) : 0;
  const cell = cap > 0 ? cap / Math.max(unitsX, unitsY) : 0;
  const planeW = cell * unitsX;
  const planeH = cell * unitsY;

  const viewBox = useMemo(
    () => ({ x: [xMin - pad, xMax + pad] as [number, number], y: [yMin - pad, yMax + pad] as [number, number] }),
    [xMin, xMax, yMin, yMax, pad],
  );
  const plane = useMemo(() => new MathPlane(viewBox, { width: planeW, height: planeH }), [viewBox, planeW, planeH]);

  // constrain: snap BOTH axes to gridStep and clamp into range — a worklet (UI
  // thread). Inlined (a worklet can't call the imported JS `snapToGrid`, which
  // is reused verbatim in `initialCoordinatePlane` on the JS side).
  const constrain = useCallback(
    (p: Vec2): Vec2 => {
      "worklet";
      let x = xMin + Math.round((p.x - xMin) / gridStep) * gridStep;
      let y = yMin + Math.round((p.y - yMin) / gridStep) * gridStep;
      x = x < xMin ? xMin : x > xMax ? xMax : x;
      y = y < yMin ? yMin : y > yMax ? yMax : y;
      return { x, y };
    },
    [xMin, xMax, yMin, yMax, gridStep],
  );

  const reportAt = useCallback(
    (index: number, x: number, y: number) => {
      const points = stateRef.current.points.map((p, i) => (i === index ? { x, y } : p));
      stateRef.current = { points };
      onSolvedChange(coordinatePlaneSolved(spec, { points }));
      onStateChange?.({ points });
    },
    [spec, onSolvedChange, onStateChange],
  );

  // Always call the hook 3 times (never conditionally) — index i is only
  // wired live when i < count; the rest sit inert at the first point's start.
  const starts: Vec2[] = [0, 1, 2].map((i) => spec.draggable[i]?.start ?? spec.draggable[0].start);
  const handle0 = useMovableHandle({ plane, initial: starts[0], constrain });
  const handle1 = useMovableHandle({ plane, initial: starts[1], constrain });
  const handle2 = useMovableHandle({ plane, initial: starts[2], constrain });
  const allHandles = [handle0, handle1, handle2];

  // Destructure each handle's SharedValues and snapTick OUT of the handle
  // object before the worklets below. A worklet serializes everything its
  // closure captures, and a handle also carries its Pan `gesture` — which
  // Worklets cannot copy, so touching `handleN.mx.value` (or
  // `runOnJS(handleN.snapTick)`) inside a worklet throws
  // "[Worklets] Cannot copy value of type `PanGesture`". In a Release build RN
  // escalates that to RCTFatal -> abort(), so the app hard-crashes the moment
  // this manipulative renders. Capturing the pieces directly keeps the gesture
  // out of the closure.
  const { mx: mx0, my: my0, snapTick: snapTick0 } = handle0;
  const { mx: mx1, my: my1, snapTick: snapTick1 } = handle1;
  const { mx: mx2, my: my2, snapTick: snapTick2 } = handle2;

  // Watch each handle's rounded (x,y) pair and report (+ the shared selection
  // tick) whenever either coordinate crosses — same idiom as Array.native's 2D
  // corner, just three times over. Reactions for inert handles (i >= count)
  // simply never see their static position change.
  useAnimatedReaction(
    () => ({
      x: xMin + Math.round((mx0.get() - xMin) / gridStep) * gridStep,
      y: yMin + Math.round((my0.get() - yMin) / gridStep) * gridStep,
    }),
    (curr, prev) => {
      if (count < 1) return;
      if (prev !== null && (curr.x !== prev.x || curr.y !== prev.y)) {
        runOnJS(snapTick0)();
        runOnJS(reportAt)(0, curr.x, curr.y);
      }
    },
    [count, xMin, yMin, gridStep, reportAt],
  );
  useAnimatedReaction(
    () => ({
      x: xMin + Math.round((mx1.get() - xMin) / gridStep) * gridStep,
      y: yMin + Math.round((my1.get() - yMin) / gridStep) * gridStep,
    }),
    (curr, prev) => {
      if (count < 2) return;
      if (prev !== null && (curr.x !== prev.x || curr.y !== prev.y)) {
        runOnJS(snapTick1)();
        runOnJS(reportAt)(1, curr.x, curr.y);
      }
    },
    [count, xMin, yMin, gridStep, reportAt],
  );
  useAnimatedReaction(
    () => ({
      x: xMin + Math.round((mx2.get() - xMin) / gridStep) * gridStep,
      y: yMin + Math.round((my2.get() - yMin) / gridStep) * gridStep,
    }),
    (curr, prev) => {
      if (count < 3) return;
      if (prev !== null && (curr.x !== prev.x || curr.y !== prev.y)) {
        runOnJS(snapTick2)();
        runOnJS(reportAt)(2, curr.x, curr.y);
      }
    },
    [count, xMin, yMin, gridStep, reportAt],
  );

  const onLayout = (e: LayoutChangeEvent) => setBoxW(e.nativeEvent.layout.width);

  // Grid + axis ticks (rounded to kill FP dust, same idiom as NumberLine.native).
  const xTicks: number[] = [];
  for (let v = xMin; v <= xMax + 1e-9; v += gridStep) xTicks.push(Math.round(v * 1e6) / 1e6);
  const yTicks: number[] = [];
  for (let v = yMin; v <= yMax + 1e-9; v += gridStep) yTicks.push(Math.round(v * 1e6) / 1e6);
  const xAxisVisible = yMin <= 0 && yMax >= 0;
  const yAxisVisible = xMin <= 0 && xMax >= 0;
  const labelSize = Math.max(11, Math.min(15, cell * 0.55));

  return (
    <View style={styles.wrap} onLayout={onLayout}>
      {cell > 0 && (
        <View style={{ width: planeW, height: planeH, position: "relative", overflow: "visible" }}>
          <Svg width={planeW} height={planeH}>
            {/* grid */}
            {xTicks.map((v, i) => (
              <Line key={`gx${i}`} x1={plane.x(v)} y1={plane.y(yMin)} x2={plane.x(v)} y2={plane.y(yMax)} stroke={palette.gray[200]} strokeWidth={1} />
            ))}
            {yTicks.map((v, i) => (
              <Line key={`gy${i}`} x1={plane.x(xMin)} y1={plane.y(v)} x2={plane.x(xMax)} y2={plane.y(v)} stroke={palette.gray[200]} strokeWidth={1} />
            ))}
            {/* axes */}
            {xAxisVisible && (
              <Line x1={plane.x(xMin)} y1={plane.y(0)} x2={plane.x(xMax)} y2={plane.y(0)} stroke={palette.navy[500]} strokeWidth={2} />
            )}
            {yAxisVisible && (
              <Line x1={plane.x(0)} y1={plane.y(yMin)} x2={plane.x(0)} y2={plane.y(yMax)} stroke={palette.navy[500]} strokeWidth={2} />
            )}
            {/* axis tick labels */}
            {xAxisVisible &&
              xTicks.map((v, i) => (
                <SvgText key={`xt${i}`} x={plane.x(v)} y={plane.y(0) + labelSize + 6} fontSize={labelSize} fontFamily={fonts.medium} fill={palette.charcoal[500]} textAnchor="middle">
                  {String(v)}
                </SvgText>
              ))}
            {yAxisVisible &&
              yTicks.map((v, i) => (
                <SvgText key={`yt${i}`} x={plane.x(0) - labelSize * 0.8} y={plane.y(v) + labelSize * 0.35} fontSize={labelSize} fontFamily={fonts.medium} fill={palette.charcoal[500]} textAnchor="middle">
                  {String(v)}
                </SvgText>
              ))}
            {/* fixed decorative segments */}
            {(spec.segments ?? []).map((seg, i) => (
              <Line key={`seg${i}`} x1={plane.x(seg[0].x)} y1={plane.y(seg[0].y)} x2={plane.x(seg[1].x)} y2={plane.y(seg[1].y)} stroke={palette.darkCyan[500]} strokeWidth={2} />
            ))}
            {/* fixed labeled points */}
            {(spec.fixedPoints ?? []).map((m, i) => (
              <Circle key={`fp${i}`} cx={plane.x(m.x)} cy={plane.y(m.y)} r={6} fill={palette.darkCyan[500]} />
            ))}
            {(spec.fixedPoints ?? []).map((m, i) =>
              m.label ? (
                <SvgText key={`fpl${i}`} x={plane.x(m.x) + 10} y={plane.y(m.y) - 8} fontSize={labelSize + 2} fontFamily={fonts.bold} fill={palette.darkCyan[500]}>
                  {m.label}
                </SvgText>
              ) : null,
            )}
          </Svg>
          {allHandles.slice(0, count).map((h, i) => (
            <MovableHandleView key={`h${i}`} handle={h} color={HANDLE_COLORS[i]} ringColor={palette.white} accessibilityLabel={`coordinate plane point ${i + 1}`} />
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: "100%",
    alignItems: "center",
    overflow: "visible",
  },
});
