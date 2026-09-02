"use client";

import { Box, Spinner, Text, VStack } from "@chakra-ui/react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

type WorkingLevelData = NonNullable<ReturnType<typeof useQuery<typeof api.workingLevel.forScholar>>>;

/**
 * Reference-only Working Level readout — a staff instrument, never shown to
 * the scholar (review/assessment-and-goals-plan.html §10). Lives on the
 * Overall tab's evidence pane, alongside the coverage + dimension-ratings
 * summary (components/narrative/BinderPane.tsx).
 *
 * The number-button `RatingControl` that used to live here was removed
 * 2026-07-02 in favor of the shared `RubricSlider` (components/ui/RubricSlider.tsx).
 */
export function WorkingLevelReadout({ workingLevel }: { workingLevel: WorkingLevelData | undefined }) {
  return (
    <Box>
      <Text
        fontFamily="heading"
        fontWeight="700"
        fontSize="xs"
        textTransform="uppercase"
        letterSpacing="0.04em"
        color="charcoal.400"
        mb={1.5}
      >
        Working Level
      </Text>
      {workingLevel === undefined ? (
        <Spinner size="xs" color="violet.500" />
      ) : workingLevel.byDomain.length === 0 ? (
        <Text fontSize="2xs" color="charcoal.300" fontFamily="body">
          No working-level data yet.
        </Text>
      ) : (
        <VStack align="stretch" gap={1.5}>
          {workingLevel.byDomain.map((d) => (
            <Box key={d.domain}>
              <Text fontSize="xs" fontFamily="heading" fontWeight="600" color="navy.600">
                {d.domain}:{" "}
                <Text as="span" fontFamily="body" fontWeight="400" color="charcoal.600">
                  {d.level}
                </Text>
              </Text>
              <Text fontSize="3xs" color="charcoal.300" fontFamily="body">
                {d.source}
              </Text>
            </Box>
          ))}
        </VStack>
      )}
      <Text fontSize="3xs" color="charcoal.300" fontFamily="body" mt={1.5}>
        Reference only — computed from the record, never shown to the scholar.
      </Text>
    </Box>
  );
}
