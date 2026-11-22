"use client";

/**
 * The Schedule tab's Homework view (TRA-581): for each group, one row per
 * school week with that week's homework by subject, the way a teacher's
 * hand-made calendar for families reads. A view over gives
 * (convex/homeworkPlanner.ts `weeks`), never a separate store: homework
 * given anywhere (the give form, the Run page, the aide, Slack) lands in the
 * week it is due.
 *
 * Week headings and due phrases come from the same helpers the family
 * Homework tab uses (shared/homeworkWeek.ts, shared/homeworkPlanWeeks.ts),
 * so "Due this week" means the same day here as on a parent's phone.
 */
import { useState } from "react";
import {
  Box,
  Flex,
  HStack,
  IconButton,
  Spinner,
  Stack,
  Text,
} from "@chakra-ui/react";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import { useSmoothedQuery } from "@/hooks/useSmoothedQuery";
import { useNow } from "@/hooks/useNow";
import { Surface } from "@/components/ui/Surface";
import { EmptyState } from "@/components/ui/EmptyState";
import { dayKeyForTimezone, shiftDayKey } from "@/shared/institutionDay";
import {
  homeworkWeekWindow,
  schoolWeekMondayForDayKey,
  schoolWeekRange,
  weekClosedNote,
} from "@/shared/homeworkWeek";
import { homeworkPlanWhen } from "@/shared/homeworkPlanWeeks";

const WEEKS = 6;
const MINUTE = 60_000;

/** "Nov 9" for a day key. */
function monthDay(dayKey: string): string {
  return new Date(`${dayKey}T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  });
}

export function HomeworkPlanner() {
  const now = useNow(MINUTE);
  // Null = this school week first; the arrows page six weeks at a time.
  const [fromMondayKey, setFromMondayKey] = useState<string | null>(null);
  // The school's zone comes back with the plan; until the first result, the
  // browser's. "Today" as a school-local day key changes once a day, so the
  // query re-runs at midnight instead of every minute (T11). The smoothed
  // query keeps the last result while re-arming, so its zone stays known.
  const [zone, setZone] = useState<string | null>(null);
  const todayKey = dayKeyForTimezone(
    now,
    zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const data = useSmoothedQuery(api.homeworkPlanner.weeks, {
    todayKey,
    weeks: WEEKS,
    ...(fromMondayKey ? { fromMondayKey } : {}),
  });
  // Adopt the school's zone during render (no effect): one re-arm at most.
  if (data && data.timeZone !== zone) setZone(data.timeZone);

  if (data === undefined) {
    return (
      <Flex h="full" align="center" justify="center">
        <Spinner color="violet.500" />
      </Flex>
    );
  }

  const thisMonday = schoolWeekMondayForDayKey(todayKey);
  const first = data.mondayKeys[0];
  const last = data.mondayKeys[data.mondayKeys.length - 1];
  const page = (weeks: number) =>
    setFromMondayKey(shiftDayKey(first, 7 * weeks));

  return (
    <Box h="full" overflowY="auto" bg="gray.50" px={{ base: 3, md: 6 }} py={4}>
      <Stack gap={4} maxW="4xl" mx="auto">
        <HStack justify="space-between">
          <Text
            fontFamily="heading"
            fontSize="sm"
            fontWeight="600"
            color="charcoal.600"
          >
            Weeks of {monthDay(first)} – {monthDay(last)}
          </Text>
          <HStack gap={1}>
            <IconButton
              aria-label="Earlier weeks"
              size="sm"
              variant="ghost"
              onClick={() => page(-WEEKS)}
            >
              <CaretLeft />
            </IconButton>
            {first !== thisMonday && (
              <Text
                as="button"
                fontFamily="heading"
                fontSize="sm"
                color="violet.600"
                cursor="pointer"
                onClick={() => setFromMondayKey(null)}
              >
                This week
              </Text>
            )}
            <IconButton
              aria-label="Later weeks"
              size="sm"
              variant="ghost"
              onClick={() => page(WEEKS)}
            >
              <CaretRight />
            </IconButton>
          </HStack>
        </HStack>

        {data.groups.length === 0 ? (
          <Surface>
            <EmptyState
              title="No groups with classes yet"
              hint="Groups appear here once they have classes on the schedule."
            />
          </Surface>
        ) : (
          data.groups.map((group) => (
            <Surface key={group.groupId} p={0} overflow="hidden">
              <Text
                as="h2"
                fontFamily="heading"
                fontSize="md"
                fontWeight="600"
                color="charcoal.700"
                px={4}
                pt={3}
                pb={2}
              >
                {group.name}
              </Text>
              {group.weeks.map((week) => {
                const range = schoolWeekRange(week.mondayKey, todayKey);
                const heading =
                  week.mondayKey === thisMonday
                    ? `This week · ${range}`
                    : week.mondayKey === shiftDayKey(thisMonday, 7)
                      ? `Next week · ${range}`
                      : range;
                // A week with no school day says just that, once.
                const allClosed =
                  homeworkWeekWindow(week.mondayKey, data.closures) === null;
                const closedNote = allClosed
                  ? null
                  : weekClosedNote(week.mondayKey, data.closures);
                return (
                  <Flex
                    key={week.mondayKey}
                    gap={4}
                    px={4}
                    py={2.5}
                    borderTopWidth="1px"
                    borderColor="gray.100"
                    direction={{ base: "column", md: "row" }}
                  >
                    <Box w={{ md: "180px" }} flexShrink={0}>
                      <Text
                        fontFamily="heading"
                        fontSize="sm"
                        fontWeight={
                          week.mondayKey === thisMonday ? "600" : "500"
                        }
                        color="charcoal.600"
                      >
                        {heading}
                      </Text>
                      {closedNote && (
                        <Text fontSize="xs" color="charcoal.400">
                          {closedNote}
                        </Text>
                      )}
                    </Box>
                    <Stack gap={1} flex={1} minW={0}>
                      {week.items.length === 0 ? (
                        <Text fontSize="sm" color="charcoal.300">
                          {allClosed ? "No school" : "No homework yet"}
                        </Text>
                      ) : (
                        week.items.map((item) => (
                          <HStack key={item.key} gap={2} align="baseline">
                            <Text
                              fontFamily="heading"
                              fontSize="sm"
                              fontWeight="600"
                              color="charcoal.700"
                              w="140px"
                              flexShrink={0}
                              truncate
                              title={item.subject ?? undefined}
                            >
                              {item.subject ?? "No subject"}
                            </Text>
                            <Box minW={0}>
                              <Text
                                as="span"
                                fontSize="sm"
                                color="charcoal.700"
                                mr={2}
                              >
                                {item.title}
                              </Text>
                              <Text
                                as="span"
                                fontSize="xs"
                                color="charcoal.400"
                              >
                                {[
                                  homeworkPlanWhen(
                                    { key: item.key, dueAt: null },
                                    item.dueDayKey,
                                    todayKey,
                                    thisMonday,
                                    data.closures,
                                  ),
                                  item.teacherName
                                    ? `with ${item.teacherName}`
                                    : null,
                                  item.partOfGroup != null
                                    ? `${item.partOfGroup} ${item.partOfGroup === 1 ? "scholar" : "scholars"}`
                                    : null,
                                  item.live ? null : "planned",
                                ]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </Text>
                            </Box>
                          </HStack>
                        ))
                      )}
                    </Stack>
                  </Flex>
                );
              })}
            </Surface>
          ))
        )}
      </Stack>
    </Box>
  );
}
