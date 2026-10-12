"use client";

/**
 * The drill's verdict language, as two small shared pieces: the corner STAMP
 * ("✓ Correct" green / "Not quite" amber, pop motion, reduced-motion respected)
 * and the matching tinted RING. Used by BOTH VerdictStemCard (the practice /
 * placement stem card) and QuestionCard (the done-screen bonus question) so a
 * verdict reads identically wherever the scholar meets one. A miss is amber,
 * never red.
 *
 * The stamp is positioned absolutely against its nearest positioned ancestor
 * (`top: -11px; right: -6px`), so the host wraps its card in a `position:
 * relative` box with room for the overhang (see VerdictStemCard's header).
 * To replay the pop per attempt, key the component (`<VerdictStamp key=…/>`).
 * Native twin: `PracticeVerdictStamp.tsx`.
 */

import { HStack, Text } from "@chakra-ui/react";
import { Check } from "@phosphor-icons/react";

export type VerdictTone = "correct" | "miss" | null;

/** Border colour + box-shadow for a card wearing a verdict (neutral when null). */
export function verdictRing(tone: VerdictTone): {
  borderColor: string;
  boxShadow: string;
} {
  if (tone === "correct") {
    return {
      borderColor: "#8fe3bf",
      boxShadow: "0 0 0 3px rgba(0,181,116,0.18), 0 2px 6px rgba(23,32,27,0.06)",
    };
  }
  if (tone === "miss") {
    return {
      borderColor: "#f2c98a",
      boxShadow: "0 0 0 3px rgba(255,166,57,0.22)",
    };
  }
  return { borderColor: "#ded8cb", boxShadow: "0 1px 2px rgba(23,32,27,0.05)" };
}

export function VerdictStamp({
  tone,
  label,
  announcement,
  placement = "card",
}: {
  tone: VerdictTone;
  /** "card" (default) overhangs the card's top-right corner; "row" sits just
   *  inside a hairline list row's top-right (a row in a clipped list surface
   *  has no room for the overhang). */
  placement?: "card" | "row";
  /** Overrides the default stamp text ("Correct" / "Not quite"). */
  label?: string;
  /** Overrides the screen-reader announcement (defaults to the visible label). */
  announcement?: string;
}) {
  const isCorrect = tone === "correct";
  const isMiss = tone === "miss";
  if (!isCorrect && !isMiss) return null;
  const visibleLabel = label ?? (isCorrect ? "Correct" : "Not quite");
  const a11yLabel = announcement ?? visibleLabel;
  return (
    <HStack
      className="rh-stamp"
      position="absolute"
      top={placement === "row" ? "10px" : "-11px"}
      right={placement === "row" ? "12px" : "-6px"}
      gap={1}
      px={2.5}
      py={1}
      borderRadius="full"
      fontSize="12px"
      fontWeight="800"
      bg={isCorrect ? "#00b574" : "#FFA639"}
      color={isCorrect ? "#fff" : "#3a2a08"}
      boxShadow={isCorrect ? "0 5px 14px rgba(0,181,116,0.42)" : "0 5px 14px rgba(255,166,57,0.42)"}
      pointerEvents="none"
      whiteSpace="nowrap"
      aria-live="polite"
      aria-label={a11yLabel}
    >
      {isCorrect ? <Check weight="bold" aria-hidden="true" /> : null}
      <Text as="span" aria-hidden="true">{visibleLabel}</Text>
    </HStack>
  );
}

/**
 * Stamp-pop / card-shake / note-fade keyframes as global CSS classes
 * (`rh-stamp`, `rh-shake`, `rh-note`) — self-injected by the cards that use
 * them, so a consumer needs no separate wiring. PracticeSession.tsx also
 * declares `rh-note`/`rh-stamp`/`rh-shake` locally (identical rules; applying
 * them twice is harmless).
 */
export const VERDICT_MOTION_CSS = `
@keyframes rhStampPop { from { opacity: 0; transform: scale(0.55); } to { opacity: 1; transform: scale(1); } }
@keyframes rhShakeX { 0%,100%{transform:translateX(0)} 18%{transform:translateX(-7px)} 38%{transform:translateX(6px)} 58%{transform:translateX(-4px)} 78%{transform:translateX(3px)} }
@keyframes rhFade { from { opacity: 0; } to { opacity: 1; } }
.rh-stamp { animation: rhStampPop 0.34s cubic-bezier(0.2,1.35,0.4,1) both; }
.rh-shake { animation: rhShakeX 0.42s; }
.rh-note { animation: rhFade 0.3s ease both; }
@media (prefers-reduced-motion: reduce) {
  .rh-stamp { animation: none !important; opacity: 1 !important; transform: none !important; }
  .rh-shake { animation: none !important; }
}
`;
