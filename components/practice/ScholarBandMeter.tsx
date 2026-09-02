"use client";

/**
 * ScholarBandMeter — a thin stacked bar of one scholar's mastery-band mix across
 * a domain's skills. It is a SECOND CONSUMER of the same per-scholar band counts
 * the scholar × domain detail already renders as rows (`bandCountsForScholar`),
 * so the header glance (D1) and the detail never disagree — it mints no new
 * signal, only a denser rendering of an existing one.
 *
 * Colour discipline (shared with the dial + rail): the bar reuses the exact
 * mastery hues from `MASTERY_DOT_COLOR`, one hue per band — amber IS frontier,
 * green IS fluent. `placed` shares fluent's green HUE, so (as on the dial, where
 * ring-vs-fill is the tell) it is drawn as a hatched green segment to read
 * "provisional / inferred" rather than a second solid green. `locked` (not
 * started) is deliberately OMITTED from the bar: the meter visualises the earned
 * mix among ENGAGED skills (the teacher's "who's mostly-yellow?" triage), while
 * coverage (started / total) lives in the tooltip and the detail. `struggling`
 * (red) IS an engaged skill (touched, just recently failing), so unlike `locked`
 * it stays in the bar — dropping it would over-represent the good bands and
 * silently hide the at-risk skills from the glance, tooltip, and aria summary.
 */

import { Box, Flex, Text, Tooltip, Portal } from "@chakra-ui/react";
import { MASTERY_DOT_COLOR } from "@/shared/masteryDialPalette";
import { MasteryDot } from "@/components/MasteryDot";
import {
  ENGAGED_BAND_ORDER,
  MASTERY_FILTER_LABEL,
  type BandCounts,
  type MasteryFilterKey,
} from "@/components/practice/mathSkillsMasteryFilters";

/** A green hatched fill for the provisional `placed` band (shares fluent's hue). */
function placedFill(green: string): string {
  return `repeating-linear-gradient(-45deg, ${green} 0 3px, #ffffff 3px 5px)`;
}

function segmentBackground(band: MasteryFilterKey): string {
  return band === "placed"
    ? placedFill(MASTERY_DOT_COLOR.placed)
    : MASTERY_DOT_COLOR[band];
}

export function ScholarBandMeter({
  counts,
  total,
  engaged,
  height = 6,
  showLegend = false,
  ariaLabelPrefix = "Mastery mix",
}: {
  counts: BandCounts;
  total: number;
  engaged: number;
  /** Bar thickness in px. The header glance is thin (6); the report is chunky. */
  height?: number;
  /** Render a per-band count legend below the bar (the report's big meter). */
  showLegend?: boolean;
  ariaLabelPrefix?: string;
}) {
  const shownBands = ENGAGED_BAND_ORDER.filter((band) => counts[band] > 0);
  const summary = shownBands
    .map((band) => `${counts[band]} ${MASTERY_FILTER_LABEL[band].toLowerCase()}`)
    .join(", ");
  const ariaLabel = `${ariaLabelPrefix}: ${
    engaged === 0 ? "nothing started" : summary
  }. ${engaged} of ${total} skills started.`;

  const bar = (
    <Box
      display="flex"
      w="full"
      h={`${height}px`}
      borderRadius="full"
      overflow="hidden"
      bg="gray.100"
      role="img"
      aria-label={ariaLabel}
    >
      {engaged > 0 &&
        shownBands.map((band) => (
          <Box
            key={band}
            h="full"
            flexGrow={counts[band]}
            flexBasis={0}
            minW="2px"
            background={segmentBackground(band)}
            borderRightWidth={band === "placed" ? "1px" : 0}
            borderColor="whiteAlpha.700"
          />
        ))}
    </Box>
  );

  if (!showLegend) {
    return (
      <Tooltip.Root openDelay={200} closeDelay={0}>
        <Tooltip.Trigger asChild>
          <Box w="full">{bar}</Box>
        </Tooltip.Trigger>
        <Portal>
          <Tooltip.Positioner>
            <Tooltip.Content px={2.5} py={2} maxW="220px">
              {engaged === 0 ? (
                <Text fontSize="xs">Nothing started in this domain yet.</Text>
              ) : (
                <Box>
                  {shownBands.map((band) => (
                    <Flex key={band} align="center" gap={1.5} mb={0.5}>
                      <MasteryDot state={band} size={14} />
                      <Text fontSize="xs">
                        <Text as="span" fontWeight="700">
                          {counts[band]}
                        </Text>{" "}
                        {MASTERY_FILTER_LABEL[band]}
                      </Text>
                    </Flex>
                  ))}
                </Box>
              )}
              <Text fontSize="2xs" color="whiteAlpha.800" mt={1}>
                {engaged} of {total} skills started
              </Text>
            </Tooltip.Content>
          </Tooltip.Positioner>
        </Portal>
      </Tooltip.Root>
    );
  }

  // Big meter (report): bar + an explicit per-band count legend so the numbers
  // are readable without a hover.
  return (
    <Box>
      {bar}
      <Flex wrap="wrap" gap={3} mt={2.5}>
        {shownBands.length === 0 ? (
          <Text fontSize="xs" color="charcoal.400">
            Nothing started in this domain yet.
          </Text>
        ) : (
          shownBands.map((band) => (
            <Flex key={band} align="center" gap={1.5}>
              <MasteryDot state={band} size={16} />
              <Text fontSize="xs" color="charcoal.600">
                <Text as="span" fontWeight="700" color="charcoal.700">
                  {counts[band]}
                </Text>{" "}
                {MASTERY_FILTER_LABEL[band]}
              </Text>
            </Flex>
          ))
        )}
        <Text fontSize="xs" color="charcoal.400" ml="auto">
          {engaged} of {total} started
        </Text>
      </Flex>
    </Box>
  );
}
