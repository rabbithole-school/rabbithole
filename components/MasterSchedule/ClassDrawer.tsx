"use client";

/**
 * ClassDrawer — the "class view" as a drawer, not a new route
 * (review/unit-flow-into-class-plan.html §7 "the class drawer"). Clicking a
 * class header in the schedule grid opens this for that `(groupId, subject)`
 * class: ONE chronological spine of the queue as it flows across the term.
 *
 *   1. Class identity — subject heading (PlacementChipExpanded eyebrow style),
 *      discovered meeting pattern ("Meets Tue · Thu 11:10 AM"), teacher.
 *   2. PAST meetings (most recent few) — each with the SHARED DidThisHappenSection
 *      inline (the §7 dialog; the class drawer may become the main place teachers
 *      answer it).
 *   3. UPCOMING meetings — the queue projection ("n of N", title, date), the SAME
 *      dated-list idiom as the flow-palette preview (T1: one projection rendering).
 *   4. "At this pace: finishes <date>" for the active queue.
 *   5. When the queue runs out — "Nothing queued after <date>" → the EXISTING flow
 *      palette, anchored at the class's first free meeting (no new flow UI).
 *
 * Everything derives client-side from the grid query's placements filtered to the
 * class (coreGrid already returns every term row across weeks) + the same pure
 * generators the cascade uses — so this is the SECOND consumer of the implicit
 * (groupId, subject) class entity, with NO new table, route, or grid lens.
 *
 * Shell mirrors PlacementDetailDrawer: Chakra Drawer.Root placement="end"
 * size="sm" in a Portal, stably mounted (never keyed while open — the Ark
 * body-lock rule), the inner body keyed per class. Never stacks a Dialog.
 */
import { useMemo, useState } from "react";
import { useNow } from "@/hooks/useNow";
import {
  Box,
  Button,
  Drawer,
  Flex,
  HStack,
  Portal,
  Text,
  VStack,
  chakra,
} from "@chakra-ui/react";
import { CalendarPlus, Plus, X } from "@phosphor-icons/react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionEyebrow } from "@/components/ui/SectionEyebrow";
import { DidThisHappenSection, type DidThisHappenResult } from "@/components/MasterSchedule/DidThisHappenSection";
import { fmtTime } from "@/components/MasterSchedule/timeFormat";
import { deriveClassMeetingPattern } from "@/shared/meetingSlots";
import { assembleClassSpine, firstFreeMeeting, type SpineChip } from "@/shared/classSpine";
import { scheduleWeekStartMs } from "@/shared/scheduleWeek";

type GridData = NonNullable<ReturnType<typeof useQuery<typeof api.masterSchedule.grid>>>;
type Placement = GridData["placements"][number];

const DAY_MS = 86_400_000;
const WEEKDAY_SHORT = ["", "Mon", "Tue", "Wed", "Thu", "Fri"];
// Recent past meetings shown inline — the term-long history is NOT rendered
// (§7 "most recent few"); this caps it with a count.
const PAST_CAP = 5;

export type ClassDrawerTarget = { groupId: string; subject: string };

/** The anchor a "flow another unit" click hands back to the parent — enough to
 *  reopen the existing QuickAddPalette in fill mode at the class's first free
 *  meeting (class-anchored: `anchorPlacementId` supplies subject + pattern). */
export type FlowAnotherUnitAnchor = {
  groupId: string;
  subject: string;
  weekday: number;
  blockId: string;
  weekStartMs: number;
  anchorPlacementId: string;
  teacherId: string;
};

function monthDay(ms: number): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(ms));
}

function targetKey(t: ClassDrawerTarget): string {
  return `${t.groupId}|${t.subject.trim().toLowerCase()}`;
}

function hhmmToMinutes(hhmm: string): number | null {
  const [h, m] = hhmm.split(":").map(Number);
  return Number.isNaN(h) || Number.isNaN(m) ? null : h * 60 + m;
}

/** A block's own length in minutes — the same calibration the flow palette's
 *  duration lint uses, so the spine's spanBlocks end-time agrees with it. */
function blockLengthMinutes(block: { startLocal: string; endLocal: string }): number | null {
  const s = hhmmToMinutes(block.startLocal);
  const e = hhmmToMinutes(block.endLocal);
  return s != null && e != null ? e - s : null;
}

export function ClassDrawer({
  target,
  grid,
  onClose,
  onFlowUnit,
}: {
  target: ClassDrawerTarget | null;
  grid: GridData | undefined;
  onClose: () => void;
  onFlowUnit: (anchor: FlowAnotherUnitAnchor) => void;
}) {
  return (
    <Drawer.Root
      open={target !== null}
      onOpenChange={(d) => {
        if (!d.open) onClose();
      }}
      placement="end"
      size="sm"
    >
      <Portal>
        <Drawer.Backdrop />
        <Drawer.Positioner>
          <Drawer.Content
            display="flex"
            flexDirection="column"
            bg="white"
            shadow="lg"
            pt="env(safe-area-inset-top)"
            pb="env(safe-area-inset-bottom)"
          >
            {target && grid && (
              <ClassDrawerBody
                key={targetKey(target)}
                target={target}
                grid={grid}
                onClose={onClose}
                onFlowUnit={onFlowUnit}
              />
            )}
          </Drawer.Content>
        </Drawer.Positioner>
      </Portal>
    </Drawer.Root>
  );
}

function ClassDrawerBody({
  target,
  grid,
  onClose,
  onFlowUnit,
}: {
  target: ClassDrawerTarget;
  grid: GridData;
  onClose: () => void;
  onFlowUnit: (anchor: FlowAnotherUnitAnchor) => void;
}) {
  const subjectKey = target.subject.trim().toLowerCase();

  // Which past meetings the teacher has already answered THIS drawer session,
  // keyed by placementId — swaps the inline dialog for a quiet acknowledgment.
  // Local + ephemeral (no query); the body is keyed per class, so it resets when
  // the drawer closes or switches class.
  const [answered, setAnswered] = useState<Record<string, DidThisHappenResult>>({});

  // The drawer's whole past/upcoming split and its "flow another unit" anchor
  // hang off this instant. Reading Date.now() INSIDE the memo froze it on the
  // grid data: meetings never moved from upcoming to past while the drawer
  // stayed open, and the first-free anchor could point at a meeting already in
  // the past. Minute grain is enough — meeting boundaries are minute-aligned.
  const nowMs = useNow(60_000);
  const derived = useMemo(() => {
    const blockOrder = new Map(grid.blocks.map((b) => [String(b._id), b.order]));
    const blockById = new Map(grid.blocks.map((b) => [String(b._id), b]));

    // Every non-homework row of this class, across all weeks.
    const classRows = grid.placements.filter(
      (p) =>
        String(p.groupId) === target.groupId &&
        p.subject.trim().toLowerCase() === subjectKey &&
        p.mode !== "homework",
    );
    const placementsById = new Map<string, Placement>(
      classRows.map((p) => [String(p._id), p]),
    );

    // The recurring structure rows (no own week) ARE the class's identity + its
    // weekly meeting pattern.
    const recurringRows = classRows.filter(
      (p) => p.weekStartMs == null && p.weekday != null && p.blockId != null,
    );
    const pattern = deriveClassMeetingPattern({
      placements: grid.placements.map((p) => ({
        weekStartMs: p.weekStartMs ?? null,
        weekday: p.weekday ?? null,
        blockId: p.blockId ? String(p.blockId) : null,
        groupId: String(p.groupId),
        subject: p.subject,
        mode: p.mode ?? null,
      })),
      groupId: target.groupId,
      subject: target.subject,
      blockOrder,
    });

    // "Meets Tue · Thu 11:10 AM" from the discovered pattern.
    const meetingLabel = (() => {
      if (pattern.length === 0) return null;
      const days = pattern
        .map((m) => WEEKDAY_SHORT[m.weekday] ?? "")
        .filter(Boolean);
      const startTimes = Array.from(
        new Set(
          pattern
            .map((m) => blockById.get(m.blockId)?.startLocal)
            .filter((t): t is string => Boolean(t)),
        ),
      );
      const time = startTimes.length === 1 ? ` ${fmtTime(startTimes[0])}` : "";
      return `Meets ${days.join(" · ")}${time}`;
    })();

    const teacherName =
      recurringRows.find((p) => p.teacherName)?.teacherName ??
      classRows.find((p) => p.teacherName)?.teacherName ??
      null;
    const group = grid.groups.find((g) => String(g._id) === target.groupId) ?? null;

    // Rows of this class that lost (or never got) a day — the §8b bridge:
    // the class surfaces its own unplaced structure inline, so a meeting a
    // deleted block orphaned onto the Not-yet-scheduled lane is honestly
    // visible here without a second surface.
    const unplacedCount = classRows.filter((p) => p.onShelf).length;

    // The concrete queued chips (one materialized/planned row per activity) →
    // the spine.
    const chips: SpineChip[] = classRows
      .filter((p) => p.weekStartMs != null && p.weekday != null && p.blockId)
      .map((p) => {
        const block = blockById.get(String(p.blockId));
        const startMins = block ? hhmmToMinutes(block.startLocal) : null;
        // Meeting length = the block's own length × spanBlocks, the SAME block
        // length the flow palette's duration lint uses (blockMinutes). A double
        // period (spanBlocks > 1) must not read as past until its LAST spanned
        // block ends, so the end is `spanBlocks` block-lengths past the start.
        const blockLen = block ? blockLengthMinutes(block) : null;
        const span = Math.max(1, p.spanBlocks ?? 1);
        const dayMs = p.weekStartMs! + (p.weekday! - 1) * DAY_MS;
        const endMs =
          startMins != null && blockLen != null
            ? dayMs + (startMins + blockLen * span) * 60_000
            : dayMs + DAY_MS - 1;
        return {
          placementId: String(p._id),
          weekStartMs: p.weekStartMs!,
          weekday: p.weekday!,
          blockId: String(p.blockId),
          dayMs,
          endMs,
          sequenceIndex: p.sequenceIndex,
          sequenceRank: p.sequenceRank,
          sequenceLength: p.sequenceLength,
          activityTitle: p.activityTitle,
          unitTitle: p.unitTitle,
          linkState: p.linkState,
        };
      });

    const spine = assembleClassSpine({ chips, nowMs, pastCap: PAST_CAP });

    const nowWeekStartMs = scheduleWeekStartMs(nowMs);
    const nowWeekday = Math.floor((nowMs - nowWeekStartMs) / DAY_MS) + 1;
    const free = firstFreeMeeting({
      queuedSlots: chips.map((c) => ({
        weekStartMs: c.weekStartMs,
        weekday: c.weekday,
        blockId: c.blockId,
      })),
      pattern,
      blockOrder,
      nowWeekStartMs,
      nowWeekday,
      // Route the anchor off no-school days via the cascade's generator, so the
      // grid never navigates to a closed day (the flowed unit would start
      // off-screen).
      closures: grid.closures,
      timeZone: grid.closureTimeZone,
    });
    // Class-anchored flow needs a placement to read the subject + pattern from:
    // the recurring row at the free meeting, else any recurring row, else any
    // row of the class.
    const anchorRow = free
      ? (recurringRows.find(
          (p) => p.weekday === free.weekday && String(p.blockId) === free.blockId,
        ) ??
        recurringRows[0] ??
        classRows[0] ??
        null)
      : null;

    return { spine, free, anchorRow, meetingLabel, teacherName, group, unplacedCount, blockById, placementsById };
  }, [grid, target.groupId, target.subject, subjectKey, nowMs]);

  const { spine, free, anchorRow, meetingLabel, teacherName, group, unplacedCount, blockById, placementsById } =
    derived;

  const flow = () => {
    if (!free || !anchorRow) return;
    onFlowUnit({
      groupId: target.groupId,
      subject: target.subject,
      weekday: free.weekday,
      blockId: free.blockId,
      weekStartMs: free.weekStartMs,
      anchorPlacementId: String(anchorRow._id),
      teacherId: anchorRow.teacherId ? String(anchorRow.teacherId) : "",
    });
  };

  const blockLabel = (blockId: string) => blockById.get(blockId)?.label ?? "";

  return (
    <>
      {/* 1 · Class identity */}
      <Flex
        direction="column"
        gap={2}
        px={5}
        py={4}
        borderBottom="1px solid"
        borderColor="gray.100"
      >
        <Flex align="start" justify="space-between" gap={3}>
          <Box minW={0}>
            <Text
              fontFamily="heading"
              fontSize="2xs"
              fontWeight="700"
              color="charcoal.400"
              textTransform="uppercase"
              letterSpacing="0.05em"
              lineClamp={1}
            >
              {group ? `${group.emoji ? `${group.emoji} ` : ""}${group.name}` : "Class"}
            </Text>
            <Drawer.Title asChild>
              <Text fontFamily="heading" fontWeight="700" fontSize="md" color="navy.700" lineClamp={2}>
                {target.subject}
              </Text>
            </Drawer.Title>
          </Box>
          <chakra.button
            type="button"
            cursor="pointer"
            onClick={onClose}
            aria-label="Close"
            color="charcoal.400"
            _hover={{ color: "charcoal.600" }}
            p={1}
            flexShrink={0}
          >
            <X size={18} />
          </chakra.button>
        </Flex>
        <VStack align="stretch" gap={0.5}>
          {meetingLabel && (
            <Text fontSize="xs" color="charcoal.400">
              {meetingLabel}
            </Text>
          )}
          {teacherName && (
            <Text fontSize="xs" color="charcoal.400">
              Taught by {teacherName}
            </Text>
          )}
          {unplacedCount > 0 && (
            <Text fontSize="xs" color="orange.600" mt={0.5}>
              {unplacedCount} meeting{unplacedCount === 1 ? "" : "s"} unplaced — give it a day
            </Text>
          )}
        </VStack>
      </Flex>

      <VStack align="stretch" gap={5} px={5} py={5} flex={1} overflowY="auto">
        {/* 2 · Past meetings — the recent few, each with the shared "Did this
            activity happen?" dialog inline. There is no cheap class-level
            "answered" signal on the row (Yes writes activityCompletions, No
            re-flows — neither stamps the placement), so the dialog shows for
            every recent past meeting until answered THIS session, after which a
            quiet one-line acknowledgment replaces it (local, resets on close).
            It's idempotent + reversible (§7). */}
        {spine.pastTotal > 0 && (
          <Box>
            <SectionEyebrow count={spine.pastTotal}>Recent meetings</SectionEyebrow>
            {spine.pastTotal > spine.past.length && (
              <Text fontSize="xs" color="charcoal.400" mt={1}>
                Showing the last {spine.past.length}.
              </Text>
            )}
            <VStack align="stretch" gap={3} mt={2}>
              {spine.past.map((c) => {
                const pl = placementsById.get(c.placementId);
                const ack = answered[c.placementId];
                return (
                  <VStack key={c.placementId} align="stretch" gap={2}>
                    <MeetingRow chip={c} blockLabel={blockLabel(c.blockId)} muted />
                    {ack ? (
                      <AnsweredLine result={ack} />
                    ) : pl ? (
                      <DidThisHappenSection
                        placement={pl}
                        grid={grid}
                        // Record the answer so the dialog is replaced by a quiet
                        // one-liner for the rest of the session; the reactive
                        // spine also re-derives (a "No" moves the chip to
                        // Upcoming; a "Yes" leaves it where history put it).
                        onDone={(result) =>
                          setAnswered((prev) => ({ ...prev, [c.placementId]: result }))
                        }
                      />
                    ) : null}
                  </VStack>
                );
              })}
            </VStack>
          </Box>
        )}

        {/* 3 · Upcoming meetings — the queue projection. */}
        {spine.upcoming.length > 0 && (
          <Box>
            <SectionEyebrow count={spine.upcoming.length}>Upcoming</SectionEyebrow>
            <VStack align="stretch" gap={2} mt={2}>
              {spine.upcoming.map((c) => (
                <MeetingRow key={c.placementId} chip={c} blockLabel={blockLabel(c.blockId)} />
              ))}
            </VStack>
          </Box>
        )}

        {/* 4 · At this pace / 5 · flow another unit. */}
        {spine.upcoming.length > 0 ? (
          <VStack align="stretch" gap={3}>
            {spine.finishesMs != null && (
              <Text fontSize="sm" fontWeight="700" fontFamily="heading" color="charcoal.600">
                At this pace: finishes {monthDay(spine.finishesMs)}
              </Text>
            )}
            {free && anchorRow && (
              <Button
                size="sm"
                variant="outline"
                fontFamily="heading"
                alignSelf="flex-start"
                onClick={flow}
              >
                <HStack gap={1.5}>
                  <Plus size={14} /> Flow another unit
                </HStack>
              </Button>
            )}
          </VStack>
        ) : (
          <EmptyState
            icon={<CalendarPlus weight="duotone" />}
            title="Nothing queued"
            hint={
              spine.finishesMs != null
                ? `Nothing queued after ${monthDay(spine.finishesMs)} — flow another unit to keep this class going.`
                : "No activities are queued for this class yet — flow a unit onto its meetings."
            }
            cta={
              free && anchorRow
                ? { label: "Flow a unit", icon: <Plus size={14} />, onClick: flow, primary: true }
                : undefined
            }
            outline
          />
        )}
      </VStack>
    </>
  );
}

/** One meeting of the spine — the SAME dated "n of N · title · date" idiom the
 *  flow-palette preview uses (T1). Shared by past + upcoming. Planning facts are
 *  xs minimum (2xs is reserved for genuine fine print); hierarchy is carried by
 *  weight + color, not size. */
function MeetingRow({
  chip,
  blockLabel,
  muted,
}: {
  chip: SpineChip;
  blockLabel: string;
  muted?: boolean;
}) {
  const idx =
    chip.sequenceRank ??
    (chip.sequenceIndex != null ? chip.sequenceIndex + 1 : null);
  const nOfN = idx != null && chip.sequenceLength ? `${idx} of ${chip.sequenceLength}` : null;
  const secondary = [chip.unitTitle, nOfN].filter(Boolean).join(" · ");
  return (
    <HStack justify="space-between" gap={3} align="start" opacity={muted ? 0.85 : 1}>
      <HStack gap={2} minW={0} align="start">
        <Text
          fontSize="xs"
          fontWeight="700"
          color="charcoal.400"
          w="20px"
          flexShrink={0}
          textAlign="right"
          mt={0.5}
        >
          {idx ?? "•"}
        </Text>
        <VStack align="start" gap={0} minW={0}>
          <Text fontSize="xs" fontWeight="600" color="navy.700" lineClamp={1}>
            {chip.activityTitle ?? "—"}
          </Text>
          {secondary && (
            <Text fontSize="xs" color="charcoal.400" lineClamp={1}>
              {secondary}
            </Text>
          )}
        </VStack>
      </HStack>
      <VStack align="end" gap={0} flexShrink={0}>
        <Text fontSize="xs" fontWeight="700" color="charcoal.500">
          {WEEKDAY_SHORT[chip.weekday] ?? ""} {monthDay(chip.dayMs)}
        </Text>
        {blockLabel && (
          <Text fontSize="xs" color="charcoal.400" lineClamp={1} maxW="120px">
            {blockLabel}
          </Text>
        )}
      </VStack>
    </HStack>
  );
}

/** The quiet one-line acknowledgment that replaces the "Did this happen?" dialog
 *  once a past meeting has been answered this session (fix per review). */
function AnsweredLine({ result }: { result: DidThisHappenResult }) {
  const marked = result.kind === "marked";
  return (
    <HStack gap={1.5} px={1} color={marked ? "green.600" : "charcoal.500"}>
      <Text fontSize="xs" fontWeight="700" aria-hidden="true" lineHeight={1}>
        {marked ? "✓" : "→"}
      </Text>
      <Text fontSize="xs" color="charcoal.500">
        {marked
          ? `Marked done for ${result.count} scholar${result.count === 1 ? "" : "s"}`
          : "Pushed the rest one meeting"}
      </Text>
    </HStack>
  );
}
