"use client";

/**
 * BloomLadder — depth (Bloom's level) as a small NEUTRAL ladder: five rungs
 * filled from the bottom up to the level, so "how high did they take it" reads
 * as height, not colour. Colour is deliberately reserved for the four-stop
 * mastery scale (met / beyond), so depth stays monochrome here and never
 * competes with it. Pair it with the named level (Remember…Create) in adjacent
 * text where space allows.
 *
 * level is the 0–5 Bloom float; null/undefined renders an empty ladder.
 */

import { Box } from "@chakra-ui/react";

const RUNGS = 5; // Understand … Create (Remember reads as the empty floor)

export function BloomLadder({
  level,
  size = 16,
  title,
}: {
  level?: number | null;
  size?: number;
  title?: string;
}) {
  // Map the 0–5 Bloom float to how many of the 5 rungs are lit.
  const lit = level == null ? 0 : Math.max(0, Math.min(RUNGS, Math.round(level)));
  const w = size;
  const h = size + 4;
  const gap = 2;
  const rungH = (h - gap * (RUNGS - 1)) / RUNGS;
  return (
    <Box flexShrink={0} lineHeight={0} data-testid="bloom-ladder" data-bloom-lit={lit}>
      <svg
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label={title ?? `Bloom depth ${lit} of ${RUNGS}`}
      >
        {Array.from({ length: RUNGS }).map((_, i) => {
          // i=0 is the bottom rung.
          const y = h - (i + 1) * rungH - i * gap;
          const on = i < lit;
          return (
            <rect
              key={i}
              x={0}
              y={y}
              width={w}
              height={rungH}
              rx={rungH / 2}
              fill={on ? "#475063" : "#dde2e8"}
            />
          );
        })}
      </svg>
    </Box>
  );
}
