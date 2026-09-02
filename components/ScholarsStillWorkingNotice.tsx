"use client";

/**
 * ScholarsStillWorkingNotice — "the turn, not the bell" item 4's quiet "still
 * finishing their thought" line. Given an (assignmentId, activityId) pair
 * whose class-focus push has turned, queries lingeringScholarsForPush and
 * renders nothing if nobody's still working — names only, no durations, no
 * red. Shared by AssignmentPanel (the live Run page) and ClassActiveView.
 */
import { Clock } from "@phosphor-icons/react";
import { useQuery } from "convex/react";
import { Flex, Text } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

export type TurnedPush = {
  assignmentId: Id<"assignments">;
  activityId: Id<"activities">;
  activityTitle: string;
};

export function ScholarsStillWorkingNotice({ turned }: { turned: TurnedPush }) {
  const lingering = useQuery(api.assignments.lingeringScholarsForPush, {
    assignmentId: turned.assignmentId,
    activityId: turned.activityId,
  });
  if (!lingering || lingering.length === 0) return null;
  return (
    <Flex
      align="center"
      gap={2}
      px={2.5}
      py={2}
      bg="violet.50"
      borderWidth="1px"
      borderColor="violet.100"
      borderRadius="md"
    >
      <Clock size={12} color="var(--chakra-colors-violet-500)" />
      <Text fontSize="xs" color="violet.700" fontFamily="heading">
        Still finishing their thought on {turned.activityTitle}:{" "}
        {lingering.map((s) => s.name).join(", ")}
      </Text>
    </Flex>
  );
}

/**
 * Tracks class-focus pushes that just disappeared from a live list since the
 * last render — the room turned (auto-cleared or a teacher's "Wrap now").
 * Remembered briefly so the lingering-awareness line can attach to an
 * activity even after its own push vanishes from the live view. Bounded to
 * TURNED_MEMORY_MS so a long teacher session doesn't grow this unbounded —
 * well past the backend's own 15-minute lastMessageAt window.
 */
export const TURNED_MEMORY_MS = 20 * 60 * 1000;

export function nextTurnedMap<T extends TurnedPush>(
  prevTurned: Map<string, TurnedPush & { turnedAt: number }>,
  prevLive: Map<string, T>,
  currentLive: Map<string, T>,
  now: number,
): Map<string, TurnedPush & { turnedAt: number }> {
  const next = new Map(prevTurned);
  for (const [key, t] of next) {
    if (now - t.turnedAt > TURNED_MEMORY_MS) next.delete(key);
  }
  for (const key of currentLive.keys()) next.delete(key);
  for (const [key, row] of prevLive) {
    if (!currentLive.has(key) && !next.has(key)) {
      next.set(key, {
        assignmentId: row.assignmentId,
        activityId: row.activityId,
        activityTitle: row.activityTitle,
        turnedAt: now,
      });
    }
  }
  return next;
}
