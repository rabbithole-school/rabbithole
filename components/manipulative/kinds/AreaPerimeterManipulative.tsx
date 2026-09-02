"use client";

/**
 * AreaPerimeter — drag the Mafs corner to reshape a rectangle whose perimeter is
 * fixed (the corner is constrained to the line w + h = perimeter/2, so dragging
 * trades width for height). Filled unit cells make the area countable. Isolates
 * the classic "longer/bigger-perimeter ⇒ more area" misconception.
 */
import { useEffect } from "react";
import { Mafs, Coordinates, Image as MafsImage, Polygon, useMovablePoint } from "mafs";
import type { KindProps } from "../Manipulative";
import type { AreaPerimeterSpec } from "@/lib/manipulative/types";
import { C } from "../colors";
import { areaPerimeterSolved, clamp } from "@/lib/manipulative/logic";
import { useThemeIcon, THEME_ICON_PLACEHOLDER } from "@/hooks/useThemeIcon";
import { resolveThemeLabel } from "@/lib/manipulative/types";

export function AreaPerimeterManipulative({ spec, onSolvedChange, onStateChange }: KindProps<AreaPerimeterSpec>) {
  const half = spec.perimeter / 2;
  const maxDim = half - 1;
  const corner = useMovablePoint([spec.startWidth, half - spec.startWidth], {
    constrain: ([x]) => {
      const w = clamp(Math.round(x), 1, maxDim);
      return [w, half - w];
    },
    color: C.orange,
  });
  const w = Math.round(corner.point[0]);
  const h = half - w;

  useEffect(() => {
    onSolvedChange(areaPerimeterSolved(spec, { width: w }));
    onStateChange?.({ width: w });
  }, [spec, w, onSolvedChange, onStateChange]);

  // The area/count is still exactly `w * h`, computed the same way as the
  // undecorated variant — the icon below is a 1:1 visual stand-in for the
  // neutral cell fill, never a second source of truth for the count.
  const fillIconHref = useThemeIcon(spec.theme);
  // See ArrayManipulative for the full rationale: a Mafs `<Image>` whose href is
  // added/changed after the canvas has laid out never repaints, so we mount the
  // tile `<image>` up front with a transparent placeholder and key `<Mafs>` on
  // icon-readiness to remount (re-measure) once the URL resolves. The corner's
  // `useMovablePoint` state lives in this parent, so the remount is state-safe.
  const themed = !!resolveThemeLabel(spec.theme);

  const cells = [];
  for (let r = 0; r < h; r++)
    for (let c = 0; c < w; c++) {
      cells.push(
        <Polygon
          key={`cell-${r}-${c}`}
          points={[[c, r], [c + 1, r], [c + 1, r + 1], [c, r + 1]]}
          color={C.green}
          fillOpacity={fillIconHref ? 0.08 : 0.28}
          weight={1}
        />,
      );
      if (themed) {
        cells.push(
          <MafsImage
            key={`icon-${r}-${c}`}
            href={fillIconHref ?? THEME_ICON_PLACEHOLDER}
            x={c + 0.5}
            y={r + 0.5}
            width={0.86}
            height={0.86}
            anchor="cc"
          />,
        );
      }
    }

  return (
    <div className="manip-mafs">
      <Mafs key={fillIconHref ? "themed" : "plain"} viewBox={{ x: [0, maxDim], y: [0, maxDim] }} pan={false} zoom={false} height={360}>
        <Coordinates.Cartesian subdivisions={1} xAxis={{ labels: () => "" }} yAxis={{ labels: () => "" }} />
        {cells}
        <Polygon points={[[0, 0], [w, 0], [w, h], [0, h]]} color={C.navy} fillOpacity={0} weight={4} />
        {corner.element}
      </Mafs>
    </div>
  );
}
