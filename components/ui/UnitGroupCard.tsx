"use client";

/**
 * UnitGroupCard — a single card that OWNS a unit's activity rows.
 *
 * The unit name is a quiet tinted band at the TOP of the card (a
 * "segment of the card"), with the activity rows nested inside it — so a
 * unit's activities can never be mistaken for the next unit's (the old
 * floating-heading ambiguity). The band is deliberately SECONDARY: muted,
 * smaller text; the activity title in each row stays the bold, primary
 * line. See files/unit-context-redesign.html (the approved sketch).
 *
 * Used for every unit-bearing scholar activity. Single-activity units use one
 * row beneath the same band so web matches the native iPad card structure;
 * multi-activity units add more rows without changing visual vocabulary.
 *
 *   <UnitGroupCard>
 *     <UnitGroupBand emoji title completedCount activityCount ... />
 *     <UnitGroupRow status showDivider href cta>…</UnitGroupRow>
 *     <UnitGroupRow status showDivider … />
 *   </UnitGroupCard>
 *
 * Rows lead with an 18px status dot at the same x as the band's 18px emoji
 * box, so every text line (band name + row titles + descriptions) shares
 * one left grid line.
 */

import NextLink from "next/link";
import {
  Avatar,
  Box,
  Flex,
  HStack,
  Stack,
  Text,
  Link as ChakraLink,
  chakra,
  type BoxProps,
} from "@chakra-ui/react";
import { Surface } from "@/components/ui/Surface";

/** Plate row status. (Completed activities don't appear on the plate, but
 *  "done" is supported for reuse in unit-outline contexts.) */
export type RowStatus = "here" | "todo" | "done";

const FOCUS_RING = {
  outline: "2px solid",
  outlineColor: "violet.400",
  outlineOffset: "-2px",
} as const;

// Shared lead-column geometry: an 18px leading glyph (status dot / emoji
// box) + this gap means the band name and the row titles align on one grid.
const LEAD_W = "18px";
const LEAD_GAP = 2.5; // 10px

export function ActivityStatusDot({ status }: { status: RowStatus }) {
  if (status === "done") {
    return (
      <Flex
        w={LEAD_W}
        h={LEAD_W}
        flexShrink={0}
        mt="2px"
        rounded="full"
        bg="green.500"
        color="white"
        align="center"
        justify="center"
        fontSize="10px"
        fontWeight="bold"
        aria-hidden
      >
        ✓
      </Flex>
    );
  }
  if (status === "here") {
    return (
      <Flex
        w={LEAD_W}
        h={LEAD_W}
        flexShrink={0}
        mt="2px"
        rounded="full"
        borderWidth="2px"
        borderColor="violet.500"
        align="center"
        justify="center"
        aria-hidden
      >
        <Box w="6px" h="6px" rounded="full" bg="violet.500" />
      </Flex>
    );
  }
  return (
    <Box
      w={LEAD_W}
      h={LEAD_W}
      flexShrink={0}
      mt="2px"
      rounded="full"
      borderWidth="1.5px"
      borderStyle="dashed"
      borderColor="gray.300"
      aria-hidden
    />
  );
}

export function UnitGroupCard({
  children,
  ...rest
}: { children: React.ReactNode } & Omit<BoxProps, "children">) {
  return (
    <Surface p={0} overflow="hidden" {...rest}>
      {children}
    </Surface>
  );
}

export function UnitGroupBand({
  emoji,
  title,
  completedCount,
  activityCount,
  teacherName,
  teacherImage,
  meta,
  onProgressClick,
  action,
}: {
  emoji: string | null;
  title: string | null;
  completedCount: number | null;
  activityCount: number | null;
  teacherName?: string;
  teacherImage?: string;
  /** A not-started right slot: a path meta like "Guided path · 6 activities"
   *  shown in the meter's place when there's no progress to show yet. */
  meta?: string;
  /** When set, the progress meter becomes a button that opens the unit's
   *  "where am I" outline. */
  onProgressClick?: () => void;
  /** An optional raised action for the unit itself, independent of its rows. */
  action?: React.ReactNode;
}) {
  const showProgress =
    completedCount !== null && activityCount !== null && activityCount > 0;
  const showMeta = !showProgress && !!meta;
  const pct = showProgress
    ? Math.round((completedCount! / activityCount!) * 100)
    : 0;
  const teacherChip = teacherName ? (
    <HStack gap={1} flexShrink={0} minW={0}>
      {teacherImage && (
        <Avatar.Root size="2xs">
          <Avatar.Image src={teacherImage} alt={teacherName} />
          <Avatar.Fallback>{teacherName[0] ?? "?"}</Avatar.Fallback>
        </Avatar.Root>
      )}
      <Text
        fontSize="xs"
        fontWeight="500"
        color="charcoal.400"
        fontFamily="heading"
        lineClamp={1}
      >
        {teacherName}
      </Text>
    </HStack>
  ) : null;
  const progressMeter = showProgress ? (
    <HStack
      gap={2}
      flexShrink={0}
      {...(onProgressClick
        ? {
            as: "button" as const,
            type: "button" as const,
            onClick: onProgressClick,
            cursor: "pointer",
            "aria-label": `Where you are in ${title ?? "this unit"} — ${completedCount} of ${activityCount} done`,
            rounded: "md",
            mx: -1.5,
            px: 1.5,
            py: 1,
            transition: "background 0.12s",
            _hover: { bg: "gray.100" },
            _focusVisible: FOCUS_RING,
          }
        : {})}
    >
      <Box w="56px" h="6px" rounded="full" bg="gray.200" overflow="hidden">
        <Box
          h="100%"
          w={`${pct}%`}
          css={{
            background:
              "linear-gradient(90deg, var(--chakra-colors-violet-500), var(--chakra-colors-green-400))",
          }}
        />
      </Box>
      <Text fontSize="xs" color="charcoal.400" fontFamily="heading">
        {completedCount}/{activityCount}
      </Text>
    </HStack>
  ) : null;
  const metaSlot = showMeta ? (
    <Text
      fontSize="xs"
      color="charcoal.400"
      fontFamily="heading"
      flexShrink={0}
    >
      {meta}
    </Text>
  ) : null;
  return (
    <Flex
      align="center"
      gap={LEAD_GAP}
      px={3.5}
      py={2.5}
      bg="white"
      borderBottomWidth="1px"
      borderColor="gray.200"
      userSelect="none"
    >
      {/* Emoji in an 18px box so its NAME aligns with the row titles below
          (rows lead with an 18px status dot + the same gap). */}
      <Flex
        w={LEAD_W}
        justify="center"
        flexShrink={0}
        fontSize="15px"
        lineHeight="1"
        aria-hidden
      >
        {emoji || "•"}
      </Flex>
      <HStack gap={1.5} minW={0} flex={1}>
        <Text
          fontFamily="heading"
          fontWeight="700"
          fontSize="xs"
          color="charcoal.500"
          letterSpacing="0.01em"
          lineClamp={1}
        >
          {title}
        </Text>
        {/* When the band has a progress meter on the right, the teacher rides
            inline after the title. With no meter (e.g. choice lessons) the
            teacher becomes the right-aligned trailing element instead — unless
            a path meta occupies that slot, in which case it rides inline too. */}
        {teacherName && (showProgress || showMeta) && (
          <>
            <Text fontSize="xs" color="charcoal.300" flexShrink={0}>
              ·
            </Text>
            {teacherChip}
          </>
        )}
      </HStack>
      <HStack gap={2} flexShrink={0}>
        {showProgress ? progressMeter : showMeta ? metaSlot : teacherChip}
        {action && (
          <Box position="relative" zIndex={1} flexShrink={0}>
            {action}
          </Box>
        )}
      </HStack>
    </Flex>
  );
}

export function UnitGroupRow({
  status,
  showDivider,
  href,
  onClick,
  ariaLabel,
  opacity,
  trailing,
  cta,
  secondaryAction,
  onMouseEnter,
  onMouseLeave,
  children,
}: {
  status: RowStatus;
  showDivider: boolean;
  href?: string;
  onClick?: () => void;
  ariaLabel?: string;
  opacity?: number;
  trailing?: React.ReactNode;
  cta?: React.ReactNode;
  secondaryAction?: React.ReactNode;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  children: React.ReactNode;
}) {
  return (
    <Box
      role="group"
      position="relative"
      px={3.5}
      py={3}
      bg="white"
      opacity={opacity}
      borderTopWidth={showDivider ? "1px" : 0}
      borderColor="gray.100"
      transition="background 0.12s"
      contentVisibility="auto"
      containIntrinsicSize="88px"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <Flex align="flex-start" gap={LEAD_GAP}>
        <ActivityStatusDot status={status} />
        <Stack gap={1} flex={1} minW={0}>
          {children}
        </Stack>
        {((trailing != null && trailing !== false) ||
          (cta != null && cta !== false) ||
          (secondaryAction != null && secondaryAction !== false)) && (
          <Flex flexShrink={0} alignSelf="center" align="center" gap={1.5}>
            {trailing != null && trailing !== false && (
              <Box position="relative" zIndex={1}>
                {trailing}
              </Box>
            )}
            {cta != null && cta !== false && (
              <Box flexShrink={0}>{cta}</Box>
            )}
            {secondaryAction != null && secondaryAction !== false && (
              <Box position="relative" zIndex={1}>
                {secondaryAction}
              </Box>
            )}
          </Flex>
        )}
      </Flex>

      {/* Stretched-overlay interaction — keeps trailing buttons valid. */}
      {href && (
        <ChakraLink
          asChild
          position="absolute"
          inset={0}
          aria-label={ariaLabel}
          _focusVisible={FOCUS_RING}
        >
          <NextLink href={href} />
        </ChakraLink>
      )}
      {onClick && !href && (
        <chakra.button
          type="button"
          position="absolute"
          inset={0}
          cursor="pointer"
          aria-label={ariaLabel}
          onClick={onClick}
          _focusVisible={FOCUS_RING}
        />
      )}
    </Box>
  );
}

/** A quiet unit breadcrumb for non-plate surfaces that cannot use a full band. */
export function UnitChip({
  emoji,
  title,
}: {
  emoji?: string | null;
  title: string;
}) {
  return (
    <HStack gap={1.5} mb={0.5} minW={0} userSelect="none">
      {emoji && (
        <Text as="span" fontSize="xs" lineHeight="1" flexShrink={0}>
          {emoji}
        </Text>
      )}
      <Text
        as="span"
        fontFamily="heading"
        fontWeight="600"
        fontSize="2xs"
        color="charcoal.400"
        letterSpacing="0.02em"
        lineClamp={1}
      >
        {title}
      </Text>
    </HStack>
  );
}
