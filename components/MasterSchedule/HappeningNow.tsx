"use client";

/**
 * HappeningNow — the "Now" projection of the Schedule tab
 * (review/now-view-redesign.html §4). It collapses the Day/Week grid to the
 * current slice of the day and answers "what is everyone doing right now?":
 *
 *   • Block-first rows — Previous / Now / Next — orient the teacher in time.
 *   • Columns are the current lens (By group or By teacher), matching Day/Week.
 *   • Enriched placement chips (the shared PlacementChipExpanded) carry the live
 *     work; per-cell "+ assign" opens the one "Assign work" verb targeted at
 *     that group + the current block.
 *   • Coverage / conflict are derived schedule facts, surfaced here as
 *     teacher-readable, clickable tags that hand the problem to the aide — DRY
 *     with the conflict→chat pattern.
 *
 * It reads the SAME `masterSchedule.grid` query as the Day/Week grid — no new
 * source of truth — and derives the current block from `scheduleBlocks`
 * start/end times against the wall clock.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { Box, Button, Flex, HStack, IconButton, Stack, Text, VStack, chakra } from "@chakra-ui/react";
import { ArrowSquareOut, Plus, UserPlus, Warning, X } from "@phosphor-icons/react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  PlacementChipExpanded,
  type Lens,
  type PlacementChipData,
} from "@/components/MasterSchedule/PlacementChip";
import {
  AssignWorkDrawer,
  type AssignTarget,
} from "@/components/MasterSchedule/AssignWorkDrawer";
import {
  PlacementDetailDrawer,
  type DrawerTarget,
} from "@/components/MasterSchedule/PlacementDetailDrawer";
import { offSchedulePushes } from "@/components/MasterSchedule/offSchedulePushes";
import { SectionEyebrow } from "@/components/ui/SectionEyebrow";
import { ActivityModeBadge } from "@/lib/activityMode";
import {
  dueStatus,
  minuteOfDayForTimezone,
  weekdayForTimezone,
} from "@/shared/institutionDay";
import { toaster } from "@/lib/toaster";
import { useAideDock } from "@/components/aide/AideDockProvider";
import { isClassFocusRunningLong } from "@/shared/roomTurn";
import { RoomCueControl } from "@/components/RoomCueControl";
import { useInstitutionDay } from "@/hooks/useInstitutionDay";
import { useNow } from "@/hooks/useNow";
import { scheduleWeekStartMs } from "@/shared/scheduleWeek";

type GridData = NonNullable<ReturnType<typeof useQuery<typeof api.masterSchedule.grid>>>;
type GridBlock = GridData["blocks"][number];
type GridPlacement = GridData["placements"][number];
type ActivePush = NonNullable<
  ReturnType<typeof useQuery<typeof api.assignments.activePushesForTeacher>>
>[number];

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function fmt12h(hhmm: string): string {
  const mins = parseHHMM(hhmm);
  if (mins == null) return hhmm;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

export function HappeningNow() {
  // Active term — the "now" period. Fall back to the most recent one.
  const currentTerm = useQuery(api.reportingPeriods.current, {});
  const terms = useQuery(api.reportingPeriods.list, {});
  const termId = (currentTerm ?? terms?.[0])?._id ?? null;

  // The period clock supplies its authoritative timezone once; useInstitutionDay
  // then advances it at each institution-local midnight (and on tab resume).
  // That changes the explicit grid anchor at a week boundary without relying on
  // a long-lived server subscription to notice elapsed time.
  const serverDay = useQuery(
    api.masterSchedule.periodClock,
    termId ? { periodId: termId } : "skip",
  );
  const institutionDay = useInstitutionDay(serverDay);
  const nowMs = useNow();
  const weekStartMs = institutionDay
    ? scheduleWeekStartMs(institutionDay.dayStart, institutionDay.timeZone)
    : null;
  const grid = useQuery(
    api.masterSchedule.grid,
    termId && weekStartMs != null ? { periodId: termId, weekStartMs } : "skip",
  );

  // Live pushes across ALL the teacher's assignments (term-independent). Used to
  // surface pushes that are live to scholars right now but were sent straight
  // from a Run page — i.e. have no matching timetable placement in the grid.
  const activePushes = useQuery(api.assignments.activePushesForTeacher, {});

  const [lens, setLens] = useState<Lens>("group");
  const [assignTarget, setAssignTarget] = useState<AssignTarget | null>(null);
  // Click-through detail drawer — the same PlacementDetailDrawer the Day/Week
  // grid opens (placement target). Now-view chips don't carry remove / flag
  // callbacks, so those drawer sections stay hidden here.
  const [detailTarget, setDetailTarget] = useState<DrawerTarget | null>(null);
  const aide = useAideDock();

  // The Now view's always-available "assign a child something right now" entry:
  // opens the one Assign-work drawer with an empty learner target so the teacher
  // picks the scholar in the drawer. Present in every Now state (even before a
  // schedule exists) — assigning a child work must never depend on the timetable.
  const openAssignScholar = () =>
    setAssignTarget({ kind: "learner", scholars: [], intent: "custom" });

  // The week anchor, weekday, and minute all use the institution's calendar.
  // Weekend clamps to a "school's out" state so the board is honest, not falsely
  // "live". Fallback values are never rendered while the calendar is loading.
  const jsDay = institutionDay
    ? weekdayForTimezone(nowMs, institutionDay.timeZone)
    : 1; // 0=Sun … 6=Sat
  const isSchoolDay = jsDay >= 1 && jsDay <= 5;
  const schoolWeekday = isSchoolDay ? jsDay : 1; // weekend previews Monday's plan
  const nowMinutes = institutionDay
    ? minuteOfDayForTimezone(nowMs, institutionDay.timeZone)
    : 0;
  // The explicitly anchored query's effective feed already excludes other weeks
  // and layers concrete bare rows.
  const weekPlacements = useMemo(
    () => grid?.weekPlacements ?? [],
    [grid?.weekPlacements],
  );

  // The bell-schedule timeline for today (exclude the virtual homework block).
  const timeline = useMemo(() => {
    return (grid?.blocks ?? [])
      .filter((b) => b.kind !== "homework")
      .filter((b) => (b.weekdays ?? []).includes(schoolWeekday) || (b.weekdays ?? []).length === 0)
      .map((b) => ({ block: b, start: parseHHMM(b.startLocal) ?? 0, end: parseHHMM(b.endLocal) ?? 0 }))
      .sort((a, b) => a.start - b.start);
  }, [grid?.blocks, schoolWeekday]);

  // Resolve previous / current / next slots against the clock.
  const { prev, current, next } = useMemo(() => {
    if (!isSchoolDay || timeline.length === 0) {
      return { prev: null, current: null, next: timeline[0] ?? null };
    }
    let cur: (typeof timeline)[number] | null = null;
    let pv: (typeof timeline)[number] | null = null;
    let nx: (typeof timeline)[number] | null = null;
    for (const slot of timeline) {
      if (nowMinutes >= slot.start && nowMinutes < slot.end) cur = slot;
      else if (slot.end <= nowMinutes) pv = slot; // last one before now
      else if (nx == null && slot.start > nowMinutes) nx = slot;
    }
    return { prev: pv, current: cur, next: nx };
  }, [timeline, nowMinutes, isSchoolDay]);

  // Columns = groups (By group) or teachers (By teacher). Only those with any
  // placement today, else all — so the board is never empty and stays assignable.
  const columns = useMemo(() => {
    if (!grid) return [];
    const placedToday = new Set<string>();
    for (const p of weekPlacements) {
      if (p.onShelf || p.weekday !== schoolWeekday) continue;
      placedToday.add(lens === "group" ? String(p.groupId) : String(p.teacherId ?? ""));
    }
    if (lens === "group") {
      const cols = grid.groups
        .map((g) => ({ id: String(g._id), label: g.name, emoji: g.emoji }))
        .filter((c) => placedToday.has(c.id));
      return cols.length > 0
        ? cols
        : grid.groups.map((g) => ({ id: String(g._id), label: g.name, emoji: g.emoji }));
    }
    const cols = grid.teachers
      .map((t) => ({ id: String(t._id), label: t.name, emoji: null as string | null }))
      .filter((c) => placedToday.has(c.id));
    return cols.length > 0
      ? cols
      : grid.teachers.map((t) => ({ id: String(t._id), label: t.name, emoji: null }));
  }, [grid, lens, schoolWeekday, weekPlacements]);

  const groupEmojiById = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const g of grid?.groups ?? []) m.set(String(g._id), g.emoji);
    return m;
  }, [grid?.groups]);

  // placements for (block, column) today, class-focus only (homework is a rail).
  function cellPlacements(blockId: string, colId: string): GridPlacement[] {
    if (!grid) return [];
    return weekPlacements.filter((p) => {
      if (p.onShelf || p.weekday !== schoolWeekday) return false;
      if (String(p.blockId) !== blockId) return false;
      if (p.mode === "homework") return false;
      return lens === "group" ? String(p.groupId) === colId : String(p.teacherId ?? "") === colId;
    });
  }

  const conflictKeys = useMemo(() => {
    const s = new Set<string>();
    for (const c of grid?.conflicts ?? []) s.add(`${c.blockId}|${c.weekday}`);
    return s;
  }, [grid?.conflicts]);
  const coverageByKey = useMemo(() => {
    const m = new Map<string, GridData["coverage"][number]>();
    for (const c of grid?.coverage ?? []) m.set(`${c.blockId}|${c.weekday}`, c);
    return m;
  }, [grid?.coverage]);

  // Live pushes with NO matching schedule placement (matched on
  // assignmentId + activityId). These never appear in the grid cells above, so
  // they'd otherwise be invisible on the Now cross-section. Pure matching lives
  // in ./offSchedulePushes (unit-tested).
  const offSchedule = useMemo(
    () => offSchedulePushes(activePushes ?? [], grid?.placements ?? []),
    [activePushes, grid?.placements],
  );

  const headerLabel = isSchoolDay
    ? current
      ? `${WEEKDAY_NAMES[jsDay]} · ${current.block.label} · ${fmt12h(current.block.startLocal)}–${fmt12h(current.block.endLocal)}`
      : `${WEEKDAY_NAMES[jsDay]} · no class in session`
    : "Weekend · previewing Monday's plan";

  if (termId === null && terms !== undefined) {
    return (
      <Flex direction="column" h="full" overflow="hidden" bg="white">
        <RoomCueBar onAssignScholar={openAssignScholar} />
        <EmptyState message="No active term yet. Create a reporting period to build a schedule — or assign a scholar something right now with the button above." />
        <AssignWorkDrawer open={assignTarget !== null} onClose={() => setAssignTarget(null)} target={assignTarget} />
      </Flex>
    );
  }
  if (!institutionDay || !grid) {
    return (
      <Flex direction="column" h="full" overflow="hidden" bg="white">
        <RoomCueBar onAssignScholar={openAssignScholar} />
        <EmptyState message="Loading the schedule…" />
        <AssignWorkDrawer open={assignTarget !== null} onClose={() => setAssignTarget(null)} target={assignTarget} />
      </Flex>
    );
  }
  if (timeline.length === 0) {
    // No bell schedule for today — but a teacher may still have live Run-page
    // pushes going. Show those rather than a dead-end empty state.
    if (offSchedule.length === 0) {
      return (
        <Flex direction="column" h="full" overflow="hidden" bg="white">
          <RoomCueBar onAssignScholar={openAssignScholar} />
          <EmptyState message="No bell schedule for today. Add blocks in Day/Week to see the live cross-section — or assign a scholar something right now with the button above." />
          <AssignWorkDrawer open={assignTarget !== null} onClose={() => setAssignTarget(null)} target={assignTarget} />
        </Flex>
      );
    }
    return (
      <Flex direction="column" h="full" overflow="auto" bg="white">
        <RoomCueBar onAssignScholar={openAssignScholar} />
        <Box px={4} pt={6} pb={2}>
          <Text fontSize="sm" color="charcoal.300" textAlign="center" maxW="360px" mx="auto">
            No bell schedule for today. Add blocks in Day/Week to see the live cross-section.
          </Text>
        </Box>
        <Box px={4} pb={4}>
          <OffScheduleRail pushes={offSchedule} />
        </Box>
        <AssignWorkDrawer open={assignTarget !== null} onClose={() => setAssignTarget(null)} target={assignTarget} />
      </Flex>
    );
  }

  const rows: { key: string; tag: string; tagColor: string; slot: (typeof timeline)[number] | null; live: boolean }[] = [
    { key: "prev", tag: "Previous", tagColor: "charcoal.300", slot: prev, live: false },
    { key: "now", tag: current ? "Now" : "No class in session", tagColor: current ? "green.600" : "charcoal.300", slot: current, live: Boolean(current) },
    { key: "next", tag: "Next", tagColor: "violet.500", slot: next, live: false },
  ];

  return (
    <Flex direction="column" h="full" overflow="hidden" bg="white">
      {/* Sub-header: current-slice label + lens toggle */}
      <Flex align="center" gap={3} px={4} py={2.5} borderBottom="1px solid" borderColor="gray.100" flexShrink={0} flexWrap="wrap">
        <Text fontFamily="heading" fontWeight="700" fontSize="sm" color="navy.700">
          {headerLabel}
        </Text>
        <Box flex={1} />
        <AssignScholarButton onClick={openAssignScholar} />
        <HStack gap={1} p={1} bg="gray.100" borderRadius="full" display="inline-flex">
          {(["group", "teacher"] as Lens[]).map((l) => (
            <chakra.button
              key={l}
              type="button"
              cursor="pointer"
              onClick={() => setLens(l)}
              px={3}
              py={1}
              borderRadius="full"
              fontFamily="heading"
              fontWeight="600"
              fontSize="xs"
              bg={lens === l ? "white" : "transparent"}
              color={lens === l ? "navy.700" : "charcoal.400"}
              shadow={lens === l ? "xs" : "none"}
            >
              {l === "group" ? "By group" : "By teacher"}
            </chakra.button>
          ))}
        </HStack>
        <RoomCueControl />
      </Flex>

      {/* Cross-section grid: rows = Prev/Now/Next, columns = groups/teachers */}
      <Box flex={1} overflow="auto" p={4}>
        <Box
          display="grid"
          gridTemplateColumns={`150px repeat(${Math.max(columns.length, 1)}, minmax(200px, 1fr))`}
          gap={2}
          minW="fit-content"
        >
          {/* Column header row */}
          <Box />
          {columns.map((c) => (
            <HStack key={c.id} gap={1.5} px={1} py={1} align="center">
              {c.emoji && <Text fontSize="md">{c.emoji}</Text>}
              <Text fontFamily="heading" fontWeight="700" fontSize="sm" color="navy.600" lineClamp={1}>
                {c.label}
              </Text>
            </HStack>
          ))}

          {/* Timeline rows */}
          {rows.map((row) => (
            <RowFragment
              key={row.key}
              row={row}
              columns={columns}
              lens={lens}
              groupEmojiById={groupEmojiById}
              cellPlacements={cellPlacements}
              conflictKeys={conflictKeys}
              coverageByKey={coverageByKey}
              schoolWeekday={schoolWeekday}
              termId={termId}
              onAssign={setAssignTarget}
              onAskBot={(text) => aide.seedComposer(text)}
              onOpenDetail={(placementId) => setDetailTarget({ kind: "placement", placementId })}
            />
          ))}
        </Box>

        {/* Live pushes with no timetable placement — otherwise invisible here. */}
        {offSchedule.length > 0 && <OffScheduleRail pushes={offSchedule} />}
      </Box>

      <AssignWorkDrawer open={assignTarget !== null} onClose={() => setAssignTarget(null)} target={assignTarget} />
      <PlacementDetailDrawer
        target={detailTarget}
        grid={grid}
        lens={lens}
        onClose={() => setDetailTarget(null)}
        onAskBot={(text) => aide.seedComposer(text)}
      />
    </Flex>
  );
}

function RowFragment({
  row,
  columns,
  lens,
  groupEmojiById,
  cellPlacements,
  conflictKeys,
  coverageByKey,
  schoolWeekday,
  termId,
  onAssign,
  onAskBot,
  onOpenDetail,
}: {
  row: { key: string; tag: string; tagColor: string; slot: { block: GridBlock } | null; live: boolean };
  columns: { id: string; label: string; emoji: string | null }[];
  lens: Lens;
  groupEmojiById: Map<string, string | null>;
  cellPlacements: (blockId: string, colId: string) => GridPlacement[];
  conflictKeys: Set<string>;
  coverageByKey: Map<string, GridData["coverage"][number]>;
  schoolWeekday: number;
  termId: Id<"reportingPeriods"> | null;
  onAssign: (t: AssignTarget) => void;
  onAskBot: (text: string) => void;
  onOpenDetail: (placementId: string) => void;
}) {
  const block = row.slot?.block ?? null;
  return (
    <>
      {/* Row label */}
      <Flex direction="column" justify="center" px={2} py={2}>
        <Text fontFamily="heading" fontWeight="700" fontSize="xs" color={row.tagColor} textTransform="uppercase" letterSpacing="0.04em">
          {row.tag}
        </Text>
        {block ? (
          <>
            <Text fontFamily="heading" fontWeight="600" fontSize="sm" color="navy.700" lineClamp={1}>
              {block.label}
            </Text>
            <Text fontSize="2xs" color="charcoal.300">
              {row.live ? "live" : row.key === "prev" ? "ended" : "upcoming"}
            </Text>
          </>
        ) : (
          <Text fontSize="2xs" color="charcoal.300">
            —
          </Text>
        )}
      </Flex>

      {/* Cells per column */}
      {columns.map((c) => {
        if (!block) {
          return <Box key={c.id} minH="60px" borderRadius="md" bg="gray.50" opacity={0.5} />;
        }
        const items = cellPlacements(String(block._id), c.id);
        const cellKey = `${block._id}|${schoolWeekday}`;
        const hasConflict = conflictKeys.has(cellKey);
        const coverage = lens === "group" ? undefined : coverageByKey.get(cellKey);
        const understaffed = coverage && !coverage.ok;

        // Empty group cell → the WHOLE cell is the "+" assign target, not a
        // tiny corner button. Bigger, more discoverable click surface.
        if (items.length === 0 && lens === "group" && termId) {
          return (
            <chakra.button
              key={c.id}
              type="button"
              cursor="pointer"
              minH="60px"
              display="flex"
              alignItems="center"
              justifyContent="center"
              borderRadius="md"
              border="1px solid"
              borderColor="gray.100"
              bg={row.live ? "white" : "gray.50"}
              color="charcoal.200"
              aria-label={`Assign work to ${c.label}`}
              transition="background 0.1s, border-color 0.1s, color 0.1s"
              _hover={{ bg: "violet.50", borderColor: "violet.200", color: "violet.500" }}
              _focusVisible={{ outline: "2px solid", outlineColor: "violet.400", outlineOffset: "1px" }}
              onClick={() =>
                onAssign({
                  kind: "group",
                  periodId: termId,
                  groupId: c.id as Id<"scholarGroups">,
                  groupLabel: c.label,
                  blockId: block._id as Id<"scheduleBlocks">,
                  weekday: schoolWeekday,
                  slotLabel: block.label,
                })
              }
            >
              <Plus size={16} weight="bold" />
            </chakra.button>
          );
        }
        return (
          <Box
            key={c.id}
            position="relative"
            minH="60px"
            p={1.5}
            borderRadius="md"
            border="1px solid"
            borderColor="gray.100"
            bg={row.live ? "white" : "gray.50"}
          >
            <VStack align="stretch" gap={1.5}>
              {items.length === 0 ? (
                <Text fontSize="xs" color="charcoal.200" py={2} textAlign="center">
                  free
                </Text>
              ) : (
                items.map((p) => (
                  // Click reveals the detail drawer. A Box with button semantics
                  // (not a real <button>) because the chip nests its own
                  // "+ assign next" action — button-in-button is invalid HTML.
                  <Box
                    key={String(p._id)}
                    role="button"
                    tabIndex={0}
                    cursor="pointer"
                    borderRadius="md"
                    aria-label={`Details for ${p.subject}`}
                    _focusVisible={{ outline: "2px solid", outlineColor: "violet.400", outlineOffset: "2px" }}
                    onClick={() => onOpenDetail(String(p._id))}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onOpenDetail(String(p._id));
                      }
                    }}
                  >
                  <PlacementChipExpanded
                    p={p as PlacementChipData}
                    lens={lens}
                    groupEmoji={groupEmojiById.get(String(p.groupId))}
                    actions={
                      lens === "group" && termId ? (
                        <chakra.button
                          type="button"
                          cursor="pointer"
                          fontSize="2xs"
                          fontWeight="700"
                          color="violet.600"
                          _hover={{ color: "violet.700" }}
                          onClick={(e) => {
                            e.stopPropagation(); // its own verb — never also open the drawer
                            onAssign({
                              kind: "group",
                              periodId: termId,
                              groupId: p.groupId as Id<"scholarGroups">,
                              groupLabel: c.label,
                              blockId: block._id as Id<"scheduleBlocks">,
                              weekday: schoolWeekday,
                              slotLabel: block.label,
                              ...(p.teacherId ? { defaultTeacherId: p.teacherId as Id<"users"> } : {}),
                            });
                          }}
                        >
                          + assign next
                        </chakra.button>
                      ) : undefined
                    }
                  />
                  </Box>
                ))
              )}

              {/* Tags — conflict / understaffed → hand to the aide (DRY). */}
              {(hasConflict || understaffed) && (
                <chakra.button
                  type="button"
                  cursor="pointer"
                  onClick={() =>
                    onAskBot(
                      `${block.label} for ${c.label} is ${hasConflict ? "double-booked" : "short-staffed"}. Help me resolve it.`,
                    )
                  }
                  alignSelf="start"
                >
                  <HStack gap={1} bg="amber.50" color="amber.700" borderRadius="sm" px={1.5} py={0.5} fontSize="2xs" fontWeight="700" _hover={{ bg: "amber.100" }}>
                    <Warning size={11} weight="fill" />
                    <Text>{hasConflict ? "Double-booked · ask bot" : "Short-staffed · ask bot"}</Text>
                  </HStack>
                </chakra.button>
              )}
            </VStack>

            {/* Assign into an empty group cell in the current block. */}
            {lens === "group" && termId && (
              <chakra.button
                type="button"
                cursor="pointer"
                position="absolute"
                bottom={1}
                right={1}
                color="charcoal.300"
                _hover={{ color: "violet.500" }}
                aria-label={`Assign work to ${c.label}`}
                onClick={() =>
                  onAssign({
                    kind: "group",
                    periodId: termId,
                    groupId: c.id as Id<"scholarGroups">,
                    groupLabel: c.label,
                    blockId: block._id as Id<"scheduleBlocks">,
                    weekday: schoolWeekday,
                    slotLabel: block.label,
                  })
                }
              >
                <Plus size={14} weight="bold" />
              </chakra.button>
            )}
          </Box>
        );
      })}
    </>
  );
}

function OffScheduleRail({ pushes }: { pushes: ActivePush[] }) {
  const clearActivity = useMutation(api.assignments.clearActivity);
  // Group by assignment so the rail reads "Aviation cohort is live on X, Y"
  // rather than a flat list — same grouping instinct as ClassActiveView.
  const groups = useMemo(() => {
    const m = new Map<
      string,
      {
        assignmentId: Id<"assignments">;
        unitTitle: string;
        unitEmoji: string | null;
        scholarCount: number;
        pushes: ActivePush[];
      }
    >();
    for (const p of pushes) {
      const key = String(p.assignmentId);
      if (!m.has(key)) {
        m.set(key, {
          assignmentId: p.assignmentId,
          unitTitle: p.unitTitle,
          unitEmoji: p.unitEmoji,
          scholarCount: p.scholarCount,
          pushes: [],
        });
      }
      m.get(key)!.pushes.push(p);
    }
    return [...m.values()];
  }, [pushes]);

  if (groups.length === 0) return null;

  return (
    <Box mt={6}>
      <SectionEyebrow count={pushes.length} boxProps={{ px: 1, mb: 1 }}>
        Live now — not on the schedule
      </SectionEyebrow>
      <Text fontSize="xs" color="charcoal.400" px={1} mb={2} maxW="520px">
        Pushed straight from a Run page, so it isn&rsquo;t placed on the timetable
        above — but it&rsquo;s live for scholars right now.
      </Text>
      <Stack gap={2}>
        {groups.map((g) => (
          <Box
            key={String(g.assignmentId)}
            borderWidth="1px"
            borderColor="gray.200"
            borderRadius="md"
            bg="white"
            p={3}
          >
            <Link href={`/teacher/schedule/${g.assignmentId}`}>
              <HStack gap={2} align="center" mb={2}>
                <Box fontSize="lg" flexShrink={0}>
                  {g.unitEmoji ?? "📋"}
                </Box>
                <Stack gap={0} flex={1} minW={0}>
                  <Text
                    fontFamily="heading"
                    fontWeight="700"
                    fontSize="sm"
                    color="navy.600"
                    _hover={{ color: "violet.600" }}
                    lineClamp={1}
                  >
                    {g.unitTitle}
                  </Text>
                  <Text fontSize="2xs" color="charcoal.400" fontFamily="heading">
                    {g.scholarCount} scholar{g.scholarCount === 1 ? "" : "s"} ·{" "}
                    {g.pushes.length} live push{g.pushes.length === 1 ? "" : "es"}
                  </Text>
                </Stack>
                <Box color="charcoal.300" flexShrink={0}>
                  <ArrowSquareOut size={14} />
                </Box>
              </HStack>
            </Link>
            <Stack gap={1}>
              {g.pushes.map((p) => (
                <HStack
                  key={`${p.assignmentId}-${p.activityId}`}
                  gap={2}
                  align="center"
                  px={2}
                  py={1.5}
                  borderWidth="1px"
                  borderColor="gray.100"
                  borderRadius="md"
                >
                  <ActivityModeBadge mode={p.mode} variant="soft" />
                  <Stack gap={0} flex={1} minW={0}>
                    <HStack gap={1.5}>
                      <Text
                        fontFamily="heading"
                        fontWeight="600"
                        fontSize="sm"
                        color="navy.500"
                        lineClamp={1}
                      >
                        {p.activityTitle}
                      </Text>
                      {p.mode === "classFocus" &&
                        isClassFocusRunningLong(Date.now(), p.setAt, p.endsAt) && (
                          <Box
                            as="span"
                            px={1.5}
                            py={0.5}
                            bg="gray.100"
                            color="charcoal.500"
                            fontSize="2xs"
                            fontFamily="heading"
                            fontWeight="600"
                            borderRadius="full"
                            flexShrink={0}
                          >
                            running long
                          </Box>
                        )}
                    </HStack>
                    {p.lessonTitle && (
                      <Text
                        fontSize="2xs"
                        color="charcoal.400"
                        fontFamily="heading"
                        lineClamp={1}
                      >
                        {p.lessonTitle}
                      </Text>
                    )}
                  </Stack>
                  {(p.dueAt || p.endsAt) && (
                    <Text
                      fontSize="2xs"
                      color="charcoal.300"
                      fontFamily="heading"
                      whiteSpace="nowrap"
                      flexShrink={0}
                    >
                      {p.dueAt
                        ? `${dueStatus(p.dueAt, Date.now(), p.timeZone)?.phrase ?? ""}`
                        : `${formatRemaining(p.endsAt!)} left`}
                    </Text>
                  )}
                  {p.mode === "classFocus" ? (
                    <Button
                      size="2xs"
                      variant="outline"
                      color="charcoal.500"
                      flexShrink={0}
                      onClick={async () => {
                        await clearActivity({
                          assignmentId: p.assignmentId,
                          activityId: p.activityId,
                        });
                        toaster.success({ title: "Wrapped — room moved on" });
                      }}
                    >
                      Wrap now
                    </Button>
                  ) : (
                    <IconButton
                      aria-label="Clear push"
                      size="xs"
                      variant="ghost"
                      color="charcoal.400"
                      flexShrink={0}
                      _hover={{ color: "red.500", bg: "red.50" }}
                      onClick={async () => {
                        await clearActivity({
                          assignmentId: p.assignmentId,
                          activityId: p.activityId,
                        });
                        toaster.success({ title: "Homework cleared" });
                      }}
                    >
                      <X />
                    </IconButton>
                  )}
                </HStack>
              ))}
            </Stack>
          </Box>
        ))}
      </Stack>
    </Box>
  );
}

function formatRemaining(endsAt: number): string {
  const ms = endsAt - Date.now();
  if (ms <= 0) return "ended";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

// A persistent, thin top bar carrying just the Room control — used by every
// early-return state (loading/empty/no-schedule) so a teacher can always
// reach a room cue from the Now tab, not only once the grid has real data.
// The populated grid's own sub-header (above) hosts the control inline
// instead, alongside the lens toggle.
function AssignScholarButton({ onClick }: { onClick: () => void }) {
  return (
    <chakra.button
      type="button"
      cursor="pointer"
      onClick={onClick}
      display="inline-flex"
      alignItems="center"
      gap={1.5}
      px={3}
      py={1.5}
      borderRadius="full"
      bg="violet.500"
      color="white"
      fontFamily="heading"
      fontWeight="700"
      fontSize="xs"
      _hover={{ bg: "violet.600" }}
      _focusVisible={{ outline: "2px solid", outlineColor: "violet.300", outlineOffset: "1px" }}
      aria-label="Assign work to a scholar"
    >
      <UserPlus size={14} weight="bold" />
      Assign to a scholar
    </chakra.button>
  );
}

function RoomCueBar({ onAssignScholar }: { onAssignScholar?: () => void }) {
  return (
    <Flex align="center" gap={3} px={4} py={2} borderBottom="1px solid" borderColor="gray.100" flexShrink={0}>
      <Box flex={1} />
      {onAssignScholar && <AssignScholarButton onClick={onAssignScholar} />}
      <RoomCueControl />
    </Flex>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <Flex h="full" align="center" justify="center" p={8}>
      <Text fontSize="sm" color="charcoal.300" textAlign="center" maxW="360px">
        {message}
      </Text>
    </Flex>
  );
}
