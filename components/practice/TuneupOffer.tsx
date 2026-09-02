"use client";

/**
 * TuneupOffer — the "quick tune-up?" mixed-retention check (parity plan §4B).
 * Surfaced on the practice session-complete screen when the engine finds a
 * scholar has a pool of fluent skills they haven't touched in a while — with
 * INFERRED credit (placement / valve / re-probe, never independently
 * demonstrated) floated to the top. It's an OFFER, never forced.
 *
 * There is ZERO new serve/grade code: accepting records the tune-up
 * (`practiceTuneups.start`) and hands the sampled `skillKeys` back to the
 * parent `PracticeSession`, which re-enters its ordinary
 * `practiceSession`/`submitAnswer` loop scoped to those skills. Declining is
 * client-state only (dismiss for this wrap; the server won't re-offer for a
 * week once one is started). No score, no timer, no streak, no nag — a miss
 * just lapses the half-life and the skill resurfaces as an ordinary review.
 *
 * Copy passes the §5 scholar-facing lexicon (no quiz/test/score/grade/timed/
 * lost/forgot/rusty). Even borders — no accent-stripe styling (visual-design.md),
 * matching ReprobeOffer.tsx.
 */

import { Box, Button, HStack, Text } from "@chakra-ui/react";
import { ArrowRight } from "@phosphor-icons/react";

export function TuneupOffer({
  count,
  onAccept,
  onDecline,
}: {
  /** How many skills the tune-up will serve (the sampled `skillKeys` length). */
  count: number;
  /** Accept — the parent records the tune-up and re-enters a scoped session. */
  onAccept: () => void;
  /** Decline — dismissed for this wrap only. */
  onDecline: () => void;
}) {
  return (
    <Box w="100%" bg="#eef6f0" border="1px solid #bcdfc7" borderRadius="14px" p={4}>
      <Text fontSize="16px" fontWeight="700" color="#2f6b46" mb={1}>
        Quick tune-up?
      </Text>
      <Text fontSize="14px" color="#2f6b46" mb={3}>
        {count} quick ones from things you&apos;ve already learned — keeps your map fresh.
      </Text>
      <HStack gap={2}>
        <Button colorPalette="teal" onClick={onAccept}>
          Let&apos;s go <ArrowRight />
        </Button>
        <Button variant="ghost" color="#3f7a58" onClick={onDecline}>
          Not now
        </Button>
      </HStack>
    </Box>
  );
}
