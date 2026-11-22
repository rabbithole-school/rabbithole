"use client";

// School › Screen time — how long each scholar was on their BunnyPad and where
// the time went, as a day, a week or a month.
//
// DAY is a minute-by-minute strip per scholar (DayStrip.tsx), read from
// `api.deviceActivity.dayTimeline`: one day per call, because it also reads
// every tutor turn and practice attempt to say what each stretch was.
//
// WEEK and MONTH are one row per scholar, read from the per-scholar-day
// summary (`api.screenTimeDays.periodUsage`, convex/screenTimeDays.ts): about
// a thousand small rows for a month, refreshed a couple of minutes after each
// scholar's activity, instead of every device event on every heartbeat. When
// a past day of the period is not summarized yet, the period falls back to
// the live read. A live MONTH never asks one query for a whole school-month: a
// whole-school `dailyUsage` read is capped at MAX_SCHOOL_ROLLUP_DAYS and a
// 14-day one has already hit the read limit on prod, so it is read as up to
// five 7-day queries and summed here.
//
// Either way the rows are `dailyUsage`'s shape (TRA-585), and the week and
// month tables sum them with `sumScholarWeeks` (shared/screenTimeWeek.ts), the same sum the scholar header
// uses, so the two always say the same number.
//
// THE FIRST DAY IS CLAMPED. Until 2026-09-19 the iPad heartbeated whenever
// Rabbithole was frontmost, so the nightly fleet release booked unattended
// minutes as use. The fix (PRESENCE_IDLE_TIMEOUT_MS in
// native/src/lib/deviceActivityQueue.ts) first shipped in canary build 61 on
// 2026-09-20, and every scholar iPad was on a build containing it when the
// fleet was checked on 2026-11-08. Days before SCREEN_TIME_FIRST_DAY_KEY are
// never offered. The raw rows are kept; this page simply does not report them.
//
// MEASURED AND ESTIMATED STAY APART. An external app the iPad never came back
// from contributes a capped estimate (shared/deviceActivityRollup.ts), shown as
// "+10m est." beside the measured figure and never added into it.
//
// SORTED BY NAME, NOT BY MINUTES. A column of minutes sorted high to low reads
// as a leaderboard, and these are diagnostics to read, not scores
// (.claude/rules/rabbithole-product-taste.md T9). The table, the day strip
// and the in-school averages chart are all sorted by name.
//
// SCOPE. The shared ScholarScopePicker (All scholars, My scholars, a group)
// narrows every view: the day strip, the table and both charts. The averages
// chart's dashed line and the activity bars are the scope's average scholar.
// `?scholar=` highlights one scholar inside the scope (and the bars become
// their own days); it never narrows it, so the picker's focus tier stays off.
//
// ACTIVITY BARS. One bar per day, stacked by the day strip's kinds in its
// colours, from the summary rows' per-kind minutes (the strip's own
// classifier). `?side=` picks At school, Outside school or Both, split at the
// bell like the table's "Outside school" column. EXTENDED ED IS OUTSIDE
// SCHOOL: the bell clock puts after-school time outside, and the stored
// `extended_ed` tag (shared/deviceActivityContext.ts) marks only program
// guests, never an enrolled scholar staying after school, so it cannot
// separate Extended Ed reliably. The page says so under the toggle and in each
// bar's hover.
// Test accounts are left out, as the Friday roundup leaves them out.
//
// The charts are drawn by pure SVG builders in shared/screenTimeCharts.ts,
// which the Friday Slack roundup also rasterizes to PNG; ./charts.tsx only
// measures, renders and adds the hover.
//
// GATE — scholar-admin (teacher / school_admin / platform_admin / operations
// staff), matching the `scholarAdminQuery` on the backing query. Everything
// here is timing; no transcript content reaches this page. PARENTS NEVER SEE
// THIS SURFACE.

import { Fragment, useMemo, useState } from "react";
import { ActivityBarsChart, AveragesChart, DayStrip, type ActivityDay } from "./charts";
import {
  averageKindsByDay,
  summarizePeriod,
  type BellSide,
  type DayKindRow,
} from "@/shared/screenTimePeriod";
import { ViewToggle } from "@/components/ui/ViewToggle";
import { useRouter, useSearchParams } from "next/navigation";
import { Box, Button, HStack, Stack, Table, Text } from "@chakra-ui/react";
import { CaretDown, CaretRight } from "@phosphor-icons/react";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { AuthorizationPending } from "@/components/AuthorizationPending";
import { DateNavPicker } from "@/components/ui/DateNavPicker";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { Surface } from "@/components/ui/Surface";
import { useAuthorizationGuard } from "@/hooks/useAuthorizationGuard";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useUrlScholarScope } from "@/hooks/useUrlScholarScope";
import { ScholarScopePicker } from "@/components/ScholarScopePicker";
import { isTestAccount } from "@/convex/lib/testAccounts";
import { useSchoolOperationsAccess } from "@/hooks/useSchoolOperationsAccess";
import { isScholarAdminRole } from "@/convex/lib/roles";
import { dayKeyForTimezone, shiftDayKey } from "@/shared/institutionDay";
import {
  BUILDER_FIRST_DAY_KEY,
  SCREEN_TIME_FIRST_DAY_KEY,
  formatScreenMinutes,
  sumScholarWeeks,
  type ScholarWeek,
} from "@/shared/screenTimeWeek";

type DayRow = FunctionReturnType<typeof api.deviceActivity.dailyUsage>[number];

/**
 * "Today" in school-local terms, pinned at module load (the idiom the admin
 * usage report uses). Not read during render: a component must be pure, and a
 * window that slid under the reader would be worse than one that needs a
 * reload after midnight.
 */
const TODAY_DAY_KEY = dayKeyForTimezone(Date.now());

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

type View = "day" | "week" | "month";
const VIEWS: { value: View; label: string }[] = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
];

const SIDES: { value: BellSide; label: string }[] = [
  { value: "inSchool", label: "At school" },
  { value: "outside", label: "Outside school" },
  { value: "both", label: "Both" },
];

function parseSide(raw: string | null): BellSide {
  return raw === "inSchool" || raw === "outside" ? raw : "both";
}

function parseView(raw: string | null): View {
  return raw === "day" || raw === "month" ? raw : "week";
}

function clampDayKey(raw: string | null): string {
  if (!raw || !DAY_KEY_PATTERN.test(raw)) return TODAY_DAY_KEY;
  if (raw > TODAY_DAY_KEY) return TODAY_DAY_KEY;
  return raw < SCREEN_TIME_FIRST_DAY_KEY ? SCREEN_TIME_FIRST_DAY_KEY : raw;
}

const MONTH_PATTERN = /^\d{4}-\d{2}$/;
const THIS_MONTH = TODAY_DAY_KEY.slice(0, 7);
const FIRST_MONTH = SCREEN_TIME_FIRST_DAY_KEY.slice(0, 7);

function clampMonth(raw: string | null): string {
  if (!raw || !MONTH_PATTERN.test(raw) || raw > THIS_MONTH) return THIS_MONTH;
  return raw < FIRST_MONTH ? FIRST_MONTH : raw;
}

function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  const date = new Date(y, m - 1 + by, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** The reportable days of a month, as at most five ranges of at most 7 days. */
const MONTH_CHUNKS = 5;
function monthChunks(month: string): ({ startDayKey: string; endDayKey: string } | null)[] {
  const first = `${month}-01`;
  const last = shiftDayKey(`${shiftMonth(month, 1)}-01`, -1);
  const from = first < SCREEN_TIME_FIRST_DAY_KEY ? SCREEN_TIME_FIRST_DAY_KEY : first;
  const to = last > TODAY_DAY_KEY ? TODAY_DAY_KEY : last;
  return Array.from({ length: MONTH_CHUNKS }, (_, index) => {
    const startDayKey = shiftDayKey(first, index * 7);
    const endDayKey = shiftDayKey(startDayKey, 6);
    const start = startDayKey < from ? from : startDayKey;
    const end = endDayKey > to ? to : endDayKey;
    return start <= end ? { startDayKey: start, endDayKey: end } : null;
  });
}

function daysOfPeriod(
  ranges: readonly { startDayKey: string; endDayKey: string }[],
): string[] {
  const days: string[] = [];
  for (const range of ranges) {
    for (let day = range.startDayKey; day <= range.endDayKey; day = shiftDayKey(day, 1)) {
      days.push(day);
    }
  }
  return days;
}

function monthLabel(month: string): string {
  return dayKeyToDate(`${month}-01`).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

function clampEndDayKey(raw: string | null): string {
  if (!raw || !DAY_KEY_PATTERN.test(raw)) return TODAY_DAY_KEY;
  if (raw > TODAY_DAY_KEY) return TODAY_DAY_KEY;
  const earliestEnd = shiftDayKey(SCREEN_TIME_FIRST_DAY_KEY, 6);
  return raw < earliestEnd ? earliestEnd : raw;
}

function dayKeyToDate(dayKey: string): Date {
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function dateToDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function shortDay(dayKey: string, withWeekday = false): string {
  return dayKeyToDate(dayKey).toLocaleDateString("en-US", {
    ...(withWeekday ? { weekday: "short" } : {}),
    month: "short",
    day: "numeric",
  });
}

function Minutes({ measured, estimated }: { measured: number; estimated?: number }) {
  return (
    <>
      {formatScreenMinutes(measured)}
      {estimated !== undefined && estimated >= 1 ? (
        <Text as="span" color="charcoal.400">
          {" "}+{formatScreenMinutes(estimated)} est.
        </Text>
      ) : null}
    </>
  );
}

function BuilderCell({
  onScreen,
  active,
  recorded,
}: {
  onScreen: number;
  active: number;
  recorded: boolean;
}) {
  if (!recorded) return <Text as="span" color="charcoal.400">—</Text>;
  if (onScreen < 1) return <>{formatScreenMinutes(0)}</>;
  if (active < 1) return <>{formatScreenMinutes(onScreen)}</>;
  return (
    <>
      {formatScreenMinutes(onScreen)}
      <Text as="span" color="charcoal.400">
        {" "}({formatScreenMinutes(active)} building)
      </Text>
    </>
  );
}

function UsageCells({
  totals,
  builderRecorded,
}: {
  totals: ScholarWeek["totals"];
  builderRecorded: boolean;
}) {
  return (
    <>
      <Table.Cell textAlign="end" whiteSpace="nowrap">
        <Minutes measured={totals.measuredMinutes} estimated={totals.estimatedMinutes} />
      </Table.Cell>
      <Table.Cell textAlign="end" whiteSpace="nowrap">
        <Minutes
          measured={totals.outsideSchool.measuredMinutes}
          estimated={totals.outsideSchool.estimatedMinutes}
        />
      </Table.Cell>
      <Table.Cell textAlign="end" whiteSpace="nowrap">
        <BuilderCell
          onScreen={totals.builder.onScreenMinutes}
          active={totals.builder.activeMinutes}
          recorded={builderRecorded}
        />
      </Table.Cell>
      <Table.Cell textAlign="end" whiteSpace="nowrap">
        {formatScreenMinutes(totals.webActivityMinutes)}
      </Table.Cell>
      <Table.Cell textAlign="end" whiteSpace="nowrap">
        <Minutes measured={totals.appsMeasuredMinutes} estimated={totals.appsEstimatedMinutes} />
      </Table.Cell>
      <Table.Cell textAlign="end" whiteSpace="nowrap">
        {formatScreenMinutes(totals.otherRabbitholeMinutes)}
      </Table.Cell>
    </>
  );
}

function UsageTable({
  weeks,
  focusScholarId,
  builderRecordedAll,
}: {
  weeks: ScholarWeek[];
  focusScholarId: string | null;
  builderRecordedAll: boolean;
}) {
  const [openScholarIds, setOpenScholarIds] = useState<Set<string>>(
    () => new Set(focusScholarId ? [focusScholarId] : []),
  );
  const toggle = (scholarId: string) =>
    setOpenScholarIds((prev) => {
      const next = new Set(prev);
      if (next.has(scholarId)) next.delete(scholarId);
      else next.add(scholarId);
      return next;
    });
  const builderRecordedFor = (dayKey: string) => dayKey >= BUILDER_FIRST_DAY_KEY;

  return (
    <Surface p={0} overflowX="auto">
      <Table.Root size="sm" variant="line">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeader>Scholar</Table.ColumnHeader>
            <Table.ColumnHeader textAlign="end">Total</Table.ColumnHeader>
            <Table.ColumnHeader textAlign="end">Outside school</Table.ColumnHeader>
            <Table.ColumnHeader textAlign="end">App builder</Table.ColumnHeader>
            <Table.ColumnHeader textAlign="end">Web activities</Table.ColumnHeader>
            <Table.ColumnHeader textAlign="end">Launched apps</Table.ColumnHeader>
            <Table.ColumnHeader textAlign="end">Rest of Rabbithole</Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {weeks.map((week) => {
            const open = openScholarIds.has(week.scholarId);
            return (
              <Fragment key={week.scholarId}>
                <Table.Row
                  bg={week.scholarId === focusScholarId ? "violet.50" : undefined}
                >
                  <Table.Cell>
                    <Button
                      variant="plain"
                      size="sm"
                      px={0}
                      h="auto"
                      fontFamily="body"
                      fontWeight="600"
                      color="navy.500"
                      onClick={() => toggle(week.scholarId)}
                      aria-expanded={open}
                    >
                      {open ? <CaretDown /> : <CaretRight />}
                      {week.scholarName}
                    </Button>
                  </Table.Cell>
                  <UsageCells totals={week.totals} builderRecorded={builderRecordedAll} />
                </Table.Row>
                {open &&
                  week.days.map((day) => (
                    <Table.Row key={`${week.scholarId}-${day.dayKey}`} color="charcoal.500">
                      <Table.Cell pl={9} whiteSpace="nowrap">
                        {shortDay(day.dayKey, true)}
                        {day.apps.length > 0 ? (
                          <Text fontSize="sm" color="charcoal.400">
                            {day.apps
                              .map((app) => `${app.appName} ${formatScreenMinutes(app.measuredMinutes)}`)
                              .join(" · ")}
                          </Text>
                        ) : null}
                      </Table.Cell>
                      <UsageCells
                        totals={day.totals}
                        builderRecorded={builderRecordedFor(day.dayKey)}
                      />
                    </Table.Row>
                  ))}
              </Fragment>
            );
          })}
        </Table.Body>
      </Table.Root>
    </Surface>
  );
}

function ChartHeading({ title, hint }: { title: string; hint: string }) {
  return (
    <Stack gap={0.5}>
      <Text fontFamily="heading" fontSize="md" fontWeight="600" color="navy.500">
        {title}
      </Text>
      <Text fontFamily="body" fontSize="sm" color="charcoal.400">
        {hint}
      </Text>
    </Stack>
  );
}

function Loading() {
  return (
    <Text fontFamily="body" fontSize="sm" color="charcoal.400">
      Loading…
    </Text>
  );
}

export default function SchoolScreenTimePage() {
  const { user, isLoading } = useCurrentUser();
  const { activeInstitution, hasSchoolOperationsAccess } =
    useSchoolOperationsAccess(user, !!user);
  const router = useRouter();
  const searchParams = useSearchParams();
  const inst = searchParams.get("inst") ?? "";
  const focusScholarId = searchParams.get("scholar");
  const view = parseView(searchParams.get("view"));
  const side = parseSide(searchParams.get("side"));
  const endDayKey = clampEndDayKey(searchParams.get("end"));
  const startDayKey = shiftDayKey(endDayKey, -6);
  const dayKey = clampDayKey(searchParams.get("day"));
  const month = clampMonth(searchParams.get("month"));
  const chunks = useMemo(() => monthChunks(month), [month]);

  const allowed =
    isScholarAdminRole(user?.role) || hasSchoolOperationsAccess === true;
  const authorization = useAuthorizationGuard({
    isLoading: isLoading || activeInstitution === undefined,
    hasUser: !!user,
    isAllowed: allowed,
    unauthorizedRedirect: "/",
  });
  const ready = authorization === "allowed";

  // WEEK and MONTH read the per-scholar-day summary (convex/screenTimeDays.ts)
  // in one query. Until every past day of the period is summarized (before
  // the backfill, or a day the nightly pass has not reached), the period is
  // read live instead, so nothing goes blank.
  const firstChunk = chunks.find((chunk) => chunk !== null) ?? null;
  const lastChunk = [...chunks].reverse().find((chunk) => chunk !== null) ?? null;
  const periodRange =
    view === "week"
      ? { startDayKey, endDayKey }
      : view === "month" && firstChunk && lastChunk
        ? { startDayKey: firstChunk.startDayKey, endDayKey: lastChunk.endDayKey }
        : null;
  const summarized = useQuery(
    api.screenTimeDays.periodUsage,
    ready && periodRange
      ? { institutionScope: inst, ...periodRange, todayDayKey: TODAY_DAY_KEY }
      : "skip",
  );
  const readLive = summarized !== undefined && !summarized.complete;

  const weekRows: DayRow[] | undefined = useQuery(
    api.deviceActivity.dailyUsage,
    ready && view === "week" && readLive
      ? { institutionScope: inst, startDayKey, endDayKey }
      : "skip",
  );
  const timeline = useQuery(
    api.deviceActivity.dayTimeline,
    ready && view === "day" ? { institutionScope: inst, dayKey } : "skip",
  );
  // A live month is five fixed hooks, one per 7-day range; a short or partial
  // month skips the ranges it does not have.
  const monthArgs = (index: number) => {
    const chunk = chunks[index];
    return ready && view === "month" && readLive && chunk
      ? { institutionScope: inst, ...chunk }
      : ("skip" as const);
  };
  const month0 = useQuery(api.deviceActivity.dailyUsage, monthArgs(0));
  const month1 = useQuery(api.deviceActivity.dailyUsage, monthArgs(1));
  const month2 = useQuery(api.deviceActivity.dailyUsage, monthArgs(2));
  const month3 = useQuery(api.deviceActivity.dailyUsage, monthArgs(3));
  const month4 = useQuery(api.deviceActivity.dailyUsage, monthArgs(4));
  const monthParts = [month0, month1, month2, month3, month4];
  const monthLoaded = chunks.every(
    (chunk, index) => chunk === null || monthParts[index] !== undefined,
  );
  const monthRows: DayRow[] | undefined = monthLoaded
    ? monthParts.flatMap((part) => part ?? [])
    : undefined;
  const liveRows = view === "month" ? monthRows : weekRows;

  const scope = useUrlScholarScope();
  // All scholars keeps every row (a scholar the roster leaves out, such as an
  // Extended Education guest, still used their BunnyPad); a narrower scope
  // keeps its own members. Test accounts are never a child's time.
  const memberKey = scope.scopeKey === "" ? null : scope.scopedScholarIds.join(",");
  const inScope = useMemo(() => {
    const members = memberKey === null ? null : new Set(memberKey.split(","));
    return (scholarId: string) =>
      !isTestAccount(scholarId) && (members === null || members.has(scholarId));
  }, [memberKey]);
  const scopeReady = !scope.isLoading;

  const allRows: DayRow[] | undefined =
    summarized === undefined ? undefined : summarized.complete ? summarized.rows : liveRows;
  const rows = useMemo(
    () => (allRows && scopeReady ? allRows.filter((row) => inScope(String(row.scholarId))) : undefined),
    [allRows, scopeReady, inScope],
  );
  const dayScholars = useMemo(
    () =>
      timeline && scopeReady
        ? timeline.scholars.filter((scholar) => inScope(String(scholar.scholarId)))
        : undefined,
    [timeline, scopeReady, inScope],
  );
  const weeks = useMemo(() => (rows ? sumScholarWeeks(rows) : undefined), [rows]);
  const periodDays = daysOfPeriod(
    view === "month"
      ? chunks.filter((chunk) => chunk !== null)
      : [{ startDayKey, endDayKey }],
  );
  // Every scholar in the scope counts toward its average, a day off as zero.
  const roster = scope.scholars
    .filter((scholar) => inScope(scholar.id))
    .map((scholar) => ({ scholarId: scholar.id, scholarName: scholar.name }));
  const summary = rows ? summarizePeriod(rows, roster, periodDays) : undefined;

  // The activity bars: each day's minutes by kind, from the summary rows (the
  // day strip's classifier, split at the bell). A period still read live has
  // no kinds, so the bars wait for the summary.
  const focusPerson = summary?.people.find((person) => person.id === focusScholarId);
  let activityDays: ActivityDay[] | null = null;
  if (summary && summarized?.complete) {
    const scopedRows = summarized.rows.filter((row) => inScope(String(row.scholarId)));
    const kindRows: DayKindRow[] = scopedRows.map((row) => ({
      scholarId: String(row.scholarId),
      dayKey: row.dayKey,
      inSchool: row.kinds.inSchool,
      outside: row.kinds.outside,
    }));
    const ids = focusPerson ? [focusPerson.id] : summary.people.map((person) => person.id);
    const minutes = averageKindsByDay(kindRows, ids, periodDays, side);
    activityDays = periodDays.map((dayKey, index) => {
      const dayRows = scopedRows.filter((row) => row.dayKey === dayKey);
      return {
        dayKey,
        schoolDay: dayRows.length === 0 ? null : dayRows.some((row) => row.schoolDay),
        minutes: minutes[index],
      };
    });
  }

  const setParams = (updates: Record<string, string>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) params.set(key, value);
    // Keep the reader where they are: the bars' toggle sits mid-page.
    router.replace(`/school/screen-time?${params.toString()}`, { scroll: false });
  };
  const setEnd = (value: string) => setParams({ end: clampEndDayKey(value) });
  const setDay = (value: string) => setParams({ day: clampDayKey(value) });
  const setMonth = (value: string) => setParams({ month: clampMonth(value) });

  if (!ready || !user) {
    return <AuthorizationPending />;
  }

  const rangeStart =
    view === "month" ? (chunks.find((chunk) => chunk)?.startDayKey ?? `${month}-01`) : startDayKey;
  const rangeEnd = periodDays[periodDays.length - 1] ?? endDayKey;
  // A period that starts before builder recording still totals the days it
  // has; the footnote says the earlier days aren't in it.
  const builderRecordedAll = rangeEnd >= BUILDER_FIRST_DAY_KEY;
  const builderPartial = rangeStart < BUILDER_FIRST_DAY_KEY;
  const totalEstimatedIntervals = (rows ?? []).reduce(
    (sum, row) => sum + row.estimatedIntervals,
    0,
  );

  return (
    <Box p={{ base: 5, lg: 8 }}>
      <Stack gap={5} maxW="1100px">
        <PageHeader
          title="Screen time"
          subtitle="How long each scholar was on their BunnyPad, and where the time went. Outside school means a weekend, a closed day, or before or after the school-day bell schedule. Builder time counts as building in the minutes around each request the scholar makes; the rest is trying the app."
        />

        <HStack gap={4} wrap="wrap">
          <ViewToggle
            items={VIEWS}
            value={view}
            onChange={(next) => setParams({ view: next })}
            ariaLabel="Day, week or month"
          />
          <ScholarScopePicker
            groups={scope.groups}
            scopeKey={scope.scopeKey}
            hasMine={scope.hasMine}
            onSelectScope={scope.selectScope}
            visibleScholarIds={scope.visibleScholarIds}
          />
          {view === "day" ? (
            <DateNavPicker
              label={shortDay(dayKey, true)}
              selected={dayKeyToDate(dayKey)}
              onSelect={(date) => setDay(dateToDayKey(date))}
              onPrevious={() => setDay(shiftDayKey(dayKey, -1))}
              onNext={() => setDay(shiftDayKey(dayKey, 1))}
              previousAriaLabel="Previous day"
              nextAriaLabel="Next day"
              reset={{ label: "Today", onReset: () => setDay(TODAY_DAY_KEY) }}
              ariaLabel="Choose the day"
            />
          ) : view === "month" ? (
            <DateNavPicker
              label={monthLabel(month)}
              selected={dayKeyToDate(`${month}-01`)}
              onSelect={(date) => setMonth(dateToDayKey(date).slice(0, 7))}
              onPrevious={() => setMonth(shiftMonth(month, -1))}
              onNext={() => setMonth(shiftMonth(month, 1))}
              previousAriaLabel="Previous month"
              nextAriaLabel="Next month"
              reset={{ label: "This month", onReset: () => setMonth(THIS_MONTH) }}
              ariaLabel="Choose the month"
            />
          ) : (
            <DateNavPicker
              label={`${shortDay(startDayKey)} – ${shortDay(endDayKey)}`}
              selected={dayKeyToDate(endDayKey)}
              onSelect={(date) => setEnd(dateToDayKey(date))}
              onPrevious={() => setEnd(shiftDayKey(endDayKey, -7))}
              onNext={() => setEnd(shiftDayKey(endDayKey, 7))}
              previousAriaLabel="Previous 7 days"
              nextAriaLabel="Next 7 days"
              reset={{ label: "Last 7 days", onReset: () => setEnd(TODAY_DAY_KEY) }}
              ariaLabel="Choose the last day of the 7-day window"
            />
          )}
        </HStack>

        {view === "day" ? (
          timeline === undefined || dayScholars === undefined ? (
            <Loading />
          ) : dayScholars.length === 0 ? (
            <EmptyState
              title="No BunnyPad time on this day"
              hint="Time appears here once scholars use their BunnyPads."
            />
          ) : (
            <Surface p={{ base: 4, lg: 5 }}>
              <DayStrip data={{ ...timeline, scholars: dayScholars }} emphasizeScholarId={focusScholarId} />
            </Surface>
          )
        ) : weeks === undefined ? (
          <Loading />
        ) : weeks.length === 0 ? (
          <EmptyState
            title={
              view === "month"
                ? `No BunnyPad time in ${monthLabel(month)}`
                : "No BunnyPad time in these 7 days"
            }
            hint="Time appears here once scholars use their BunnyPads."
          />
        ) : (
          <>
            {summary && summary.people.length > 0 ? (
              <Surface p={{ base: 4, lg: 5 }}>
                <Stack gap={6}>
                  <Stack gap={2}>
                    <ChartHeading
                      title="In school, per school day"
                      hint="Minutes on screen during school hours, averaged over every school day in the period. The dashed line marks the average scholar."
                    />
                    <AveragesChart
                      summary={summary}
                      scopeName={scope.scopeName}
                      emphasizeScholarId={focusScholarId}
                    />
                  </Stack>
                  <Stack gap={3}>
                    <HStack justify="space-between" align="flex-start" gap={3} wrap="wrap">
                      <ChartHeading
                        title="Minutes by activity, day by day"
                        hint={
                          focusPerson
                            ? `${focusPerson.name}'s own minutes on each day, in the day strip's colours.`
                            : `The average scholar in ${scope.scopeName} on each day, in the day strip's colours. Open Screen time from a scholar's profile to see their own days.`
                        }
                      />
                      <ViewToggle
                        items={SIDES}
                        value={side}
                        onChange={(next) => setParams({ side: next })}
                        ariaLabel="At school, outside school or both"
                      />
                    </HStack>
                    <Text fontFamily="body" fontSize="sm" color="charcoal.400">
                      At school is inside the bell schedule on a school day.
                      Outside school is everything else, including Extended
                      Ed after the last bell, weekends and closed days.
                    </Text>
                    {activityDays ? (
                      <ActivityBarsChart
                        days={activityDays}
                        side={side}
                        who={focusPerson ? focusPerson.name : `Average scholar, ${scope.scopeName}`}
                      />
                    ) : (
                      <Text fontFamily="body" fontSize="sm" color="charcoal.400">
                        Activity types appear once every day in this period has
                        been summarized, usually by the next morning.
                      </Text>
                    )}
                  </Stack>
                </Stack>
              </Surface>
            ) : null}
            <UsageTable
            key={`${view}-${view === "month" ? month : endDayKey}`}
            weeks={weeks}
            focusScholarId={focusScholarId}
            builderRecordedAll={builderRecordedAll}
          />
          </>
        )}

        <Stack gap={1} maxW="760px">
          {view === "day" ? (
            <Text fontFamily="body" fontSize="sm" color="charcoal.400">
              The BunnyPad reports only that Rabbithole was on screen, so each
              stretch is named from what else happened at the same time: the
              scholar&rsquo;s own app on screen (building near their requests,
              playing otherwise), a web activity, math practice answers, or
              turns in a chat. Gray is time off Rabbithole.
            </Text>
          ) : null}
          {view !== "day" && builderPartial && (
            <Text fontFamily="body" fontSize="sm" color="charcoal.400">
              App builder time is recorded from {shortDay(BUILDER_FIRST_DAY_KEY)}, 2026: earlier days show a dash, and totals count only the days since.
            </Text>
          )}
          {view !== "day" && totalEstimatedIntervals > 0 && (
            <Text fontFamily="body" fontSize="sm" color="charcoal.400">
              {totalEstimatedIntervals}{" "}
              {totalEstimatedIntervals === 1 ? "visit" : "visits"} to a launched
              app ended without a return to Rabbithole, so the time in that app
              isn&rsquo;t known. Each counts as a capped estimate, marked
              &ldquo;est.&rdquo;, and is never added to the measured minutes.
            </Text>
          )}
        </Stack>
      </Stack>
    </Box>
  );
}
