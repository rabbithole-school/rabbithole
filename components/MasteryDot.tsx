"use client";

/**
 * MasteryDot — the swatch that names a mastery state in menus, legends, and band
 * lists (the mastery-filter menu, the report's band marks, the band-meter legend).
 * It is a thin `<svg>` wrapper around `MasteryCenterDot`, so the coloured disc, the
 * hollow `placed` ring, and the punched knockout shape are the SAME geometry the
 * dial and cohort tree draw — one accessible vocabulary, no per-surface drift.
 *
 * The dot is decorative next to a text label that names the state, so it is
 * aria-hidden.
 */

import type { MasteryState } from "@/shared/treeMapLayout";
import type { DialSurface } from "@/shared/masteryDialPalette";
import { MasteryCenterDot } from "@/components/MasteryCenterDot";

export interface MasteryDotProps {
  /** Which mastery state the swatch names. */
  state: MasteryState;
  /** Dot DIAMETER in px. Default 16 (legend size — the mark reads). */
  size?: number;
  /** Plane the dot sits on. Default `paper` (every teacher swatch is on paper). */
  surface?: DialSurface;
}

export function MasteryDot({
  state,
  size = 16,
  surface = "paper",
}: MasteryDotProps) {
  const c = size / 2;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{ display: "block", flexShrink: 0 }}
      aria-hidden
    >
      <MasteryCenterDot cx={c} cy={c} r={c} state={state} surface={surface} />
    </svg>
  );
}
