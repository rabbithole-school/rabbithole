"use client";

/**
 * PlannedTodayCard — a ghost (dashed border, no CTA) card representing a
 * PLANNED today entry (setAt=null, startsAt today).
 *
 * Invariant 1: planned entries are NEVER startable. This card deliberately
 * renders NO launch CTA — only a "starts h:mm" chip.
 * See review/scholar-home-tabs-impl-spec.md §Global invariants.
 *
 * The card owns the ghost treatment; the row inside it is the shared
 * `ForecastRow`, identical to every row in Coming up. Those were two hand-
 * rolled copies of one object until
 * review/scholar-activity-row-rationalization.html §P3.
 */

import { Box } from "@chakra-ui/react";
import { formatStartTime } from "@/shared/comingUp";
import { ForecastRow } from "@/components/ui/ForecastRow";
import { StatusChip } from "@/components/ui/DueChip";

export type PlannedEntry = {
  activityTitle: string;
  unitTitle: string | null;
  unitEmoji: string | null;
  subject: string | null;
  startsAt: number;
};

export function PlannedTodayCard({
  entry,
  timeZone,
}: {
  entry: PlannedEntry;
  timeZone: string;
}) {
  const timeLabel = formatStartTime(entry.startsAt, timeZone);

  return (
    <Box
      borderWidth="1px"
      borderStyle="dashed"
      borderColor="gray.300"
      borderRadius="xl"
      p={4}
      bg="gray.50"
    >
      <ForecastRow
        glyph={entry.unitEmoji}
        title={entry.activityTitle}
        meta={entry.unitTitle ?? entry.subject}
        status={timeLabel ? <StatusChip>starts {timeLabel}</StatusChip> : null}
      />
    </Box>
  );
}
