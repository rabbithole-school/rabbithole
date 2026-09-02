"use client";

/**
 * Small banner shown above the scholar's chat when the activity has
 * `hasScholarAngles: true` AND the scholar has chosen an angle.
 * Renders muted; visible context for the scholar so they remember
 * which angle they're working from.
 */
import { useQuery } from "convex/react";
import { HStack, Text } from "@chakra-ui/react";
import { ScholarAngleIcon } from "@/lib/scholarAngle";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

export function ScholarAngleBanner({
  activityId,
}: {
  activityId: Id<"activities">;
}) {
  const angle = useQuery(api.scholarActivityAngles.getMyAngleForActivity, {
    activityId,
  });
  if (!angle) return null;
  return (
    <HStack
      gap={2}
      px={3}
      py={2}
      bg="violet.50"
      borderRadius="md"
      borderWidth="1px"
      borderColor="violet.200"
    >
      <ScholarAngleIcon size={14} color="var(--chakra-colors-violet-500)" />
      <Text fontSize="xs" fontFamily="heading" color="violet.700">
        <Text as="span" fontWeight="700" textTransform="uppercase" letterSpacing="0.04em" fontSize="2xs" mr={1.5}>
          Your angle
        </Text>
        <Text as="span" fontWeight="600">
          {angle.title}
        </Text>
      </Text>
    </HStack>
  );
}
