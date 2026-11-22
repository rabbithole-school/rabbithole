"use client";

/**
 * The scholar's PARKING LOT in the Workshop (sessions.parkingLot): ideas the
 * App designer saved for after the gate instead of building them now
 * (lib/designerTools.ts park_idea). Hidden when empty. Once the activity is
 * done, the builder passes `renderActions` (the done screen's Build it now +
 * Make it a Quest per idea, TRA-519 B2 — useSavedForLaterActions) and each
 * idea carries its own buttons. Until then the chips are read-only.
 * This strip owns its heading; the chips are the shared ParkedIdeaList (one
 * rendering of the lot, TRA-519 B1).
 * Native shows the lot in the builder chat drawer's Saved tab instead
 * (native/src/components/vibecode/VibecodeScreen.tsx).
 */
import { Box, Text } from "@chakra-ui/react";
import type { ReactNode } from "react";
import { MISSION_COPY } from "@/shared/missionCopy";
import { ParkedIdeaList, type ParkedIdea } from "../ParkedIdeaList";

export type { ParkedIdea };

export function ParkingLot({
  ideas,
  renderActions,
}: {
  ideas: readonly ParkedIdea[] | undefined;
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
      aria-label={MISSION_COPY.savedForLater}
    >
      <Text
        fontSize="xs"
        fontFamily="heading"
        fontWeight="600"
        color="charcoal.500"
        mb={1.5}
      >
        {MISSION_COPY.savedForLater}
      </Text>
      <ParkedIdeaList ideas={ideas} renderActions={renderActions} />
    </Box>
  );
}
