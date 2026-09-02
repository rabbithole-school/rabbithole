"use client";

/**
 * ForecastRow (web) — the row shape shared by everything a scholar can SEE but
 * not yet DO: a planned entry on today's Now tab, and every row in Coming up.
 *
 * These were two components (`PlannedTodayCard`, `ComingUpRow`) drawing the
 * same object with different wrappers, and they had drifted apart in the small
 * ways duplicated components always do — one dimmed its title, one put a clock
 * glyph inside the status pill, one nested the emoji differently. None of that
 * was a decision. One row, one anatomy: glyph · (title + attribution) · status.
 *
 * Deliberately no CTA and no press target. A forecast row is non-actionable by
 * construction, and that is enforced by the server (the live/planned `setAt`
 * boundary), not by a caller remembering to leave the CTA off. If you find
 * yourself wanting to add one, the row you want is an activity row, not this.
 *
 * The ghost treatment — dashed border, tinted background — belongs to the
 * WRAPPER, not the row. A planned card looks provisional because of the card
 * around it; the row inside it reads exactly like every other forecast row.
 */

import { Box, HStack, Stack, Text } from "@chakra-ui/react";

export function ForecastRow({
  glyph,
  title,
  meta,
  status,
}: {
  /** Identity glyph. Only present when the row is NOT under a unit band, and
   *  never a fallback — a generic emoji on every unitless row identifies
   *  nothing. */
  glyph?: string | null;
  title: string;
  /** "what this is and whose it is" — unit · with teacher. */
  meta?: string | null;
  /** The status slot: a DueChip, a StatusChip, or nothing. A node, not an
   *  enum, so a surface can fill it without this component learning every
   *  kind of status that exists. */
  status?: React.ReactNode;
}) {
  return (
    <HStack justify="space-between" align="flex-start" gap={3}>
      <HStack gap={2} align="flex-start" flex={1} minW={0}>
        {glyph ? (
          <Text fontSize="md" flexShrink={0} lineHeight="1.4" aria-hidden>
            {glyph}
          </Text>
        ) : null}
        <Stack gap={0.5} flex={1} minW={0}>
          <Text
            fontFamily="heading"
            fontWeight="500"
            fontSize="sm"
            color="charcoal.600"
            lineClamp={2}
          >
            {title}
          </Text>
          {meta ? (
            <Text fontSize="2xs" color="charcoal.400" fontFamily="heading">
              {meta}
            </Text>
          ) : null}
        </Stack>
      </HStack>
      {status ? (
        <Box mt={0.5} flexShrink={0}>
          {status}
        </Box>
      ) : null}
    </HStack>
  );
}
