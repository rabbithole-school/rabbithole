"use client";

/**
 * Summary tab of an ACTIVITY — the read view + its maturity timeline.
 * Activities are where rehearsal/debrief actually happen, so the activity
 * Summary is the detailed depiction Andy asked for: what the activity is,
 * its prompt + deliverable, and its standing on the Draft → Rehearsed →
 * Debriefed ladder. Editing is the Edit tab; running the sims is the
 * Rehearse / Debrief tabs. See review/curriculum-rehearse-and-maturity.md.
 *
 * The body itself lives in the shared ActivityReadBody (also consumed by the
 * schedule's PlacementDetailDrawer) — this wrapper owns the pane chrome:
 * title, padding, and the full-height scroll container.
 */
import { useQuery } from "convex/react";
import { Box, Flex, Spinner, Stack, Text } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ActivityReadBody } from "@/components/ActivityReadBody";

export function ActivitySummary({
  unitId,
  activityId,
}: {
  unitId: Id<"units">;
  activityId: Id<"activities">;
}) {
  const activity = useQuery(api.activities.get, { id: activityId });

  if (activity === undefined) {
    return (
      <Flex h="full" align="center" justify="center">
        <Spinner size="md" color="violet.500" />
      </Flex>
    );
  }
  if (activity === null) {
    return (
      <Flex h="full" align="center" justify="center">
        <Text fontSize="sm" color="charcoal.400">
          Activity not found
        </Text>
      </Flex>
    );
  }

  return (
    <Box h="full" overflowY="auto">
      {/* gap=2 spaces title → the body's meta strip; the body's own internal
          stack keeps the section rhythm (gap=6), so the pane renders exactly
          as the pre-extraction ActivitySummary did. */}
      <Stack gap={2} px={8} pt={2} pb={8} maxW="900px">
        <Text
          fontFamily="heading"
          fontWeight="700"
          fontSize="xl"
          color="navy.500"
        >
          {activity.title}
        </Text>
        <ActivityReadBody unitId={unitId} activityId={activityId} longText="full" />
      </Stack>
    </Box>
  );
}
