"use client";

/**
 * The scholar's PARKING LOT in the Workshop (sessions.parkingLot): ideas the
 * App designer parked for the Free play version instead of building them now
 * (lib/designerTools.ts park_idea). Hidden when empty. Once the assignment
 * version is done (`freePlayEligible`, lib/freePlay.ts), a "Start free play"
 * button beside the chips opens the scholar's own version (TRA-489).
 * Native twin: native/src/components/vibecode/ParkingLot.tsx.
 */
import { Box, Button, Flex, Text } from "@chakra-ui/react";

export type ParkedIdea = { text: string; parkedAt: number; reason?: string };

export function ParkingLot({
  ideas,
  onStartFreePlay,
  startingFreePlay = false,
}: {
  ideas: readonly ParkedIdea[] | undefined;
  /** Present only when sessions.startFreePlay would succeed. */
  onStartFreePlay?: () => void;
  startingFreePlay?: boolean;
}) {
  if (!ideas || ideas.length === 0) return null;
  return (
    <Box
      px={3}
      py={2}
      borderTop="1px solid"
      borderColor="gray.200"
      flexShrink={0}
      maxH="132px"
      overflowY="auto"
      aria-label="Parking lot for Free play"
    >
      <Flex align="center" gap={2} mb={1.5}>
        <Text fontSize="xs" fontFamily="heading" fontWeight="600" color="charcoal.500">
          Parking lot · Free play
        </Text>
        <Box flex={1} />
        {onStartFreePlay ? (
          <Button
            size="xs"
            colorPalette="violet"
            onClick={onStartFreePlay}
            loading={startingFreePlay}
          >
            Start free play
          </Button>
        ) : null}
      </Flex>
      <Flex gap={1.5} wrap="wrap">
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
          >
            <Text fontSize="sm" fontFamily="heading" color="charcoal.700">
              {idea.text}
            </Text>
            {idea.reason ? (
              <Text fontSize="xs" color="charcoal.400">
                {idea.reason}
              </Text>
            ) : null}
          </Box>
        ))}
      </Flex>
    </Box>
  );
}
