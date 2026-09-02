"use client";

/**
 * RoomCueBanner — the calm, dismissible strip a scholar sees when a teacher
 * calls a "message" or "transition" room cue (see convex/roomCues.ts). One
 * banner per live cue; the caller renders up to one per kind (message,
 * transition never replace each other). Quiet styling deliberately distinct
 * from the orange focus-lock banner (a restriction) and the violet angle
 * banner (personal context) — this is a passed-through, teacher-spoken note,
 * so it reads as an announcement, not a warning.
 *
 * Dismiss is LOCAL only (see hooks/useActiveRoomCues.ts) — it never writes to
 * the server. The words themselves are the teacher's, verbatim; this
 * component only supplies the fixed chrome around them.
 */

import { Flex, IconButton, Text } from "@chakra-ui/react";
import { X } from "@phosphor-icons/react";
import { roomCueBannerText, type RoomCueForDisplay } from "@/shared/roomCueCopy";

export function RoomCueBanner({
  cue,
  onDismiss,
}: {
  cue: RoomCueForDisplay;
  onDismiss: (cueId: string) => void;
}) {
  return (
    <Flex
      px={4}
      py={3}
      bg="navy.50"
      borderBottom="1px solid"
      borderColor="navy.200"
      align="center"
      gap={3}
    >
      <Text fontSize="sm" fontFamily="heading" color="navy.700" flex={1}>
        {roomCueBannerText(cue)}
      </Text>
      <IconButton
        aria-label="Dismiss"
        size="xs"
        variant="ghost"
        color="navy.500"
        _hover={{ bg: "navy.100" }}
        onClick={() => onDismiss(cue.cueId)}
      >
        <X size={14} />
      </IconButton>
    </Flex>
  );
}
