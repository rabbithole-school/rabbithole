"use client";

/**
 * MasteryGlyphSvg — draws a mastery state's mark as SVG GEOMETRY in a single
 * `color`, centred on (cx, cy) by construction. It is used as the KNOCKOUT inside
 * `MasteryCenterDot`'s mask (drawn in black = "punch a hole here"), so the mark
 * ends up as a transparent shape cut through the coloured disc rather than ink on
 * top. Keeping it a standalone geometry renderer means the dial, the cohort tree,
 * and the swatch all get pixel-identical shapes from one place.
 *
 * Why geometry, not a font glyph: a typeset "−"/"•"/"✓"/"✦" is positioned on the
 * font's baseline and x-height, which do NOT coincide with the circle's centre —
 * so a character never sits perfectly in the dot. A rect / circle / path is
 * centred exactly.
 *
 * Returns `null` for the states with no mark (`placed`, whose hollow ring is its
 * signal). Size gating lives in `MasteryCenterDot`.
 */

import type { MasteryState } from "@/shared/treeMapLayout";
import { masteryGlyphKind } from "@/shared/masteryGlyph";

export interface MasteryGlyphSvgProps {
  /** Centre of the dot. */
  cx: number;
  cy: number;
  /** Dot RADIUS in user units — the mark is scaled to it. */
  r: number;
  state: MasteryState;
  /** Fill/stroke for the geometry. Inside a mask this is `#000` (= knockout). */
  color: string;
}

export function MasteryGlyphSvg({
  cx,
  cy,
  r,
  state,
  color,
}: MasteryGlyphSvgProps) {
  const kind = masteryGlyphKind(state);
  if (kind === "none") return null;

  if (kind === "bar") {
    const w = r * 1.0;
    const h = Math.max(1.6, r * 0.28);
    return (
      <rect
        x={cx - w / 2}
        y={cy - h / 2}
        width={w}
        height={h}
        rx={h / 2}
        fill={color}
      />
    );
  }

  if (kind === "dot") {
    return <circle cx={cx} cy={cy} r={Math.max(1.5, r * 0.34)} fill={color} />;
  }

  if (kind === "check") {
    const sw = Math.max(1.5, r * 0.24);
    const pt = (fx: number, fy: number) => `${cx + fx * r},${cy + fy * r}`;
    return (
      <polyline
        points={`${pt(-0.42, 0.04)} ${pt(-0.14, 0.32)} ${pt(0.44, -0.34)}`}
        fill="none"
        stroke={color}
        strokeWidth={sw}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    );
  }

  if (kind === "cross") {
    // An X — the check's counterpart, drawn as two strokes through the centre
    // at the same weight so the two marks read as siblings at a glance.
    const sw = Math.max(1.5, r * 0.24);
    const a = r * 0.4;
    return (
      <g
        stroke={color}
        strokeWidth={sw}
        strokeLinecap="round"
        fill="none"
      >
        <line x1={cx - a} y1={cy - a} x2={cx + a} y2={cy + a} />
        <line x1={cx - a} y1={cy + a} x2={cx + a} y2={cy - a} />
      </g>
    );
  }

  // star (✦) — a four-pointed sparkle: outer points N/E/S/W, concave sides.
  const ro = r * 0.92;
  const ri = r * 0.36;
  const pts: string[] = [];
  for (let i = 0; i < 8; i++) {
    const rad = ((-90 + i * 45) * Math.PI) / 180;
    const rr = i % 2 === 0 ? ro : ri;
    pts.push(`${cx + rr * Math.cos(rad)},${cy + rr * Math.sin(rad)}`);
  }
  return <polygon points={pts.join(" ")} fill={color} />;
}
