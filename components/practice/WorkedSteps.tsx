"use client";

/**
 * Backward-faded worked-example scaffold (SPIKE — Renkl/Atkinson faded worked
 * examples, run as a COMPLETION problem). Renders the server-computed fade
 * (`convex/lib/practice/fadedSteps.ts`'s `FadeResult`) for a practice item:
 * the early revealed steps as a plain numbered list, the remaining (trailing)
 * faded steps as quiet blanked placeholder rows for the scholar to finish, and
 * the completion prompt (when present) below the list.
 *
 * Purely a display of what the server already decided — no answer text (the
 * answer-producing final step is always faded), no client-side fade logic.
 * Renders only when there's at least one revealed step to build on; a
 * fully-bare item is just a plain problem and shows no scaffold card. Even
 * borders on every row (no accent stripe/gradient — see
 * .claude/rules/visual-design.md).
 */

import { Box, HStack, Text, VStack } from "@chakra-ui/react";
import { FractionText } from "@/components/FractionText";
import { SpeakableLabel } from "@/components/SpeakableLabel";
import { superscriptExponents } from "@/shared/mathNotation";
import type { FadeResult } from "@/convex/lib/practice/fadedSteps";

export function WorkedSteps({
  steps,
  // When set (the teach-as-action moment), each REVEALED step is tap-to-hear
  // through the existing TTS path — never auto-played. Off elsewhere (the
  // answering scaffold stays silent). Respects ttsEnabled inside SpeakableLabel.
  speakable = false,
  label = "Let’s start it together",
  showWhenOnlyFaded = false,
  acknowledgedRevealedIndexes = [],
  revealedCount,
}: {
  steps: FadeResult;
  speakable?: boolean;
  label?: string;
  showWhenOnlyFaded?: boolean;
  /** Revealed only because the scholar attempted the blank; render muted. */
  acknowledgedRevealedIndexes?: number[];
  /** Caller-controlled accumulating reveal (the Launchpad "Show me the move"
   *  path): show only the first `revealedCount` revealed steps and NO faded
   *  rows, so the caller can append steps one tap at a time. Undefined (every
   *  existing caller) keeps the server-decided fade verbatim. */
  revealedCount?: number;
}) {
  const all = steps;
  // When the caller drives an accumulating reveal, clamp the revealed list and
  // drop the faded blanks (the caller is walking a fully-known example, not a
  // completion problem); otherwise render exactly what the server decided.
  const revealed = revealedCount == null ? all.revealed : all.revealed.slice(0, revealedCount);
  const faded = revealedCount == null ? all.faded : [];
  const selfExplainPrompt = all.selfExplainPrompt;
  if (revealed.length === 0 && !(showWhenOnlyFaded && faded.length > 0)) return null;

  return (
    <Box w="100%" bg="#fffdfa" border="1px solid #ded8cb" borderRadius="16px" p={4}>
      <Text fontSize="14px" fontWeight="600" color="#3a4038" mb={2.5}>
        {label}
      </Text>
      <VStack align="stretch" gap={2}>
        {revealed.map((step, i) => (
          <HStack key={`revealed-${i}`} align="flex-start" gap={2}>
            <Text
              fontSize="13px"
              fontWeight="700"
              color={acknowledgedRevealedIndexes.includes(i) ? "#9b9483" : "#3a9e6b"}
              minW="18px"
            >
              {i + 1}.
            </Text>
            {speakable ? (
              <SpeakableLabel text={step.text} tapAnywhere ariaLabel="Hear this step">
                <FractionText
                  value={superscriptExponents(step.text)}
                  inline
                  fontSize={15}
                  align="left"
                  color={acknowledgedRevealedIndexes.includes(i) ? "#6b675f" : "#2c332e"}
                />
              </SpeakableLabel>
            ) : (
              <FractionText
                value={superscriptExponents(step.text)}
                inline
                fontSize={15}
                align="left"
                color={acknowledgedRevealedIndexes.includes(i) ? "#6b675f" : "#2c332e"}
              />
            )}
          </HStack>
        ))}
        {faded.map((step, i) => (
          <HStack key={`faded-${i}`} align="flex-start" gap={2}>
            <Text fontSize="13px" fontWeight="700" color="#9b9483" minW="18px">
              {revealed.length + i + 1}.
            </Text>
            <Box flex="1" border="1px solid #e6e0d2" borderRadius="8px" px={2.5} py={1}>
              <Text fontSize="14px" color="#847c68" fontStyle="italic">
                {step.blankText}
              </Text>
            </Box>
          </HStack>
        ))}
      </VStack>
      {selfExplainPrompt && (
        <Text mt={3} fontSize="13px" color="#5a655d" fontStyle="italic">
          {selfExplainPrompt}
        </Text>
      )}
    </Box>
  );
}
