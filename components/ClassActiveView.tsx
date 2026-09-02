"use client";

/**
 * ClassActiveView — the Assignments > Class sub-tab.
 *
 * Post-refactor (per-activity scheduling): shows every Assignment with
 * any currently-active push as a card with its active activities.
 * Each activity row carries a Clear control + a click-through to its
 * Run page for deeper edits. Empty state = "no class assignment
 * running"; Start launches the dialog (which goes to the new Run
 * page after create).
 *
 * No more "Start different" — multiple Assignments can be active
 * simultaneously for different scholar groups. No more "End focus" at
 * the Assignment level — clearing is per-activity now.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import {
  Box,
  Button,
  Flex,
  IconButton,
  Spinner,
  Stack,
  Text,
} from "@chakra-ui/react";
import { Lectern, Plus, X, ArrowSquareOut } from "@phosphor-icons/react";
import { ActivityModeBadge } from "@/lib/activityMode";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { StartAssignmentDialog } from "@/components/StartAssignmentDialog";
import { RoomCueControl } from "@/components/RoomCueControl";
import { SectionEyebrow } from "@/components/ui/SectionEyebrow";
import { Surface } from "@/components/ui/Surface";
import { toaster } from "@/lib/toaster";
import { dueStatus } from "@/shared/institutionDay";
import { isClassFocusRunningLong } from "@/shared/roomTurn";
import {
  ScholarsStillWorkingNotice,
  nextTurnedMap,
  type TurnedPush,
} from "@/components/ScholarsStillWorkingNotice";

type PushRow = NonNullable<
  ReturnType<typeof useQuery<typeof api.assignments.activePushesForTeacher>>
>[number];

// "The turn, not the bell" (item 4): tracks class-focus pushes that
// disappeared from the live list since the last render — the room turned
// (auto-cleared or a teacher's "Wrap now"). Remembered briefly (via the
// shared nextTurnedMap) so the "still finishing their thought" awareness can
// attach to it even after its own group vanishes from the live pushes list.
function useRecentlyTurnedClassFocus(pushes: PushRow[]): TurnedPush[] {
  const prevRef = useRef<Map<string, PushRow>>(new Map());
  const [turned, setTurned] = useState<Map<string, TurnedPush & { turnedAt: number }>>(
    new Map(),
  );

  useEffect(() => {
    const current = new Map(
      pushes
        .filter((p) => p.mode === "classFocus")
        .map((p): [string, PushRow] => [`${p.assignmentId}::${p.activityId}`, p]),
    );
    setTurned((prev) => nextTurnedMap(prev, prevRef.current, current, Date.now()));
    prevRef.current = current;
  }, [pushes]);

  return Array.from(turned.values()).sort((a, b) => b.turnedAt - a.turnedAt);
}

export function ClassActiveView() {
  const pushes = useQuery(api.assignments.activePushesForTeacher, {});
  const clearActivity = useMutation(api.assignments.clearActivity);
  const pushActivity = useMutation(api.assignments.pushActivity);
  const [startOpen, setStartOpen] = useState(false);
  // A calm 30s tick — just enough to keep the "running long" tag honest as
  // time passes, never a per-second countdown (teacher-only awareness).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const recentlyTurned = useRecentlyTurnedClassFocus(pushes ?? []);

  if (pushes === undefined) {
    return (
      <Flex justify="center" py={12}>
        <Spinner color="violet.500" />
      </Flex>
    );
  }

  if (pushes.length === 0 && recentlyTurned.length === 0) {
    return (
      <>
        <RoomCueHeader />
        <Box px={6} py={4}>
          <EmptyClassState onStart={() => setStartOpen(true)} />
        </Box>
        <StartAssignmentDialog
          open={startOpen}
          onClose={() => setStartOpen(false)}
          initialMode="unit"
        />
      </>
    );
  }

  // Group pushes by assignmentId so the UI reads as "Aviation 101 cohort
  // is currently doing X, Y" rather than a flat list.
  const byAssignment = new Map<
    string,
    {
      unitTitle: string;
      unitEmoji: string | null;
      assignmentId: Id<"assignments">;
      scholarCount: number;
      pushes: PushRow[];
    }
  >();
  for (const p of pushes) {
    const key = String(p.assignmentId);
    if (!byAssignment.has(key)) {
      byAssignment.set(key, {
        unitTitle: p.unitTitle,
        unitEmoji: p.unitEmoji,
        assignmentId: p.assignmentId,
        scholarCount: p.scholarCount,
        pushes: [],
      });
    }
    byAssignment.get(key)!.pushes.push(p);
  }

  return (
    <>
      <RoomCueHeader />
      <Stack gap={4} px={6} py={4}>
        {Array.from(byAssignment.values()).map((group) => (
          <Surface key={String(group.assignmentId)} p={4}>
            <Flex align="center" gap={3} mb={3}>
              <Box fontSize="xl">{group.unitEmoji ?? "📋"}</Box>
              <Stack gap={0} flex={1} minW={0}>
                <Link href={`/teacher/schedule/${group.assignmentId}`}>
                  <Text
                    fontFamily="heading"
                    fontWeight="700"
                    fontSize="md"
                    color="navy.500"
                    _hover={{ color: "violet.500" }}
                    cursor="pointer"
                  >
                    {group.unitTitle}
                  </Text>
                </Link>
                <Text fontSize="xs" color="charcoal.400" fontFamily="heading">
                  {group.scholarCount} scholar
                  {group.scholarCount === 1 ? "" : "s"} ·{" "}
                  {group.pushes.length} active push
                  {group.pushes.length === 1 ? "" : "es"}
                </Text>
              </Stack>
              <Link href={`/teacher/schedule/${group.assignmentId}`}>
                <Button size="xs" variant="outline" color="charcoal.500">
                  <ArrowSquareOut size={12} style={{ marginRight: 4 }} />
                  Open
                </Button>
              </Link>
            </Flex>
            <Stack gap={1.5}>
              {group.pushes.map((p) => (
                <Flex
                  key={`${p.assignmentId}-${p.activityId}`}
                  align="center"
                  gap={3}
                  p={2.5}
                  bg="white"
                  borderWidth="1px"
                  borderColor="gray.200"
                  borderRadius="md"
                >
                  <ActivityModeBadge mode={p.mode} />
                  <Stack gap={0} flex={1} minW={0}>
                    <Flex align="center" gap={1.5}>
                      <Text
                        fontFamily="heading"
                        fontWeight="600"
                        color="navy.500"
                        fontSize="sm"
                      >
                        {p.activityTitle}
                      </Text>
                      {p.mode === "classFocus" &&
                        isClassFocusRunningLong(now, p.setAt, p.endsAt) && (
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
                          >
                            running long
                          </Box>
                        )}
                    </Flex>
                    {p.lessonTitle && (
                      <Text
                        fontSize="2xs"
                        color="charcoal.400"
                        fontFamily="heading"
                      >
                        {p.lessonTitle}
                        {p.dueAt
                          ? ` · ${dueStatus(p.dueAt, Date.now(), p.timeZone)?.phrase ?? ""}`
                          : p.endsAt
                            ? ` · ${formatRemaining(p.endsAt)} left`
                            : ""}
                      </Text>
                    )}
                  </Stack>
                  {p.mode === "classFocus" ? (
                    <Flex gap={1.5} flexShrink={0}>
                      <Button
                        size="2xs"
                        variant="outline"
                        color="violet.600"
                        borderColor="violet.200"
                        onClick={async () => {
                          await pushActivity({
                            assignmentId: p.assignmentId,
                            activityId: p.activityId,
                            mode: "classFocus",
                            endsAt: (p.endsAt ?? Date.now()) + 10 * 60_000,
                          });
                          toaster.success({ title: "Extended 10 minutes" });
                        }}
                      >
                        Extend +10
                      </Button>
                      <Button
                        size="2xs"
                        variant="outline"
                        color="charcoal.500"
                        onClick={async () => {
                          // "Wrap now" just lifts the lock — clearActivity is
                          // the clean, immediate version of "endsAt = now"
                          // (unlike re-driving pushActivity with a past
                          // endsAt, this never leaves an inert stale entry
                          // sitting in activitySchedule forever). The
                          // scholar-side choice (item 3) then applies exactly
                          // as it would for a natural auto-clear.
                          await clearActivity({
                            assignmentId: p.assignmentId,
                            activityId: p.activityId,
                          });
                          toaster.success({ title: "Wrapped — room moved on" });
                        }}
                      >
                        Wrap now
                      </Button>
                    </Flex>
                  ) : (
                    <IconButton
                      aria-label="Clear push"
                      size="xs"
                      variant="ghost"
                      color="charcoal.400"
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
                </Flex>
              ))}
            </Stack>
          </Surface>
        ))}
        {recentlyTurned.length > 0 && (
          <Stack gap={1.5}>
            {recentlyTurned.map((t) => (
              <ScholarsStillWorkingNotice
                key={`${t.assignmentId}-${t.activityId}`}
                turned={t}
              />
            ))}
          </Stack>
        )}
      </Stack>
      <StartAssignmentDialog
        open={startOpen}
        onClose={() => setStartOpen(false)}
        initialMode="unit"
      />
    </>
  );
}

// The "Room" control's header row — a teacher's cue is orthogonal to any
// specific assignment/push, so it renders above BOTH the empty state and the
// populated list, never nested inside a per-assignment card.
function RoomCueHeader() {
  return (
    <Flex justify="flex-end" px={6} pt={4}>
      <RoomCueControl />
    </Flex>
  );
}

function EmptyClassState({ onStart }: { onStart: () => void }) {
  return (
    <Flex direction="column" align="center" justify="center" py={20} gap={3}>
      <Box color="violet.300">
        <Lectern size={48} />
      </Box>
      <Text fontFamily="heading" fontWeight="700" fontSize="xl" color="navy.500">
        No class assignment running
      </Text>
      <Text
        fontSize="sm"
        color="charcoal.400"
        fontFamily="body"
        textAlign="center"
        maxW="400px"
      >
        Assign a unit to your scholars and push activities as class focus or
        homework. Multiple cohorts can have different pushes active at once.
      </Text>
      <Button
        bg="violet.500"
        color="white"
        _hover={{ bg: "violet.600" }}
        onClick={onStart}
        mt={2}
        fontFamily="heading"
        fontWeight="600"
        size="sm"
      >
        <Plus size={14} style={{ marginRight: 6 }} />
        Assign a unit
      </Button>
    </Flex>
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

// Re-export for any old consumers that imported the eyebrow helpers
// (no longer used in this file; kept here so external imports don't
// break — can be cleaned up in a follow-up).
export { SectionEyebrow };
