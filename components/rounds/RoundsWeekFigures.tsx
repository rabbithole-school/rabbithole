"use client";

/**
 * The weekly figures for one scholar: three FIXED slots plus, when it clears
 * the server's calibrated floor, a friction line.
 *
 * The three slots are fixed relative to EACH OTHER — a scholar who practised
 * and a scholar who did some but not all of the three occupy the same slot
 * heights, so a partial week never reads as a verdict. An individually empty
 * slot says "None"; it does not collapse and shorten the row.
 *
 * A week with NO arithmetic at all is different: rather than three greyed
 * "None" boxes it folds to one honest sentence (see `hasNoFigures`). The
 * two-altitude board carries the equal-status guarantee at the row level now —
 * every collapsed row is the same shape — so a fully-empty figures block can be
 * a single line here instead of a fixed-height placeholder.
 *
 * There is no total here, and no comparison between scholars. See the header of
 * `RoundsWeekBoard` for why this surface carries no aggregate anything.
 */

import { Box, Grid, Stack, Text } from "@chakra-ui/react";

import {
  figuresAreCurrentLine,
  frictionLine,
  hasNoFigures,
  noFiguresLine,
  roundsFigureSlots,
  type RoundsPracticeSignals,
} from "./roundsFigures";

export function RoundsWeekFigures({
  signals,
  scholarName,
  compact = false,
  pastWeekLabel = null,
}: {
  signals: RoundsPracticeSignals | null;
  scholarName: string;
  /** Board rows run compact; the pane gives the same figures more air. */
  compact?: boolean;
  /**
   * Set when the board has stepped back to a closed week. The figures are a
   * trailing-seven-day instrument and cannot be recomputed for a past week, so
   * they are replaced by a sentence saying so rather than shown as that week's.
   */
  pastWeekLabel?: string | null;
}) {
  if (!signals) return null;

  if (pastWeekLabel) {
    return (
      <Text
        fontFamily="body"
        fontSize={compact ? "sm" : "md"}
        color="charcoal.400"
      >
        {figuresAreCurrentLine(pastWeekLabel)}
      </Text>
    );
  }

  const slots = roundsFigureSlots(signals);
  const friction = frictionLine(signals);
  const empty = hasNoFigures(signals);

  // A week with no arithmetic at all folds to one honest sentence rather than
  // three greyed "None" boxes. The old fixed-slot geometry existed to keep a
  // quiet scholar from reading as lower status on a row of equal-height blocks;
  // the two-altitude board carries that guarantee at the row level now, so the
  // absence can be one line here.
  if (empty) {
    return (
      <Text
        fontFamily="body"
        fontSize={compact ? "sm" : "md"}
        color="charcoal.400"
      >
        {noFiguresLine(signals, scholarName)}
      </Text>
    );
  }

  return (
    <Stack gap={compact ? 2 : 3}>
      <Grid
        templateColumns={{ base: "1fr", sm: "repeat(3, minmax(0, 1fr))" }}
        gap={compact ? 3 : 4}
        borderWidth="1px"
        borderColor="gray.200"
        borderRadius="md"
        bg="gray.50"
        px={compact ? 3 : 4}
        py={compact ? 3 : 4}
      >
        {slots.map((slot) => (
          <Stack key={slot.key} gap={0.5} minW={0}>
            <Text
              fontFamily="heading"
              fontSize={compact ? "lg" : "xl"}
              fontWeight="700"
              lineHeight="1.15"
              color={slot.present ? "navy.500" : "charcoal.300"}
            >
              {slot.value}
            </Text>
            <Text
              fontFamily="heading"
              fontSize="sm"
              fontWeight="600"
              color="charcoal.400"
            >
              {slot.label}
            </Text>
            {slot.caption ? (
              <Text fontFamily="body" fontSize="sm" color="charcoal.300">
                {slot.caption}
              </Text>
            ) : null}
          </Stack>
        ))}
      </Grid>

      {friction ? (
        <Box>
          <Text
            fontFamily="heading"
            fontSize={compact ? "sm" : "md"}
            fontWeight="600"
            color="charcoal.500"
          >
            {friction.headline}
          </Text>
          <Text fontFamily="body" fontSize="sm" color="charcoal.300">
            {friction.caption}
          </Text>
        </Box>
      ) : null}
    </Stack>
  );
}
