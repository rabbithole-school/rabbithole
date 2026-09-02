"use client";

import Link from "next/link";
import { Box, Flex, HStack, IconButton, Text } from "@chakra-ui/react";
import { House } from "@phosphor-icons/react";
import { AccountMenu } from "./AccountMenu";
import { AppHeader } from "./AppHeader";
import { useSignOut } from "@/hooks/useSignOut";

interface ScholarPageHeaderProps {
  /** Left-side back button destination (e.g. "/scholar" or "/teacher/curriculum"). */
  homeHref: string;
  /** aria-label / tooltip text for the left back button. */
  homeLabel: string;
  /** Show `homeLabel` as visible text beside the house icon, not just the
   *  aria-label/tooltip. Off by default (most callers already fill the row
   *  with an eyebrow/title/subtitle and don't have the spare width) — the
   *  scholar map pages opt in: the icon-only back action tested as
   *  undiscoverable for touch (FTUE L1). */
  showHomeLabel?: boolean;
  /** Small-caps line above the title (e.g. "UNIT" or "QUEST"). */
  eyebrow?: string | null;
  /** Required page H1. */
  title: string;
  /** Optional one-line subtitle below the title (e.g. lesson title). */
  subtitle?: string | null;
  /** Caller-injected controls centered in the header, independent of title width. */
  centerSlot?: React.ReactNode;
  /** Caller-injected right-side controls (Edit, Refresh, etc.) rendered
   *  just before the AccountMenu. */
  rightSlot?: React.ReactNode;
}

/**
 * Shared page chrome bar for full-screen scholar surfaces that aren't
 * the in-project chat view. The chat view uses `SessionHeader` which
 * carries a bunch of streaming/sync chrome — but `/scholar/unit/[id]`,
 * `/scholar/quest/[id]`, and `/scholar/[id]/progress` are simpler:
 * back button, page title, action slot, AccountMenu.
 *
 * Title lives in the bar (not the body below), so navigating from a
 * unit page into a project page doesn't make the title jump from
 * "body" to "bar." Matches SessionHeader's non-remote left-zone
 * structure: home icon, then title stack.
 */
export function ScholarPageHeader({
  homeHref,
  homeLabel,
  showHomeLabel = false,
  eyebrow,
  title,
  subtitle,
  centerSlot,
  rightSlot,
}: ScholarPageHeaderProps) {
  const [signOut] = useSignOut();
  return (
    <AppHeader>
      <Flex flex={1} align="center" gap={3} minW={0} position="relative">
        <Link href={homeHref} style={{ flexShrink: 0, textDecoration: "none" }}>
          <HStack gap={1}>
            <IconButton
              aria-label={homeLabel}
              title={homeLabel}
              size="sm"
              variant="ghost"
              color="charcoal.400"
              _hover={{ bg: "gray.100", color: "navy.500" }}
            >
              <House size={16} />
            </IconButton>
            {showHomeLabel ? (
              <Text
                aria-hidden="true"
                fontSize="xs"
                fontWeight="600"
                color="charcoal.400"
                whiteSpace="nowrap"
              >
                {homeLabel}
              </Text>
            ) : null}
          </HStack>
        </Link>
        <Box flex={1} minW={0}>
          {eyebrow ? (
            <Text
              as="span"
              display="block"
              fontSize="2xs"
              fontFamily="heading"
              fontWeight="700"
              color="violet.500"
              textTransform="uppercase"
              letterSpacing="0.05em"
              lineHeight="1.1"
            >
              {eyebrow}
            </Text>
          ) : null}
          <Text
            as="h1"
            display="block"
            fontFamily="heading"
            fontWeight="700"
            color="navy.500"
            fontSize="sm"
            lineHeight="1.2"
            overflow="hidden"
            textOverflow="ellipsis"
            whiteSpace="nowrap"
          >
            {title}
          </Text>
          {subtitle ? (
            <Text
              as="span"
              display="block"
              fontSize="2xs"
              color="charcoal.500"
              lineHeight="1.2"
              overflow="hidden"
              textOverflow="ellipsis"
              whiteSpace="nowrap"
            >
              {subtitle}
            </Text>
          ) : null}
        </Box>
        {centerSlot ? (
          <Box
            position="absolute"
            left="50%"
            top="50%"
            transform="translate(-50%, -50%)"
            zIndex={1}
          >
            {centerSlot}
          </Box>
        ) : null}
        <HStack gap={1} flexShrink={0}>
          {rightSlot}
          <AccountMenu onSignOut={signOut} />
        </HStack>
      </Flex>
    </AppHeader>
  );
}
