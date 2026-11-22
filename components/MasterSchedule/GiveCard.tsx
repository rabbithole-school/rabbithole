"use client";

/**
 * A give on the teacher Master Schedule (TRA-582): work given to a class on a
 * day, drawn from `masterSchedule.grid`'s `gives`. Same chip as every other
 * card on the grid (PlacementChip); a click opens the assignment's Run page
 * when the give came from unit work. Ad hoc gives (an app, a link) have no
 * page to open and are display-only.
 */
import { Box, HStack, Text, VStack, chakra } from "@chakra-ui/react";
import { ArrowRight } from "@phosphor-icons/react";
import { useDndContext, useDraggable, useDroppable } from "@dnd-kit/core";
import Link from "next/link";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import { PlacementChip, type Lens } from "@/components/MasterSchedule/PlacementChip";

export type GridGive = NonNullable<
  FunctionReturnType<typeof api.masterSchedule.grid>
>["gives"][number];

export type GridClassMeeting = NonNullable<
  FunctionReturnType<typeof api.masterSchedule.grid>
>["classMeetings"][number];

/** What a dragged give card carries (onDragEnd and the drop targets read it). */
export type GiveDragData = { kind: "gridGive"; give: GridGive };

/** The give being dragged, if the active drag is a give card. */
export function activeGive(data: unknown): GridGive | null {
  const d = data as Partial<GiveDragData> | undefined;
  return d?.kind === "gridGive" && d.give ? d.give : null;
}

/** The lens mark for a give's card: its group's emoji, or a neutral mark
 *  when one card stands for a give to several groups (the teacher lens). */
export function giveGroupMark(
  give: GridGive & { groupCount?: number },
  groupEmojiById: Map<string, string | null>,
): string | null {
  return (give.groupCount ?? 1) > 1 ? "👥" : (groupEmojiById.get(String(give.groupId)) ?? null);
}

/** Whether a give belongs on the grid's current lens. */
export function giveInLens(give: GridGive, lens: Lens, key: string | null): boolean {
  return lens === "group"
    ? String(give.groupId) === key
    : String(give.teacherId) === key;
}

export function GiveCard({
  give,
  lens,
  groupEmoji,
  separated = false,
  fill = false,
  draggable = false,
  isJustDragged,
  inClassCell = false,
}: {
  give: GridGive;
  lens: Lens;
  groupEmoji?: string | null;
  /** A planned unit give of the viewer's own: drag it to another of the
   *  group's classes, the All day row or the Homework due row. */
  draggable?: boolean;
  /** True right after a drag, so its trailing click doesn't open the link. */
  isJustDragged?: () => boolean;
  /** Draw a hairline above it (a later row inside one class cell). */
  separated?: boolean;
  /** Inside a filled class cell, the cell is the card: drop the chip's own
   *  chrome but keep its status pip. */
  fill?: boolean;
  /** Drawn inside its class's meeting cell, which already names the class. */
  inClassCell?: boolean;
}) {
  const chip = (
    <PlacementChip
      p={give}
      lens={lens}
      groupEmoji={groupEmoji}
      fill={fill}
      // A class cell already names the class. In the All day row and Other
      // times strip, a give that still belongs to a class (one whose meeting
      // moved, or an archived class) names it; unlinked gives have none. So
      // does work drawn in ANOTHER class's cell (scheduled into that slot,
      // filed under its own subject's class: TRA-725).
      suppressSubjectEyebrow={
        (inClassCell && give.slotClassId == null) || give.classId == null
      }
    />
  );
  // Pointer drag only (the grid wires a PointerSensor), so the card takes no
  // dnd-kit keyboard attributes: its link stays the keyboard path.
  const { listeners, setNodeRef, isDragging } = useDraggable({
    id: `grid-give:${give.key}`,
    data: { kind: "gridGive", give } satisfies GiveDragData,
    disabled: !draggable,
  });
  return (
    <Box
      ref={draggable ? setNodeRef : undefined}
      {...(draggable ? listeners : {})}
      opacity={isDragging ? 0.4 : 1}
      cursor={draggable ? (isDragging ? "grabbing" : "grab") : undefined}
      touchAction={draggable ? "none" : undefined}
      borderTopWidth={separated ? "1px" : "0"}
      borderTopColor="gray.100"
      onClick={(e) => e.stopPropagation()}
    >
      {give.assignmentId ? (
        <Link
          href={`/teacher/schedule/${give.assignmentId}`}
          aria-label={`Open ${give.activityTitle}`}
          draggable={false}
          style={draggable ? { cursor: "inherit" } : undefined}
          onDragStart={(event) => event.preventDefault()}
          onClick={(event) => {
            if (isJustDragged?.()) event.preventDefault();
          }}
        >
          {chip}
        </Link>
      ) : (
        chip
      )}
    </Box>
  );
}

/** One day's cell in the All day row or the Other times strip. With
 *  `dropDayKey`, the cell takes a dragged give (the All day row, on a day
 *  that hasn't started). */
export function GiveStripCell({
  gives,
  lens,
  groupEmojiById,
  dropId,
  dropDayKey,
  canDragGive,
  isJustDragged,
}: {
  gives: readonly GridGive[];
  lens: Lens;
  groupEmojiById: Map<string, string | null>;
  /** Unique per cell (droppable ids must not repeat). */
  dropId: string;
  dropDayKey?: string | null;
  canDragGive?: (give: GridGive) => boolean;
  isJustDragged?: () => boolean;
}) {
  const { active } = useDndContext();
  const dragged = activeGive(active?.data.current);
  const accepts = Boolean(dropDayKey) && dragged != null;
  const { setNodeRef, isOver } = useDroppable({
    id: dropId,
    data: { zone: "allDay", dayKey: dropDayKey },
    disabled: !accepts,
  });
  return (
    <VStack
      ref={setNodeRef}
      align="stretch"
      gap={1}
      p={1}
      minH="40px"
      borderRadius={isOver ? "md" : undefined}
      border={isOver ? "1px solid" : undefined}
      borderBottom={isOver || gives.length === 0 ? "1px solid" : undefined}
      borderColor={isOver ? "violet.400" : "gray.100"}
      bg={isOver ? "violet.50" : undefined}
      opacity={active && !accepts && dropDayKey !== undefined ? 0.45 : undefined}
    >
      {gives.map((give) => (
        <GiveCard
          key={give.key}
          give={give}
          lens={lens}
          groupEmoji={giveGroupMark(give, groupEmojiById)}
          draggable={canDragGive?.(give) ?? false}
          isJustDragged={isJustDragged}
        />
      ))}
    </VStack>
  );
}

/** "Up next" on a class meeting: the unit's next activity this group hasn't
 *  been given. One click gives it to that class on that day. */
export function UpNextButton({
  meeting,
  onGive,
}: {
  meeting: GridClassMeeting;
  onGive: (meeting: GridClassMeeting) => void;
}) {
  const upNext = meeting.upNext!;
  return (
    <chakra.button
      type="button"
      w="full"
      textAlign="left"
      px={1.5}
      py={1}
      borderRadius="sm"
      border="1px dashed"
      borderColor="gray.200"
      bg="transparent"
      cursor="pointer"
      _hover={{ bg: "violet.50", borderColor: "violet.300" }}
      _focusVisible={{ outline: "2px solid", outlineColor: "violet.400" }}
      aria-label={`Give ${upNext.activityTitle} to ${meeting.subject}`}
      title={`Give it to ${meeting.subject} this day`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onGive(meeting);
      }}
    >
      <HStack gap={1} align="center">
        <Text fontSize="2xs" fontWeight="700" color="charcoal.400" flexShrink={0}>
          Up next
        </Text>
        <Text fontSize="xs" color="navy.700" lineClamp={1} flex={1}>
          {upNext.activityTitle}
        </Text>
        <ArrowRight size={12} />
      </HStack>
    </chakra.button>
  );
}

/** The row label for the All day row and the Other times strip. */
export function GiveRowLabel({ title, hint }: { title: string; hint: string }) {
  return (
    <VStack align="start" justify="center" gap={0} px={2} py={2}>
      <Text fontFamily="heading" fontWeight="700" fontSize="sm" color="navy.700" lineClamp={1}>
        {title}
      </Text>
      <Text fontSize="2xs" color="charcoal.300">
        {hint}
      </Text>
    </VStack>
  );
}
