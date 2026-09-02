"use client";

import { type CSSProperties } from "react";
import {
  countablesAccessibilityLabel,
  countablesGeometry,
  type CountablesPromptVisual as CountablesPromptVisualSpec,
} from "@/shared/practicePromptVisual";

const DOT_FILL = "#16707e";
const DOT_STROKE = "#0f4f59";
const FRAME_STROKE = "#ded8cb";
const FRAME_FILL = "#fffdfa";

// Standard "sr-only" recipe (mirrors the a11y node list in
// components/map/MapTreeCanvas.tsx): visually hidden, but exposed to every
// assistive tech and accessibility snapshot as REAL DOM text — unlike an SVG
// `aria-label`, which some AT/snapshot tools skip. This is the robust,
// single-source text alternative for the decorative dots picture.
const srOnlyStyle: CSSProperties = {
  position: "absolute",
  width: "1px",
  height: "1px",
  padding: 0,
  margin: "-1px",
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
  border: 0,
};

export function CountablesPromptVisual({ spec }: { spec: CountablesPromptVisualSpec }) {
  const geometry = countablesGeometry(spec);
  return (
    <>
      <span style={srOnlyStyle}>{countablesAccessibilityLabel(spec)}</span>
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox={`0 0 ${geometry.width} ${geometry.height}`}
        style={{ width: "100%", maxWidth: 320, height: "auto", display: "block" }}
      >
      <defs>
        <radialGradient id="countable-dot" cx="35%" cy="30%" r="70%">
          <stop offset="0%" stopColor="#39a2b1" />
          <stop offset="100%" stopColor={DOT_FILL} />
        </radialGradient>
      </defs>
      {geometry.tenFrameCells.map((cell, i) => (
        <rect
          key={`cell-${i}`}
          x={cell.x}
          y={cell.y}
          width={cell.width}
          height={cell.height}
          rx={i % 10 === 0 || i % 10 === 4 || i % 10 === 5 || i % 10 === 9 ? 7 : 0}
          fill={FRAME_FILL}
          stroke={FRAME_STROKE}
          strokeWidth={1.4}
        />
      ))}
      {geometry.points.map((point) => (
        <g
          key={point.index}
          transform={`translate(${point.x} ${point.y}) rotate(${point.rotation}) scale(${point.scale})`}
        >
          <CountableMotif motif={spec.motif} r={point.r} />
        </g>
      ))}
    </svg>
    </>
  );
}

function CountableMotif({ motif, r }: { motif: string; r: number }) {
  switch (motif) {
    case "dot":
    default:
      return (
        <circle
          cx={0}
          cy={0}
          r={r}
          fill="url(#countable-dot)"
          stroke={DOT_STROKE}
          strokeWidth={1.5}
        />
      );
  }
}
