"use client";

// Per-scholar "Badges" strip on the teacher's Work tab — the earned unit
// completion badges for THIS scholar. Until now the only teacher-facing badge
// surface was the group-wide Trophy Case; this is the per-scholar view.

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Box, Flex, HStack, Text, Spinner } from "@chakra-ui/react";
import { Medal } from "@phosphor-icons/react";
import { BadgeArt } from "@/components/BadgeArt";
import { formatTimeAgo } from "@/lib/relativeTime";

export function ScholarBadgesCard({ scholarId }: { scholarId: Id<"users"> }) {
  const badges = useQuery(api.scholarUnitBadges.badgesForScholar, { scholarId });

  return (
    <Box>
      <HStack mb={3}>
        <Medal color="#AD60BF" />
        <Text fontWeight="600" fontFamily="heading" color="navy.500" fontSize="sm">
          Badges{badges && badges.length > 0 ? ` (${badges.length})` : ""}
        </Text>
      </HStack>

      {badges === undefined ? (
        <Flex justify="center" py={4}>
          <Spinner size="sm" color="violet.500" />
        </Flex>
      ) : badges.length === 0 ? (
        <Text
          fontSize="sm"
          color="charcoal.300"
          fontFamily="heading"
          textAlign="center"
          py={4}
        >
          No badges yet — earned by completing a unit, or award one from “+ Add”.
        </Text>
      ) : (
        <Box
          display="grid"
          gridTemplateColumns="repeat(auto-fill, minmax(116px, 1fr))"
          gap={3}
        >
          {badges.map((b) => (
            <Flex
              key={b._id}
              direction="column"
              align="center"
              gap={1}
              p={3}
              bg="white"
              borderRadius="lg"
              borderWidth="1px"
              borderColor="gray.200"
              shadow="xs"
            >
              <BadgeArt
                imageUrl={b.imageUrl}
                emoji={b.unitEmoji ?? "🏅"}
                status={b.artStatus}
                size="72px"
                alt={`${b.unitTitle} badge`}
                showGeneratingOverlay={false}
              />
              <Text
                fontFamily="heading"
                fontWeight="600"
                fontSize="xs"
                color="navy.500"
                textAlign="center"
                lineClamp={2}
              >
                {b.unitTitle}
              </Text>
              <Text fontSize="2xs" color="charcoal.400" fontFamily="heading">
                {formatTimeAgo(b.earnedAt)}
              </Text>
            </Flex>
          ))}
        </Box>
      )}
    </Box>
  );
}
