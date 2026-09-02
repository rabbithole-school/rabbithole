"use client";

/**
 * MasteryCenterDot — the ONE renderer for a mastery state's dot: a coloured disc
 * with its redundant, colour-independent mark punched THROUGH it as a transparent
 * knockout (bar / ring / check / star), so the shape reads from the background
 * regardless of hue — the most colour-blind-safe redundancy available.
 *
 * Used everywhere a mastery dot appears: the dial's centre (`KnowledgeNodeDial`),
 * the cohort tree's median-band node (`CohortTreeView`), and the legend/menu
 * swatch (`MasteryDot`). One implementation ⇒ the disc, the hollow-`placed` ring,
 * and every punched shape are pixel-identical across all teacher surfaces.
 *
 * States:
 *   placed                      → HOLLOW ring (surface shows through the centre);
 *                                 the ring vs. solid fill is its whole tell — no
 *                                 knockout.
 *   locked/frontier/fluent/…    → solid disc with the state's shape knocked out,
 *                                 when the dot is ≥ `minDiameter`; below that,
 *                                 a plain solid disc (colour carries it).
 *
 * The knockout is an SVG luminance mask (white = keep, black = hole). Each
 * instance mints a unique mask id via `useId` so masks never collide when many
 * dots share one page.
 */

import { useId } from "react";

import type { MasteryState } from "@/shared/treeMapLayout";
import {
  dialHollowFill,
  masteryDotColor,
  type DialSurface,
} from "@/shared/masteryDialPalette";
import {
  MASTERY_GLYPH_MIN_DIAMETER,
  masteryGlyphKind,
} from "@/shared/masteryGlyph";
import { MasteryGlyphSvg } from "@/components/MasteryGlyphSvg";

export interface MasteryCenterDotProps {
  /** Centre of the dot. */
  cx: number;
  cy: number;
  /** Dot RADIUS in user units. */
  r: number;
  state: MasteryState;
  /** Plane the dot sits on (drives the locked grey + hollow fill). */
  surface?: DialSurface;
  /**
   * Draw the redundant knockout shape. Default true. The scholar-facing dial
   * passes false (it stays a plain coloured dot, matching native); only teacher
   * surfaces opt in.
   */
  mark?: boolean;
  /** Hide the knockout below this dot DIAMETER. */
  minDiameter?: number;
}

export function MasteryCenterDot({
  cx,
  cy,
  r,
  state,
  surface = "paper",
  mark = true,
  minDiameter = MASTERY_GLYPH_MIN_DIAMETER,
}: MasteryCenterDotProps) {
  const rawId = useId();
  const maskId = `mastery-knockout-${rawId.replace(/:/g, "")}`;
  const color = masteryDotColor(state, surface);

  // placed → hollow ring; the open centre IS the signal, so no knockout.
  if (state === "placed") {
    const ring = Math.max(1.5, r * 0.28);
    return (
      <circle
        cx={cx}
        cy={cy}
        r={r - ring / 2}
        fill={dialHollowFill(surface)}
        stroke={color}
        strokeWidth={ring}
      />
    );
  }

  const showMark =
    mark && masteryGlyphKind(state) !== "none" && 2 * r >= minDiameter;

  if (!showMark) {
    return <circle cx={cx} cy={cy} r={r} fill={color} />;
  }

  return (
    <g>
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse">
          {/* white = disc kept; the black shape below = transparent hole */}
          <circle cx={cx} cy={cy} r={r} fill="#fff" />
          <MasteryGlyphSvg cx={cx} cy={cy} r={r} state={state} color="#000" />
        </mask>
      </defs>
      <circle cx={cx} cy={cy} r={r} fill={color} mask={`url(#${maskId})`} />
    </g>
  );
}
