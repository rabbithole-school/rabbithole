"use client";

/**
 * The scholar's parked ideas (sessions.parkingLot) as a list of chips — ONE
 * rendering shared by every surface that shows the lot (T1/T12):
 *   • the Workshop strip (components/vibecode/ParkingLot.tsx),
 *   • the "Saved for later" block on the done screen (SessionInterface).
 * The caller owns the heading and any buttons; this only draws the ideas.
 * `renderActions`, when given, puts per-idea buttons inside each chip.
 * Native twin: native/src/components/ParkedIdeaList.tsx.
 */
import { Box, Flex, Text } from "@chakra-ui/react";
import type { ReactNode } from "react";

export type ParkedIdea = {
  text: string;
  parkedAt: number;
  reason?: string;
  /** Set once "Make it a Quest" planted a seed for this idea. */
  questSeedId?: string;
};

export function ParkedIdeaList({
  ideas,
  renderActions,
}: {
  ideas: readonly ParkedIdea[];
  renderActions?: (idea: ParkedIdea) => ReactNode;
}) {
  return (
    <Flex gap={1.5} wrap="wrap" direction={renderActions ? "column" : "row"}>
      {ideas.map((idea) => (
        <Box
          key={`${idea.parkedAt}-${idea.text}`}
          borderWidth="1px"
          borderColor="gray.200"
          borderRadius="md"
          bg="white"
          px={2}
          py={1}
          maxW="100%"
          textAlign="left"
        >
          <Text fontSize="sm" fontFamily="heading" color="charcoal.700">
            {idea.text}
          </Text>
          {idea.reason ? (
            <Text fontSize="xs" color="charcoal.400">
              {idea.reason}
            </Text>
          ) : null}
          {renderActions ? (
            <Flex gap={1.5} mt={1.5} wrap="wrap">
              {renderActions(idea)}
            </Flex>
          ) : null}
        </Box>
      ))}
    </Flex>
  );
}
