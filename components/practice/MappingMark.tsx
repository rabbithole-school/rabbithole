"use client";

/**
 * MappingMark — the survey-plot glyph for a domain's check-in (MAPPING) state
 * in the all-domains matrix's empty cells.
 *
 * Design rationale (review/math-skills-mapping-mark-spike.html §6, §8):
 *  · Outline COMPLETION encodes progress, never AREA fill — a partial fill
 *    would read as "how much mastery", the exact defect the mark must avoid.
 *  · Hue is disjoint from the green/teal mastery family (violet), so a mapping
 *    state can never be mistaken for a mastery level.
 *  · Shape is a rounded-square survey PLOT, never a ring — the ring is reserved
 *    for playlist sequence (scholar) and placed-node (tree) elsewhere.
 *
 * The three glyph states:
 *  · notReady     — a receding grey dotted plot (out of the affect-safe ring).
 *  · needsMapping  — a violet dotted plot inviting a survey (the cell tints on
 *                    hover — that affordance lives on the matrix cell, not here).
 *  · inProgress   — two sides solidified + a centre stake: a survey underway,
 *                    resumable from here.
 *
 * Inline SVG, no deps. `currentColor` resolves to the wrapper's Chakra `color`
 * token (the app's violet.500/600 family for the active states, a faint grey
 * for the receding one), so the mark stays inside the app's palette.
 */

import { Box } from "@chakra-ui/react";

export type MappingMarkState = "notReady" | "needsMapping" | "inProgress";

const STATE_LABEL: Record<MappingMarkState, string> = {
  notReady: "Not ready",
  needsMapping: "Needs mapping",
  inProgress: "In progress",
};

export function MappingMark({
  state,
  size = 15,
  title,
}: {
  state: MappingMarkState;
  /** Rendered edge length in px (the plot is a square). */
  size?: number;
  /** Richer hover text; falls back to the state's own label. */
  title?: string;
}) {
  const isReceding = state === "notReady";
  // The plot outline: a dotted rounded square for every state; in-progress adds
  // a solid left+bottom overlay and a centre stake over the same dotted base.
  const strokeWidth = isReceding ? 1.25 : 2;
  return (
    <Box
      as="span"
      role="img"
      aria-label={STATE_LABEL[state]}
      title={title ?? STATE_LABEL[state]}
      display="inline-flex"
      alignItems="center"
      justifyContent="center"
      flex="0 0 auto"
      // currentColor → the plot's ink. Violet for the actionable states (invite
      // / resume), a quiet grey for the receding not-ready plot.
      color={isReceding ? "gray.300" : "violet.600"}
      opacity={isReceding ? 0.5 : 1}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 15 15"
        fill="none"
        aria-hidden
        focusable="false"
      >
        {/* The dotted plot outline — every state draws this base. */}
        <rect
          x={1}
          y={1}
          width={13}
          height={13}
          rx={4}
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeDasharray="1.5 2.5"
          strokeLinecap="round"
        />
        {state === "inProgress" && (
          <>
            {/* Two sides solidified — the left + bottom edges of the plot,
                following the rounded bottom-left corner. */}
            <path
              d="M 1 5 L 1 10 Q 1 14 5 14 L 10 14"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
            />
            {/* The centre stake — the survey is underway. */}
            <circle cx={7.5} cy={7.5} r={2} fill="currentColor" />
          </>
        )}
      </svg>
    </Box>
  );
}
