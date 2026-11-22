"use client";

// The parent portal's Homework tab (TRA-581): one child's homework for a
// month, week by week, the way a teacher's hand-made calendar for families
// reads. Each school week is a subheading ("This week · Nov 9–13") over its
// items, drawn as the same row a scholar sees (glyph, title, "Subject · with
// Teacher") with a plain due phrase, plus one quiet line for the week's
// no-school days and one for the child's field trips (TRA-601). Open-until
// work sits right after this week under "Open from class", the child's own
// heading for it (TRA-724). The weeks come from shared/homeworkPlanWeeks.ts over
// parents.childHomeworkPlan.
//
// The PLAN, never status (TRA-574): finished work stays listed, and nothing
// on the page says done, late or started. No Start, no DueChip tone.

import { Fragment, useState } from "react";
import { Box, chakra, Heading, HStack, Spinner, Stack, Text } from "@chakra-ui/react";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import type { FunctionReturnType } from "convex/server";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ForecastRow } from "@/components/ui/ForecastRow";
import { Surface } from "@/components/ui/Surface";
import { useNow } from "@/hooks/useNow";
import { useSmoothedQuery } from "@/hooks/useSmoothedQuery";
import { homeworkListRowMeta } from "@/shared/homeworkList";
import { DEFAULT_TIMEZONE } from "@/shared/institutionDay";
import { OPEN_FROM_CLASS_HEADING } from "@/shared/openUntil";
import {
  buildHomeworkMonth,
  homeworkMonthFirstDay,
  homeworkMonthKeyFor,
  shiftMonthKey,
} from "@/shared/homeworkPlanWeeks";

type PlanItem = FunctionReturnType<
  typeof api.parents.childHomeworkPlan
>["items"][number];

export function ParentHomeworkTab({ scholarId }: { scholarId: Id<"users"> }) {
  const nowMs = useNow(60_000);
  const minuteNow = Math.floor(nowMs / 60_000) * 60_000;
  // Null: follow the clock to this week's month.
  const [pickedMonth, setPickedMonth] = useState<string | null>(null);
  // The school's zone arrives with the first read; until then the default
  // places the month (the read keeps its last result while args change).
  const [knownTimeZone, setKnownTimeZone] = useState<string | null>(null);
  const currentMonth = homeworkMonthKeyFor(nowMs, knownTimeZone ?? DEFAULT_TIMEZONE);
  const monthKey = pickedMonth ?? currentMonth;
  // Keep the last result only across the minute clock: a different child or
  // month is a different subject, so it loads to the spinner instead of
  // showing the old, narrower plan as a month of "No homework".
  const plan = useSmoothedQuery(
    api.parents.childHomeworkPlan,
    {
      scholarId,
      now: minuteNow,
      fromDayKey: homeworkMonthFirstDay(monthKey),
    },
    { resetKey: `${scholarId}:${monthKey}` },
  );
  const timeZone = plan?.timeZone || DEFAULT_TIMEZONE;
  if (plan && plan.timeZone !== knownTimeZone) setKnownTimeZone(plan.timeZone);

  const month =
    plan === undefined
      ? null
      : buildHomeworkMonth(plan.items, plan.closures, {
          monthKey,
          nowMs,
          timeZone,
          trips: plan.trips,
        });
  const go = (months: number) => {
    const next = shiftMonthKey(monthKey, months);
    setPickedMonth(next === currentMonth ? null : next);
  };

  return (
    <Box>
      <HStack justify="space-between" align="center" mb={6} gap={3} wrap="wrap">
        <Heading as="h1" size="lg" fontFamily="heading" color="navy.500">
          Homework
        </Heading>
        <HStack gap={1}>
          <MonthButton label="Previous month" onClick={() => go(-1)}>
            <CaretLeft size={16} weight="bold" />
          </MonthButton>
          <Text
            fontFamily="heading"
            fontWeight="600"
            fontSize="md"
            color="charcoal.700"
            minW="9.5rem"
            textAlign="center"
            aria-live="polite"
          >
            {month?.title ?? ""}
          </Text>
          <MonthButton label="Next month" onClick={() => go(1)}>
            <CaretRight size={16} weight="bold" />
          </MonthButton>
        </HStack>
      </HStack>
      {month === null ? (
        <HStack py={6} justify="center">
          <Spinner size="sm" color="violet.400" />
        </HStack>
      ) : (
        <Surface p={0} overflow="hidden">
          {month.weeks.map((week, index) => (
            <Fragment key={week.mondayKey}>
              <WeekBlock
                first={index === 0}
                heading={week.heading}
                closedNote={week.closedNote}
                tripNote={week.tripNote}
                emptyText={week.emptyText}
                rows={week.entries.map((entry) => ({ item: entry.item, when: entry.when }))}
              />
              {/* Open from class: open now, so right under this week. */}
              {week.mondayKey === month.openFromClassAfter &&
                month.openFromClass.length > 0 && (
                  <WeekBlock
                    first={false}
                    heading={OPEN_FROM_CLASS_HEADING}
                    closedNote={null}
                    tripNote={null}
                    emptyText=""
                    rows={month.openFromClass}
                  />
                )}
            </Fragment>
          ))}
          {month.undated.length > 0 && (
            <WeekBlock
              first={false}
              heading="No date"
              closedNote={null}
              tripNote={null}
              emptyText=""
              rows={month.undated.map((item) => ({ item, when: null }))}
            />
          )}
        </Surface>
      )}
    </Box>
  );
}

function MonthButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <chakra.button
      type="button"
      aria-label={label}
      onClick={onClick}
      display="inline-flex"
      alignItems="center"
      justifyContent="center"
      w={9}
      h={9}
      borderRadius="full"
      color="charcoal.500"
      cursor="pointer"
      _hover={{ bg: "gray.100" }}
      _focusVisible={{ outline: "2px solid", outlineColor: "violet.400" }}
    >
      {children}
    </chakra.button>
  );
}

/** One week: its subheading, the quiet no-school and field-trip lines, then its rows (or
 *  "Not posted yet." / "No homework."). */
function WeekBlock({
  first,
  heading,
  closedNote,
  tripNote,
  emptyText,
  rows,
}: {
  first: boolean;
  heading: string;
  closedNote: string | null;
  tripNote: string | null;
  emptyText: string;
  rows: Array<{ item: PlanItem; when: string | null }>;
}) {
  return (
    <Box as="section" borderTopWidth={first ? 0 : "1px"} borderColor="gray.100" pb={2}>
      <Heading
        as="h2"
        px={4}
        pt={3}
        pb={1}
        fontFamily="heading"
        fontWeight="700"
        fontSize="xs"
        color="charcoal.500"
      >
        {heading}
      </Heading>
      {closedNote && (
        <Text px={4} pb={1} fontSize="xs" fontFamily="heading" color="charcoal.400">
          {closedNote}
        </Text>
      )}
      {tripNote && (
        <Text px={4} pb={1} fontSize="xs" fontFamily="heading" color="charcoal.400">
          {tripNote}
        </Text>
      )}
      {rows.length === 0 ? (
        <Text px={4} py={2} fontSize="sm" fontFamily="heading" color="charcoal.400">
          {emptyText}
        </Text>
      ) : (
        <Stack gap={0}>
          {rows.map(({ item, when }) => (
            <Box key={item.key} px={4} py={2.5}>
              <ForecastRow
                glyph={item.emoji}
                title={item.title}
                meta={homeworkListRowMeta({
                  subject: item.subject,
                  teacherName: item.teacherName,
                  isOffline: item.awayFromBunnyPad,
                })}
                status={
                  when ? (
                    <Text fontSize="xs" fontFamily="heading" color="charcoal.500">
                      {when}
                    </Text>
                  ) : null
                }
              />
            </Box>
          ))}
        </Stack>
      )}
    </Box>
  );
}

/**
 * This week's homework, for the Home tab: the same week block the Homework
 * tab draws (one rendering per item, T1), for this week only, plus the work
 * open from class. Null while loading.
 */
export function ParentHomeworkThisWeek({ scholarId }: { scholarId: Id<"users"> }) {
  const nowMs = useNow(60_000);
  const minuteNow = Math.floor(nowMs / 60_000) * 60_000;
  const [knownTimeZone, setKnownTimeZone] = useState<string | null>(null);
  const monthKey = homeworkMonthKeyFor(nowMs, knownTimeZone ?? DEFAULT_TIMEZONE);
  const plan = useSmoothedQuery(
    api.parents.childHomeworkPlan,
    { scholarId, now: minuteNow, fromDayKey: homeworkMonthFirstDay(monthKey) },
    { resetKey: `${scholarId}:${monthKey}` },
  );
  const timeZone = plan?.timeZone || DEFAULT_TIMEZONE;
  if (plan && plan.timeZone !== knownTimeZone) setKnownTimeZone(plan.timeZone);
  if (plan === undefined) {
    return (
      <HStack py={6} justify="center">
        <Spinner size="sm" color="violet.400" />
      </HStack>
    );
  }
  const month = buildHomeworkMonth(plan.items, plan.closures, {
    monthKey,
    nowMs,
    timeZone,
    trips: plan.trips,
  });
  const week = month.weeks.find((w) => w.isThisWeek);
  return (
    <>
      {week && (
        <WeekBlock
          first
          heading={week.heading}
          closedNote={week.closedNote}
          tripNote={week.tripNote}
          emptyText={week.emptyText}
          rows={week.entries.map((entry) => ({ item: entry.item, when: entry.when }))}
        />
      )}
      {month.openFromClass.length > 0 && (
        <WeekBlock
          first={!week}
          heading={OPEN_FROM_CLASS_HEADING}
          closedNote={null}
          tripNote={null}
          emptyText=""
          rows={month.openFromClass}
        />
      )}
      {!week && month.openFromClass.length === 0 && (
        <Text px={4} py={3} fontSize="sm" fontFamily="heading" color="charcoal.400">
          No homework this week.
        </Text>
      )}
    </>
  );
}
