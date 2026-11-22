/**
 * FunctionGraph (native) — shape a graph by hand, the iPad-first renderer for
 * the `functionGraph` kind (see FunctionGraphSpec in vendor/manipulative/types).
 * Three boards, one per goal:
 *   • matchTransform  — a faint parent curve, a live curve with two handles:
 *                       the anchor (vertex / corner / centre) sets h and k, the
 *                       stretch handle one step to its right sets a. The anchor's
 *                       coordinates are shown; the live equation never is.
 *   • placeZeros      — a tray of markers to drag onto the x-axis, tap to switch
 *                       crosses ↔ bounces, and two end arrows; a sketch of the
 *                       polynomial those choices describe redraws live.
 *   • placeAsymptotes — dashed lines to drag onto the asymptotes; the true curve
 *                       appears only once they are right.
 *
 * Every rule about where a handle sits and how it snaps lives in the shared,
 * tested vendor/manipulative/functionGraph (the web renderer runs the same
 * code); curves come from vendor/shared/functionCurves. This file owns only
 * pixels and touches.
 *
 * Gestures: each handle is its own small RN view with a container-level Pan
 * (gesture-handler v2 has no per-SVG-element detector — see kit.tsx). Positions
 * are React state, so the handle and the curve always move together, one snap
 * at a time. The Pan's callbacks reach JS through stable functions that read
 * the latest props from a ref, so the gesture object survives re-renders mid-drag.
 * No runOnJS from an animation callback (the React Compiler crash note in
 * Rekenrek.native.tsx).
 */

import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, useWindowDimensions, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import Svg, { Circle, ClipPath, Defs, G, Line, Path, Rect, Text as SvgText } from "react-native-svg";

import {
  FUNCTION_GRAPH_LANDSCAPE_CHROME,
  functionGraphAnchorLabel,
  functionGraphAxisX,
  functionGraphAxisY,
  functionGraphB,
  functionGraphDropZero,
  functionGraphFlip,
  functionGraphHandles,
  functionGraphInitialSlots,
  functionGraphLayout,
  functionGraphMoveAnchor,
  functionGraphPxInPlot,
  functionGraphSetScale,
  functionGraphSketchInput,
  functionGraphSnapX,
  functionGraphSnapY,
  functionGraphSolved,
  functionGraphTickLabels,
  functionGraphToMath,
  functionGraphToPx,
  functionGraphTraySlot,
  functionGraphZerosState,
  initialFunctionGraph,
  type FunctionGraphAsymptotesState,
  type FunctionGraphLayout,
  type FunctionGraphState,
  type FunctionGraphTransformState,
  type FunctionGraphZeroSlot,
  type MathPoint,
} from "../../../vendor/manipulative/functionGraph";
import type { FunctionGraphParent, FunctionGraphSpec } from "../../../vendor/manipulative/types";
import {
  curvePathD,
  polynomialSketchCurve,
  rationalCurve,
  rationalValue,
  sampleCurve,
  transformAsymptotes,
  transformCurve,
  transformValue,
  type SampleableCurve,
} from "../../../vendor/shared/functionCurves";
import {
  GRAB_MS,
  GRAB_SCALE,
  ManipulativeScrollContext,
  lightImpact,
  mediumImpact,
  selectionTick,
  type KindProps,
} from "./kit";
import { fonts, palette } from "@/theme";

/** Touch target edge (pt) for a point handle — above the 44pt minimum. */
const HIT = 52;
/** A tap is a touch that moved less than this (pt). */
const TAP_SLOP = 8;
const MAX_WIDTH = 600;

const INK = palette.navy[500];
const GRID = palette.gray[200];
const MUTED = palette.charcoal[300];
const LIVE = palette.violet[500];
const STRETCH = palette.orange[500];
const GHOST = palette.gray[300];

export function FunctionGraphNative({
  spec,
  onSolvedChange,
  onStateChange,
}: KindProps<FunctionGraphSpec, FunctionGraphState>) {
  const [boxW, setBoxW] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setBoxW(e.nativeEvent.layout.width);
  // BunnyPads sit in landscape, where the practice card is short: the board is
  // sized from the height left under the header and above the pinned Done lane
  // (see FUNCTION_GRAPH_LANDSCAPE_CHROME), and its controls move beside the plot
  // when that gives the bigger plot. Portrait has the height to stack them.
  const screen = useWindowDimensions();
  const landscape = screen.width > screen.height;
  const frameHeight = landscape ? Math.max(300, screen.height - FUNCTION_GRAPH_LANDSCAPE_CHROME) : undefined;
  const layout = useMemo(
    () => (boxW > 0 ? functionGraphLayout(spec, { width: Math.min(boxW, MAX_WIDTH), height: frameHeight }) : null),
    [spec, boxW, frameHeight],
  );

  // Reporting is shared by every board: the board owns its state, this sends
  // it up (and the optimistic self-check) whenever it changes, including on
  // mount — the practice card needs a state before the first touch.
  const report = useCallback(
    (state: FunctionGraphState) => {
      onSolvedChange(functionGraphSolved(spec, state));
      onStateChange?.(state);
    },
    [spec, onSolvedChange, onStateChange],
  );

  const goal = spec.goal;
  return (
    <View style={styles.wrap} onLayout={onLayout}>
      {layout &&
        (goal.type === "matchTransform" ? (
          <TransformBoard spec={spec} parent={goal.parent} layout={layout} report={report} />
        ) : goal.type === "placeZeros" ? (
          <ZerosBoard spec={spec} layout={layout} report={report} />
        ) : (
          <AsymptotesBoard spec={spec} layout={layout} report={report} />
        ))}
    </View>
  );
}

interface BoardProps {
  spec: FunctionGraphSpec;
  layout: FunctionGraphLayout;
  report: (state: FunctionGraphState) => void;
}

// ── shared pieces ────────────────────────────────────────────────────────────

function pathFor(curve: SampleableCurve, layout: FunctionGraphLayout): string {
  const lines = sampleCurve(curve, layout);
  return curvePathD(lines, (p) => functionGraphToPx(layout, p));
}

/** Grid, axes and numbered ticks. Static per layout. */
function GridLayer({ layout }: { layout: FunctionGraphLayout }) {
  const { xMin, xMax, yMin, yMax, plotLeft, plotTop, plotWidth, plotHeight } = layout;
  const px = (x: number, y: number) => functionGraphToPx(layout, { x, y });
  const xs: number[] = [];
  for (let v = xMin; v <= xMax; v++) xs.push(v);
  const ys: number[] = [];
  for (let v = yMin; v <= yMax; v++) ys.push(v);
  const axisY = functionGraphAxisY(layout);
  const axisX = functionGraphAxisX(layout);
  return (
    <G>
      <Rect x={plotLeft} y={plotTop} width={plotWidth} height={plotHeight} fill={palette.white} stroke={GRID} strokeWidth={1} />
      {xs.map((v) => (
        <Line key={`gx${v}`} x1={px(v, 0).x} y1={plotTop} x2={px(v, 0).x} y2={plotTop + plotHeight} stroke={GRID} strokeWidth={1} />
      ))}
      {ys.map((v) => (
        <Line key={`gy${v}`} x1={plotLeft} y1={px(0, v).y} x2={plotLeft + plotWidth} y2={px(0, v).y} stroke={GRID} strokeWidth={1} />
      ))}
      <Line x1={plotLeft} y1={axisY} x2={plotLeft + plotWidth} y2={axisY} stroke={INK} strokeWidth={2} />
      {axisX !== null && <Line x1={axisX} y1={plotTop} x2={axisX} y2={plotTop + plotHeight} stroke={INK} strokeWidth={2} />}
      {functionGraphTickLabels(layout).map((tick, i) => (
        <SvgText
          key={`t${i}`}
          x={tick.x}
          y={tick.y}
          fontSize={layout.tickFontSize}
          fontFamily={fonts.medium}
          fill={palette.charcoal[500]}
          textAnchor={tick.anchor}
        >
          {tick.text}
        </SvgText>
      ))}
    </G>
  );
}

function PlotClip({ layout, id }: { layout: FunctionGraphLayout; id: string }) {
  return (
    <Defs>
      <ClipPath id={id}>
        <Rect x={layout.plotLeft} y={layout.plotTop} width={layout.plotWidth} height={layout.plotHeight} />
      </ClipPath>
    </Defs>
  );
}

interface DragHandleProps {
  /** Centre of the touch target, in board pixels. */
  cx: number;
  cy: number;
  w?: number;
  h?: number;
  onStart?: () => void;
  onMove: (dx: number, dy: number) => void;
  /** `completed` is false when the touch was cancelled (e.g. the page scrolled). */
  onEnd: (dx: number, dy: number, completed: boolean) => void;
  accessibilityLabel: string;
  children: ReactNode;
}

/**
 * A grabbable region: its own Pan, the shared grab "squish" and haptics, and
 * translation deltas reported to JS. Callbacks are read through a ref, so the
 * memoised gesture never has to be rebuilt while a finger is down.
 */
function DragHandle(props: DragHandleProps) {
  const { cx, cy, w = HIT, h = HIT, accessibilityLabel, children } = props;
  const { onStart, onMove, onEnd } = props;
  const scale = useSharedValue(1);
  const scrollRef = useContext(ManipulativeScrollContext);

  const begin = () => {
    mediumImpact();
    onStart?.();
  };
  const end = (dx: number, dy: number, completed: boolean) => {
    lightImpact();
    onEnd(dx, dy, completed);
  };

  // Built in the component body, not memoised, as the shared kit's handle does:
  // GestureDetector diffs the gesture object, so each render's callbacks are the
  // current ones and no ref has to carry them.
  let gesture = Gesture.Pan()
    .minDistance(0)
    .onBegin(() => {
      "worklet";
      scale.set(withTiming(GRAB_SCALE, { duration: GRAB_MS }));
      runOnJS(begin)();
    })
    .onUpdate((e) => {
      "worklet";
      runOnJS(onMove)(e.translationX, e.translationY);
    })
    .onFinalize((e, success) => {
      "worklet";
      scale.set(withTiming(1, { duration: GRAB_MS }));
      runOnJS(end)(e.translationX, e.translationY, success);
    });
  if (scrollRef) {
    gesture = gesture.blocksExternalGesture(scrollRef as Parameters<typeof gesture.blocksExternalGesture>[0]);
  }

  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        accessible
        accessibilityLabel={accessibilityLabel}
        style={[styles.handle, { left: cx - w / 2, top: cy - h / 2, width: w, height: h }, style]}
      >
        {children}
      </Animated.View>
    </GestureDetector>
  );
}

function Knob({ color, size = 26, hollow = false }: { color: string; size?: number; hollow?: boolean }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: hollow ? palette.white : color,
        borderWidth: hollow ? 4 : 3,
        borderColor: hollow ? color : palette.white,
      }}
    />
  );
}

// ── matchTransform ───────────────────────────────────────────────────────────

function TransformBoard({ spec, parent, layout, report }: BoardProps & { parent: FunctionGraphParent }) {
  const [t, setT] = useState<FunctionGraphTransformState>(
    () => initialFunctionGraph(spec) as FunctionGraphTransformState,
  );
  const tRef = useRef(t);
  const dragRef = useRef<{ t: FunctionGraphTransformState; px: MathPoint } | null>(null);

  useEffect(() => {
    report(t);
  }, [t, report]);

  const commit = (next: FunctionGraphTransformState) => {
    const cur = tRef.current;
    if (next.a === cur.a && next.h === cur.h && next.k === cur.k && next.b === cur.b) return;
    tRef.current = next;
    setT(next);
    selectionTick();
  };

  const handles = functionGraphHandles(parent, t);
  const anchorPx = functionGraphToPx(layout, handles.anchor);
  const scalePx = functionGraphToPx(layout, handles.scale);
  const cornerPx = functionGraphToPx(layout, { x: handles.scale.x, y: handles.anchor.y });

  const ghostD = useMemo(() => pathFor(transformCurve(parent, { a: 1, h: 0, k: 0 }), layout), [parent, layout]);
  const liveD = useMemo(() => pathFor(transformCurve(parent, t), layout), [parent, t, layout]);
  const asym = transformAsymptotes(parent, t);

  const startDrag = (px: MathPoint) => {
    dragRef.current = { t: tRef.current, px };
  };
  const rawAt = (dx: number, dy: number): MathPoint | null => {
    const d = dragRef.current;
    return d ? functionGraphToMath(layout, { x: d.px.x + dx, y: d.px.y + dy }) : null;
  };

  const clipId = "fg-transform-clip";
  // Clear of the stretch handle, its dotted step and every axis number, on a
  // white backing so grid lines never cut through it.
  const label = functionGraphAnchorLabel(layout, parent, t, (x) => transformValue(parent, t, x));
  const controls = layout.controls;

  return (
    <View style={{ width: layout.width, height: layout.height }}>
      <Svg width={layout.width} height={layout.height}>
        <PlotClip layout={layout} id={clipId} />
        <GridLayer layout={layout} />
        <G clipPath={`url(#${clipId})`}>
          <Path d={ghostD} stroke={GHOST} strokeWidth={3} fill="none" strokeDasharray="2 6" strokeLinecap="round" />
          {asym.vertical.map((x) => {
            const p = functionGraphToPx(layout, { x, y: 0 }).x;
            return <Line key={`av${x}`} x1={p} y1={layout.plotTop} x2={p} y2={layout.plotTop + layout.plotHeight} stroke={LIVE} strokeWidth={2} strokeDasharray="8 6" opacity={0.7} />;
          })}
          {asym.horizontal.map((y) => {
            const p = functionGraphToPx(layout, { x: 0, y }).y;
            return <Line key={`ah${y}`} x1={layout.plotLeft} y1={p} x2={layout.plotLeft + layout.plotWidth} y2={p} stroke={LIVE} strokeWidth={2} strokeDasharray="8 6" opacity={0.7} />;
          })}
          <Path d={liveD} stroke={LIVE} strokeWidth={4} fill="none" strokeLinejoin="round" strokeLinecap="round" />
          {/* the stretch as a step: one unit across from the anchor, then up or down by a·f(u) */}
          <Line x1={anchorPx.x} y1={anchorPx.y} x2={cornerPx.x} y2={cornerPx.y} stroke={STRETCH} strokeWidth={2} strokeDasharray="3 4" />
          <Line x1={cornerPx.x} y1={cornerPx.y} x2={scalePx.x} y2={scalePx.y} stroke={STRETCH} strokeWidth={2} strokeDasharray="3 4" />
        </G>
        <Rect x={label.box.x} y={label.box.y} width={label.box.width} height={label.box.height} rx={5} fill={palette.white} opacity={0.92} />
        <SvgText x={label.x} y={label.y} fontSize={label.fontSize} fontFamily={fonts.bold} fill={INK} textAnchor="start">
          {label.text}
        </SvgText>
      </Svg>
      <DragHandle
        cx={scalePx.x}
        cy={scalePx.y}
        accessibilityLabel="function graph stretch handle"
        onStart={() => startDrag(scalePx)}
        onMove={(dx, dy) => {
          const raw = rawAt(dx, dy);
          const d = dragRef.current;
          if (raw && d) commit(functionGraphSetScale(spec, parent, { ...tRef.current, a: d.t.a }, raw.y));
        }}
        onEnd={() => {
          dragRef.current = null;
        }}
      >
        <Knob color={STRETCH} size={22} />
      </DragHandle>
      <DragHandle
        cx={anchorPx.x}
        cy={anchorPx.y}
        accessibilityLabel="function graph anchor handle"
        onStart={() => startDrag(anchorPx)}
        onMove={(dx, dy) => {
          const raw = rawAt(dx, dy);
          const d = dragRef.current;
          if (raw && d) commit(functionGraphMoveAnchor(spec, parent, d.t, raw));
        }}
        onEnd={() => {
          dragRef.current = null;
        }}
      >
        <Knob color={LIVE} size={28} />
      </DragHandle>
      {/* A drag can only move or stretch the curve; a mirror in a vertical line
          needs its own control, labelled in words. Offered only where a flip
          changes the graph (not for x² or |x|). */}
      {controls && (
        <View style={[styles.controls, { left: controls.x, top: controls.y, width: controls.width }]}>
          <Pressable
            onPress={() => commit(functionGraphFlip(spec, parent, tRef.current))}
            accessibilityRole="button"
            accessibilityLabel={`Flip left–right. ${functionGraphB(t) === -1 ? "Now flipped." : "Not flipped."}`}
            style={({ pressed }) => [styles.flipButton, functionGraphB(t) === -1 && styles.flipButtonOn, pressed && { opacity: 0.7 }]}
          >
            <Text style={[styles.flipText, functionGraphB(t) === -1 && styles.flipTextOn]}>Flip left–right</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

// ── placeZeros ───────────────────────────────────────────────────────────────

function ZeroGlyph({ touch }: { touch: boolean }) {
  // Two states that cannot be confused: a solid violet disc with a white ×
  // (the graph passes THROUGH) vs a white disc in a thick orange ring with an
  // orange ∪ (the graph touches and turns back).
  return (
    <View
      style={[
        styles.zero,
        touch
          ? { backgroundColor: palette.white, borderColor: STRETCH, borderWidth: 4 }
          : { backgroundColor: LIVE, borderColor: palette.white, borderWidth: 3 },
      ]}
    >
      <Text style={[styles.zeroGlyph, { color: touch ? STRETCH : palette.white }]}>{touch ? "∪" : "×"}</Text>
    </View>
  );
}

function EndToggle({ up, side, onPress, x, y }: { up: boolean; side: "left" | "right"; onPress: () => void; x: number; y: number }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${side} end points ${up ? "up" : "down"}. Tap to flip.`}
      style={[styles.endToggle, { left: x - 22, top: y - 30 }]}
    >
      <Svg width={44} height={60}>
        <Rect x={2} y={2} width={40} height={56} rx={12} fill={palette.violet[50]} stroke={LIVE} strokeWidth={2} />
        {up ? (
          <Path d="M22 12 L32 28 L25 28 L25 48 L19 48 L19 28 L12 28 Z" fill={LIVE} />
        ) : (
          <Path d="M22 48 L32 32 L25 32 L25 12 L19 12 L19 32 L12 32 Z" fill={LIVE} />
        )}
      </Svg>
    </Pressable>
  );
}

function ZerosBoard({ spec, layout, report }: BoardProps) {
  const [slots, setSlots] = useState<FunctionGraphZeroSlot[]>(() => functionGraphInitialSlots(spec));
  const [leftUp, setLeftUp] = useState(true);
  const [rightUp, setRightUp] = useState(true);
  const [drag, setDrag] = useState<{ index: number; px: MathPoint } | null>(null);
  const dragStartRef = useRef<MathPoint | null>(null);
  const lastSnapRef = useRef<number | null>(null);

  const state = useMemo(() => functionGraphZerosState(slots, leftUp, rightUp), [slots, leftUp, rightUp]);
  useEffect(() => {
    report(state);
  }, [state, report]);

  const axisY = functionGraphAxisY(layout);
  const n = slots.length;
  const homeOf = (i: number): MathPoint => {
    const x = slots[i]?.x;
    return x == null ? functionGraphTraySlot(layout, i, n) : { x: functionGraphToPx(layout, { x, y: 0 }).x, y: axisY };
  };

  // While a marker is over the plot, the sketch previews it at its snapped x.
  // Keyed on the snapped x (not the finger), so the curve is resampled once per
  // grid step rather than every frame.
  const dragIndex = drag?.index ?? null;
  const dragSnapX =
    drag && functionGraphPxInPlot(layout, drag.px)
      ? functionGraphSnapX(spec, functionGraphToMath(layout, drag.px).x)
      : null;
  const previewSlots = useMemo(() => {
    if (dragIndex === null) return slots;
    return functionGraphDropZero(spec, slots, dragIndex, dragSnapX);
  }, [dragIndex, dragSnapX, slots, spec]);
  const sketchD = useMemo(() => {
    const preview = functionGraphZerosState(previewSlots, leftUp, rightUp);
    if (preview.zeros.length === 0) return "";
    const { zeros, leading } = functionGraphSketchInput(preview);
    return pathFor(polynomialSketchCurve(zeros, leading, layout), layout);
  }, [previewSlots, leftUp, rightUp, layout]);

  const clipId = "fg-zeros-clip";
  const tray = layout.tray;
  const midY = layout.plotTop + layout.plotHeight / 2;

  return (
    <View style={{ width: layout.width, height: layout.height }}>
      <Svg width={layout.width} height={layout.height}>
        <PlotClip layout={layout} id={clipId} />
        <GridLayer layout={layout} />
        <G clipPath={`url(#${clipId})`}>
          {sketchD ? <Path d={sketchD} stroke={LIVE} strokeWidth={4} fill="none" strokeLinejoin="round" strokeLinecap="round" opacity={0.85} /> : null}
        </G>
        {tray && (
          <Rect x={tray.x} y={tray.y} width={tray.width} height={tray.height} rx={14} fill={palette.gray[50]} stroke={GRID} strokeWidth={1} />
        )}
      </Svg>
      {tray && (
        <Text style={[styles.trayHint, { left: tray.x + 10, top: tray.y + 6, width: tray.width - 20 }]}>
          Drag each marker to the x-axis. Tap it: × crosses, ∪ bounces.
        </Text>
      )}
      <EndToggle up={leftUp} side="left" x={layout.plotLeft - 24} y={midY} onPress={() => { selectionTick(); setLeftUp((v) => !v); }} />
      <EndToggle up={rightUp} side="right" x={layout.plotLeft + layout.plotWidth + 24} y={midY} onPress={() => { selectionTick(); setRightUp((v) => !v); }} />
      {slots.map((slot, i) => {
        const dragging = drag?.index === i;
        let at = homeOf(i);
        if (dragging && drag) {
          at = functionGraphPxInPlot(layout, drag.px)
            ? { x: functionGraphToPx(layout, { x: functionGraphSnapX(spec, functionGraphToMath(layout, drag.px).x), y: 0 }).x, y: axisY }
            : drag.px;
        }
        return (
          <DragHandle
            key={`z${i}`}
            cx={at.x}
            cy={at.y}
            accessibilityLabel={`zero marker ${i + 1}, ${slot.x == null ? "in the tray" : `at x = ${slot.x}`}, ${slot.touch ? "bounces" : "crosses"}`}
            onStart={() => {
              dragStartRef.current = homeOf(i);
              lastSnapRef.current = slot.x;
            }}
            onMove={(dx, dy) => {
              const start = dragStartRef.current;
              if (!start || Math.hypot(dx, dy) < TAP_SLOP) return;
              const px = { x: start.x + dx, y: start.y + dy };
              setDrag({ index: i, px });
              const snapped = functionGraphPxInPlot(layout, px) ? functionGraphSnapX(spec, functionGraphToMath(layout, px).x) : null;
              if (snapped !== lastSnapRef.current) {
                lastSnapRef.current = snapped;
                if (snapped !== null) selectionTick();
              }
            }}
            onEnd={(dx, dy, completed) => {
              const start = dragStartRef.current;
              dragStartRef.current = null;
              setDrag(null);
              if (!start) return;
              if (Math.hypot(dx, dy) < TAP_SLOP) {
                if (completed) setSlots((prev) => prev.map((s, j) => (j === i ? { ...s, touch: !s.touch } : s)));
                return;
              }
              const px = { x: start.x + dx, y: start.y + dy };
              const rawX = functionGraphPxInPlot(layout, px) ? functionGraphToMath(layout, px).x : null;
              setSlots((prev) => functionGraphDropZero(spec, prev, i, rawX));
            }}
          >
            <ZeroGlyph touch={slot.touch} />
          </DragHandle>
        );
      })}
    </View>
  );
}

// ── placeAsymptotes ──────────────────────────────────────────────────────────

function AsymptotesBoard({ spec, layout, report }: BoardProps) {
  const [s, setS] = useState<FunctionGraphAsymptotesState>(
    () => initialFunctionGraph(spec) as FunctionGraphAsymptotesState,
  );
  const sRef = useRef(s);
  const startRef = useRef<FunctionGraphAsymptotesState | null>(null);
  useEffect(() => {
    report(s);
  }, [s, report]);

  const commit = (next: FunctionGraphAsymptotesState) => {
    const cur = sRef.current;
    if (next.horizontal === cur.horizontal && next.vertical.every((v, i) => v === cur.vertical[i])) return;
    sRef.current = next;
    setS(next);
    selectionTick();
  };

  const solved = functionGraphSolved(spec, s);
  const goal = spec.goal;
  const curveD = useMemo(
    () => (solved && goal.type === "placeAsymptotes" ? pathFor(rationalCurve(goal.rational), layout) : ""),
    [solved, goal, layout],
  );

  // Removable holes appear with the payoff curve, as hollow dots on it.
  const holes =
    solved && goal.type === "placeAsymptotes"
      ? (goal.rational.holes ?? [])
          .map((c) => ({ c, y: rationalValue(goal.rational, c) }))
          .filter(({ y }) => Number.isFinite(y) && y >= layout.yMin && y <= layout.yMax)
          .map(({ c, y }) => functionGraphToPx(layout, { x: c, y }))
      : [];
  const clipId = "fg-asym-clip";
  const top = layout.plotTop;
  const bottom = layout.plotTop + layout.plotHeight;
  const hY = s.horizontal == null ? null : functionGraphToPx(layout, { x: 0, y: s.horizontal }).y;

  return (
    <View style={{ width: layout.width, height: layout.height }}>
      <Svg width={layout.width} height={layout.height}>
        <PlotClip layout={layout} id={clipId} />
        <GridLayer layout={layout} />
        <G clipPath={`url(#${clipId})`}>
          {curveD ? <Path d={curveD} stroke={palette.darkCyan[500]} strokeWidth={4} fill="none" strokeLinejoin="round" strokeLinecap="round" /> : null}
        </G>
        {holes.map((h) => (
          <Circle key={`hole${h.x}`} cx={h.x} cy={h.y} r={6} fill={palette.white} stroke={palette.darkCyan[500]} strokeWidth={3} />
        ))}
        {s.vertical.map((x, i) => {
          const px = functionGraphToPx(layout, { x, y: 0 }).x;
          return <Line key={`v${i}`} x1={px} y1={top} x2={px} y2={bottom} stroke={LIVE} strokeWidth={3} strokeDasharray="10 7" />;
        })}
        {hY != null && (
          <Line x1={layout.plotLeft} y1={hY} x2={layout.plotLeft + layout.plotWidth} y2={hY} stroke={STRETCH} strokeWidth={3} strokeDasharray="10 7" />
        )}
        {s.vertical.map((x, i) => (
          <SvgText key={`vl${i}`} x={functionGraphToPx(layout, { x, y: 0 }).x} y={top - 3} fontSize={13} fontFamily={fonts.bold} fill={LIVE} textAnchor="middle">
            {`x = ${x}`}
          </SvgText>
        ))}
        {hY != null && (
          <SvgText x={layout.plotLeft + layout.plotWidth + 4} y={hY + 4} fontSize={13} fontFamily={fonts.bold} fill={STRETCH} textAnchor="start">
            {`y = ${s.horizontal}`}
          </SvgText>
        )}
      </Svg>
      {hY != null && (
        <DragHandle
          cx={layout.plotLeft + layout.plotWidth / 2}
          cy={hY}
          w={layout.plotWidth}
          h={40}
          accessibilityLabel={`horizontal dashed line at y = ${s.horizontal}`}
          onStart={() => {
            startRef.current = sRef.current;
          }}
          onMove={(_dx, dy) => {
            const start = startRef.current;
            if (!start || start.horizontal == null) return;
            const startPx = functionGraphToPx(layout, { x: 0, y: start.horizontal }).y;
            const y = functionGraphSnapY(spec, functionGraphToMath(layout, { x: 0, y: startPx + dy }).y);
            commit({ ...sRef.current, horizontal: y });
          }}
          onEnd={() => {
            startRef.current = null;
          }}
        >
          <View style={styles.lineGrip} />
        </DragHandle>
      )}
      {s.vertical.map((x, i) => (
        <DragHandle
          key={`vh${i}`}
          cx={functionGraphToPx(layout, { x, y: 0 }).x}
          cy={layout.plotTop + layout.plotHeight / 2}
          w={40}
          h={layout.plotHeight}
          accessibilityLabel={`vertical dashed line ${i + 1} at x = ${x}`}
          onStart={() => {
            startRef.current = sRef.current;
          }}
          onMove={(dx) => {
            const start = startRef.current;
            if (!start) return;
            const startPx = functionGraphToPx(layout, { x: start.vertical[i] ?? 0, y: 0 }).x;
            const nx = functionGraphSnapX(spec, functionGraphToMath(layout, { x: startPx + dx, y: 0 }).x);
            const vertical = sRef.current.vertical.map((v, j) => (j === i ? nx : v));
            commit({ ...sRef.current, vertical });
          }}
          onEnd={() => {
            startRef.current = null;
          }}
        >
          <View style={styles.lineGripVertical} />
        </DragHandle>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: "100%", alignItems: "center", overflow: "visible" },
  controls: { position: "absolute", alignItems: "center" },
  trayHint: { position: "absolute", fontFamily: fonts.medium, fontSize: 12.5, lineHeight: 16, color: MUTED },
  flipButton: {
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 22,
    borderWidth: 2,
    borderColor: LIVE,
    backgroundColor: palette.white,
    alignItems: "center",
    justifyContent: "center",
  },
  flipButtonOn: { backgroundColor: LIVE },
  flipText: { fontFamily: fonts.bold, fontSize: 16, color: LIVE },
  flipTextOn: { color: palette.white },
  handle: { position: "absolute", alignItems: "center", justifyContent: "center" },
  zero: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  zeroGlyph: { fontFamily: fonts.bold, fontSize: 18, lineHeight: 20, marginTop: -1 },
  endToggle: { position: "absolute", width: 44, height: 60 },
  lineGrip: { width: 34, height: 8, borderRadius: 4, backgroundColor: STRETCH, opacity: 0.9 },
  lineGripVertical: { width: 8, height: 34, borderRadius: 4, backgroundColor: LIVE, opacity: 0.9 },
});
