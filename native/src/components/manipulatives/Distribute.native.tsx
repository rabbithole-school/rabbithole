/**
 * Distribute (native) — the RN port of the web Mafs Distribute. Drag the ONE
 * vertical split inside a rectangle: the left and right pieces make a × (b + c)
 * feel like a × b + a × c — same whole, two addends. The split is x-constrained
 * (snaps to a whole column in 1..width-1) and the height is fixed, so this reuses
 * the kit's single-axis snap path directly (like AreaPerimeter).
 *
 * The math is reused verbatim from the shared logic layer (`distributeSolved`,
 * `initialDistribute`, `clamp`); this file owns only pixels + the drag.
 */

import { useCallback, useMemo, useState } from "react";
import { StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import Svg, { Line, Rect, Text as SvgText } from "react-native-svg";

import { clamp, distributeSolved, initialDistribute } from "../../../vendor/manipulative/logic";
import type { DistributeState } from "../../../vendor/manipulative/logic";
import type { DistributeSpec } from "../../../vendor/manipulative/types";
import {
  CoordinatePlane,
  MovableHandleView,
  useMovableHandle,
  type KindProps,
  type Vec2,
} from "./kit";
import { fonts, palette } from "@/theme";

const MAX_SIZE = 320; // cap the plane so side-by-side layout stays sane
const PAD = 0.5; // math-unit padding so the border stroke + handle never clip

export function DistributeNative({
  spec,
  onSolvedChange,
  onStateChange,
}: KindProps<DistributeSpec, DistributeState>) {
  const maxSplit = spec.width - 1;
  const handleY = spec.height / 2;

  const [boxW, setBoxW] = useState(0);
  const [column, setColumn] = useState(() => initialDistribute(spec).column);

  // Equal cell size on both axes so unit columns/rows read as squares.
  const unitsX = spec.width + 2 * PAD;
  const unitsY = spec.height + 2 * PAD;
  const cap = boxW > 0 ? Math.min(boxW, MAX_SIZE) : 0;
  const cell = cap > 0 ? cap / Math.max(unitsX, unitsY) : 0;
  const planeW = cell * unitsX;
  const planeH = cell * unitsY;

  const viewBox = useMemo(
    () => ({
      x: [-PAD, spec.width + PAD] as [number, number],
      y: [-PAD, spec.height + PAD] as [number, number],
    }),
    [spec.width, spec.height],
  );
  const plane = useMemo(
    () => new CoordinatePlane(viewBox, { width: planeW, height: planeH }),
    [viewBox, planeW, planeH],
  );

  // constrain: round the dragged x to a whole column in [1, width-1] and pin the
  // handle to the vertical midline — a worklet (UI thread). Rounding/clamp is
  // inlined (worklets can't call imported JS); `clamp` is reused verbatim below.
  const constrain = useCallback(
    (p: Vec2): Vec2 => {
      "worklet";
      let x = Math.round(p.x);
      x = x < 1 ? 1 : x > maxSplit ? maxSplit : x;
      return { x, y: handleY };
    },
    [maxSplit, handleY],
  );

  const report = useCallback(
    (p: Vec2) => {
      const c = clamp(Math.round(p.x), 1, maxSplit);
      setColumn(c);
      onSolvedChange(distributeSolved(spec, { column: c }));
      onStateChange?.({ column: c });
    },
    [maxSplit, onSolvedChange, onStateChange, spec],
  );

  const handle = useMovableHandle({
    plane,
    initial: { x: column, y: handleY },
    constrain,
    snapIncrement: 1,
    snapAxis: "x",
    onChange: report,
    onSettled: report,
  });

  const onLayout = (e: LayoutChangeEvent) => setBoxW(e.nativeEvent.layout.width);

  // Faint unit grid so each column is countable.
  const gridCols: number[] = [];
  for (let i = 0; i <= spec.width; i++) gridCols.push(i);
  const gridRows: number[] = [];
  for (let i = 0; i <= spec.height; i++) gridRows.push(i);

  const rightWidth = spec.width - column;
  const labelSize = Math.max(13, Math.min(20, cell * 0.9));

  return (
    <View style={styles.wrap}>
      <View style={{ width: "100%", alignItems: "center" }} onLayout={onLayout}>
        {cell > 0 && (
          <View
            style={{
              width: planeW,
              height: planeH,
              position: "relative",
              overflow: "visible",
            }}
          >
            <Svg width={planeW} height={planeH}>
              {/* left region — a × b */}
              <Rect
                x={plane.x(0)}
                y={plane.y(spec.height)}
                width={column * plane.pxPerX}
                height={spec.height * plane.pxPerY}
                fill={palette.cyan[500]}
                fillOpacity={0.34}
              />
              {/* right region — a × c */}
              <Rect
                x={plane.x(column)}
                y={plane.y(spec.height)}
                width={rightWidth * plane.pxPerX}
                height={spec.height * plane.pxPerY}
                fill={palette.violet[500]}
                fillOpacity={0.24}
              />
              {/* faint unit grid */}
              {gridCols.map((i) => (
                <Line
                  key={`v-${i}`}
                  x1={plane.x(i)}
                  y1={plane.y(0)}
                  x2={plane.x(i)}
                  y2={plane.y(spec.height)}
                  stroke={palette.gray[200]}
                  strokeWidth={1}
                />
              ))}
              {gridRows.map((i) => (
                <Line
                  key={`h-${i}`}
                  x1={plane.x(0)}
                  y1={plane.y(i)}
                  x2={plane.x(spec.width)}
                  y2={plane.y(i)}
                  stroke={palette.gray[200]}
                  strokeWidth={1}
                />
              ))}
              {/* outer border — the fixed whole */}
              <Rect
                x={plane.x(0)}
                y={plane.y(spec.height)}
                width={spec.width * plane.pxPerX}
                height={spec.height * plane.pxPerY}
                fill="none"
                stroke={palette.navy[500]}
                strokeWidth={4}
              />
              {/* the movable cut */}
              <Line
                x1={plane.x(column)}
                y1={plane.y(0)}
                x2={plane.x(column)}
                y2={plane.y(spec.height)}
                stroke={palette.orange[500]}
                strokeWidth={5}
                strokeLinecap="round"
              />
              {/* region labels */}
              <SvgText
                x={plane.x(column / 2)}
                y={plane.y(handleY) + labelSize * 0.35}
                fontSize={labelSize}
                fontFamily={fonts.bold}
                fill={palette.navy[500]}
                textAnchor="middle"
              >
                {column} × {spec.height}
              </SvgText>
              <SvgText
                x={plane.x(column + rightWidth / 2)}
                y={plane.y(handleY) + labelSize * 0.35}
                fontSize={labelSize}
                fontFamily={fonts.bold}
                fill={palette.navy[500]}
                textAnchor="middle"
              >
                {rightWidth} × {spec.height}
              </SvgText>
            </Svg>
            <MovableHandleView
              handle={handle}
              color={palette.orange[500]}
              ringColor={palette.white}
              accessibilityLabel="split handle"
            />
          </View>
        )}
      </View>
      {/* the distributive identity, live */}
      <Text style={styles.equation}>
        {spec.width} × {spec.height} = {column} × {spec.height} + {rightWidth} ×{" "}
        {spec.height}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: "100%", gap: 12, alignItems: "center" },
  equation: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: palette.charcoal[500],
    textAlign: "center",
  },
});
