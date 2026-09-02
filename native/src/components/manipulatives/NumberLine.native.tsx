/**
 * NumberLine (native) — the RN port of the web Mafs NumberLine. Horizontal
 * lines keep their established fixed x-scale; vertical lines reuse the same
 * state and grading contract with values increasing upward.
 */

import { useCallback, useMemo, useState } from "react";
import { StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import Svg, { Circle, G, Line, Polygon, Rect, Text as SvgText } from "react-native-svg";
import Animated, { useAnimatedStyle } from "react-native-reanimated";

import {
  clamp,
  initialNumberLine,
  multipleTrackLandings,
  normalizeNumberLineValue,
  numberLineSolved,
} from "../../../vendor/manipulative/logic";
import type { NumberLineState } from "../../../vendor/manipulative/logic";
import type { NumberLineSpec } from "../../../vendor/manipulative/types";
import {
  CoordinatePlane,
  MovableHandleView,
  useMovableHandle,
  type KindProps,
  type Vec2,
} from "./kit";
import { fonts, palette } from "@/theme";

const SCALE = 10;
const HORIZONTAL_PAD = 0.5;
const HORIZONTAL_HEIGHT = 132;
const DUAL_TRACK_HORIZONTAL_HEIGHT = 230;
const VERTICAL_HEIGHT = 360;
const HORIZONTAL_VIEWBOX = {
  x: [-HORIZONTAL_PAD, SCALE + HORIZONTAL_PAD] as [number, number],
  y: [-1.4, 0.7] as [number, number],
};
const DUAL_TRACK_HORIZONTAL_VIEWBOX = {
  x: [-HORIZONTAL_PAD, SCALE + HORIZONTAL_PAD] as [number, number],
  y: [-3.2, 0.7] as [number, number],
};
const VERTICAL_VIEWBOX = {
  x: [-2.2, 3.3] as [number, number],
  y: [-0.55, SCALE + 0.55] as [number, number],
};

export function NumberLineNative(props: KindProps<NumberLineSpec, NumberLineState>) {
  return props.spec.orientation === "vertical" ? (
    <VerticalNumberLine {...props} />
  ) : (
    <HorizontalNumberLine {...props} />
  );
}

function HorizontalNumberLine({
  spec,
  onSolvedChange,
  onStateChange,
}: KindProps<NumberLineSpec, NumberLineState>) {
  const [width, setWidth] = useState(0);
  const [currentValue, setCurrentValue] = useState(() => initialNumberLine(spec).value);
  const hasTracks = spec.multipleTracks != null;
  const horizontalHeight = hasTracks ? DUAL_TRACK_HORIZONTAL_HEIGHT : HORIZONTAL_HEIGHT;
  const horizontalViewBox = hasTracks ? DUAL_TRACK_HORIZONTAL_VIEWBOX : HORIZONTAL_VIEWBOX;
  const span = spec.max - spec.min;
  const toInternal = useCallback(
    (v: number) => ((v - spec.min) / span) * SCALE,
    [spec.min, span],
  );
  const fromInternal = useCallback(
    (ix: number) => spec.min + (ix / SCALE) * span,
    [spec.min, span],
  );
  const snapInternal = spec.snap ? (spec.snap / span) * SCALE : undefined;
  const plane = useMemo(
    () => new CoordinatePlane(horizontalViewBox, { width, height: horizontalHeight }),
    [horizontalHeight, horizontalViewBox, width],
  );

  const constrain = useCallback(
    (p: Vec2): Vec2 => {
      "worklet";
      let ix = p.x < 0 ? 0 : p.x > SCALE ? SCALE : p.x;
      if (snapInternal && snapInternal > 0) {
        const s = Math.round(ix / snapInternal) * snapInternal;
        ix = s < 0 ? 0 : s > SCALE ? SCALE : s;
      }
      return { x: ix, y: 0 };
    },
    [snapInternal],
  );

  const report = useCallback(
    (p: Vec2) => {
      const value = normalizeNumberLineValue(
        spec,
        fromInternal(clamp(p.x, 0, SCALE)),
      );
      setCurrentValue(value);
      onSolvedChange(numberLineSolved(spec, { value }));
      onStateChange?.({ value });
    },
    [fromInternal, onSolvedChange, onStateChange, spec],
  );

  const handle = useMovableHandle({
    plane,
    initial: { x: toInternal(initialNumberLine(spec).value), y: 0 },
    constrain,
    snapIncrement: snapInternal,
    snapAxis: "x",
    onChange: report,
    onSettled: report,
  });
  const ticks = numberLineTicks(spec);
  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);
  const lineY = plane.y(0);
  const tickTop = plane.y(0.32);
  const tickBottom = plane.y(-0.32);
  const labelY = plane.y(-0.85);
  const markerLabelY = plane.y(0.42);
  const revealedTracks = multipleTrackLandings(spec.multipleTracks, currentValue, spec.max);
  const hasMoved = Math.abs(currentValue - spec.start) > 1e-9;
  const distance = Math.abs(currentValue - spec.start);
  const direction = currentValue < spec.start ? "left" : "right";
  const movementSummary = hasMoved
    ? `Started at ${spec.start}. Moved ${distance} ${direction}. Now at ${currentValue}.`
    : `Start at ${spec.start}. Drag the dot left or right.`;
  const accessibilityStep = spec.snap ?? spec.tickStep;
  const adjustAccessibility = useCallback(
    (direction: "increment" | "decrement") => {
      const value = normalizeNumberLineValue(
        spec,
        clamp(currentValue + (direction === "increment" ? accessibilityStep : -accessibilityStep), spec.min, spec.max),
      );
      const internalValue = toInternal(value);
      handle.mx.set(internalValue);
      handle.my.set(0);
      report({ x: internalValue, y: 0 });
    },
    [accessibilityStep, currentValue, handle.mx, handle.my, report, spec, toInternal],
  );

  return (
    <View style={[styles.horizontalWrap, hasTracks && styles.dualTrackHorizontalWrap]} onLayout={onLayout}>
      {width > 0 && (
        <>
          <Svg width={width} height={horizontalHeight}>
            <Line
              x1={plane.x(0)}
              y1={lineY}
              x2={plane.x(SCALE)}
              y2={lineY}
              stroke={palette.navy[500]}
              strokeWidth={3}
              strokeLinecap="round"
            />
            {hasMoved && (
              <Line
                x1={plane.x(toInternal(spec.start))}
                y1={lineY}
                x2={plane.x(toInternal(currentValue))}
                y2={lineY}
                stroke={palette.violet[500]}
                strokeWidth={12}
                strokeOpacity={0.24}
                strokeLinecap="round"
              />
            )}
            {hasMoved && (
              <Circle
                cx={plane.x(toInternal(spec.start))}
                cy={lineY}
                r={6}
                fill={palette.orange[500]}
              />
            )}
            {ticks.map((v, i) => (
              <Line
                key={`tick-${i}`}
                x1={plane.x(toInternal(v))}
                y1={tickTop}
                x2={plane.x(toInternal(v))}
                y2={tickBottom}
                stroke={palette.navy[500]}
                strokeWidth={2}
              />
            ))}
            {ticks.map((v, i) => (
              <SvgText
                key={`label-${i}`}
                x={plane.x(toInternal(v))}
                y={labelY}
                fontSize={15}
                fontFamily={fonts.medium}
                fill={palette.charcoal[500]}
                textAnchor="middle"
              >
                {String(v)}
              </SvgText>
            ))}
            {(spec.markers ?? []).map((m, i) => (
              <Circle
                key={`marker-${i}`}
                cx={plane.x(toInternal(m.value))}
                cy={lineY}
                r={6}
                fill={palette.darkCyan[500]}
              />
            ))}
            {(spec.markers ?? []).map((m, i) =>
              m.label ? (
                <SvgText
                  key={`marker-label-${i}`}
                  x={plane.x(toInternal(m.value))}
                  y={markerLabelY}
                  fontSize={13}
                  fontFamily={fonts.medium}
                  fill={palette.darkCyan[500]}
                  textAnchor="middle"
                >
                  {m.label}
                </SvgText>
              ) : null,
            )}
            {revealedTracks.common.map((landing) => (
              <Line
                key={`common-${landing}`}
                x1={plane.x(toInternal(landing))}
                y1={plane.y(-1)}
                x2={plane.x(toInternal(landing))}
                y2={plane.y(-2)}
                stroke={palette.charcoal[500]}
                strokeWidth={2}
              />
            ))}
            {spec.multipleTracks?.map((period, trackIndex) => {
              const lane = trackIndex === 0 ? -1 : -2;
              const color = trackIndex === 0 ? palette.green[500] : palette.orange[500];
              return (
                <G key={`track-${period}`}>
                  <Line
                    x1={plane.x(0)}
                    y1={plane.y(lane)}
                    x2={plane.x(SCALE)}
                    y2={plane.y(lane)}
                    stroke={palette.gray[200]}
                    strokeWidth={2}
                  />
                  <SvgText
                    x={plane.x(0.2)}
                    y={plane.y(lane - 0.3)}
                    fontSize={13}
                    fontFamily={fonts.medium}
                    fill={color}
                  >
                    {period}s
                  </SvgText>
                  {revealedTracks.tracks[trackIndex].map((landing) => (
                    <Circle
                      key={landing}
                      cx={plane.x(toInternal(landing))}
                      cy={plane.y(lane)}
                      r={6}
                      fill={color}
                    />
                  ))}
                </G>
              );
            })}
          </Svg>
          <MovableHandleView
            handle={handle}
            color={palette.violet[500]}
            ringColor={palette.white}
            accessibilityLabel="number line thumb"
            accessibilityValue={{
              min: spec.min,
              max: spec.max,
              now: currentValue,
              text: `${currentValue}; ${revealedTracks.common.length} shared landings revealed`,
            }}
            onAccessibilityAdjust={adjustAccessibility}
          />
          <Text
            accessibilityLiveRegion="polite"
            style={[styles.horizontalStatus, hasMoved ? styles.statusMoved : styles.statusIdle]}
          >
            {movementSummary}
          </Text>
        </>
      )}
    </View>
  );
}

function VerticalNumberLine({
  spec,
  onSolvedChange,
  onStateChange,
}: KindProps<NumberLineSpec, NumberLineState>) {
  const [width, setWidth] = useState(0);
  const [currentValue, setCurrentValue] = useState(() => initialNumberLine(spec).value);
  const span = spec.max - spec.min;
  const toInternal = useCallback(
    (v: number) => ((v - spec.min) / span) * SCALE,
    [spec.min, span],
  );
  const fromInternal = useCallback(
    (iy: number) => spec.min + (iy / SCALE) * span,
    [spec.min, span],
  );
  const snapInternal = spec.snap ? (spec.snap / span) * SCALE : undefined;
  const plane = useMemo(
    () => new CoordinatePlane(VERTICAL_VIEWBOX, { width, height: VERTICAL_HEIGHT }),
    [width],
  );

  const constrain = useCallback(
    (p: Vec2): Vec2 => {
      "worklet";
      let iy = p.y < 0 ? 0 : p.y > SCALE ? SCALE : p.y;
      if (snapInternal && snapInternal > 0) {
        const s = Math.round(iy / snapInternal) * snapInternal;
        iy = s < 0 ? 0 : s > SCALE ? SCALE : s;
      }
      return { x: 0, y: iy };
    },
    [snapInternal],
  );

  const report = useCallback(
    (p: Vec2) => {
      const value = normalizeNumberLineValue(
        spec,
        fromInternal(clamp(p.y, 0, SCALE)),
      );
      setCurrentValue(value);
      onSolvedChange(numberLineSolved(spec, { value }));
      onStateChange?.({ value });
    },
    [fromInternal, onSolvedChange, onStateChange, spec],
  );

  const handle = useMovableHandle({
    plane,
    initial: { x: 0, y: toInternal(initialNumberLine(spec).value) },
    constrain,
    snapIncrement: snapInternal,
    snapAxis: "y",
    onChange: report,
    onSettled: report,
  });
  const ticks = numberLineTicks(spec);
  const scene = spec.scene;
  const zeroY = toInternal(0);
  const hasZero = spec.min <= 0 && spec.max >= 0;
  const actorLabel =
    spec.handleLabel ??
    (scene?.type === "building"
      ? "Elevator"
      : scene?.type === "mountain"
        ? "Hiker"
        : undefined);
  const accessibilityLabel =
    actorLabel
      ? `Move the ${actorLabel.toLowerCase()} along the vertical number line`
      : "Move the marker along the vertical number line";
  const actorX = scene?.type === "building" ? 1.2 : 0.65;
  const actorPx = plane.x(actorX);
  const { minY, height, pxPerY } = plane;
  const actorY = handle.my;
  const actorXValue = handle.mx;
  const accessibilityStep = spec.snap ?? spec.tickStep;
  const adjustAccessibility = useCallback(
    (direction: "increment" | "decrement") => {
      const delta = direction === "increment" ? accessibilityStep : -accessibilityStep;
      const value = normalizeNumberLineValue(
        spec,
        clamp(currentValue + delta, spec.min, spec.max),
      );
      const internalValue = toInternal(value);
      actorXValue.set(0);
      actorY.set(internalValue);
      report({ x: 0, y: internalValue });
    },
    [
      accessibilityStep,
      actorXValue,
      actorY,
      currentValue,
      report,
      spec,
      toInternal,
    ],
  );
  const actorStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: actorPx - 46 },
      { translateY: height - (actorY.get() - minY) * pxPerY - 46 },
    ],
  }));
  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  return (
    <View style={styles.verticalWrap} onLayout={onLayout}>
      {width > 0 && (
        <>
          <Svg width={width} height={VERTICAL_HEIGHT}>
            {scene?.type === "mountain" && hasZero && (
              <MountainScene plane={plane} seaLevel={zeroY} />
            )}
            {scene?.type === "building" && (
              <BuildingScene plane={plane} ticks={ticks} toInternal={toInternal} zeroY={zeroY} hasZero={hasZero} />
            )}
            {hasZero && (
              <Line
                x1={plane.x(-1.8)}
                y1={plane.y(zeroY)}
                x2={plane.x(3.1)}
                y2={plane.y(zeroY)}
                stroke={palette.darkCyan[500]}
                strokeWidth={3}
              />
            )}
            <Line
              x1={plane.x(0)}
              y1={plane.y(0)}
              x2={plane.x(0)}
              y2={plane.y(SCALE)}
              stroke={palette.navy[500]}
              strokeWidth={3}
              strokeLinecap="round"
            />
            {ticks.map((v, i) => (
              <Line
                key={`tick-${i}`}
                x1={plane.x(-0.24)}
                y1={plane.y(toInternal(v))}
                x2={plane.x(0.24)}
                y2={plane.y(toInternal(v))}
                stroke={palette.navy[500]}
                strokeWidth={2}
              />
            ))}
            {ticks.map((v, i) => (
              <SvgText
                key={`label-${i}`}
                x={plane.x(-0.62)}
                y={plane.y(toInternal(v)) + 5}
                fontSize={14}
                fontFamily={fonts.medium}
                fill={palette.charcoal[500]}
                textAnchor="end"
              >
                {String(v)}
              </SvgText>
            ))}
            {(spec.markers ?? []).map((m, i) => (
              <Circle
                key={`marker-${i}`}
                cx={plane.x(0)}
                cy={plane.y(toInternal(m.value))}
                r={6}
                fill={palette.darkCyan[500]}
              />
            ))}
            {(spec.markers ?? []).map((m, i) =>
              m.label ? (
                <SvgText
                  key={`marker-label-${i}`}
                  x={plane.x(-1.85)}
                  y={plane.y(toInternal(m.value) + 0.25)}
                  fontSize={12}
                  fontFamily={fonts.medium}
                  fill={palette.darkCyan[500]}
                >
                  {m.label}
                </SvgText>
              ) : null,
            )}
          </Svg>
          {actorLabel && (
            <Animated.View
              pointerEvents="none"
              style={[styles.actorOverlay, actorStyle]}
            >
              <View
                style={[
                  styles.actorBadge,
                  scene?.type === "building" && styles.elevatorBadge,
                ]}
              >
                <Text style={styles.actorText}>{actorLabel}</Text>
              </View>
            </Animated.View>
          )}
          <MovableHandleView
            handle={handle}
            color={palette.violet[500]}
            ringColor={palette.white}
            accessibilityLabel={accessibilityLabel}
            accessibilityValue={{
              min: spec.min,
              max: spec.max,
              now: currentValue,
              text: `${currentValue}`,
            }}
            onAccessibilityAdjust={adjustAccessibility}
          />
        </>
      )}
    </View>
  );
}

function MountainScene({ plane, seaLevel }: { plane: CoordinatePlane; seaLevel: number }) {
  const peak = Math.min(SCALE - 0.2, seaLevel + 5.8);
  const points = [
    [0.45, seaLevel],
    [1.2, seaLevel + 1.5],
    [1.85, peak],
    [2.55, seaLevel + 2.1],
    [3.1, seaLevel],
  ]
    .map(([x, y]) => `${plane.x(x)},${plane.y(y)}`)
    .join(" ");
  return (
    <>
      <Rect
        x={plane.x(0.45)}
        y={plane.y(seaLevel)}
        width={plane.x(3.1) - plane.x(0.45)}
        height={plane.y(0) - plane.y(seaLevel)}
        fill={palette.darkCyan[500]}
        fillOpacity={0.08}
      />
      <Polygon
        points={points}
        fill={palette.green[500]}
        fillOpacity={0.25}
        stroke={palette.green[500]}
        strokeWidth={2}
      />
    </>
  );
}

function BuildingScene({
  plane,
  ticks,
  toInternal,
  zeroY,
  hasZero,
}: {
  plane: CoordinatePlane;
  ticks: number[];
  toInternal: (value: number) => number;
  zeroY: number;
  hasZero: boolean;
}) {
  const x = plane.x(0.65);
  const right = plane.x(2.65);
  return (
    <>
      <Rect
        x={x}
        y={plane.y(SCALE)}
        width={right - x}
        height={plane.y(0) - plane.y(SCALE)}
        fill={palette.navy[50]}
        stroke={palette.navy[500]}
        strokeWidth={2}
      />
      {hasZero && zeroY > 0 && (
        <Rect
          x={x}
          y={plane.y(zeroY)}
          width={right - x}
          height={plane.y(0) - plane.y(zeroY)}
          fill={palette.charcoal[500]}
          fillOpacity={0.1}
        />
      )}
      {ticks.map((value) => (
        hasZero && value === 0 ? null : (
        <Line
          key={value}
          x1={x}
          y1={plane.y(toInternal(value))}
          x2={right}
          y2={plane.y(toInternal(value))}
          stroke={palette.navy[500]}
          strokeWidth={1}
        />
        )
      ))}
    </>
  );
}

function numberLineTicks(spec: NumberLineSpec): number[] {
  const ticks: number[] = [];
  for (let v = spec.min; v <= spec.max + 1e-9; v += spec.tickStep) {
    ticks.push(Math.round(v * 1e6) / 1e6);
  }
  return ticks;
}

const styles = StyleSheet.create({
  horizontalWrap: {
    width: "100%",
    height: HORIZONTAL_HEIGHT,
    position: "relative",
    overflow: "visible",
  },
  dualTrackHorizontalWrap: {
    height: DUAL_TRACK_HORIZONTAL_HEIGHT,
  },
  horizontalStatus: {
    marginTop: -22,
    textAlign: "center",
    fontFamily: fonts.medium,
    fontSize: 13,
  },
  statusMoved: {
    color: palette.violet[500],
  },
  statusIdle: {
    color: palette.charcoal[500],
  },
  verticalWrap: {
    width: "100%",
    height: VERTICAL_HEIGHT,
    position: "relative",
    overflow: "visible",
  },
  actorOverlay: {
    position: "absolute",
    left: 0,
    top: 0,
    width: 92,
    height: 92,
    alignItems: "center",
    justifyContent: "center",
  },
  actorBadge: {
    position: "absolute",
    left: 56,
    minWidth: 52,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 2,
    borderColor: palette.violet[500],
    backgroundColor: palette.white,
  },
  elevatorBadge: {
    borderRadius: 5,
  },
  actorText: {
    color: palette.charcoal[500],
    fontFamily: fonts.medium,
    fontSize: 12,
  },
});
