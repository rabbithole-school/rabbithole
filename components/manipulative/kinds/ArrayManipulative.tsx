"use client";

/**
 * Array — drag the Mafs corner point to build a rectangle of tiles (rows × cols)
 * on a unit grid. Isolates multiplication as area, factors, and commutativity.
 * "Make 12" lights up for 3×4, 4×3, 2×6 … every factor pair.
 */
import { useEffect } from "react";
import { Mafs, Coordinates, Image as MafsImage, Polygon, useMovablePoint } from "mafs";
import type { KindProps } from "../Manipulative";
import type { ArraySpec } from "@/lib/manipulative/types";
import { C } from "../colors";
import { arraySolved, clamp } from "@/lib/manipulative/logic";
import { useThemeIcon, THEME_ICON_PLACEHOLDER } from "@/hooks/useThemeIcon";
import { resolveThemeLabel } from "@/lib/manipulative/types";

export function ArrayManipulative({ spec, onSolvedChange, onStateChange }: KindProps<ArraySpec>) {
  const maxRows = spec.maxRows ?? 8;
  const maxCols = spec.maxCols ?? 8;
  const corner = useMovablePoint([spec.cols, spec.rows], {
    constrain: ([x, y]) => [clamp(Math.round(x), 1, maxCols), clamp(Math.round(y), 1, maxRows)],
    color: C.orange,
  });
  const cols = Math.round(corner.point[0]);
  const rows = Math.round(corner.point[1]);

  useEffect(() => {
    onSolvedChange(arraySolved(spec, { rows, cols }));
    onStateChange?.({ rows, cols });
  }, [spec, rows, cols, onSolvedChange, onStateChange]);

  // The product is still exactly `rows * cols`, computed the same way as the
  // undecorated variant — the icon is a 1:1 visual stand-in for a tile, never
  // a second source of truth for the count.
  const fillIconHref = useThemeIcon(spec.theme);
  // A themed array expects a lazily-generated icon that resolves after first
  // paint. A Mafs `<Image>` whose href is added/changed *after* the canvas has
  // laid out its transform never repaints (the transformed region isn't
  // invalidated). So we (1) mount the tile `<image>` from the canvas's first
  // render with a transparent placeholder, and (2) key `<Mafs>` on icon-
  // readiness so the canvas remounts once the URL lands — re-measuring its
  // transform with the real href present. `useMovablePoint` state lives here in
  // the parent, so the remount preserves the scholar's drag + grading state.
  const themed = !!resolveThemeLabel(spec.theme);

  const tiles = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      tiles.push(
        <Polygon
          key={`cell-${r}-${c}`}
          points={[[c + 0.08, r + 0.08], [c + 0.92, r + 0.08], [c + 0.92, r + 0.92], [c + 0.08, r + 0.92]]}
          color={C.cyan}
          fillOpacity={fillIconHref ? 0.08 : 0.5}
        />,
      );
      if (themed) {
        tiles.push(
          <MafsImage
            key={`icon-${r}-${c}`}
            href={fillIconHref ?? THEME_ICON_PLACEHOLDER}
            x={c + 0.5}
            y={r + 0.5}
            width={0.8}
            height={0.8}
            anchor="cc"
          />,
        );
      }
    }

  return (
    <div className="manip-mafs">
      <Mafs key={fillIconHref ? "themed" : "plain"} viewBox={{ x: [0, maxCols], y: [0, maxRows] }} pan={false} zoom={false} height={360}>
        <Coordinates.Cartesian subdivisions={1} xAxis={{ labels: () => "" }} yAxis={{ labels: () => "" }} />
        {tiles}
        {corner.element}
      </Mafs>
    </div>
  );
}
