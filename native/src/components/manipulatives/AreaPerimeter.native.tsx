/**
 * AreaPerimeter (native) — the RN port of the web Mafs AreaPerimeter. Drag the
 * single corner handle to reshape a rectangle whose PERIMETER is fixed: the
 * corner is constrained to the line w + h = perimeter/2, so dragging trades
 * width for height. A unit grid makes the area countable; a live readout shows
 * the two quantities changing in opposition — isolating the classic
 * "longer/bigger-perimeter ⇒ more area" misconception.
 *
 * All the math is reused verbatim from the shared logic layer
 * (`heightForPerimeter`, `areaPerimeterArea`, `areaPerimeterSolved`, `clamp`,
 * `initialAreaPerimeter`); this file owns only pixels + the drag.
 */

import { useCallback, useMemo, useState } from "react";
import { StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import Svg, { Image as SvgImage, Line, Rect } from "react-native-svg";
import { useThemeIcon } from "./useThemeIcon";

import {
  areaPerimeterArea,
  areaPerimeterSolved,
  clamp,
  heightForPerimeter,
  initialAreaPerimeter,
} from "../../../vendor/manipulative/logic";
import type { AreaPerimeterState } from "../../../vendor/manipulative/logic";
import type { AreaPerimeterSpec } from "../../../vendor/manipulative/types";
import {
  CoordinatePlane,
  MovableHandleView,
  useMovableHandle,
  type KindProps,
  type Vec2,
} from "./kit";
import { fonts, palette } from "@/theme";

const MAX_SIZE = 300; // cap the square plane so side-by-side layout stays sane
const PAD = 0.5; // math-unit padding so the border stroke + corner never clip

export function AreaPerimeterNative({
  spec,
  onSolvedChange,
  onStateChange,
}: KindProps<AreaPerimeterSpec, AreaPerimeterState>) {
  const [boxW, setBoxW] = useState(0);
  const [width, setWidth] = useState(() => initialAreaPerimeter(spec).width);
  // Generative charm: `theme.fill.label` → a hosted, chroma-keyed icon URL
  // tiled one-per-cell inside the pen (undefined until ready → plain fill).
  // Area is still exactly w * h; the icon is a 1:1 visual stand-in.
  const iconUrl = useThemeIcon(spec.theme);

  const half = spec.perimeter / 2;
  const maxDim = half - 1;
  const height = heightForPerimeter(spec.perimeter, width);

  // Square plane (equal x/y scale) so grid cells read as squares.
  const size = boxW > 0 ? Math.min(boxW, MAX_SIZE) : 0;
  const viewBox = useMemo(
    () => ({
      x: [-PAD, maxDim + PAD] as [number, number],
      y: [-PAD, maxDim + PAD] as [number, number],
    }),
    [maxDim],
  );
  const plane = useMemo(
    () => new CoordinatePlane(viewBox, { width: size, height: size }),
    [viewBox, size],
  );

  // constrain: round the dragged x to an integer width in [1, maxDim] and derive
  // the height on the fixed-perimeter line — a worklet (UI thread). The integer
  // rounding is inlined (worklets can't call imported JS); the identical `clamp`
  // is reused verbatim on the JS side below.
  const constrain = useCallback(
    (p: Vec2): Vec2 => {
      "worklet";
      let w = Math.round(p.x);
      w = w < 1 ? 1 : w > maxDim ? maxDim : w;
      return { x: w, y: half - w };
    },
    [half, maxDim],
  );

  const report = useCallback(
    (p: Vec2) => {
      const w = clamp(Math.round(p.x), 1, maxDim);
      setWidth(w);
      onSolvedChange(areaPerimeterSolved(spec, { width: w }));
      onStateChange?.({ width: w });
    },
    [maxDim, onSolvedChange, onStateChange, spec],
  );

  const handle = useMovableHandle({
    plane,
    initial: { x: width, y: half - width },
    constrain,
    snapIncrement: 1,
    snapAxis: "x",
    onChange: report,
    onSettled: report,
  });

  const onLayout = (e: LayoutChangeEvent) => setBoxW(e.nativeEvent.layout.width);

  // Grid lines across the full plane (unit spacing).
  const gridLines: number[] = [];
  for (let i = 0; i <= maxDim; i++) gridLines.push(i);

  const area = areaPerimeterArea(spec, { width });

  return (
    <View style={styles.wrap}>
      <View style={{ width: "100%", alignItems: "center" }} onLayout={onLayout}>
        {size > 0 && (
          <View style={{ width: size, height: size, position: "relative", overflow: "visible" }}>
            <Svg width={size} height={size}>
              {/* unit grid — makes the area countable */}
              {gridLines.map((i) => (
                <Line
                  key={`v-${i}`}
                  x1={plane.x(i)}
                  y1={plane.y(0)}
                  x2={plane.x(i)}
                  y2={plane.y(maxDim)}
                  stroke={palette.gray[200]}
                  strokeWidth={1}
                />
              ))}
              {gridLines.map((i) => (
                <Line
                  key={`h-${i}`}
                  x1={plane.x(0)}
                  y1={plane.y(i)}
                  x2={plane.x(maxDim)}
                  y2={plane.y(i)}
                  stroke={palette.gray[200]}
                  strokeWidth={1}
                />
              ))}
              {/* the rectangle's filled area (green) — encodes area directly */}
              <Rect
                x={plane.x(0)}
                y={plane.y(height)}
                width={width * plane.pxPerX}
                height={height * plane.pxPerY}
                fill={palette.green[500]}
                fillOpacity={iconUrl ? 0.08 : 0.24}
              />
              {/* generative charm: one themed icon per unit cell inside the pen */}
              {iconUrl &&
                Array.from({ length: Math.round(height) }).flatMap((_, r) =>
                  Array.from({ length: Math.round(width) }).map((__, c) => (
                    <SvgImage
                      key={`icon-${r}-${c}`}
                      href={{ uri: iconUrl }}
                      x={plane.x(c + 0.1)}
                      y={plane.y(r + 0.9)}
                      width={0.8 * plane.pxPerX}
                      height={0.8 * plane.pxPerY}
                      preserveAspectRatio="xMidYMid meet"
                    />
                  )),
                )}
              {/* the rectangle's border (navy) — encodes the fixed perimeter */}
              <Rect
                x={plane.x(0)}
                y={plane.y(height)}
                width={width * plane.pxPerX}
                height={height * plane.pxPerY}
                fill="none"
                stroke={palette.navy[500]}
                strokeWidth={4}
              />
            </Svg>
            <MovableHandleView
              handle={handle}
              color={palette.orange[500]}
              ringColor={palette.white}
              accessibilityLabel="rectangle corner handle"
            />
          </View>
        )}
      </View>
      {/* live readout — the two quantities that move in opposition */}
      <View style={styles.readout}>
        <View style={styles.stat}>
          <Text style={styles.statValue}>{area}</Text>
          <Text style={styles.statLabel}>AREA</Text>
        </View>
        <View style={styles.divider} />
        <View style={styles.stat}>
          <Text style={styles.statValue}>{spec.perimeter}</Text>
          <Text style={styles.statLabel}>PERIMETER</Text>
        </View>
        <View style={styles.divider} />
        <View style={styles.stat}>
          <Text style={styles.statValue}>
            {width} × {height}
          </Text>
          <Text style={styles.statLabel}>W × H</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: "100%", gap: 12 },
  readout: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
  },
  stat: { alignItems: "center", minWidth: 64 },
  statValue: {
    fontFamily: fonts.bold,
    fontSize: 22,
    color: palette.navy[500],
  },
  statLabel: {
    fontFamily: fonts.semibold,
    fontSize: 11,
    letterSpacing: 1,
    color: palette.charcoal[400],
    marginTop: 2,
  },
  divider: {
    width: 1,
    height: 28,
    backgroundColor: palette.gray[200],
  },
});
