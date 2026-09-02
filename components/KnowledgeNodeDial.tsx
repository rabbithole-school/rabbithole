/**
 * KnowledgeNodeDial — the locked "Option B · side-flanks" node dial.
 *
 * Three readings on one SVG:
 *   • Centre dot  = mastery state (locked / frontier / fluent / overlearned)
 *   • Left arc    = automaticity (mint  #43cf8e) — how retained right now
 *   • Right arc   = depth        (indigo #5663c6) — Bloom conceptual depth
 *
 * The two arcs sit on the SAME circle. A ~3° angular gap at the top and
 * bottom of the circle keeps the two gauges legible even when both are full —
 * without any horizontal offset between them.
 *
 * Arc fill: pathLength="100" + stroke-dasharray="<fill*100> 100"
 * (mirrors the exact technique in §5 of the practice-engine roadmap).
 *
 * Palette (locked in the roadmap):
 *   mint   #43cf8e  — automaticity (left arc)
 *   indigo #5663c6  — depth (right arc)
 * The DOT colours — and their night-surface restatement — live in
 * `shared/masteryDialPalette.ts`, the one place a mastery state becomes a
 * colour. Do not re-declare them here.
 *
 * No arc tracks, no dot border (per spec).
 */

import type { MasteryState } from "@/shared/treeMapLayout";
import {
  MASTERY_DOT_COLOR,
  type DialSurface,
} from "@/shared/masteryDialPalette";
import { STRUGGLING_LABEL } from "@/shared/masteryLexicon";
import { MasteryCenterDot } from "@/components/MasteryCenterDot";

export type { MasteryState } from "@/shared/treeMapLayout";

// ── Types ────────────────────────────────────────────────────────────────────

export interface KnowledgeNodeDialProps {
  /** Mastery band — controls dot fill colour. */
  mastery: MasteryState;
  /** Automaticity 0..1 — how retained right now (left arc, mint). */
  automaticity: number;
  /** Depth 0..1 — Bloom conceptual depth (right arc, indigo). */
  depth: number;
  /** Outer bounding-box size in px. Default 44. */
  size?: number;
  /** Override the flank (arc) stroke width. Default scales with `size`; pass a
   *  small value (~1) for the super-subtle 1px flanks the tree map uses. */
  flankWidth?: number;
  /** Which plane the dial sits on. `night` re-states the palette's intent for a
   *  dark card — see `shared/masteryDialPalette.ts`. Default `paper`. */
  surface?: DialSurface;
  /**
   * Superimpose the mastery GLYPH on the centre dot (Exploration A — the
   * colour-blind-safe redundant channel). Off by default so shared scholar
   * surfaces (map, home card, recap) are untouched; teacher surfaces opt in.
   * The glyph is auto-dropped when the dot renders below ~14px (see
   * `shared/masteryGlyph.ts`), so tiny tree-map dials rely on colour + ring.
   */
  glyphs?: boolean;
}

// ── Palette ──────────────────────────────────────────────────────────────────

/** Re-exported for existing consumers; the palette itself lives in `shared/`
 *  (one canonical home, and the only place that knows about surfaces). */
export const DOT_COLOR = MASTERY_DOT_COLOR;

const COLOR_AUTOMATICITY = "#43cf8e"; // mint
const COLOR_DEPTH = "#5663c6"; // indigo

// ── Geometry helpers ─────────────────────────────────────────────────────────

/** Angular half-gap at top AND bottom of the arc pair (degrees → radians). */
const GAP_DEG = 3;
const GAP_RAD = (GAP_DEG * Math.PI) / 180;
const GAP_SIN = Math.sin(GAP_RAD); // ≈ 0.0523
const GAP_COS = Math.cos(GAP_RAD); // ≈ 0.9986

function arcPath(
  cx: number,
  cy: number,
  r: number,
  side: "left" | "right",
): string {
  // Each arc runs from near-bottom to near-top on its respective side,
  // with a tiny angular gap (GAP_DEG °) at top and bottom.
  const xOff = r * GAP_SIN * (side === "left" ? -1 : 1);
  const topY = cy - r * GAP_COS;
  const botY = cy + r * GAP_COS;
  const x = cx + xOff;
  // left:  sweep-flag 1 (clockwise)  → traces the left semicircle
  // right: sweep-flag 0 (counterclockwise) → traces the right semicircle
  const sweep = side === "left" ? 1 : 0;
  return `M ${x} ${botY} A ${r} ${r} 0 0 ${sweep} ${x} ${topY}`;
}

// ── Component ────────────────────────────────────────────────────────────────

export function KnowledgeNodeDial({
  mastery,
  automaticity,
  depth,
  size = 44,
  flankWidth,
  surface = "paper",
  glyphs = false,
}: KnowledgeNodeDialProps) {
  const cx = size / 2;
  const cy = size / 2;

  // Scale geometry from default 44px design:
  //   arcR ≈ 18/44 of size, dotR ≈ 11/44, strokeW ≈ 4/44
  const arcR = Math.round((size * 18) / 44);
  const dotR = Math.round((size * 11) / 44);
  const strokeW = flankWidth ?? Math.max(2, Math.round((size * 4) / 44));

  // Clamp fill fractions to [0, 1] then scale to pathLength=100
  const autoFill = Math.round(Math.max(0, Math.min(1, automaticity)) * 100);
  const depthFill = Math.round(Math.max(0, Math.min(1, depth)) * 100);

  const leftPath = arcPath(cx, cy, arcR, "left");
  const rightPath = arcPath(cx, cy, arcR, "right");

  // Human-readable aria-label summarising all three readings
  const masteryLabel =
    mastery === "locked" ? "not yet unlocked"
    : mastery === "struggling" ? `${STRUGGLING_LABEL} (recent misses)`
    : mastery === "frontier" ? "practicing (frontier)"
    : mastery === "placed" ? "placed at this level (not yet proven)"
    : mastery === "fluent" ? "fluent"
    : "overlearned";
  const autoPercent = Math.round(automaticity * 100);
  const depthPercent = Math.round(depth * 100);
  const ariaLabel = `Skill: ${masteryLabel}; automaticity ${autoPercent}%; depth ${depthPercent}%`;

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      role="img"
      aria-label={ariaLabel}
      style={{ display: "block", overflow: "visible" }}
    >
      {/* Left arc — automaticity (mint) */}
      <path
        d={leftPath}
        fill="none"
        stroke={COLOR_AUTOMATICITY}
        strokeWidth={strokeW}
        pathLength={100}
        strokeDasharray={`${autoFill} 100`}
        strokeLinecap="butt"
      />

      {/* Right arc — depth (indigo) */}
      <path
        d={rightPath}
        fill="none"
        stroke={COLOR_DEPTH}
        strokeWidth={strokeW}
        pathLength={100}
        strokeDasharray={`${depthFill} 100`}
        strokeLinecap="butt"
      />

      {/* Centre dot — mastery state. "placed" (provisional) draws HOLLOW so
          inferred credit reads as "at this level, not yet proven"; the other
          states draw a solid disc with their redundant, colour-blind-safe shape
          punched THROUGH it (opt-in via `glyphs` — scholar dials stay plain to
          match native). One renderer keeps every surface pixel-identical. */}
      <MasteryCenterDot
        cx={cx}
        cy={cy}
        r={dotR}
        state={mastery}
        surface={surface}
        mark={glyphs}
      />
    </svg>
  );
}
