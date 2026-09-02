"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Box, Flex, VStack, HStack, Text, Badge, Spinner } from "@chakra-ui/react";

// ── Cross-domain connections ──────────────────────────────────────────────
// The transdisciplinary leaps the observer recorded for one scholar. This used
// to carry a second "Strengths" lens (signal bars + learner-stated
// reflections); that lens was removed because the same signals already have a
// canonical home in the Portrait and the feed, and a second rendering of one
// signal is the exact thing the taste charter forbids (T1).

interface SignalsTabProps {
  scholarId: string;
}

export function SignalsTab({ scholarId }: SignalsTabProps) {
  const connections = useQuery(api.crossDomainConnections.listByScholar, {
    scholarId: scholarId as Id<"users">,
  });

  if (connections === undefined) {
    return (
      <Flex justify="center" py={8}>
        <Spinner size="md" color="violet.500" />
      </Flex>
    );
  }

  if (!connections.length) {
    return (
      <Text fontSize="sm" color="charcoal.300" fontFamily="heading" textAlign="center" py={8}>
        No cross-domain connections recorded yet.
      </Text>
    );
  }

  return (
    <VStack gap={2} align="stretch">
      {connections.map((conn) => (
        <Box
          key={conn._id}
          p={3}
          bg="white"
          borderRadius="md"
          shadow="xs"
          borderWidth="1px"
          borderColor="cyan.400"
        >
          <HStack gap={1} mb={1} flexWrap="wrap">
            {conn.domains.map((d: string) => (
              <Badge key={d} bg="cyan.50" color="cyan.700" fontSize="2xs">
                {d}
              </Badge>
            ))}
            {conn.studentInitiated && (
              <Badge bg="teal.50" color="teal.600" fontSize="2xs">
                student-initiated
              </Badge>
            )}
          </HStack>
          <Text fontSize="sm" color="charcoal.600" fontFamily="body" lineHeight="1.4">
            {conn.description}
          </Text>
        </Box>
      ))}
    </VStack>
  );
}
