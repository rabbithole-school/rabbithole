"use client";

/**
 * Reading and writing, told apart.
 *
 * TWO instruments share a vocabulary in this product and must never share a
 * rendering:
 *
 *   confirmed          a teacher-ratified SETTING the tutor adapts to. `setAt`
 *                      is when a human ratified, not when anything was measured.
 *   writing complexity Flesch–Kincaid over typed messages. Mechanical. Its
 *                      canonical rendering is the profile chart; we state the
 *                      latest value and point there instead of drawing a second.
 *
 * The AI's writing estimate is a third thing, and it is deliberately NOT here:
 * it is info-only on the scholar profile's Write row (TRA-513), and nothing in
 * a meeting can act on it.
 */

import { Badge, HStack, Stack, Text } from "@chakra-ui/react";

import {
  confirmedLevelLine,
  writingComplexityLine,
  type RoundsLevelSignals,
} from "./roundsFigures";

/**
 * Said when the level read was refused — non-teaching operations staff have no
 * access to it. A quiet "not available", never an error banner: the rest of the
 * week is theirs to read, and the meeting should not stop for a boundary
 * working as designed.
 */
const LEVEL_UNAVAILABLE = "Reading level not available to your role";

/** The pane form: the setting and the mechanical writing trend, told apart. */
export function RoundsLevelCard({
  scholarName,
  signals,
  writingComplexity,
  unavailable = false,
}: {
  scholarName: string;
  signals: RoundsLevelSignals | null;
  /** Latest Flesch–Kincaid grade level over typed messages, or null. */
  writingComplexity: number | null;
  /** The level read was refused for this viewer. Say so; show the rest. */
  unavailable?: boolean;
}) {
  const complexityOnly = writingComplexityLine(writingComplexity);
  if (unavailable || !signals) {
    if (!unavailable) return null;
    return (
      <Stack gap={4}>
        <Text fontFamily="body" fontSize="sm" color="charcoal.400">
          {LEVEL_UNAVAILABLE}. The rest of {scholarName}&rsquo;s week is below.
        </Text>
        <Stack gap={0.5}>
          <Text fontFamily="heading" fontSize="sm" fontWeight="600" color="charcoal.400">
            {complexityOnly.headline}
          </Text>
          <Text fontFamily="body" fontSize="sm" color="charcoal.300">
            {complexityOnly.caption}
          </Text>
        </Stack>
      </Stack>
    );
  }

  const confirmed = confirmedLevelLine(signals);
  const complexity = writingComplexityLine(writingComplexity);

  return (
    <Stack gap={4}>
      <Stack gap={1}>
        <HStack gap={2} align="baseline" flexWrap="wrap">
          <Text fontFamily="heading" fontSize="md" fontWeight="700" color="charcoal.600">
            {confirmed.headline}
          </Text>
          <Badge
            variant="subtle"
            colorPalette="gray"
            fontFamily="heading"
            fontSize="xs"
          >
            The tutor adapts to this
          </Badge>
        </HStack>
        {confirmed.caption ? (
          <Text fontFamily="body" fontSize="sm" color="charcoal.400">
            {confirmed.caption}
          </Text>
        ) : null}
      </Stack>

      <Stack gap={0.5}>
        <Text fontFamily="heading" fontSize="sm" fontWeight="600" color="charcoal.400">
          {complexity.headline}
        </Text>
        <Text fontFamily="body" fontSize="sm" color="charcoal.300">
          {complexity.caption} Its chart lives on the profile as &ldquo;Scholar
          writing over time&rdquo;.
        </Text>
      </Stack>
    </Stack>
  );
}
