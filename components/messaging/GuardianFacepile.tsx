"use client";

import { Box, HStack, Text } from "@chakra-ui/react";
import { Avatar } from "@/components/Avatar";

export interface GuardianAvatar {
  _id: string;
  name: string;
  image?: string | null;
}

/**
 * Compact participant treatment for a conversation: a scholar's guardians on
 * a family thread, or the scholar + named adults on a mentor/Workshop thread.
 * It renders only the people who can read and reply here.
 */
export function GuardianFacepile({
  guardians,
  size = "xs",
  max = 3,
  viewerId,
}: {
  guardians: GuardianAvatar[];
  size?: "2xs" | "xs" | "sm";
  max?: number;
  /** The signed-in user — never shown their own avatar (or name). */
  viewerId?: string | null;
}) {
  // A facepile answers "who else is in this conversation"; the viewer
  // already knows they are. One face per person: a staffer who is also a
  // guardian can be on both sides of a family thread.
  const others = guardians.filter(
    (guardian, index) =>
      guardian._id !== viewerId &&
      guardians.findIndex((other) => other._id === guardian._id) === index,
  );
  const visible = others.slice(0, max);
  const overflow = others.length - visible.length;
  if (others.length === 0) return null;
  const label = `Conversation with ${others.map((guardian) => guardian.name).join(", ")}`;

  return (
    // `role="group"` makes the label nameable — on a generic element with its
    // avatars aria-hidden, assistive tech would announce nothing.
    <HStack gap={1} align="center" role="group" aria-label={label}>
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
