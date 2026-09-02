"use client";

/**
 * Protractor — rotate a handle along a 0..180° arc, the same "knob on a scale"
 * idiom as the number line (see `NumberLineManipulative`), bent into a
 * semicircle. ONE goal mode: constructAngle — only the fixed base ray is
 * drawn; the scholar drags the FREE RAY itself (solid, from the vertex) until
 * it reads the target degree the prompt states in words — the ray IS the
 * construction.
 *
 * A `measureAngle` mode (a pre-drawn second ray the scholar read with a
 * separate marker) existed briefly and was REMOVED (2026-07) — it was
 * gameable: the answer was literally on screen as a drawn ray, so a scholar
 * could slide the marker onto it by visual matching without ever reading the
 * scale. See the `ProtractorGoal` doc comment in lib/manipulative/types.ts.
 *
 * Degrees are always relative to `spec.baseRayDeg` (default 0) — the whole
 * diagram just rotates for display; grading (`protractorSolved`) never reads
 * that offset.
 */
import { useEffect, useMemo } from "react";
import { Mafs, Line, Point, Text, useMovablePoint } from "mafs";
import type { KindProps } from "../Manipulative";
import type { ProtractorSpec } from "@/lib/manipulative/types";
import { C } from "../colors";
import { clamp, initialProtractor, protractorSolved } from "@/lib/manipulative/logic";

const R = 4; // arc radius, math units
const PAD = 0.6;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function ProtractorManipulative({ spec, onSolvedChange, onStateChange }: KindProps<ProtractorSpec>) {
  const baseDeg = spec.baseRayDeg ?? 0;

  // relDeg 0..180 (relative to the base ray) → a point on the arc.
  const pointAt = (relDeg: number): [number, number] => {
    const rad = toRad(baseDeg + relDeg);
    return [R * Math.cos(rad), R * Math.sin(rad)];
  };
  // The inverse: a raw (x, y) → the relative degree it reads on the scale.
  const relDegOf = (x: number, y: number): number => {
    const raw = (Math.atan2(y, x) * 180) / Math.PI - baseDeg;
    return clamp(raw, 0, 180);
  };

  const ray = useMovablePoint(pointAt(initialProtractor(spec).angleDeg), {
    constrain: ([x, y]) => pointAt(relDegOf(x, y)),
    color: C.violet,
  });
  const angleDeg = relDegOf(ray.point[0], ray.point[1]);

  useEffect(() => {
    onSolvedChange(protractorSolved(spec, { angleDeg }));
    onStateChange?.({ angleDeg });
  }, [spec, angleDeg, onSolvedChange, onStateChange]);

  // The arc, sampled every 2° for a smooth curve (Mafs has no native arc
  // primitive, so it's a chain of short segments — same idiom as a polyline).
  const arcPoints = useMemo(() => {
    const pts: [number, number][] = [];
    for (let d = 0; d <= 180; d += 2) pts.push(pointAt(d));
    return pts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseDeg]);

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

  const tickOuter = (d: number, len: number): [number, number] => {
    const rad = toRad(baseDeg + d);
    return [R * Math.cos(rad) + len * Math.cos(rad), R * Math.sin(rad) + len * Math.sin(rad)];
  };
  const labelPoint = (d: number): [number, number] => {
    const rad = toRad(baseDeg + d);
    const lr = R + 0.72;
    return [lr * Math.cos(rad), lr * Math.sin(rad)];
  };

  const straightEdgeA = pointAt(0);
  const straightEdgeB = pointAt(180);

  return (
    <div className="manip-mafs">
      <Mafs viewBox={{ x: [-R - PAD, R + PAD], y: [-0.8, R + PAD] }} pan={false} zoom={false} height={260}>
        {/* the arc */}
        {arcPoints.slice(0, -1).map((p, i) => (
          <Line.Segment key={`arc-${i}`} point1={p} point2={arcPoints[i + 1]} color={C.navy} weight={2} />
        ))}
        {/* the straight edge (the protractor's baseline, through the vertex) */}
        <Line.Segment point1={straightEdgeA} point2={straightEdgeB} color={C.navy} weight={2} />
        {/* minor ticks every 5°, unlabeled */}
        {minorTicks.map((d) => (
          <Line.Segment key={`minor-${d}`} point1={pointAt(d)} point2={tickOuter(d, 0.18)} color={C.charcoal} weight={1.5} />
        ))}
        {/* major ticks every 10°, labeled */}
        {majorTicks.map((d) => (
          <Line.Segment key={`major-${d}`} point1={pointAt(d)} point2={tickOuter(d, 0.32)} color={C.navy} weight={2} />
        ))}
        {majorTicks.map((d) => {
          const [lx, ly] = labelPoint(d);
          return (
            <Text key={`label-${d}`} x={lx} y={ly} size={13} color={C.charcoal}>
              {String(d)}
            </Text>
          );
        })}
        {/* the vertex */}
        <Point x={0} y={0} color={C.navy} />
        {/* the free ray IS the construction, drawn solid the whole length */}
        <Line.Segment point1={[0, 0]} point2={ray.point} color={C.violet} weight={3.5} />
        {ray.element}
      </Mafs>
    </div>
  );
}
