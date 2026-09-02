"use client";

/**
 * DailyRecapCard — the scholar-home factual map-movement receipt.
 *
 * A quiet card that appears ONLY when durable Knowledge Tree movement happened.
 * Scholar’s Prep owns interpretation; this component shows only the factual
 * fluency/frontier receipt.
 *
 * PRESENTATIONAL, and no longer a standing Home surface of its own. For a
 * scholar it renders as the `daily` state of components/MapHomeCard.tsx — the
 * one canonical Tree card — because a second card pointing at the same map
 * with the same CTA was the duplication that card exists to remove (Andy,
 * 2026-07-26; see shared/mapHomeCard.ts). It stays standalone in the teacher's
 * REMOTE view, which has no scholar map gates to run a ladder off. Either way
 * the `dailyRecap` query + the institution `dayKey` live on the scholar-home
 * page (app/scholar/page.tsx), which lifts them into its above-the-fold render
 * gate so the whole home paints in one step (no per-card pop-in). This card
 * just renders the `recap` it's handed.
 *
 * Portrait, not report card (see review/anti-parasocial-design.md): no scores,
 * no correct/wrong counts, no streaks, no goals, no comparisons, no empty
 * praise. When nothing moved today the backend returns `hasAny: false` and this
 * renders NOTHING — never a guilt zero-state. Delta is self-vs-self only.
 *
 * Visual: full-width, hairline-divided rows — the SAME "receipt list" idiom as
 * the sibling "Today's Math Playlists" card (PlaylistCard), sharing its row
 * geometry via `receiptRowStyle` (visual-design instruction, f26): a leading
 * status dot, the skill name as the row's main text, and the proficiency word
 * ("Fluent" / "Your frontier moved") as a quiet right-aligned tag — exactly
 * like PlaylistCard's "Next up" / "In your set" tags. The dot stays the
 * existing MapTrifold-adjacent KnowledgeNodeDial (yellow-frontier /
 * green-fluent), and a "revealed" event ("Added to your Tree Map") reuses the
 * map's quiet locked/not-started dot — no new celebration language, just a row
 * shape borrowed from its sibling card.
 */

import NextLink from "next/link";
import { Box, Flex, Text, Link as ChakraLink } from "@chakra-ui/react";
import { MapTrifold, ArrowRight } from "@phosphor-icons/react";
import { buildRecapLines, RECAP_DIAL_STATE, type RecapLine } from "@/shared/dailyRecapLines";
import type { DailyRecap } from "@/convex/lib/dailyRecap";
import { Surface } from "@/components/ui/Surface";
import { KnowledgeNodeDial, type MasteryState } from "@/components/KnowledgeNodeDial";
import {
  RECEIPT_LEAD_W,
  RECEIPT_LEAD_GAP,
  RECEIPT_ROW_PX,
  RECEIPT_ROW_PY,
  RECEIPT_STRIP_PY,
  RECEIPT_FOOTER_PY,
  RECEIPT_ROW_DIVIDER_COLOR,
  RECEIPT_STRIP_DIVIDER_COLOR,
  RECEIPT_TAG_FONT_SIZE,
  RECEIPT_TAG_COLOR,
  RECEIPT_LABEL_FONT_SIZE,
} from "@/components/practice/receiptRowStyle";

// The reveal band has no dot state of its own — see RECAP_DIAL_STATE.
const DIAL_STATE: Record<RecapLine["mastery"], MasteryState> = RECAP_DIAL_STATE;

// Only for the standalone (teacher remote-view) call site; the scholar Home
// passes MAP_HOME_COPY.tree.daily through MapHomeCard.
const DEFAULT_TITLE = "Your map changed today";
const DEFAULT_CTA = "See your map";

export function DailyRecapCard({
  recap,
  mapHref,
  title = DEFAULT_TITLE,
  ctaLabel = DEFAULT_CTA,
}: {
  recap: DailyRecap | undefined;
  // Where "See your map" lands — the page stamps it (remote-mode aware) and
  // points it at the Tree lens, the surface that shows the movement this card
  // names.
  mapHref: string;
  /**
   * Overridden by MapHomeCard's `daily` state, which reads both strings from
   * shared/mapHomeCard.ts so the receipt cannot say one thing on web and
   * another on native. The defaults are for the ONE remaining standalone call
   * site — the teacher's remote view — which sits outside that ladder.
   */
  title?: string;
  ctaLabel?: string;
}) {
  // Loading, or a day with no movement → render nothing.
  if (!recap?.hasAny) return null;

  const lines = buildRecapLines(recap);

  return (
    <Surface as="section" aria-label={title} p={0} overflow="hidden">
      <Flex
        align="center"
        gap={RECEIPT_LEAD_GAP}
        px={RECEIPT_ROW_PX}
        py={RECEIPT_STRIP_PY}
        borderBottomWidth="1px"
        borderColor={RECEIPT_STRIP_DIVIDER_COLOR}
      >
        <Box color="charcoal.500" flexShrink={0}>
          <MapTrifold size={20} weight="duotone" />
        </Box>
        <Text fontFamily="heading" fontWeight="700" color="navy.500" fontSize="md">
          {title}
        </Text>
      </Flex>

      <Box as="ul" listStyleType="none" m={0} p={0}>
        {lines.map((line) => (
          <Flex
            as="li"
            key={line.key}
            align="center"
            gap={RECEIPT_LEAD_GAP}
            px={RECEIPT_ROW_PX}
            py={RECEIPT_ROW_PY}
            borderTopWidth="1px"
            borderColor={RECEIPT_ROW_DIVIDER_COLOR}
          >
            <Box aria-hidden="true" flexShrink={0} w={RECEIPT_LEAD_W} display="flex" justifyContent="center">
              <KnowledgeNodeDial
                mastery={DIAL_STATE[line.mastery]}
                automaticity={0}
                depth={0}
                size={18}
                flankWidth={0}
              />
            </Box>
            <Text
              flex="1"
              minW={0}
              lineClamp={1}
              fontSize={RECEIPT_LABEL_FONT_SIZE}
              fontWeight="700"
              color="navy.500"
            >
              {line.text}
            </Text>
            <Text
              flexShrink={0}
              textAlign="right"
              lineClamp={1}
              fontSize={RECEIPT_TAG_FONT_SIZE}
              color={RECEIPT_TAG_COLOR}
            >
              {line.label}
            </Text>
          </Flex>
        ))}
      </Box>

      <Box
        px={RECEIPT_ROW_PX}
        py={RECEIPT_FOOTER_PY}
        borderTopWidth="1px"
        borderColor={RECEIPT_STRIP_DIVIDER_COLOR}
        bg="white"
      >
        <ChakraLink
          asChild
          display="inline-flex"
          alignItems="center"
          gap={1.5}
          color="charcoal.500"
          fontFamily="heading"
          fontWeight="600"
          fontSize="sm"
          _hover={{ color: "violet.600", textDecoration: "underline" }}
        >
          <NextLink href={mapHref}>
            {ctaLabel}
            <ArrowRight size={16} weight="bold" />
          </NextLink>
        </ChakraLink>
      </Box>
    </Surface>
  );
}
