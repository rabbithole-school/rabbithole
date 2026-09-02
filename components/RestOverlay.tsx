"use client";

/**
 * RestOverlay — the full-screen "screens down" calm state a teacher calls
 * with a `rest` room cue (see convex/roomCues.ts). This is a ROOM STATE, not
 * a countdown or a lockout: no clock ticking down, no interaction disabled
 * beyond simply covering the screen, and nothing underneath is destroyed or
 * navigated away from — the session stays exactly where it was, and the
 * overlay lifts the instant the teacher clears it (or calls a new cue),
 * purely reactively (Andy, 2026-07-13).
 *
 * Deliberately nothing tappable here yet — a "hand-raise" affordance is a
 * later PR's scope, not this one's.
 */

import { Flex, Text } from "@chakra-ui/react";
import { REST_HEADLINE, restSubline } from "@/shared/roomCueCopy";

export function RestOverlay({ returnAt }: { returnAt: number | null }) {
  const subline = restSubline(returnAt);
  return (
    <Flex
      position="fixed"
      inset={0}
      zIndex={9000}
      bg="navy.900"
      align="center"
      justify="center"
      direction="column"
      gap={2}
      px={8}
    >
      <Text fontSize="2xl" fontFamily="heading" fontWeight="700" color="white">
        {REST_HEADLINE}
      </Text>
      {subline && (
        <Text fontSize="md" fontFamily="body" color="whiteAlpha.800">
          {subline}
        </Text>
      )}
    </Flex>
  );
}
