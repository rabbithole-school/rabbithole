"use client";

import { Box, HStack, Text } from "@chakra-ui/react";
import { Avatar } from "@/components/Avatar";

export interface GuardianAvatar {
  _id: string;
  name: string;
  image?: string | null;
}

/**
 * Compact participant treatment for a scholar's shared family conversation.
 * It intentionally renders only the guardians who can read and reply here.
 */
export function GuardianFacepile({
  guardians,
  size = "xs",
  max = 3,
}: {
  guardians: GuardianAvatar[];
  size?: "2xs" | "xs" | "sm";
  max?: number;
}) {
  const visible = guardians.slice(0, max);
  const overflow = guardians.length - visible.length;

  return (
    <HStack
      gap={1}
      align="center"
      aria-label={`Conversation with ${guardians.map((guardian) => guardian.name).join(", ")}`}
    >
      <HStack gap={0} align="center" aria-hidden="true">
        {visible.map((guardian, index) => (
          <Box
            key={guardian._id}
            ml={index === 0 ? 0 : -1}
            borderRadius="full"
            boxShadow="0 0 0 1.5px white"
          >
            <Avatar
              name={guardian.name}
              src={guardian.image ?? undefined}
              size={size}
              colorKey={guardian._id}
            />
          </Box>
        ))}
      </HStack>
      {overflow > 0 && (
        <Text fontSize="2xs" color="charcoal.500" fontFamily="heading" fontWeight="600">
          +{overflow}
        </Text>
      )}
    </HStack>
  );
}
