"use client";

/**
 * ComingUpCard (web) — the scholar lookahead, rendered below the "To do
 * tonight" card on the Scholar's Prep tab and the evening Home. Move 3 of the
 * homework-flow plan (review/homework-flow-plan.html §Move 3).
 *
 * It is a FORECAST, not a todo (T4): dated rows for homework due after tonight
 * and schedule-committed planned previews, grouped by day over the next 5 open
 * school days. Deliberately carries NO checkbox, NO launch CTA, and NO "N left"
 * count — the tonight card owns the actionable list; this only dates what the
 * scholar can already reach. An empty horizon renders a quiet line, never null.
 *
 * Non-actionability is not a client convention: the query returns only
 * committed placements and the live/planned `setAt` boundary still governs
 * whether a scholar can start anything, so nothing here is launchable.
 */

import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { TrendUp } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import { Surface } from "@/components/ui/Surface";
import { DueChip, StatusChip } from "@/components/ui/DueChip";
import { ForecastRow } from "@/components/ui/ForecastRow";
import {
  formatComingUpDayHeading,
  formatStartTime,
  type ComingUpDayGroup,
  type ComingUpEntry,
} from "@/shared/comingUp";

const MINUTE_MS = 60_000;
const floorToMinute = (ms: number) => Math.floor(ms / MINUTE_MS) * MINUTE_MS;

function ComingUpRow({
  entry,
  timeZone,
  nowMs,
}: {
  entry: ComingUpEntry;
  timeZone: string;
  nowMs: number;
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
          entry.kind === "homework" ? (
            <DueChip dueAt={entry.dueAt} nowMs={nowMs} timeZone={timeZone} />
          ) : (
            <StatusChip>starts {formatStartTime(entry.startsAt, timeZone)}</StatusChip>
          )
        }
      />
    </Box>
  );
}

function ComingUpDay({
  group,
  timeZone,
  nowMs,
}: {
  group: ComingUpDayGroup;
  timeZone: string;
  nowMs: number;
}) {
  return (
    <Stack gap={0}>
      <Text
        px={4}
        pt={3}
        pb={1}
        fontFamily="heading"
        fontWeight="600"
        fontSize="xs"
        color="charcoal.500"
      >
        {formatComingUpDayHeading(group.dayKey)}
      </Text>
      {group.entries.map((entry) => (
        <ComingUpRow
          key={`${entry.kind}:${entry.assignmentId}:${entry.activityId}`}
          entry={entry}
          timeZone={timeZone}
          nowMs={nowMs}
        />
      ))}
    </Stack>
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
  const result = useQuery(api.assignments.comingUpForSelf, {
    now,
    includeWebActivities: true,
  });

  if (result === undefined) return null;
  const { groups, timeZone } = result;
  const isEmpty = groups.length === 0;
  if (isEmpty && hideWhenEmpty) return null;

  return (
    <Surface p={0} overflow="hidden">
      <Flex
        align="center"
        gap={3}
        px={4}
        py={3}
        borderBottomWidth="1px"
        borderColor="gray.100"
      >
        <Box color="violet.600" display="flex">
          <TrendUp aria-hidden="true" size={18} weight="bold" />
        </Box>
        <Text
          fontFamily="heading"
          fontWeight="700"
          fontSize="md"
          color="charcoal.600"
        >
          Coming up
        </Text>
        <Box flex={1} />
        <Text fontFamily="heading" fontSize="sm" color="charcoal.400">
          the next 5 open school days
        </Text>
      </Flex>

      {isEmpty ? (
        <Text px={4} py={4} fontSize="sm" color="charcoal.500" lineHeight="1.5">
          Nothing coming up yet.
        </Text>
      ) : (
        <>
          {groups.map((group) => (
            <ComingUpDay key={group.dayKey} group={group} timeZone={timeZone} nowMs={now} />
          ))}
          <Text
            px={4}
            py={3}
            fontSize="2xs"
            color="charcoal.400"
            fontFamily="heading"
            lineHeight="1.5"
            borderTopWidth="1px"
            borderColor="gray.100"
          >
            Just a heads-up — these aren&rsquo;t due tonight. Nothing to open here.
          </Text>
        </>
      )}
    </Surface>
  );
}
