"use client";

/**
 * ComingUpCard (web) — the scholar lookahead of planned CLASS work that hasn't
 * started yet, rendered below Homework on the evening Home and on the Scholar's
 * Prep tab. Homework is never here: it is all in the Homework section.
 *
 * It is drawn as a sibling of Homework (components/HomeworkSection.tsx): the
 * same eyebrow, the same card, and day headings from the same helper
 * ("Starts tomorrow").
 *
 * It is a FORECAST, not a todo (T4): schedule-committed planned previews,
 * grouped by day over the next 5 open school days. Deliberately carries NO
 * checkbox, NO launch CTA, and NO "N left" count.
 *
 * Non-actionability is not a client convention: the query returns only
 * committed placements and the live/planned `setAt` boundary still governs
 * whether a scholar can start anything, so nothing here is launchable.
 */

import { useEffect, useState } from "react";
import { Box, Stack, Text } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import { Surface } from "@/components/ui/Surface";
import { StatusChip } from "@/components/ui/DueChip";
import { ForecastRow } from "@/components/ui/ForecastRow";
import { ScholarHomeSectionHeader } from "@/components/ui/ScholarHomeSectionHeader";
import { useSmoothedQuery } from "@/hooks/useSmoothedQuery";
import {
  formatStartTime,
  type ComingUpDayGroup,
  type ComingUpEntry,
} from "@/shared/comingUp";
import { formatRelativeDayHeading } from "@/shared/institutionDay";

const MINUTE_MS = 60_000;
const floorToMinute = (ms: number) => Math.floor(ms / MINUTE_MS) * MINUTE_MS;

function ComingUpRow({
  entry,
  timeZone,
}: {
  entry: ComingUpEntry;
  timeZone: string;
}) {
  return (
    <Box px={4} py={3}>
      <ForecastRow
        glyph={entry.unitEmoji}
        title={entry.activityTitle}
        meta={[
          entry.unitTitle,
          entry.teacherName ? `with ${entry.teacherName}` : null,
        ]
          .filter(Boolean)
          .join(" \u00b7 ")}
        status={
          <StatusChip>{formatStartTime(entry.startsAt, timeZone)}</StatusChip>
        }
      />
    </Box>
  );
}

function ComingUpDay({
  group,
  timeZone,
  todayKey,
  divided,
}: {
  group: ComingUpDayGroup;
  timeZone: string;
  todayKey: string;
  divided: boolean;
}) {
  // Day headings from shared/institutionDay.ts (formatRelativeDayHeading).
  return (
    <Box borderTopWidth={divided ? "1px" : 0} borderColor="gray.100">
      <Text
        px={4}
        pt={3}
        pb={1}
        fontFamily="heading"
        fontWeight="700"
        fontSize="xs"
        color="charcoal.500"
      >
        {formatRelativeDayHeading(group.dayKey, todayKey, "starts")}
      </Text>
      {group.entries.map((entry) => (
        <ComingUpRow
          key={`${entry.kind}:${entry.assignmentId}:${entry.activityId}`}
          entry={entry}
          timeZone={timeZone}
        />
      ))}
    </Box>
  );
}

export function ComingUpCard({
  hideWhenEmpty = false,
}: {
  /** "One nothing per screen": when the page is ALREADY rendering a top-level
   *  empty state for a clear day, this card must not stack a second
   *  nothing-message under it. The page owns the message; we just vanish. */
  hideWhenEmpty?: boolean;
} = {}) {
  // A minute-rounded clock re-arms the reactive query across institution-local
  // midnight (and as the horizon rolls) without the client inventing a day key.
  const [now, setNow] = useState(() => floorToMinute(Date.now()));
  useEffect(() => {
    const id = setInterval(() => setNow(floorToMinute(Date.now())), MINUTE_MS);
    return () => clearInterval(id);
  }, []);
  // Smoothed so each minute's re-subscription keeps the card on screen instead
  // of dropping to `undefined` and vanishing for a round-trip.
  const result = useSmoothedQuery(api.assignments.comingUpForSelf, {
    now,
    includeWebActivities: true,
  });

  if (result === undefined) return null;
  const { groups, timeZone, dayKey } = result;
  const isEmpty = groups.length === 0;
  if (isEmpty && hideWhenEmpty) return null;

  return (
    <Stack gap={3}>
      <Stack gap={1}>
        <ScholarHomeSectionHeader>Coming up</ScholarHomeSectionHeader>
        {/* The one explanation, under the heading. An empty card says
            "Nothing coming up yet" instead, so the two never stack. */}
        {!isEmpty && (
          <Text fontFamily="heading" fontSize="sm" color="charcoal.400">
            Opens when class starts
          </Text>
        )}
      </Stack>
      <Surface p={0} overflow="hidden">
        {isEmpty ? (
          <Text px={4} py={4} fontSize="sm" color="charcoal.500" lineHeight="1.5">
            Nothing coming up yet.
          </Text>
        ) : (
          groups.map((group, groupIndex) => (
            <ComingUpDay
              key={group.dayKey}
              group={group}
              timeZone={timeZone}
              todayKey={dayKey}
              divided={groupIndex > 0}
            />
          ))
        )}
      </Surface>
    </Stack>
  );
}
