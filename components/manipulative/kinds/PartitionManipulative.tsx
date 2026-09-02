"use client";

/**
 * Partition — a whole cut into equal wedges. Tap wedges to shade; step the number
 * of parts. Isolates: unit fractions, numerator/denominator, and (with two discs)
 * equivalence across unlike denominators. Challenge examples: "Make one half"
 * (2/4, 3/6 … all light up), "Make both shaded the same".
 */
import { useEffect, useState } from "react";
import { Box, Flex } from "@chakra-ui/react";
import type { KindProps } from "../Manipulative";
import type { PartitionSpec } from "@/lib/manipulative/types";
import { C, wash } from "../colors";
import { initialPartition, partitionSolved, type PartitionState } from "@/lib/manipulative/logic";
import { Stepper } from "../Stepper";

const DISC_COLORS = [C.cyan, C.violet];

function point(cx: number, cy: number, r: number, deg: number) {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.sin(rad), cy - r * Math.cos(rad)];
}
function wedgePath(cx: number, cy: number, r: number, i: number, n: number) {
  const a0 = (i * 360) / n;
  const a1 = ((i + 1) * 360) / n;
  const [x0, y0] = point(cx, cy, r, a0);
  const [x1, y1] = point(cx, cy, r, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  if (n === 1) return `M ${cx - r},${cy} A ${r} ${r} 0 1 1 ${cx + r},${cy} A ${r} ${r} 0 1 1 ${cx - r},${cy} Z`;
  return `M ${cx},${cy} L ${x0.toFixed(2)},${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)} Z`;
}

export function PartitionManipulative({ spec, onSolvedChange, onStateChange }: KindProps<PartitionSpec>) {
  const [state, setState] = useState<PartitionState>(() => initialPartition(spec));
  const [minParts, maxParts] = spec.partsRange ?? [1, 12];
  const canParts = spec.adjustable.includes("parts");
  const canShade = spec.adjustable.includes("shaded");

  useEffect(() => {
    onSolvedChange(partitionSolved(spec, state));
    onStateChange?.(state);
  }, [spec, state, onSolvedChange, onStateChange]);

  const two = state.discs.length > 1;
  const r = 96;
  const centers = two ? [[130, 118], [370, 118]] : [[150, 118]];
  const vbW = two ? 500 : 300;

  const setDisc = (di: number, patch: Partial<{ parts: number; shaded: number }>) =>
    setState((s) => {
      const discs = s.discs.map((d, i) => {
        if (i !== di) return d;
        const parts = patch.parts ?? d.parts;
        const shaded = Math.min(patch.shaded ?? d.shaded, parts);
        return { parts, shaded };
      });
      return { discs };
    });

  const tapWedge = (di: number, i: number) => {
    if (!canShade) return;
    setState((s) => {
      const discs = s.discs.map((d, idx) => {
        if (idx !== di) return d;
        // contiguous fill: tapping the last-shaded wedge unshades it, else fill up to i
        const shaded = d.shaded === i + 1 ? i : i + 1;
        return { ...d, shaded };
      });
      return { discs };
    });
  };

  return (
    <Box>
      <svg viewBox={`0 0 ${vbW} 236`} role="group" style={{ width: "100%", height: "auto" }}>
        {centers.map(([cx, cy], di) => {
          const disc = state.discs[di];
          const color = DISC_COLORS[di % DISC_COLORS.length];
          return (
            <g key={di}>
              <circle cx={cx} cy={cy} r={r + 3} fill="none" stroke={C.line} strokeWidth={2} />
              {Array.from({ length: disc.parts }, (_, i) => {
                const filled = i < disc.shaded;
                return (
                  <path
                    key={i}
                    d={wedgePath(cx, cy, r, i, disc.parts)}
                    fill={filled ? wash(color, 0.7) : "#fbfbfd"}
                    stroke={C.navy}
                    strokeWidth={1.5}
                    onPointerDown={(e) => { e.preventDefault(); tapWedge(di, i); }}
                    role={canShade ? "button" : undefined}
                    tabIndex={canShade ? 0 : undefined}
                    aria-label={canShade ? `Wedge ${i + 1} of ${disc.parts}${filled ? ", shaded" : ""}` : undefined}
                    onKeyDown={
                      canShade
                        ? (e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              tapWedge(di, i);
                            }
                          }
                        : undefined
                    }
                    style={{ cursor: canShade ? "pointer" : "default", transition: "fill .15s" }}
                  />
                );
              })}
            </g>
          );
        })}
      </svg>
      {(canParts || two) && (
        <Flex justify={two ? "space-around" : "center"} gap={4} mt={1} flexWrap="wrap">
          {state.discs.map((d, di) =>
            canParts ? (
              <Stepper
                key={di}
                value={d.parts}
                min={minParts}
                max={maxParts}
                label="parts"
                onChange={(v) => setDisc(di, { parts: v })}
              />
            ) : null,
          )}
        </Flex>
      )}
    </Box>
  );
}
