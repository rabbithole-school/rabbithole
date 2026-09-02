"use client";

/**
 * CoordinatePlane — the 2D sibling of `numberline`: drag 1-3 Mafs movable
 * points onto a real x/y coordinate plane (first-quadrant or four-quadrant),
 * snapped to a grid. Isolates plotting/reading coordinates, reflections, and
 * completing a rectangle from three given vertices — iPad-first geometry.
 *
 * Unlike `numberline` (which fakes a 0..SCALE internal axis because Mafs locks
 * x/y unit scale equal), a coordinate plane genuinely IS 2D, so it renders in
 * its real [xMin,xMax] × [yMin,yMax] viewBox directly — no internal rescale.
 *
 * Up to 3 draggable points are needed, so `useMovablePoint` (a hook) is called
 * an UNCONDITIONAL fixed 3 times (rules of hooks) and only the first
 * `spec.draggable.length` are used/rendered — the same trick the native
 * sibling uses with `useMovableHandle`.
 */
import { Fragment, useEffect } from "react";
import { Line, Mafs, Point, Text, useMovablePoint } from "mafs";
import type { KindProps } from "../Manipulative";
import type { CoordinatePlaneSpec } from "@/lib/manipulative/types";
import { C } from "../colors";
import { clamp, coordinatePlaneSolved, snapToGrid } from "@/lib/manipulative/logic";

const DRAGGABLE_COLORS = [C.violet, C.orange, C.cyan] as const;

export function CoordinatePlaneManipulative({
  spec,
  onSolvedChange,
  onStateChange,
}: KindProps<CoordinatePlaneSpec>) {
  const { xMin, xMax, yMin, yMax, gridStep } = spec;
  const count = spec.draggable.length;

  // Always call the hook 3 times (never conditionally) — index i is only
  // wired live when i < count; the rest sit inert at a harmless fallback.
  const starts = [0, 1, 2].map((i) => spec.draggable[i]?.start ?? spec.draggable[0].start);
  const constrain = (p: readonly [number, number]): [number, number] => {
    const x = clamp(snapToGrid(p[0], xMin, xMax, gridStep), xMin, xMax);
    const y = clamp(snapToGrid(p[1], yMin, yMax, gridStep), yMin, yMax);
    return [x, y];
  };
  const p0 = useMovablePoint([starts[0].x, starts[0].y], {
    constrain,
    color: DRAGGABLE_COLORS[0],
  });
  const p1 = useMovablePoint([starts[1].x, starts[1].y], {
    constrain,
    color: DRAGGABLE_COLORS[1],
  });
  const p2 = useMovablePoint([starts[2].x, starts[2].y], {
    constrain,
    color: DRAGGABLE_COLORS[2],
  });
  const handles = [p0, p1, p2].slice(0, count);
  const points = handles.map((h) => ({ x: h.point[0], y: h.point[1] }));

  useEffect(() => {
    onSolvedChange(coordinatePlaneSolved(spec, { points }));
    onStateChange?.({ points });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, JSON.stringify(points), onSolvedChange, onStateChange]);

  // Grid lines at every gridStep across both extents.
  const xTicks: number[] = [];
  for (let v = xMin; v <= xMax + 1e-9; v += gridStep) xTicks.push(Math.round(v * 1e6) / 1e6);
  const yTicks: number[] = [];
  for (let v = yMin; v <= yMax + 1e-9; v += gridStep) yTicks.push(Math.round(v * 1e6) / 1e6);

  const pad = gridStep * 0.75;

  return (
    <div className="manip-mafs">
      <Mafs viewBox={{ x: [xMin - pad, xMax + pad], y: [yMin - pad, yMax + pad] }} pan={false} zoom={false} height={320}>
        {/* grid */}
        {xTicks.map((v, i) => (
          <Line.Segment key={`gx${i}`} point1={[v, yMin]} point2={[v, yMax]} color={C.line} weight={1} />
        ))}
        {yTicks.map((v, i) => (
          <Line.Segment key={`gy${i}`} point1={[xMin, v]} point2={[xMax, v]} color={C.line} weight={1} />
        ))}
        {/* axes (only the ones actually crossing the visible range) */}
        {yMin <= 0 && yMax >= 0 && <Line.Segment point1={[xMin, 0]} point2={[xMax, 0]} color={C.navy} weight={2} />}
        {xMin <= 0 && xMax >= 0 && <Line.Segment point1={[0, yMin]} point2={[0, yMax]} color={C.navy} weight={2} />}
        {/* axis tick labels */}
        {yMin <= 0 && yMax >= 0 &&
          xTicks.map((v, i) => (
            <Text key={`xt${i}`} x={v} y={-pad * 0.55} size={14} color={C.charcoal}>
              {String(v)}
            </Text>
          ))}
        {xMin <= 0 && xMax >= 0 &&
          yTicks.map((v, i) => (
            <Text key={`yt${i}`} x={-pad * 0.55} y={v} size={14} color={C.charcoal}>
              {String(v)}
            </Text>
          ))}
        {/* fixed decorative segments (polygon outlines, etc.) */}
        {(spec.segments ?? []).map((seg, i) => (
          <Line.Segment key={`seg${i}`} point1={[seg[0].x, seg[0].y]} point2={[seg[1].x, seg[1].y]} color={C.teal} weight={2} />
        ))}
        {/* fixed labeled points */}
        {(spec.fixedPoints ?? []).map((m, i) => (
          <Fragment key={`fp${i}`}>
            <Point x={m.x} y={m.y} color={C.teal} />
            {m.label && (
              <Text x={m.x + gridStep * 0.35} y={m.y + gridStep * 0.35} size={15} color={C.teal}>
                {m.label}
              </Text>
            )}
          </Fragment>
        ))}
        {handles.map((h, i) => (
          <Fragment key={`d${i}`}>{h.element}</Fragment>
        ))}
      </Mafs>
    </div>
  );
}
