"use client";

/**
 * BadgeCelebration — the completion-moment badge reveal + tiny customization.
 *
 * Self-contained: given the just-finished unit, it queries the scholar's
 * badge for that unit and renders nothing if there isn't one (so it only
 * appears on the completion that actually earned the badge). The art is
 * auto-minted; this strip lets the scholar remix it with PRESET choices
 * only — a style toggle + a color, applied at most MAX_BADGE_REROLLS times.
 * No free-text prompt, no standalone editor: customization stays a delight,
 * never a distraction.
 */

import { Box, HStack, Text, VStack } from "@chakra-ui/react";
import { Sparkle } from "@phosphor-icons/react";
import { useQuery } from "convex/react";
import Link from "next/link";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { BadgeArt, type BadgeArtStatus } from "./BadgeArt";
import { BadgeRemixStrip } from "./BadgeRemixStrip";

// The theme has no `amber` palette (only `yellow`), so badge accents use
// explicit warm-gold hexes — a real award gold on the dark celebration card.
const GOLD = "#f4c44c";

export function BadgeCelebration({ unitId }: { unitId: Id<"units"> }) {
  const badge = useQuery(api.scholarUnitBadges.badgeForUnit, { unitId });

  if (!badge) return null;

  const generating = badge.artStatus === "generating";

  return (
    <Box
      alignSelf="center"
      w="full"
      my={4}
      p={6}
      borderRadius="2xl"
      textAlign="center"
      color="white"
      bg="#101736"
      css={{
        background:
          "linear-gradient(160deg, #1a2350 0%, #101736 60%, #0b1026 100%)",
      }}
      borderWidth="1px"
      borderColor={GOLD}
      shadow="lg"
    >
      <HStack justify="center" gap={1.5} mb={3} color={GOLD}>
        <Sparkle size={18} weight="fill" />
        <Text fontFamily="heading" fontWeight="700" fontSize="sm" letterSpacing="wide" textTransform="uppercase">
          Badge earned
        </Text>
        <Sparkle size={18} weight="fill" />
      </HStack>

      <VStack gap={3}>
        <BadgeArt
          imageUrl={badge.imageUrl}
          emoji={badge.badge.icon ?? badge.unitEmoji ?? "🏅"}
          status={badge.artStatus as BadgeArtStatus}
          size="320px"
          alt={`${badge.badge.title} badge`}
        />
        <Text fontFamily="heading" fontWeight="800" fontSize="lg" lineClamp={2}>
          {badge.badge.title}
        </Text>
        {badge.badge.description && (
          <Text fontSize="sm" color="whiteAlpha.800">
            {badge.badge.description}
          </Text>
        )}
        <Text fontSize="sm" color="whiteAlpha.700">
          {generating
            ? "Designing your badge — this can take a few seconds…"
            : badge.isQuestUnit
              ? "You finished the whole quest. This badge is yours."
              : "You finished the whole unit. This badge is yours."}
        </Text>
        <Link href="/me" style={{ color: "inherit", textDecoration: "none" }}>
          <Text as="span" fontSize="sm" color={GOLD} fontWeight="700">
            Find it anytime in My Learning →
          </Text>
        </Link>
      </VStack>

      {/* Make-it-yours strip — preset choices only, capped remix budget. */}
      <BadgeRemixStrip
        badgeId={badge._id as Id<"scholarUnitBadges">}
        style={badge.style}
        colorway={badge.colorway}
        rerollsRemaining={badge.rerollsRemaining}
        generating={generating}
      />
    </Box>
  );
}
