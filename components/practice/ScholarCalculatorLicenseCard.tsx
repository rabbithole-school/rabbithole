"use client";

/**
 * ScholarCalculatorLicenseCard — the ONE scholar-facing Fast math + Calculator
 * license surface, mounted on the scholar Math tab (app/scholar/page.tsx).
 *
 * It is deliberately one stateful card rather than a Fast math card beside a
 * license card: progress, the license explanation, and the practice action all
 * describe the same practice-to-license path, so they share one title and one
 * visual vocabulary (necessity-bar "canonical home", taste charter T1).
 *
 * Fixed grammar — the slots never move, only their words change:
 *   Fast math eyebrow · license chip
 *   Calculator license                (constant title)
 *   68% · 284 of 418 facts automatic   (the scholar's OWN reading)
 *   16px per-fact automaticity map
 *   a short contextual explanation
 *   "Your own practice progress"      (the self-reference cue)
 *   Issued / Proctor                  (only while the credential is durable)
 *   Practice fast math              (bottom slot, always in the same spot)
 *
 * What this surface refuses to be: a score, a threshold, a peer comparison, a
 * progress bar, a streak, or an in-app version of the Calculator License Test.
 * The test is offline and teacher-proctored; the reading here is self-relative
 * automaticity. The state → words mapping lives in shared/calculatorLicense.ts
 * so the native twin renders the same card, not a second dialect.
 */

import { useState } from "react";
import NextLink from "next/link";
import { Box, Button, Flex, Stack, Text } from "@chakra-ui/react";
import { useQuery } from "convex/react";

import { api } from "@/convex/_generated/api";
import { BadgeArt, type BadgeArtStatus } from "@/components/BadgeArt";
import { FastMathFactGrid } from "@/components/practice/FactHeatmap";
import { Surface } from "@/components/ui/Surface";
import {
  CALCULATOR_LICENSE_CARD_TITLE,
  calculatorLicenseCardPresentation,
  type CalculatorLicenseChipTone,
} from "@/shared/calculatorLicense";

function formatIssuedDate(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(value);
}

function StatusChip({
  label,
  tone,
}: {
  label: string;
  tone: CalculatorLicenseChipTone;
}) {
  const on = tone === "on";
  return (
    <Box
      flexShrink={0}
      px={2}
      py={0.5}
      borderRadius="full"
      borderWidth="1px"
      borderColor={on ? "teal.200" : "gray.200"}
      bg={on ? "teal.50" : "gray.50"}
      color={on ? "teal.700" : "charcoal.500"}
      fontFamily="heading"
      fontWeight="700"
      fontSize="xs"
      lineHeight="1.5"
      whiteSpace="nowrap"
    >
      {label}
    </Box>
  );
}

function CredentialField({ label, value }: { label: string; value: string }) {
  return (
    <Box minW={0}>
      <Text
        fontSize="2xs"
        fontFamily="heading"
        fontWeight="700"
        letterSpacing="0.06em"
        color="charcoal.400"
      >
        {label}
      </Text>
      <Text mt={0.5} fontSize="sm" fontWeight="600" color="navy.500" lineClamp={1}>
        {value}
      </Text>
    </Box>
  );
}

export function ScholarCalculatorLicenseCard({
  practiceHref,
}: {
  /** Where "Practice fast math" lands — the page stamps it (remote-mode
   *  aware), mirroring CheckInHomeCard's `href` convention. It must be the
   *  real Quick-facts entry (`/scholar/practice?quickFacts=1`), which requests
   *  the dedicated backend run rather than an ordinary practice session. */
  practiceHref: string;
}) {
  const status = useQuery(api.calculatorLicenses.myLicenseStatus, {});
  // Busy is BUTTON-LOCAL: a tap never becomes a new card state, and it never
  // says anything about the offline, teacher-proctored test.
  const [starting, setStarting] = useState(false);

  // Loading (undefined) and "not a scholar" (null) both render nothing rather
  // than guessing a license chip that could flip a moment later. There is no
  // local error treatment on this card by design.
  if (status === undefined || status === null) return null;

  const card = calculatorLicenseCardPresentation({
    license: status.license
      ? {
          issuedAt: status.license.issuedAt,
          issuedByName: status.license.issuedByName,
        }
      : null,
    fastMath: status.fastMath,
  });
  const badge = status.license?.badge ?? null;

  return (
    <Surface as="section" aria-label={CALCULATOR_LICENSE_CARD_TITLE} p={0}>
      <Stack gap={2} px={4} py={4} align="stretch" textAlign="left">
        <Flex align="center" justify="space-between" gap={3}>
          <Text
            fontFamily="heading"
            fontWeight="700"
            fontSize="xs"
            // Same tracking as the sibling "Today's Math Playlists" strip title
            // (PlaylistCard) — these two card headers sit one above the other.
            letterSpacing="0.02em"
            color="charcoal.400"
          >
            {card.eyebrow}
          </Text>
          <StatusChip label={card.chip.label} tone={card.chip.tone} />
        </Flex>

        <Flex align="center" gap={3} minW={0}>
          {badge && (
            // Celebration art only, and only once there is a credential to
            // celebrate — small, decorative, never a second credential card.
            <BadgeArt
              imageUrl={badge.imageUrl}
              emoji={badge.icon}
              status={badge.artStatus as BadgeArtStatus}
              size="36px"
              rounded="full"
              showGeneratingOverlay={false}
              alt=""
            />
          )}
          <Text
            fontFamily="heading"
            fontWeight="800"
            fontSize="lg"
            color="navy.500"
            minW={0}
          >
            {card.title}
          </Text>
        </Flex>

        <Flex align="baseline" gap={2} wrap="wrap">
          <Text
            fontFamily="heading"
            fontWeight="800"
            fontSize="2xl"
            lineHeight="1.1"
            color="navy.500"
          >
            {card.status.value}
          </Text>
          <Text fontSize="sm" color="#65706a">
            {card.status.detail}
          </Text>
        </Flex>

        <Box aria-label="Your fast math facts" pt={1}>
          <FastMathFactGrid cells={status.fastMath.facts} compact />
        </Box>

        <Text fontSize="sm" color="charcoal.500" lineHeight="1.45">
          {card.body}
        </Text>

        <Text fontSize="xs" color="charcoal.400">
          {card.cue}
        </Text>

        {card.showCredentialFields && status.license && (
          <Flex gap={6} wrap="wrap">
            <CredentialField
              label="Issued"
              value={formatIssuedDate(status.license.issuedAt)}
            />
            {status.license.issuedByName && (
              <CredentialField
                label="Proctor"
                value={status.license.issuedByName}
              />
            )}
          </Flex>
        )}

        <Box pt={1}>
          <Button
            asChild
            size="sm"
            width="full"
            colorPalette="teal"
            // Always secondary: the Math tab's primary CTA is the card above
            // (check-in / playlist), and quick-facts practice is the adjacent
            // optional path in every license state. Full width to match the
            // sibling cards' bottom-slot buttons.
            variant="outline"
            fontFamily="heading"
          >
            <NextLink
              href={practiceHref}
              aria-busy={starting || undefined}
              onClick={(event) => {
                if (starting) {
                  event.preventDefault();
                  return;
                }
                setStarting(true);
              }}
            >
              {starting ? card.action.busyLabel : card.action.label}
            </NextLink>
          </Button>
        </Box>
      </Stack>
    </Surface>
  );
}
