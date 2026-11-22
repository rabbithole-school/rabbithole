"use client";

/**
 * FunctionGraph (web) — the plainer twin of native FunctionGraph.native.tsx for
 * the `functionGraph` kind: one SVG, pointer events, the same three boards
 * (match a transform, place zeros, place asymptotes). Every rule about where a
 * handle sits and how it snaps is the shared `lib/manipulative/functionGraph`;
 * curves come from `shared/functionCurves`. Only pixels and pointers live here.
 *
 * State is reported from an effect on the board's own state (never from inside
 * a setState updater — see the LiquidManipulative note on render-phase purity).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { KindProps } from "../Manipulative";
import type { FunctionGraphParent, FunctionGraphSpec } from "@/lib/manipulative/types";
import {
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
} from "@/lib/manipulative/functionGraph";
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
} from "@/shared/functionCurves";
import { C } from "../colors";

const BOARD_WIDTH = 520;
const TAP_SLOP = 6;
const GHOST = "#c6cbd1";

export function FunctionGraphManipulative({ spec, onSolvedChange, onStateChange }: KindProps<FunctionGraphSpec>) {
  // The web page scrolls, so the board is sized from the width alone and its
  // controls sit under the plot.
  const layout = useMemo(() => functionGraphLayout(spec, { width: BOARD_WIDTH }), [spec]);
  const report = useCallback(
    (state: FunctionGraphState) => {
      onSolvedChange(functionGraphSolved(spec, state));
      onStateChange?.(state);
    },
    [spec, onSolvedChange, onStateChange],
  );
  const goal = spec.goal;
  if (goal.type === "matchTransform")
    return <TransformBoard spec={spec} parent={goal.parent} layout={layout} report={report} />;
  if (goal.type === "placeZeros") return <ZerosBoard spec={spec} layout={layout} report={report} />;
  return <AsymptotesBoard spec={spec} layout={layout} report={report} />;
}

interface BoardProps {
  spec: FunctionGraphSpec;
  layout: FunctionGraphLayout;
  report: (state: FunctionGraphState) => void;
}

function pathFor(curve: SampleableCurve, layout: FunctionGraphLayout): string {
  return curvePathD(sampleCurve(curve, layout), (p) => functionGraphToPx(layout, p));
}

/**
 * Pointer drags in BOARD pixels. `begin` captures the pointer and remembers
 * where the drag started; `onMove`/`onUp` get the board-pixel position and the
 * distance travelled (for tap detection).
 */
function useBoardPointer(layout: FunctionGraphLayout) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const toBoard = useCallback(
    (e: { clientX: number; clientY: number }): MathPoint => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return { x: 0, y: 0 };
      const s = layout.width / rect.width;
      return { x: (e.clientX - rect.left) * s, y: (e.clientY - rect.top) * s };
    },
    [layout.width],
  );
  return { svgRef, toBoard };
}

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
    <g>
      <rect x={plotLeft} y={plotTop} width={plotWidth} height={plotHeight} fill={C.bg} stroke={C.line} />
      {xs.map((v) => (
        <line key={`gx${v}`} x1={px(v, 0).x} y1={plotTop} x2={px(v, 0).x} y2={plotTop + plotHeight} stroke={C.line} />
      ))}
      {ys.map((v) => (
        <line key={`gy${v}`} x1={plotLeft} y1={px(0, v).y} x2={plotLeft + plotWidth} y2={px(0, v).y} stroke={C.line} />
      ))}
      <line x1={plotLeft} y1={axisY} x2={plotLeft + plotWidth} y2={axisY} stroke={C.navy} strokeWidth={2} />
      {axisX !== null && <line x1={axisX} y1={plotTop} x2={axisX} y2={plotTop + plotHeight} stroke={C.navy} strokeWidth={2} />}
      {functionGraphTickLabels(layout).map((tick, i) => (
        <text key={`t${i}`} x={tick.x} y={tick.y} fontSize={layout.tickFontSize} fill={C.charcoal} textAnchor={tick.anchor}>
          {tick.text}
        </text>
      ))}
    </g>
  );
}

function PlotClip({ layout, id }: { layout: FunctionGraphLayout; id: string }) {
  return (
    <defs>
      <clipPath id={id}>
        <rect x={layout.plotLeft} y={layout.plotTop} width={layout.plotWidth} height={layout.plotHeight} />
      </clipPath>
    </defs>
  );
}

const svgStyle = { width: "100%", maxWidth: BOARD_WIDTH, height: "auto", display: "block", touchAction: "none", margin: "0 auto" } as const;

// ── matchTransform ───────────────────────────────────────────────────────────

function TransformBoard({ spec, parent, layout, report }: BoardProps & { parent: FunctionGraphParent }) {
  const [t, setT] = useState<FunctionGraphTransformState>(() => initialFunctionGraph(spec) as FunctionGraphTransformState);
  const [drag, setDrag] = useState<{ which: "anchor" | "scale"; t: FunctionGraphTransformState; start: MathPoint; px: MathPoint } | null>(null);
  const { svgRef, toBoard } = useBoardPointer(layout);
  useEffect(() => report(t), [t, report]);

  const handles = functionGraphHandles(parent, t);
  const anchorPx = functionGraphToPx(layout, handles.anchor);
  const scalePx = functionGraphToPx(layout, handles.scale);
  const cornerPx = functionGraphToPx(layout, { x: handles.scale.x, y: handles.anchor.y });
  const ghostD = useMemo(() => pathFor(transformCurve(parent, { a: 1, h: 0, k: 0 }), layout), [parent, layout]);
  const liveD = useMemo(() => pathFor(transformCurve(parent, t), layout), [parent, t, layout]);
  const asym = transformAsymptotes(parent, t);

  const down = (which: "anchor" | "scale", px: MathPoint) => (e: ReactPointerEvent<SVGElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ which, t, start: toBoard(e), px });
  };
  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag;
    if (!d) return;
    const now = toBoard(e);
    const raw = functionGraphToMath(layout, { x: d.px.x + now.x - d.start.x, y: d.px.y + now.y - d.start.y });
    const next = d.which === "anchor" ? functionGraphMoveAnchor(spec, parent, d.t, raw) : functionGraphSetScale(spec, parent, d.t, raw.y);
    if (next.a !== t.a || next.h !== t.h || next.k !== t.k || next.b !== t.b) setT(next);
  };
  const end = () => setDrag(null);
  const clipId = `fg-t-${spec.id}`;
  // Clear of the stretch handle, its dotted step and every axis number, on a
  // white backing so grid lines never cut through it.
  const label = functionGraphAnchorLabel(layout, parent, t, (x) => transformValue(parent, t, x));
  const flipped = functionGraphB(t) === -1;

  return (
    <div>
    <svg ref={svgRef} viewBox={`0 0 ${layout.width} ${layout.height}`} style={svgStyle} onPointerMove={onMove} onPointerUp={end} onPointerCancel={end}>
      <PlotClip layout={layout} id={clipId} />
      <GridLayer layout={layout} />
      <g clipPath={`url(#${clipId})`}>
        <path d={ghostD} stroke={GHOST} strokeWidth={3} fill="none" strokeDasharray="2 6" strokeLinecap="round" />
        {asym.vertical.map((x) => {
          const p = functionGraphToPx(layout, { x, y: 0 }).x;
          return <line key={`av${x}`} x1={p} y1={layout.plotTop} x2={p} y2={layout.plotTop + layout.plotHeight} stroke={C.violet} strokeWidth={2} strokeDasharray="8 6" opacity={0.7} />;
        })}
        {asym.horizontal.map((y) => {
          const p = functionGraphToPx(layout, { x: 0, y }).y;
          return <line key={`ah${y}`} x1={layout.plotLeft} y1={p} x2={layout.plotLeft + layout.plotWidth} y2={p} stroke={C.violet} strokeWidth={2} strokeDasharray="8 6" opacity={0.7} />;
        })}
        <path d={liveD} stroke={C.violet} strokeWidth={4} fill="none" strokeLinejoin="round" strokeLinecap="round" />
        <line x1={anchorPx.x} y1={anchorPx.y} x2={cornerPx.x} y2={cornerPx.y} stroke={C.orange} strokeWidth={2} strokeDasharray="3 4" />
        <line x1={cornerPx.x} y1={cornerPx.y} x2={scalePx.x} y2={scalePx.y} stroke={C.orange} strokeWidth={2} strokeDasharray="3 4" />
      </g>
      <rect x={label.box.x} y={label.box.y} width={label.box.width} height={label.box.height} rx={5} fill="#fff" opacity={0.92} />
      <text x={label.x} y={label.y} fontSize={label.fontSize} fontWeight={700} fill={C.navy}>
        {label.text}
      </text>
      <circle cx={scalePx.x} cy={scalePx.y} r={11} fill={C.orange} stroke="#fff" strokeWidth={3} style={{ cursor: "ns-resize" }} onPointerDown={down("scale", scalePx)} aria-label="function graph stretch handle" />
      <circle cx={anchorPx.x} cy={anchorPx.y} r={14} fill={C.violet} stroke="#fff" strokeWidth={3} style={{ cursor: "move" }} onPointerDown={down("anchor", anchorPx)} aria-label="function graph anchor handle" />
    </svg>
    {layout.controls && (
    <div style={{ display: "flex", justifyContent: "center", marginTop: 8 }}>
      <button
        type="button"
        aria-pressed={flipped}
        onClick={() => setT(functionGraphFlip(spec, parent, t))}
        style={{
          minHeight: 40,
          padding: "0 18px",
          borderRadius: 20,
          border: `2px solid ${C.violet}`,
          background: flipped ? C.violet : "#fff",
          color: flipped ? "#fff" : C.violet,
          fontWeight: 700,
          fontSize: 15,
          cursor: "pointer",
        }}
      >
        Flip left–right
      </button>
    </div>
    )}
    </div>
  );
}

// ── placeZeros ───────────────────────────────────────────────────────────────

function ZeroMark({ x, y, touch }: { x: number; y: number; touch: boolean }) {
  return touch ? (
    <g pointerEvents="none">
      <circle cx={x} cy={y} r={14} fill="#fff" stroke={C.orange} strokeWidth={4} />
      <text x={x} y={y + 6} fontSize={17} fontWeight={800} fill={C.orange} textAnchor="middle">∪</text>
    </g>
  ) : (
    <g pointerEvents="none">
      <circle cx={x} cy={y} r={14} fill={C.violet} stroke="#fff" strokeWidth={3} />
      <text x={x} y={y + 6} fontSize={17} fontWeight={800} fill="#fff" textAnchor="middle">×</text>
    </g>
  );
}

function EndArrow({ x, y, up, label, onToggle }: { x: number; y: number; up: boolean; label: string; onToggle: () => void }) {
  return (
    <g role="button" aria-label={`${label} end points ${up ? "up" : "down"}; click to flip`} style={{ cursor: "pointer" }} onClick={onToggle}>
      <rect x={x - 18} y={y - 26} width={36} height={52} rx={10} fill={C.cream} stroke={C.violet} strokeWidth={2} />
      <path
        d={up ? `M${x} ${y - 18} L${x + 9} ${y - 4} L${x + 3} ${y - 4} L${x + 3} ${y + 18} L${x - 3} ${y + 18} L${x - 3} ${y - 4} L${x - 9} ${y - 4} Z` : `M${x} ${y + 18} L${x + 9} ${y + 4} L${x + 3} ${y + 4} L${x + 3} ${y - 18} L${x - 3} ${y - 18} L${x - 3} ${y + 4} L${x - 9} ${y + 4} Z`}
        fill={C.violet}
      />
    </g>
  );
}

function ZerosBoard({ spec, layout, report }: BoardProps) {
  const [slots, setSlots] = useState<FunctionGraphZeroSlot[]>(() => functionGraphInitialSlots(spec));
  const [leftUp, setLeftUp] = useState(true);
  const [rightUp, setRightUp] = useState(true);
  const [drag, setDrag] = useState<{ index: number; start: MathPoint; home: MathPoint; px: MathPoint; moved: boolean } | null>(null);
  const { svgRef, toBoard } = useBoardPointer(layout);
  const state = useMemo(() => functionGraphZerosState(slots, leftUp, rightUp), [slots, leftUp, rightUp]);
  useEffect(() => report(state), [state, report]);

  const axisY = functionGraphAxisY(layout);
  const n = slots.length;
  const homeOf = (i: number): MathPoint => {
    const x = slots[i]?.x;
    return x == null ? functionGraphTraySlot(layout, i, n) : { x: functionGraphToPx(layout, { x, y: 0 }).x, y: axisY };
  };
  const snapAt = (px: MathPoint) => (functionGraphPxInPlot(layout, px) ? functionGraphSnapX(spec, functionGraphToMath(layout, px).x) : null);

  const dragIndex = drag?.moved ? drag.index : null;
  const dragSnapX = drag?.moved ? snapAt(drag.px) : null;
  const previewSlots = useMemo(
    () => (dragIndex === null ? slots : functionGraphDropZero(spec, slots, dragIndex, dragSnapX)),
    [dragIndex, dragSnapX, slots, spec],
  );
  const sketchD = useMemo(() => {
    const preview = functionGraphZerosState(previewSlots, leftUp, rightUp);
    if (preview.zeros.length === 0) return "";
    const { zeros, leading } = functionGraphSketchInput(preview);
    return pathFor(polynomialSketchCurve(zeros, leading, layout), layout);
  }, [previewSlots, leftUp, rightUp, layout]);

  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag) return;
    const now = toBoard(e);
    const dx = now.x - drag.start.x;
    const dy = now.y - drag.start.y;
    const moved = drag.moved || Math.hypot(dx, dy) >= TAP_SLOP;
    setDrag({ ...drag, moved, px: { x: drag.home.x + dx, y: drag.home.y + dy } });
  };
  const onUp = () => {
    if (!drag) return;
    const { index, moved, px } = drag;
    setDrag(null);
    if (!moved) {
      setSlots(slots.map((s, j) => (j === index ? { ...s, touch: !s.touch } : s)));
      return;
    }
    const rawX = functionGraphPxInPlot(layout, px) ? functionGraphToMath(layout, px).x : null;
    setSlots(functionGraphDropZero(spec, slots, index, rawX));
  };
  const clipId = `fg-z-${spec.id}`;
  const midY = layout.plotTop + layout.plotHeight / 2;

  return (
    <svg ref={svgRef} viewBox={`0 0 ${layout.width} ${layout.height}`} style={svgStyle} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => setDrag(null)}>
      <PlotClip layout={layout} id={clipId} />
      <GridLayer layout={layout} />
      <g clipPath={`url(#${clipId})`}>
        {sketchD && <path d={sketchD} stroke={C.violet} strokeWidth={4} fill="none" strokeLinejoin="round" opacity={0.85} />}
      </g>
      {layout.tray && (
        <>
          <rect x={layout.tray.x} y={layout.tray.y} width={layout.tray.width} height={layout.tray.height} rx={14} fill={C.cream} stroke={C.line} />
          <text x={layout.tray.x + 10} y={layout.tray.y + 18} fontSize={12} fill={C.charcoal}>
            Drag each marker to the x-axis. Click it: × crosses, ∪ bounces.
          </text>
        </>
      )}
      <EndArrow x={layout.plotLeft - 24} y={midY} up={leftUp} label="left" onToggle={() => setLeftUp(!leftUp)} />
      <EndArrow x={layout.plotLeft + layout.plotWidth + 24} y={midY} up={rightUp} label="right" onToggle={() => setRightUp(!rightUp)} />
      {slots.map((slot, i) => {
        const dragging = drag?.index === i && drag.moved;
        const snapped = dragging && drag ? snapAt(drag.px) : null;
        const at = dragging && drag
          ? snapped !== null
            ? { x: functionGraphToPx(layout, { x: snapped, y: 0 }).x, y: axisY }
            : drag.px
          : homeOf(i);
        return (
          <g
            key={i}
            style={{ cursor: "grab" }}
            aria-label={`zero marker ${i + 1}, ${slot.touch ? "bounces" : "crosses"}`}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              const home = homeOf(i);
              setDrag({ index: i, start: toBoard(e), home, px: home, moved: false });
            }}
          >
            <circle cx={at.x} cy={at.y} r={22} fill="transparent" />
            <ZeroMark x={at.x} y={at.y} touch={slot.touch} />
          </g>
        );
      })}
    </svg>
  );
}

// ── placeAsymptotes ──────────────────────────────────────────────────────────

function AsymptotesBoard({ spec, layout, report }: BoardProps) {
  const [s, setS] = useState<FunctionGraphAsymptotesState>(() => initialFunctionGraph(spec) as FunctionGraphAsymptotesState);
  const [drag, setDrag] = useState<{ line: number | "h"; start: MathPoint; from: FunctionGraphAsymptotesState } | null>(null);
  const { svgRef, toBoard } = useBoardPointer(layout);
  useEffect(() => report(s), [s, report]);

  const solved = functionGraphSolved(spec, s);
  const goal = spec.goal;
  const curveD = useMemo(
    () => (solved && goal.type === "placeAsymptotes" ? pathFor(rationalCurve(goal.rational), layout) : ""),
    [solved, goal, layout],
  );
  const top = layout.plotTop;
  const bottom = layout.plotTop + layout.plotHeight;
  const hY = s.horizontal == null ? null : functionGraphToPx(layout, { x: 0, y: s.horizontal }).y;

  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag;
    if (!d) return;
    const now = toBoard(e);
    if (d.line === "h") {
      if (d.from.horizontal == null) return;
      const startPx = functionGraphToPx(layout, { x: 0, y: d.from.horizontal }).y;
      const y = functionGraphSnapY(spec, functionGraphToMath(layout, { x: 0, y: startPx + now.y - d.start.y }).y);
      if (y !== s.horizontal) setS({ ...s, horizontal: y });
    } else {
      const i = d.line;
      const startPx = functionGraphToPx(layout, { x: d.from.vertical[i] ?? 0, y: 0 }).x;
      const x = functionGraphSnapX(spec, functionGraphToMath(layout, { x: startPx + now.x - d.start.x, y: 0 }).x);
      if (x !== s.vertical[i]) setS({ ...s, vertical: s.vertical.map((v, j) => (j === i ? x : v)) });
    }
  };
  const end = () => setDrag(null);
  const grab = (line: number | "h") => (e: ReactPointerEvent<SVGElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ line, start: toBoard(e), from: s });
  };
  // Removable holes appear with the payoff curve, as hollow dots on it.
  const holes =
    solved && goal.type === "placeAsymptotes"
      ? (goal.rational.holes ?? [])
          .map((c) => ({ c, y: rationalValue(goal.rational, c) }))
          .filter(({ y }) => Number.isFinite(y) && y >= layout.yMin && y <= layout.yMax)
          .map(({ c, y }) => functionGraphToPx(layout, { x: c, y }))
      : [];
  const clipId = `fg-a-${spec.id}`;

  return (
    <svg ref={svgRef} viewBox={`0 0 ${layout.width} ${layout.height}`} style={svgStyle} onPointerMove={onMove} onPointerUp={end} onPointerCancel={end}>
      <PlotClip layout={layout} id={clipId} />
      <GridLayer layout={layout} />
      <g clipPath={`url(#${clipId})`}>{curveD && <path d={curveD} stroke={C.teal} strokeWidth={4} fill="none" />}</g>
      {holes.map((h) => (
        <circle key={`hole${h.x}`} cx={h.x} cy={h.y} r={6} fill="#fff" stroke={C.teal} strokeWidth={3} />
      ))}
      {hY != null && (
        <g style={{ cursor: "ns-resize" }} onPointerDown={grab("h")} aria-label={`horizontal dashed line at y = ${s.horizontal}`}>
          <rect x={layout.plotLeft} y={hY - 14} width={layout.plotWidth} height={28} fill="transparent" />
          <line x1={layout.plotLeft} y1={hY} x2={layout.plotLeft + layout.plotWidth} y2={hY} stroke={C.orange} strokeWidth={3} strokeDasharray="10 7" />
          <text x={layout.plotLeft + layout.plotWidth + 4} y={hY + 4} fontSize={13} fontWeight={700} fill={C.orange}>
            y = {s.horizontal}
          </text>
        </g>
      )}
      {s.vertical.map((x, i) => {
        const px = functionGraphToPx(layout, { x, y: 0 }).x;
        return (
          <g key={i} style={{ cursor: "ew-resize" }} onPointerDown={grab(i)} aria-label={`vertical dashed line ${i + 1} at x = ${x}`}>
            <rect x={px - 14} y={top} width={28} height={bottom - top} fill="transparent" />
            <line x1={px} y1={top} x2={px} y2={bottom} stroke={C.violet} strokeWidth={3} strokeDasharray="10 7" />
            <text x={px} y={top - 3} fontSize={13} fontWeight={700} fill={C.violet} textAnchor="middle">
              x = {x}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
