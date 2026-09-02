"use client";

/**
 * Distribute — a movable vertical split in a rectangle. The left and right
 * pieces make a × (b + c) feel like a × b + a × c: same whole, two addends.
 */
import { useEffect } from "react";
import { Coordinates, Line, Mafs, Polygon, Text, useMovablePoint } from "mafs";
import type { KindProps } from "../Manipulative";
import type { DistributeSpec } from "@/lib/manipulative/types";
import { C } from "../colors";
import { clamp, distributeSolved } from "@/lib/manipulative/logic";

export function DistributeManipulative({ spec, onSolvedChange, onStateChange }: KindProps<DistributeSpec>) {
  const maxSplit = spec.width - 1;
  const handleY = spec.height / 2;
  const split = useMovablePoint([spec.startColumn, handleY], {
    constrain: ([x]) => [clamp(Math.round(x), 1, maxSplit), handleY],
    color: C.orange,
  });
  const column = Math.round(split.point[0]);

  useEffect(() => {
    onSolvedChange(distributeSolved(spec, { column }));
    onStateChange?.({ column });
  }, [spec, column, onSolvedChange, onStateChange]);

  return (
    <div className="manip-mafs">
      <Mafs viewBox={{ x: [0, spec.width], y: [0, spec.height] }} pan={false} zoom={false} height={360}>
        <Coordinates.Cartesian subdivisions={1} xAxis={{ labels: () => "" }} yAxis={{ labels: () => "" }} />
        <Polygon
          points={[[0, 0], [column, 0], [column, spec.height], [0, spec.height]]}
          color={C.cyan}
          fillOpacity={0.34}
          weight={2}
        />
        <Polygon
          points={[[column, 0], [spec.width, 0], [spec.width, spec.height], [column, spec.height]]}
          color={C.violet}
          fillOpacity={0.24}
          weight={2}
        />
        <Polygon points={[[0, 0], [spec.width, 0], [spec.width, spec.height], [0, spec.height]]} color={C.navy} fillOpacity={0} weight={4} />
        <Line.Segment point1={[column, 0]} point2={[column, spec.height]} color={C.orange} weight={5} />
        <Text x={column / 2} y={spec.height / 2} size={20} color={C.navy}>
          {column} × {spec.height}
        </Text>
        <Text x={column + (spec.width - column) / 2} y={spec.height / 2} size={20} color={C.navy}>
          {spec.width - column} × {spec.height}
        </Text>
        {split.element}
      </Mafs>
    </div>
  );
}
