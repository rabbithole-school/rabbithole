"use client";

/**
 * BonusChooser — the single "Keep going?" done-screen bonus set (raise-the-
 * ceiling plan §C-3, "shorter mandatory core + bonus sets"). Replaces THREE
 * separately-stacked offer blocks (challenge / more-of-your-pick / tune-up)
 * with ONE bordered chooser presenting up to three tappable bonus cards —
 * each card IS the accept action (tap it, you're in; there's no separate
 * decline button). Skipping the chooser entirely is always fine: the done
 * screen's calm summary/closure is the default path, and "Done" / "Practice
 * again" below it are unaffected.
 *
 * Re-probe ("you're on a roll, jump ahead?") is NOT one of these cards — it's
 * an EARNED offer (the engine detected a likely under-placement), not a bonus
 * a scholar opts into for its own sake, so it keeps its own distinct slot
 * ABOVE this chooser (see PracticeSession.tsx / practice.tsx).
 *
 * No scores, no streak framing, no pressure copy — matches the scholar-facing
 * lexicon in review/practice/completion-messaging-plan.html and TuneupOffer /
 * ReprobeOffer's existing tone. Even borders on every card (visual-design.md —
 * no edge-only accent stripes); each card gets its own soft, distinct tint so
 * they read as different offers without a left-border stripe trick.
 */

import { Box, Button, Text, VStack } from "@chakra-ui/react";
import { ArrowRight } from "@phosphor-icons/react";

export type BonusCardSpec = {
  /** Stable React key AND the a11y-visible identity of the card. */
  key: string;
  title: string;
  body: string;
  onAccept: () => void;
  acceptLabel?: string;
  disabled?: boolean;
  /** Soft background/border/text triple — each bonus kind gets its own quiet
   *  tint (mirrors the standalone offers' prior colors: amber for challenge,
   *  green for tune-up, violet for more-of-your-pick). */
  tone: { bg: string; border: string; text: string };
};

export function BonusChooser({ cards }: { cards: BonusCardSpec[] }) {
  if (cards.length === 0) return null;
  return (
    <Box w="100%" bg="#fffdfa" border="1px solid #ded8cb" borderRadius="14px" p={4}>
      <Text fontSize="16px" fontWeight="700" color="#2f3b34" mb={3}>
        Keep going?
      </Text>
      {/* ONE surface, hairline-separated rows — not filled boxes inside a box.
          A tinted, bordered card nested in this bordered container was
          box-in-box (visual-design.md: "keep a single outer Surface … remove
          the INNER filled boxes"), and it read worst at one card, where the
          tint distinguished the row from nothing. Each kind keeps its identity
          hue on its title + action instead of as a fill. */}
      <VStack align="stretch" gap={0}>
        {cards.map((card, i) => (
          <Button
            key={card.key}
            onClick={card.onAccept}
            disabled={card.disabled}
            variant="plain"
            h="auto"
            w="100%"
            justifyContent="space-between"
            whiteSpace="normal"
            textAlign="left"
            bg="transparent"
            borderRadius={0}
            borderTop={i === 0 ? "none" : "1px solid #ece7dc"}
            px={0}
            py={3}
            _hover={{ bg: "#faf8f4" }}
          >
            <VStack align="start" gap={0} flex="1">
              <Text fontWeight="700" fontSize="14px" color={card.tone.text}>
                {card.title}
              </Text>
              <Text fontSize="13px" color="#5f6b62" fontWeight="400" whiteSpace="normal">
                {card.body}
              </Text>
            </VStack>
            <Text fontSize="13px" fontWeight="700" color={card.tone.text} flexShrink={0} ml={3}>
              {card.disabled ? "…" : (card.acceptLabel ?? "Let's go")} <ArrowRight style={{ display: "inline" }} />
            </Text>
          </Button>
        ))}
      </VStack>
    </Box>
  );
}
