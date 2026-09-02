/**
 * Protractor (native) — the RN port of the web Mafs Protractor. Drag a handle
 * along a 0..180° arc, exactly like laying an analog protractor over a page.
 * ONE goal mode: constructAngle — only the fixed base ray is drawn; drag the
 * FREE RAY itself (solid, from the vertex) until it reads the target degree
 * the prompt states in words — the ray IS the construction.
 *
 * A `measureAngle` mode (a pre-drawn second ray the scholar read with a
 * separate marker) existed briefly and was REMOVED (2026-07) — it was
 * gameable: the answer was literally on screen as a drawn ray, so a scholar
 * could slide the marker onto it by visual matching without ever reading the
 * scale. See the `ProtractorGoal` doc comment in lib/manipulative/types.ts.
 *
 * Degrees are always relative to `spec.baseRayDeg` (default 0) — the whole
 * diagram just rotates for display; grading (`protractorSolved`, reused
 * verbatim from the shared logic layer) never reads that offset.
 *
 * Unlike the linear kinds (NumberLine, Distribute, …), the drag here isn't
 * constrained to a straight x or y axis, so `useMovableHandle`'s built-in
 * `snapIncrement`/`snapAxis` (a linear x/y grid) can't express a uniform
 * DEGREE step on a circular scale. `constrain` below stays continuous (a
 * smooth drag, never rounded), and this file fires its OWN per-5° selection
 * tick by watching which 5° bucket the live angle crosses — the "audio tick"
 * feel other kinds get from the shared snap path, adapted for an angle.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import Svg, { Circle, Line, Text as SvgText } from "react-native-svg";

import { clamp, initialProtractor, protractorSolved } from "../../../vendor/manipulative/logic";
import type { ProtractorState } from "../../../vendor/manipulative/logic";
import type { ProtractorSpec } from "../../../vendor/manipulative/types";
import {
  CoordinatePlane,
  MovableHandleView,
  selectionTick,
  useMovableHandle,
  type KindProps,
  type Vec2,
} from "./kit";
import { fonts, palette } from "@/theme";

const R = 4; // arc radius, math units
const PAD = 0.6;
const HEIGHT = 240;
/** Per-5° audio tick while dragging (see the module doc above). */
const TICK_STEP_DEG = 5;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function ProtractorNative({
  spec,
  onSolvedChange,
  onStateChange,
}: KindProps<ProtractorSpec, ProtractorState>) {
  const [width, setWidth] = useState(0);
  const baseDeg = spec.baseRayDeg ?? 0;

  // relDeg 0..180 (relative to the base ray) → a math-space point on the arc.
  const pointAt = useCallback(
    (relDeg: number): Vec2 => {
      const rad = toRad(baseDeg + relDeg);
      return { x: R * Math.cos(rad), y: R * Math.sin(rad) };
    },
    [baseDeg],
  );
  // The inverse: a raw (x, y) → the relative degree it reads on the scale.
  const relDegOf = useCallback(
    (x: number, y: number): number => {
      const raw = (Math.atan2(y, x) * 180) / Math.PI - baseDeg;
      return clamp(raw, 0, 180);
    },
    [baseDeg],
  );

  const [angleDeg, setAngleDeg] = useState(() => initialProtractor(spec).angleDeg);

  const viewBox = useMemo(
    () => ({ x: [-R - PAD, R + PAD] as [number, number], y: [-0.8, R + PAD] as [number, number] }),
    [],
  );
  const plane = useMemo(() => new CoordinatePlane(viewBox, { width, height: HEIGHT }), [viewBox, width]);

  // constrain: project the raw drag onto the arc — clamp the ANGLE into
  // [0, 180], never round it (a worklet, runs on the UI thread every frame).
  // atan2/cos/sin are plain Math calls, fine inside a worklet.
  const constrain = useCallback(
    (p: Vec2): Vec2 => {
      "worklet";
      const raw = (Math.atan2(p.y, p.x) * 180) / Math.PI - baseDeg;
      const rel = raw < 0 ? 0 : raw > 180 ? 180 : raw;
      const rad = ((baseDeg + rel) * Math.PI) / 180;
      return { x: R * Math.cos(rad), y: R * Math.sin(rad) };
    },
    [baseDeg],
  );

  // Fires the per-5° tick on a bucket crossing, mirrors the live angle into JS
  // state (so the free ray follows the finger), and reports the kind-matched
  // state up for the optimistic self-check + practice-item grade.
  const lastTickBucket = useRef(Math.round(initialProtractor(spec).angleDeg / TICK_STEP_DEG));
  const report = useCallback(
    (p: Vec2) => {
      const deg = relDegOf(p.x, p.y);
      const bucket = Math.round(deg / TICK_STEP_DEG);
      if (bucket !== lastTickBucket.current) {
        lastTickBucket.current = bucket;
        selectionTick();
      }
      setAngleDeg(deg);
      onSolvedChange(protractorSolved(spec, { angleDeg: deg }));
      onStateChange?.({ angleDeg: deg });
    },
    [relDegOf, onSolvedChange, onStateChange, spec],
  );

  const handle = useMovableHandle({
    plane,
    initial: pointAt(initialProtractor(spec).angleDeg),
    constrain,
    onChange: report,
    onSettled: report,
  });

  // Arc + ticks, sampled the same way the web renderer does.
  const arcPoints = useMemo(() => {
    const pts: Vec2[] = [];
    for (let d = 0; d <= 180; d += 2) pts.push(pointAt(d));
    return pts;
  }, [pointAt]);
  const majorTicks = useMemo(() => {
    const out: number[] = [];
    for (let d = 0; d <= 180; d += 10) out.push(d);
    return out;
  }, []);
  const minorTicks = useMemo(() => {
    const out: number[] = [];
    for (let d = 5; d < 180; d += 10) out.push(d);
    return out;
  }, []);
  const tickOuter = useCallback(
    (d: number, len: number): Vec2 => {
      const rad = toRad(baseDeg + d);
      return { x: R * Math.cos(rad) + len * Math.cos(rad), y: R * Math.sin(rad) + len * Math.sin(rad) };
    },
    [baseDeg],
  );
  const labelPoint = useCallback(
    (d: number): Vec2 => {
      const rad = toRad(baseDeg + d);
      const lr = R + 0.72;
      return { x: lr * Math.cos(rad), y: lr * Math.sin(rad) };
    },
    [baseDeg],
  );

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  const rayPoint = pointAt(angleDeg);
  const straightEdgeA = pointAt(0);
  const straightEdgeB = pointAt(180);
  const vertex = plane.width > 0 ? { x: plane.x(0), y: plane.y(0) } : null;

  return (
    <View style={styles.wrap} onLayout={onLayout}>
      {width > 0 && (
        <>
          <Svg width={width} height={HEIGHT}>
            {/* the arc */}
            {arcPoints.slice(0, -1).map((p, i) => (
              <Line
                key={`arc-${i}`}
                x1={plane.x(p.x)}
                y1={plane.y(p.y)}
                x2={plane.x(arcPoints[i + 1].x)}
                y2={plane.y(arcPoints[i + 1].y)}
                stroke={palette.navy[500]}
                strokeWidth={2}
              />
            ))}
            {/* the straight edge (the protractor's baseline, through the vertex) */}
            <Line
              x1={plane.x(straightEdgeA.x)}
              y1={plane.y(straightEdgeA.y)}
              x2={plane.x(straightEdgeB.x)}
              y2={plane.y(straightEdgeB.y)}
              stroke={palette.navy[500]}
              strokeWidth={2}
            />
            {/* minor ticks every 5°, unlabeled */}
            {minorTicks.map((d) => {
              const inner = pointAt(d);
              const outer = tickOuter(d, 0.18);
              return (
                <Line
                  key={`minor-${d}`}
                  x1={plane.x(inner.x)}
                  y1={plane.y(inner.y)}
                  x2={plane.x(outer.x)}
                  y2={plane.y(outer.y)}
                  stroke={palette.charcoal[500]}
                  strokeWidth={1.5}
                />
              );
            })}
            {/* major ticks every 10°, labeled */}
            {majorTicks.map((d) => {
              const inner = pointAt(d);
              const outer = tickOuter(d, 0.32);
              return (
                <Line
                  key={`major-${d}`}
                  x1={plane.x(inner.x)}
                  y1={plane.y(inner.y)}
                  x2={plane.x(outer.x)}
                  y2={plane.y(outer.y)}
                  stroke={palette.navy[500]}
                  strokeWidth={2}
                />
              );
            })}
            {majorTicks.map((d) => {
              const lp = labelPoint(d);
              return (
                <SvgText
                  key={`label-${d}`}
                  x={plane.x(lp.x)}
                  y={plane.y(lp.y)}
                  fontSize={13}
                  fontFamily={fonts.medium}
                  fill={palette.charcoal[500]}
                  textAnchor="middle"
                >
                  {String(d)}
                </SvgText>
              );
            })}
            {/* the free ray IS the construction, drawn solid the whole length */}
            {vertex && (
              <Line
                x1={vertex.x}
                y1={vertex.y}
                x2={plane.x(rayPoint.x)}
                y2={plane.y(rayPoint.y)}
                stroke={palette.violet[500]}
                strokeWidth={3.5}
              />
            )}
            {/* the vertex */}
            {vertex && <Circle cx={vertex.x} cy={vertex.y} r={5} fill={palette.navy[500]} />}
          </Svg>
          <MovableHandleView
            handle={handle}
            color={palette.violet[500]}
            ringColor={palette.white}
            accessibilityLabel="protractor free ray"
          />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: "100%",
    height: HEIGHT,
    position: "relative",
    overflow: "visible",
  },
});
