"use client";

/**
 * The scholar's PARKING LOT in the Workshop (sessions.parkingLot): ideas the
 * App designer parked for the Free play version instead of building them now
 * (lib/designerTools.ts park_idea). Hidden when empty. Once the activity is
 * done, the builder passes `renderActions` (the done screen's Build it now +
 * Make it a Quest per idea, TRA-519 B2 — useSavedForLaterActions) and each
 * idea carries its own buttons. Until then the chips are read-only;
 * `onStartFreePlay` remains for a caller with no per-idea actions (TRA-489).
 * This strip owns its heading; the chips are the shared ParkedIdeaList (one
 * rendering of the lot, TRA-519 B1).
 * Native twin: native/src/components/vibecode/ParkingLot.tsx.
 */
import { Box, Button, Flex, Text } from "@chakra-ui/react";
import type { ReactNode } from "react";
import { ParkedIdeaList, type ParkedIdea } from "../ParkedIdeaList";

export type { ParkedIdea };

export function ParkingLot({
  ideas,
  onStartFreePlay,
  startingFreePlay = false,
  renderActions,
}: {
  ideas: readonly ParkedIdea[] | undefined;
  /** Present only when sessions.startFreePlay would succeed. Ignored when
   *  `renderActions` is given (each idea then has its own Build it now). */
  onStartFreePlay?: () => void;
  startingFreePlay?: boolean;
  /** The done state's per-idea actions (useSavedForLaterActions). */
  renderActions?: (idea: ParkedIdea) => ReactNode;
}) {
  if (!ideas || ideas.length === 0) return null;
  return (
    <Box
      px={3}
      py={2}
      borderTop="1px solid"
      borderColor="gray.200"
      flexShrink={0}
      maxH={renderActions ? "240px" : "132px"}
      overflowY="auto"
      aria-label="Parking lot for Free play"
    >
      <Flex align="center" gap={2} mb={1.5}>
        <Text fontSize="xs" fontFamily="heading" fontWeight="600" color="charcoal.500">
          Parking lot · Free play
        </Text>
        <Box flex={1} />
        {onStartFreePlay && !renderActions ? (
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
      <ParkedIdeaList ideas={ideas} renderActions={renderActions} />
    </Box>
  );
}
