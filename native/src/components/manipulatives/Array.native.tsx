/**
 * Array (native) — the RN port of the web Mafs Array. Drag the ONE corner handle
 * to build a rectangle of tiles (rows × cols) on a unit grid: multiplication as
 * area, factors, and commutativity. "Make 12" lights up for 3×4, 4×3, 2×6 …
 * every factor pair.
 *
 * Same vocabulary as AreaPerimeter.native (CoordinatePlane + useMovableHandle,
 * integer snap) — the only twist is a genuinely 2D corner. The kit's built-in
 * snap-haptic/report path throttles on a single axis, so here the state report
 * (and its subtle haptic) is driven off a `useAnimatedReaction` watching the
 * rounded (col, row) pair, firing exactly when either integer crosses. The math
 * is reused verbatim from the shared logic layer (`arraySolved`, `initialArray`,
 * `clamp`); this file owns only pixels + the drag.
 */

import { useCallback, useMemo, useState } from "react";
import { StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import Svg, { Image as SvgImage, Line, Rect } from "react-native-svg";
import { runOnJS, useAnimatedReaction } from "react-native-reanimated";

import { useThemeIcon } from "./useThemeIcon";
import { arraySolved, clamp, initialArray } from "../../../vendor/manipulative/logic";
import type { ArrayState } from "../../../vendor/manipulative/logic";
import type { ArraySpec } from "../../../vendor/manipulative/types";
import {
  CoordinatePlane,
  MovableHandleView,
  useMovableHandle,
  type KindProps,
  type Vec2,
} from "./kit";
import { fonts, palette } from "@/theme";

const MAX_SIZE = 300; // cap the plane so side-by-side layout stays sane
const PAD = 0.5; // math-unit padding so the border stroke + corner never clip

export function ArrayNative({
  spec,
  onSolvedChange,
  onStateChange,
}: KindProps<ArraySpec, ArrayState>) {
  const maxCols = spec.maxCols ?? 8;
  const maxRows = spec.maxRows ?? 8;
  // Generative charm: `theme.fill.label` → a hosted, chroma-keyed icon URL
  // (undefined until ready → plain tile). The count is still exactly
  // rows * cols; the icon is a 1:1 visual stand-in, never a source of truth.
  const iconUrl = useThemeIcon(spec.theme);

  const [boxW, setBoxW] = useState(0);
  const [state, setState] = useState<ArrayState>(() => initialArray(spec));
  const { rows, cols } = state;

  // Equal cell size on both axes so tiles read as squares even when the grid is
  // not square. The plane covers the full [maxCols] × [maxRows] region + PAD.
  const unitsX = maxCols + 2 * PAD;
  const unitsY = maxRows + 2 * PAD;
  const cap = boxW > 0 ? Math.min(boxW, MAX_SIZE) : 0;
  const cell = cap > 0 ? cap / Math.max(unitsX, unitsY) : 0;
  const planeW = cell * unitsX;
  const planeH = cell * unitsY;

  const viewBox = useMemo(
    () => ({
      x: [-PAD, maxCols + PAD] as [number, number],
      y: [-PAD, maxRows + PAD] as [number, number],
    }),
    [maxCols, maxRows],
  );
  const plane = useMemo(
    () => new CoordinatePlane(viewBox, { width: planeW, height: planeH }),
    [viewBox, planeW, planeH],
  );

  // constrain: round the dragged point to an integer cell in [1,maxCols] ×
  // [1,maxRows] — a worklet (UI thread). The rounding/clamp is inlined (worklets
  // can't call the imported JS `clamp`, which is reused verbatim in `report`).
  const constrain = useCallback(
    (p: Vec2): Vec2 => {
      "worklet";
      let c = Math.round(p.x);
      let r = Math.round(p.y);
      c = c < 1 ? 1 : c > maxCols ? maxCols : c;
      r = r < 1 ? 1 : r > maxRows ? maxRows : r;
      return { x: c, y: r };
    },
    [maxCols, maxRows],
  );

  const handle = useMovableHandle({
    plane,
    initial: { x: cols, y: rows },
    constrain,
  });

  // Destructure the shared values OUT of `handle` before the worklet below.
  // A worklet serializes everything its closure captures, and `handle` also
  // carries the Pan `gesture` — which Worklets cannot copy, so referencing
  // `handle.mx.value` inside the worklet throws
  // "[Worklets] Cannot copy value of type `PanGesture`" and, in a Release
  // build, RN escalates that to RCTFatal -> abort(). Capturing the two
  // SharedValues directly keeps the gesture out of the closure.
  const { mx, my, snapTick } = handle;

  const report = useCallback(
    (c: number, r: number) => {
      const nextCols = clamp(Math.round(c), 1, maxCols);
      const nextRows = clamp(Math.round(r), 1, maxRows);
      // The corner snaps on BOTH axes, so the kit's single-axis snap tick can't
      // fire it — trigger the SAME selection tick (haptic only, no size change)
      // here on each (col,row) crossing so it feels identical to the 1D handles.
      snapTick();
      setState({ rows: nextRows, cols: nextCols });
      onSolvedChange(arraySolved(spec, { rows: nextRows, cols: nextCols }));
      onStateChange?.({ rows: nextRows, cols: nextCols });
    },
    [maxCols, maxRows, onSolvedChange, onStateChange, spec, snapTick],
  );

  // Watch the rounded (col,row) pair and report (with its selection tick)
  // whenever either integer crosses. Grab squish + release light-impact come
  // from the kit itself.
  useAnimatedReaction(
    () => ({
      c: Math.round(mx.get()),
      r: Math.round(my.get()),
    }),
    (curr, prev) => {
      if (prev !== null && (curr.c !== prev.c || curr.r !== prev.r)) {
        runOnJS(report)(curr.c, curr.r);
      }
    },
    [report],
  );

  const onLayout = (e: LayoutChangeEvent) => setBoxW(e.nativeEvent.layout.width);

  // Grid + tile geometry (only computed once the plane has a real size).
  const gridCols: number[] = [];
  for (let i = 0; i <= maxCols; i++) gridCols.push(i);
  const gridRows: number[] = [];
  for (let i = 0; i <= maxRows; i++) gridRows.push(i);

  const tiles: React.ReactNode[] = [];
  if (cell > 0) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        tiles.push(
          <Rect
            key={`tile-${r}-${c}`}
            x={plane.x(c + 0.08)}
            y={plane.y(r + 0.92)}
            width={0.84 * plane.pxPerX}
            height={0.84 * plane.pxPerY}
            rx={3}
            fill={palette.cyan[500]}
            fillOpacity={iconUrl ? 0.08 : 0.5}
          />,
        );
        if (iconUrl) {
          tiles.push(
            <SvgImage
              key={`icon-${r}-${c}`}
              href={{ uri: iconUrl }}
              x={plane.x(c + 0.1)}
              y={plane.y(r + 0.9)}
              width={0.8 * plane.pxPerX}
              height={0.8 * plane.pxPerY}
              preserveAspectRatio="xMidYMid meet"
            />,
          );
        }
      }
    }
  }

  const product = rows * cols;

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
              {gridCols.map((i) => (
                <Line
                  key={`v-${i}`}
                  x1={plane.x(i)}
                  y1={plane.y(0)}
                  x2={plane.x(i)}
                  y2={plane.y(maxRows)}
                  stroke={palette.gray[200]}
                  strokeWidth={1}
                />
              ))}
              {gridRows.map((i) => (
                <Line
                  key={`h-${i}`}
                  x1={plane.x(0)}
                  y1={plane.y(i)}
                  x2={plane.x(maxCols)}
                  y2={plane.y(i)}
                  stroke={palette.gray[200]}
                  strokeWidth={1}
                />
              ))}
              {tiles}
            </Svg>
            <MovableHandleView
              handle={handle}
              color={palette.orange[500]}
              ringColor={palette.white}
              accessibilityLabel="array corner handle"
            />
          </View>
        )}
      </View>
      <View style={styles.readout}>
        <View style={styles.stat}>
          <Text style={styles.statValue}>
            {rows} × {cols}
          </Text>
          <Text style={styles.statLabel}>ROWS × COLS</Text>
        </View>
        <View style={styles.divider} />
        <View style={styles.stat}>
          <Text style={styles.statValue}>{product}</Text>
          <Text style={styles.statLabel}>TILES</Text>
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
  statValue: { fontFamily: fonts.bold, fontSize: 22, color: palette.navy[500] },
  statLabel: {
    fontFamily: fonts.semibold,
    fontSize: 11,
    letterSpacing: 1,
    color: palette.charcoal[400],
    marginTop: 2,
  },
  divider: { width: 1, height: 28, backgroundColor: palette.gray[200] },
});
