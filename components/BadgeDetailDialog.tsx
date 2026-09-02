"use client";

/**
 * BadgeDetailDialog — the "tap a badge to see it bigger" surface.
 *
 * Opened from a scholar's trophy shelf (MyLearningView → "Things you've made").
 * Shows the badge at full size with its earned description (which the small
 * card omits), the quest it came from, when it was earned, and the same capped
 * "make it yours" remix the completion celebration offers — so a scholar can
 * keep tinkering with the art from their shelf, not only at the moment they
 * earned it. Dark/gold themed so the generative art reads as a real medal.
 */

import { Button, Dialog, HStack, IconButton, Portal, Text, VStack } from "@chakra-ui/react";
import { ArrowClockwise, X } from "@phosphor-icons/react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { formatRelative } from "@/lib/relativeTime";
import { useKeepWorking } from "@/hooks/useKeepWorking";
import { BadgeArt, type BadgeArtStatus } from "./BadgeArt";
import { BadgeRemixStrip } from "./BadgeRemixStrip";

const GOLD = "#f4c44c";

export type BadgeDetail = {
  _id: Id<"scholarUnitBadges">;
  unitId?: Id<"units">;
  unitTitle: string;
  unitEmoji: string | null;
  earnedAt: number;
  badge: { title: string; description?: string; icon?: string };
  imageUrl?: string | null;
  style?: string | null;
  colorway?: string | null;
  artStatus?: BadgeArtStatus;
  rerollsRemaining: number;
};

export function BadgeDetailDialog({
  badge,
  onClose,
}: {
  badge: BadgeDetail | null;
  onClose: () => void;
}) {
  const generating = badge?.artStatus === "generating";
  // The badge is unit-scoped; resolve the scholar's re-openable session for
  // that unit so "Keep working on this" can reopen the real work (its
  // artifact) — not just admire the medal. Completion is never touched
  // (sessions.reopen only un-archives), so the unit stays complete.
  const reopenTarget = useQuery(
    api.sessions.reopenableForUnit,
    badge?.unitId ? { unitId: badge.unitId } : "skip",
  );
  const { keepWorking, pendingId } = useKeepWorking();
  const reopenSessionId = reopenTarget?.sessionId ?? null;
  const reopening = pendingId != null;

  return (
    <Dialog.Root
      open={!!badge}
      onOpenChange={(d) => !d.open && onClose()}
      size="lg"
      placement="center"
    >
      <Portal>
        <Dialog.Backdrop bg="blackAlpha.600" />
        <Dialog.Positioner>
          <Dialog.Content
            bg="#101736"
            color="white"
            borderWidth="1px"
            borderColor={GOLD}
            rounded="2xl"
            overflow="hidden"
            css={{
              background:
                "linear-gradient(160deg, #1a2350 0%, #101736 60%, #0b1026 100%)",
            }}
          >
            {badge && (
              <Dialog.Body p={6}>
                <Dialog.CloseTrigger asChild>
                  <IconButton
                    aria-label="Close"
                    size="sm"
                    variant="ghost"
                    position="absolute"
                    top="10px"
                    right="10px"
                    color="whiteAlpha.700"
                    _hover={{ bg: "whiteAlpha.200", color: "white" }}
                  >
                    <X size={18} />
                  </IconButton>
                </Dialog.CloseTrigger>

                <VStack gap={4} textAlign="center">
                  <BadgeArt
                    imageUrl={badge.imageUrl}
                    emoji={badge.badge.icon ?? badge.unitEmoji ?? "🏅"}
                    status={badge.artStatus ?? "ready"}
                    size="360px"
                    alt={`${badge.badge.title} badge`}
                  />

                  <Dialog.Title asChild>
                    <Text fontFamily="heading" fontWeight="800" fontSize="2xl" lineClamp={3}>
                      {badge.badge.title}
                    </Text>
                  </Dialog.Title>

                  {badge.badge.description && (
                    <Text fontSize="sm" color="whiteAlpha.800" lineHeight="1.6">
                      {badge.badge.description}
                    </Text>
                  )}

                  <HStack gap={2} color="whiteAlpha.600" fontSize="xs" fontFamily="heading">
                    <Text color={GOLD} fontWeight="700">
                      {badge.unitEmoji ? `${badge.unitEmoji} ` : ""}
                      {badge.unitTitle}
                    </Text>
                    <Text>·</Text>
                    <Text>earned {formatRelative(badge.earnedAt)}</Text>
                  </HStack>
                </VStack>

                {reopenSessionId && (
                  <Button
                    mt={5}
                    w="100%"
                    bg={GOLD}
                    color="#1a1400"
                    fontFamily="heading"
                    fontWeight="800"
                    _hover={{ bg: "#ffd873" }}
                    _active={{ bg: "#e0af38" }}
                    loading={reopening}
                    loadingText="Opening…"
                    onClick={() =>
                      keepWorking(reopenSessionId as Id<"sessions">)
                    }
                  >
                    <ArrowClockwise size={18} weight="bold" />
                    Keep working on this
                  </Button>
                )}

                {/* The same capped remix the celebration offers. */}
                <BadgeRemixStrip
                  badgeId={badge._id}
                  style={badge.style}
                  colorway={badge.colorway}
                  rerollsRemaining={badge.rerollsRemaining}
                  generating={!!generating}
                />
              </Dialog.Body>
            )}
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
