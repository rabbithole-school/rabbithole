"use client";

/**
 * The verdict-overlay treatment for a served item's stem card — a corner stamp
 * pops in, the card gets a colored ring/tint, and (on a miss) the whole card
 * gives a short shake. Correctness is ALWAYS an overlay: never an inline box
 * that grows the column and jumps a centered card. `tone` null renders the
 * neutral (no verdict yet / still answering) card.
 *
 * The outer wrapper is inset 24px narrower than its slot (`calc(100% - 24px)`,
 * centered) so the stamp's corner overhang (`top: -11px; right: -6px`) has
 * room to render fully inside a scrollable ancestor's own bounds. A host like
 * PracticeSession's STAGE needs `overflowY="auto"` (so a tall don't-know
 * explanation can still scroll) but per the CSS overflow-x/y coupling rule an
 * ancestor can't ALSO declare `overflowX="visible"` to let the overhang past
 * its edge — the UA silently forces that back to `auto` (i.e. clipped)
 * whenever the other axis is non-visible. Reserving the room here, inside the
 * stamp's own containing block, sidesteps that entirely.
 *
 * Extracted from PracticeSession.tsx's §9 no-shift feedback choreography so
 * BOTH the practice drill and placement (#unify — Andy's direct observation
 * that placement still ran a legacy full-screen interstitial while practice
 * had this polished corner stamp) render the identical verdict language.
 * Native twin: `PracticeVerdictStamp.tsx` + the `stemBox*`/`stamp*` styles in
 * `native/src/lib/practiceShell.ts`.
 */

import { Box, HStack, Text, VStack } from "@chakra-ui/react";
import { Check } from "@phosphor-icons/react";
import { StemText } from "@/components/practice/StemText";
import { PromptVisual } from "@/components/practice/PromptVisual";
import { SpeakableLabel } from "@/components/SpeakableLabel";
import { stemToSpeech } from "@/shared/practiceStemBlocks";
import { superscriptExponents } from "@/shared/mathNotation";
import type { PracticePromptVisual } from "@/shared/practicePromptVisual";
import { STEM_FONT_LG, STEM_FONT_SM } from "@/shared/practicePromptVisual";

export type VerdictTone = "correct" | "miss" | null;

export function VerdictStemCard({
  stem,
  promptVisual,
  tone,
  label,
  announcement,
  stampKey,
  speakable = false,
  big = false,
}: {
  stem: string;
  promptVisual?: PracticePromptVisual;
  tone: VerdictTone;
  /** Overrides the default stamp text ("Correct" / "Not quite") — e.g.
   *  placement's honest "I haven't learned this yet" earns "Noted" rather
   *  than "Not quite" (a don't-know is honesty, not a wrong guess), while
   *  still getting the same amber tint + ring. */
  label?: string;
  /** Overrides the stamp's screen-reader announcement (defaults to `label`).
   *  Lets a caller speak a fuller retired-title phrase (e.g. "That's okay —
   *  good to know.") while the SIGHTED stamp stays a terse "Noted". */
  announcement?: string;
  /** Remount key for the stamp pop + card shake (defaults to `tone`) — pass a
   *  per-attempt value if a caller needs the beat to replay across two
   *  consecutive misses on the SAME card (practice's retry flow). */
  stampKey?: string;
  /** Kindergarten (grade "K") item: wrap the stem in a tap-to-hear speaker so a
   *  pre-reader can hear the question. Uses the shared `SpeakableLabel` (which
   *  itself respects the scholar's `ttsEnabled`). Default off ⇒ unchanged. */
  speakable?: boolean;
  /** A bare "Fast math" retrieval item — render the stem LARGER and tighter so
   *  a single-digit fact reads as an instant, focused recall prompt (the tactile
   *  FastMath feel), not a wordy word-problem card. Default off ⇒ STEM_FONT_SM. */
  big?: boolean;
}) {
  const isCorrect = tone === "correct";
  const isMiss = tone === "miss";
  const visibleLabel = label ?? (isCorrect ? "Correct" : "Not quite");
  const a11yLabel = announcement ?? visibleLabel;
  const stemFontSize = big ? STEM_FONT_LG : STEM_FONT_SM;

  return (
    <Box position="relative" w="calc(100% - 24px)" mx="auto">
      <style dangerouslySetInnerHTML={{ __html: VERDICT_MOTION_CSS }} />
      <Box
        w="100%"
        bg="#fffdfa"
        borderWidth="1px"
        borderStyle="solid"
        borderColor={isCorrect ? "#8fe3bf" : isMiss ? "#f2c98a" : "#ded8cb"}
        borderRadius="16px"
        p={6}
        minH="120px"
        display="flex"
        alignItems="center"
        justifyContent="center"
        boxShadow={
          isCorrect
            ? "0 0 0 3px rgba(0,181,116,0.18), 0 2px 6px rgba(23,32,27,0.06)"
            : isMiss
              ? "0 0 0 3px rgba(255,166,57,0.22)"
              : "0 1px 2px rgba(23,32,27,0.05)"
        }
        className={isMiss ? "rh-shake" : undefined}
        transition="border-color 0.3s, box-shadow 0.3s"
      >
        <VStack gap={promptVisual ? 4 : 0} w="100%">
          {speakable ? (
            <SpeakableLabel
              text={stemToSpeech(stem)}
              tapAnywhere
              ariaLabel="Hear the question"
              iconSize={24}
            >
              <StemText value={superscriptExponents(stem)} fontSize={stemFontSize} align="center" />
            </SpeakableLabel>
          ) : (
            <StemText value={superscriptExponents(stem)} fontSize={stemFontSize} align="center" />
          )}
          {promptVisual ? <PromptVisual spec={promptVisual} /> : null}
        </VStack>
      </Box>
      {(isCorrect || isMiss) && (
        <HStack
          key={stampKey ?? tone ?? "none"}
          className="rh-stamp"
          position="absolute"
          top="-11px"
          right="-6px"
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
      )}
    </Box>
  );
}

/**
 * Stamp-pop / card-shake / note-fade keyframes as global CSS classes
 * (`rh-stamp`, `rh-shake`, `rh-note`) — self-injected here so any consumer
 * (Placement.tsx) needs no separate wiring. PracticeSession.tsx keeps its OWN
 * transcript-scroll keyframes (rh-rise/rh-float-up — a different concern,
 * choreographing which problem is on screen) and also happens to already
 * declare `rh-note`/`rh-stamp`/`rh-shake` locally for its pre-extraction
 * paint; that duplication is harmless (identical rules, browsers just apply
 * them twice) and deliberately left alone to keep this extraction surgical.
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
