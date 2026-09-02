"use client";

/**
 * InvitationCard — the ONE card for the scholar-home "invitation" family: a
 * teacher-suggested quest, an unlocked story thread, or the Sky-ready milestone.
 * Extracted from SuggestedQuestCard's grammar (amber section eyebrow above the
 * card, a quiet identity band, a two-line body, a right-side CTA) so every
 * invitation reads as the same object rather than three drifted vocabularies.
 *
 * Anatomy (all slots optional):
 *   [band]                          full-width identity strip (UnitGroupBand /
 *                                   InvitationBand)
 *   [emoji]                         a centered hero glyph (the night Sky card)
 *   [title]                         a bold hero line (the night Sky card)
 *   [body] [meta]  | [actions]      two-line body + quiet meta on the left, the
 *                                   primary/secondary actions on the right
 *   [accessHint]                    a non-button access affordance (a gesture map)
 *
 * `onPress` makes the WHOLE card the primary tap target via a stretched overlay
 * button, so `primaryAction` is a non-interactive affordance (like Start) that
 * sits under it, while `secondaryAction` is a raised control that stays its own
 * tap target above it. `surface="night"` swaps the paper card for the dark
 * milestone surface; `align="center"` is the centered hero layout the Sky uses.
 *
 * Native twin: native/src/components/InvitationCard.tsx.
 */

import { Box, Flex, Image, Stack, Text, chakra } from "@chakra-ui/react";
import { Surface } from "@/components/ui/Surface";

export type InvitationSurface = "paper" | "night";

const FOCUS_RING = {
  outline: "2px solid",
  outlineColor: "violet.400",
  outlineOffset: "-2px",
} as const;

export interface InvitationCardProps {
  /** "paper" (default) or "night" (the dark milestone surface). */
  surface?: InvitationSurface;
  /** "start" (default banded invitation) or "center" (the Sky hero layout). */
  align?: "start" | "center";
  /** Full-width top identity strip (e.g. <UnitGroupBand/> or <InvitationBand/>). */
  band?: React.ReactNode;
  /** A centered hero glyph shown above the title (the night Sky card). */
  emoji?: React.ReactNode;
  /** A bold hero line inside the content area (the night Sky card). Bands carry
   *  their own title, so this is for the band-less hero layout. */
  title?: React.ReactNode;
  /** Two-line body / clue. */
  body?: React.ReactNode;
  /** Quiet meta line (e.g. "Unlocked by fractions"). */
  meta?: React.ReactNode;
  /** Non-interactive CTA affordance (sits UNDER the full-card overlay). */
  primaryAction?: React.ReactNode;
  /** A raised quiet secondary control (its own tap target, ABOVE the overlay). */
  secondaryAction?: React.ReactNode;
  /** A non-button access affordance (the gesture hint pill on a gesture map). */
  accessHint?: React.ReactNode;
  /** Content nested UNDER the hero, inside the same surface (e.g. the night
   *  reveal's launch CTA + its day's-movement rows). Kept a slot so the night
   *  surface has exactly one definition rather than being hand-rolled to nest. */
  nestedContent?: React.ReactNode;
  /** Whole-card press = the primary action. */
  onPress?: () => void;
  /** Accessible label for the stretched overlay button. */
  ariaLabel?: string;
}

export function InvitationCard({
  surface = "paper",
  align = "start",
  band,
  emoji,
  title,
  body,
  meta,
  primaryAction,
  secondaryAction,
  accessHint,
  nestedContent,
  onPress,
  ariaLabel,
}: InvitationCardProps) {
  const night = surface === "night";
  const centered = align === "center";
  const bodyColor = night ? "whiteAlpha.800" : "charcoal.500";

  const hasActions =
    (primaryAction != null && primaryAction !== false) ||
    (secondaryAction != null && secondaryAction !== false);

  const content = (
    <Stack
      gap={2}
      px={centered ? 6 : 3.5}
      py={centered ? 6 : 3}
      align={centered ? "center" : "stretch"}
      textAlign={centered ? "center" : undefined}
    >
      {emoji != null && emoji !== false && (
        <Text fontSize="40px" lineHeight="1" aria-hidden>
          {emoji}
        </Text>
      )}
      {title != null && title !== false && (
        <Text
          fontFamily="heading"
          fontWeight="800"
          fontSize="lg"
          color={night ? "white" : "navy.500"}
        >
          {title}
        </Text>
      )}
      {(body != null && body !== false) ||
      (meta != null && meta !== false) ||
      hasActions ? (
        <Flex align="center" gap={3} w="100%">
          <Box flex={1} minW={0}>
            {body != null && body !== false && (
              <Text
                fontSize="sm"
                color={bodyColor}
                fontFamily="body"
                lineHeight="1.45"
              >
                {body}
              </Text>
            )}
            {meta != null && meta !== false && <Box mt={body ? 1 : 0}>{meta}</Box>}
          </Box>
          {hasActions && (
            <Stack gap={1} flexShrink={0} align="flex-end">
              {/* Under the overlay: the whole card is the primary tap target. */}
              {primaryAction != null && primaryAction !== false && (
                <Box>{primaryAction}</Box>
              )}
              {/* Raised: its own tap target above the stretched overlay. */}
              {secondaryAction != null && secondaryAction !== false && (
                <Box position="relative" zIndex={1}>
                  {secondaryAction}
                </Box>
              )}
            </Stack>
          )}
        </Flex>
      ) : null}
      {accessHint != null && accessHint !== false && <Box>{accessHint}</Box>}
      {nestedContent != null && nestedContent !== false && nestedContent}
    </Stack>
  );

  const overlay = onPress ? (
    <chakra.button
      type="button"
      position="absolute"
      inset={0}
      borderRadius="lg"
      cursor="pointer"
      aria-label={ariaLabel}
      onClick={onPress}
      _focusVisible={FOCUS_RING}
    />
  ) : null;

  if (night) {
    return (
      <Box
        role="group"
        position="relative"
        w="100%"
        borderRadius="2xl"
        overflow="hidden"
        color="white"
        bg="#101736"
        css={{
          background:
            "linear-gradient(160deg, #241b52 0%, #141a3c 55%, #0b1026 100%)",
        }}
        borderWidth="1px"
        borderColor="violet.400"
        shadow="lg"
      >
        {band}
        {content}
        {overlay}
      </Box>
    );
  }

  return (
    <Surface
      role="group"
      position="relative"
      p={0}
      overflow="hidden"
      transition="all 0.12s"
      _hover={onPress ? { shadow: "sm", borderColor: "gray.300" } : undefined}
    >
      {band}
      {content}
      {overlay}
    </Surface>
  );
}

/**
 * A quiet identity band for invitations that don't carry a full UnitGroupBand
 * (a story's art/emoji + hook). Same left-grid geometry as UnitGroupBand: a
 * visual, then the title, over a hairline. `titleLines` lets a two-line hook wrap.
 */
export function InvitationBand({
  emoji,
  imageUrl,
  title,
  surface = "paper",
  titleLines = 1,
}: {
  emoji?: string | null;
  imageUrl?: string | null;
  title: React.ReactNode;
  surface?: InvitationSurface;
  titleLines?: 1 | 2;
}) {
  const night = surface === "night";
  return (
    <Flex
      align={titleLines === 2 ? "flex-start" : "center"}
      gap={2.5}
      px={3.5}
      py={2.5}
      bg={night ? "whiteAlpha.100" : "white"}
      borderBottomWidth="1px"
      borderColor={night ? "whiteAlpha.300" : "gray.200"}
      userSelect="none"
    >
      {imageUrl ? (
        <Image
          src={imageUrl}
          alt=""
          aria-hidden="true"
          w="32px"
          h="32px"
          flexShrink={0}
          objectFit="contain"
          mt={titleLines === 2 ? "-3px" : undefined}
        />
      ) : (
        <Flex
          w="18px"
          justify="center"
          flexShrink={0}
          fontSize="15px"
          lineHeight="1"
          mt={titleLines === 2 ? "1px" : undefined}
          aria-hidden
        >
          {emoji || "•"}
        </Flex>
      )}
      <Text
        fontFamily="heading"
        fontWeight="700"
        fontSize="sm"
        color={night ? "white" : "charcoal.600"}
        letterSpacing="0.01em"
        lineHeight="1.3"
        lineClamp={titleLines}
      >
        {title}
      </Text>
    </Flex>
  );
}
