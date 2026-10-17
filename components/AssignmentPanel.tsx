"use client";

/**
 * AssignmentPanel — the right-pane contents for a selected Assignment.
 *
 * Renders the "Run page" (header + status chips + Lessons & activities
 * outline with inline push controls + Roster). Used in two places:
 *  - As the right pane of the list-detail Assignments tab (the canonical
 *    permalink is `/teacher/schedule/<id>` — a selection in that tab).
 *  - Embedded wherever a single Assignment's Run page is shown.
 *
 * Pass `embedded` to drop the top "← Assignments" back link (the
 * list-detail layout already shows the list, no back arrow needed).
 */

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { ActivityKind } from "@/lib/activityKinds";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import {
  Badge,
  Box,
  Button,
  Flex,
  HStack,
  Popover,
  Portal,
  Spinner,
  Stack,
  Tabs,
  Text,
  chakra,
} from "@chakra-ui/react";
import { Avatar } from "@/components/Avatar";
import {
  ArrowLeft,
  Check,
  Clock,
  Download,
  ArrowSquareOut,
  Play,
  ArrowClockwise,
  WarningCircle,
} from "@phosphor-icons/react";
import { ActivityModeBadge, ActivityModeIcon } from "@/lib/activityMode";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { formatCaptureDuration } from "@/shared/captureMedia";
import { PageHeader } from "@/components/ui/PageHeader";
import { Surface } from "@/components/ui/Surface";
import { SectionEyebrow } from "@/components/ui/SectionEyebrow";
import { PaneTabs } from "@/components/ui/PaneTabs";
import { ActivityKindIcon } from "@/components/ActivityKindIcon";
import { ScholarFacepile } from "@/components/ScholarFacepile";
import { ClassDigestInline } from "@/components/ClassDigestInline";
import { SimulatorAssignControls } from "@/components/simulatorTeacher/SimulatorAssignControls";
import { ClassDigestView } from "@/components/ClassDigestView";
import { GranuleCoverageGrid } from "@/components/GranuleCoverageGrid";
import { DeliverableGradeControl } from "@/components/DeliverableGradeControl";
import { TutorTranscriptionChip } from "@/components/TutorTranscriptionChip";
import { AssessScanButton } from "@/components/AssessScanButton";
import {
  AssignmentRunSkeleton,
  ActivityProgressSkeleton,
} from "@/components/skeletons/PanelSkeletons";
import { formatRelative } from "@/lib/relativeTime";
import { toaster } from "@/lib/toaster";
import {
  formatRoomTurnTime,
  isClassFocusRunningLong,
} from "@/shared/roomTurn";
import { plannedReleaseArgs } from "@/shared/plannedRelease";
import {
  DEFAULT_TIMEZONE,
  dayStartForDayKey,
  dueStatus,
  shiftDayKey,
} from "@/shared/institutionDay";
import {
  ScholarsStillWorkingNotice,
  nextTurnedMap,
  type TurnedPush,
} from "@/components/ScholarsStillWorkingNotice";
import { ScheduleActivityDialog } from "@/components/ScheduleActivityDialog";
import { DeliverableWorkActions } from "@/components/DeliverableWorkActions";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { isTeacherRole } from "@/convex/lib/roles";

/**
 * Whether this viewer reads the cohort's LEARNING RECORD here — the class
 * digests, understanding grid, practice mastery, share-back synthesis,
 * grading, family sharing and transcript links. Teachers do. A curriculum:run
 * holder (base staff running a unit she built) does not: her Run page is the
 * schedule, completion, and what scholars handed in — nothing more.
 */
function useReadsLearningRecord(): boolean {
  const { user } = useCurrentUser();
  return !!user && isTeacherRole(user.role);
}

export function AssignmentPanel({
  assignmentId,
  embedded = false,
}: {
  assignmentId: Id<"assignments">;
  /** When true, drops the "← Assignments" back link (list-detail
   *  already shows the list). Default: false (standalone /teacher/
   *  assignment/[id] route). */
  embedded?: boolean;
}) {
  const data = useQuery(api.assignments.get, { assignmentId });

  if (data === undefined) {
    return <AssignmentRunSkeleton embedded={embedded} />;
  }
  if (data === null) {
    return (
      <Stack gap={3} align="center" py={20}>
        <Text fontFamily="heading" fontWeight="700" color="navy.500">
          Assignment not found
        </Text>
        <Text fontSize="sm" color="charcoal.400">
          It may have been archived or you don&apos;t have access.
        </Text>
        <Link href="/teacher/schedule">
          <Button size="sm" variant="outline">
            ← Back to Schedule
          </Button>
        </Link>
      </Stack>
    );
  }

  return (
    <AssignmentPageBody
      assignmentId={assignmentId}
      data={data}
      embedded={embedded}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────

type AssignmentData = NonNullable<
  ReturnType<typeof useQuery<typeof api.assignments.get>>
>;
type HomeworkDueDateOptions = NonNullable<
  ReturnType<typeof useQuery<typeof api.assignments.homeworkDueDateOptions>>
>;
/** One activity's schedule entry, shaped by the query — never re-declared
 *  here, so the `planned` flag can't drift away from the server's. */
type ActivityScheduleRow = NonNullable<
  NonNullable<
    ReturnType<typeof useQuery<typeof api.assignments.activityProgress>>
  >["lessons"][number]["activities"][number]["schedule"]
>;

function minuteRoundedNow(): number {
  return Math.floor(Date.now() / 60_000) * 60_000;
}

function AssignmentPageBody({
  assignmentId,
  data,
  embedded,
}: {
  assignmentId: Id<"assignments">;
  data: AssignmentData;
  embedded?: boolean;
}) {
  const router = useRouter();
  const progress = useQuery(api.assignments.activityProgress, {
    assignmentId,
  });
  const [dueOptionsNowMs, setDueOptionsNowMs] = useState(minuteRoundedNow);
  useEffect(() => {
    const timer = setInterval(
      () => setDueOptionsNowMs(minuteRoundedNow()),
      60_000,
    );
    return () => clearInterval(timer);
  }, []);
  const dueDateOptions = useQuery(api.assignments.homeworkDueDateOptions, {
    assignmentId,
    nowMs: dueOptionsNowMs,
  });
  // World cohorts get live classroom controls in the header (plan §8 Assign).
  // Detected from the already-loaded activity progress (no separate query) —
  // its lessons carry each activity's kind.
  const hasWorld = (progress?.lessons ?? []).some((lesson) =>
    lesson.activities.some((activity) => activity.kind === "simulator"),
  );
  // Understanding tab only renders when the unit has EQs/EUs to track.
  const readsLearningRecord = useReadsLearningRecord();
  const coverage = useQuery(
    api.granuleEvidence.coverageForAssignment,
    readsLearningRecord ? { assignmentId } : "skip",
  );
  const hasGranules =
    readsLearningRecord && (coverage?.granules.length ?? 0) > 0;
  const archive = useMutation(api.assignments.archive);
  const pushActivity = useMutation(api.assignments.pushActivity);
  const [starting, setStarting] = useState(false);

  const classFocusCount = data.classFocusCount;
  const homeworkCount = data.homeworkCount;
  // The eyebrow asks a PARTITION question ("sent, or still planned?"), so it
  // reads `sentCount`, not the chip counts below it. Those two disagree for
  // an overrun-but-unwrapped class focus: it drops out of the chips (its
  // window closed) while its row still says "running long".
  const sentCount = data.sentCount;
  const plannedCount = data.plannedCount;
  const isArchived = !!data.archivedAt;

  const onArchive = async () => {
    await archive({ assignmentId });
    toaster.success({ title: "Assignment archived" });
    if (!embedded) router.push("/teacher/schedule");
  };

  // A queued ad-hoc dispatch is a unit-less assignment whose only schedule
  // entry is still PLANNED (setAt null) — staged, but invisible to the
  // scholar until released. The unit-less Run outline can't surface the
  // usual per-activity push controls (no lessons to roll up), so offer a
  // one-click release here that stamps `setAt` via the existing
  // `pushActivity`, rather than forcing the teacher to recreate the task.
  const plannedEntry =
    !isArchived && data.unitId == null
      ? (data.activitySchedule.find((e) => e.setAt == null) ?? null)
      : null;

  const onStartNow = async () => {
    if (!plannedEntry) return;
    setStarting(true);
    try {
      const releaseArgs = plannedReleaseArgs(
        {
          mode: plannedEntry.mode,
          endsAt: plannedEntry.endsAt ?? null,
          dueAt: plannedEntry.dueAt ?? null,
          scholarIds: plannedEntry.scholarIds ?? null,
        },
        Date.now(),
      );
      await pushActivity({
        assignmentId,
        activityId: plannedEntry.activityId,
        ...releaseArgs,
      });
      toaster.success({
        title: startedToastTitle(
          plannedEntry.mode,
          releaseArgs.endsAt,
          data.timeZone,
        ),
      });
    } catch (error) {
      toaster.error({
        title: "Couldn't start that activity",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setStarting(false);
    }
  };

  return (
    <Box
      maxW={embedded ? "none" : "1200px"}
      mx={embedded ? 0 : "auto"}
      px={embedded ? 5 : 6}
      py={embedded ? 5 : 6}
    >
      {/* Back affordance — only when standalone */}
      {!embedded && (
        <Box mb={4}>
          <Link href="/teacher/schedule">
            <Button size="xs" variant="ghost" color="charcoal.500">
              <ArrowLeft size={12} style={{ marginRight: 4 }} />
              Schedule
            </Button>
          </Link>
        </Box>
      )}

      {/* Header */}
      <Surface p={5} mb={5}>
        <PageHeader
          leading={data.unitEmoji ?? "📋"}
          eyebrow={
            isArchived
              ? "Archived assignment"
              : assignmentEyebrow(sentCount, plannedCount)
          }
          title={data.title || data.unitTitle || "Assignment"}
          subtitle={
            <Stack gap={1} mt={1}>
              <HStack gap={3} flexWrap="wrap">
                <ScholarFacepile
                  scholars={data.roster.map((s) => ({
                    _id: String(s.scholarId),
                    name: s.name,
                    image: s.image,
                    username: s.username,
                  }))}
                  total={data.scholarIds.length}
                  size="sm"
                  max={5}
                  showCountFallback
                />
                <HStack gap={1} color="charcoal.500">
                  <Clock size={12} />
                  <Text fontSize="xs" fontFamily="heading">
                    Started {formatRelative(data.startedAt)}
                  </Text>
                </HStack>
                {classFocusCount > 0 && (
                  <Badge bg="violet.100" color="violet.700">
                    {classFocusCount} class focus
                    {classFocusCount === 1 ? "" : "es"}
                  </Badge>
                )}
                {homeworkCount > 0 && (
                  <Badge bg="orange.100" color="orange.700">
                    {homeworkCount} homework
                  </Badge>
                )}
                {isArchived && (
                  <Badge bg="gray.200" color="charcoal.500">
                    Archived
                  </Badge>
                )}
              </HStack>
              {data.unitDescription && (
                <Text fontSize="sm" color="charcoal.400" mt={1}>
                  {data.unitDescription}
                </Text>
              )}
            </Stack>
          }
          rightSlot={
            !isArchived ? (
              <HStack gap={2}>
                {plannedEntry && (
                  <Button
                    size="sm"
                    colorPalette="violet"
                    fontFamily="heading"
                    onClick={() => void onStartNow()}
                    loading={starting}
                  >
                    <Play size={14} weight="fill" style={{ marginRight: 4 }} />
                    Start now
                  </Button>
                )}
                {readsLearningRecord && (
                  <Button
                    size="sm"
                    variant="ghost"
                    color="charcoal.400"
                    fontFamily="heading"
                    onClick={onArchive}
                  >
                    Archive
                  </Button>
                )}
              </HStack>
            ) : null
          }
        />

        {/* Cohort "today's read" — folded into the header as a quiet
            hairline-separated line (not a standalone banner). The DRY twin
            of the per-activity digest; auto-generates, full view a click
            away. */}
        {!isArchived && readsLearningRecord && (
          <Box mt={4} pt={4} borderTopWidth="1px" borderColor="gray.100">
            <ClassDigestInline scope="cohort" assignmentId={assignmentId} />
          </Box>
        )}
        {!isArchived && hasWorld && readsLearningRecord && (
          <Box mt={4} pt={4} borderTopWidth="1px" borderColor="gray.100">
            <SimulatorAssignControls assignmentId={assignmentId} />
          </Box>
        )}
      </Surface>

      {/* Two columns: Roster | Outline */}
      <PaneTabs
        defaultValue="outline"
        items={[
          { value: "outline", label: "Lessons & activities" },
          { value: "roster", label: `Roster (${data.roster.length})` },
          ...(!isArchived && readsLearningRecord
            ? [{ value: "debrief", label: "Debrief" }]
            : []),
          ...(hasGranules ? [{ value: "understanding", label: "Understanding" }] : []),
        ]}
      >
        <Tabs.Content value="outline" pt={4}>
          <OutlineSection
            assignmentId={assignmentId}
            rosterSize={data.scholarIds.length}
            progress={progress ?? null}
            roster={data.roster.map((s) => ({ scholarId: s.scholarId, name: s.name }))}
            timeZone={data.timeZone}
            dueDateOptions={dueDateOptions ?? null}
          />
        </Tabs.Content>
        <Tabs.Content value="roster" pt={4}>
          <RosterSection roster={data.roster} unitTitle={data.unitTitle} />
        </Tabs.Content>
        {!isArchived && readsLearningRecord && (
          <Tabs.Content value="debrief" pt={2}>
            {/* Per-run, act-now read for THIS cohort — named scholars, log
                observations / plant seeds / spin up a Share-Back. The
                cohort-agnostic design read (improve the activity for next
                time) lives one click away in Curriculum — but an ad-hoc
                dispatch has no unit to open, so hide the link for those. */}
            {data.unitId && (
              <Flex justify="flex-end" px={6} pt={2}>
                <Link href={`/teacher/curriculum/${data.unitId}/debrief`}>
                  <Button
                    size="xs"
                    variant="ghost"
                    color="violet.600"
                    fontFamily="heading"
                  >
                    Improve the design in Curriculum
                    <ArrowSquareOut size={12} style={{ marginLeft: 4 }} />
                  </Button>
                </Link>
              </Flex>
            )}
            <ClassDigestView scope="cohort" assignmentId={assignmentId} />
          </Tabs.Content>
        )}
        {hasGranules && (
          <Tabs.Content value="understanding" pt={4}>
            <GranuleCoverageGrid assignmentId={assignmentId} />
          </Tabs.Content>
        )}
      </PaneTabs>
    </Box>
  );
}

// ─── Roster ─────────────────────────────────────────────────────────

function RosterSection({
  roster,
  unitTitle,
}: {
  roster: AssignmentData["roster"];
  unitTitle: string | null;
}) {
  return (
    <Stack gap={2}>
      {roster.length === 0 ? (
        <Text fontSize="sm" color="charcoal.400" py={6} textAlign="center">
          No scholars on this assignment yet.
        </Text>
      ) : (
        roster.map((s) => (
          <Surface key={String(s.scholarId)} p={3}>
            <HStack gap={3} align="center">
              <Avatar
                size="sm"
                name={s.name || undefined}
                src={s.image || undefined}
                colorKey={String(s.scholarId)}
              />
              <Stack gap={0} flex={1} minW={0}>
                <Text
                  fontFamily="heading"
                  fontWeight="600"
                  color="navy.500"
                  fontSize="sm"
                >
                  {s.name}
                </Text>
                <Text fontSize="2xs" color="charcoal.400" fontFamily="heading">
                  {s.sessionId ? (
                    <>
                      Session started{" "}
                      {s.sessionStartedAt ? formatRelative(s.sessionStartedAt) : "—"}
                      {s.lastMessageAt
                        ? ` · last activity ${formatRelative(s.lastMessageAt)}`
                        : ""}
                    </>
                  ) : (
                    "Hasn't started yet"
                  )}
                </Text>
                {s.lastMessagePreview && (
                  <Text
                    fontSize="2xs"
                    color="charcoal.400"
                    fontStyle="italic"
                    overflow="hidden"
                    textOverflow="ellipsis"
                    whiteSpace="nowrap"
                    mt={0.5}
                  >
                    {s.lastMessagePreview}
                  </Text>
                )}
              </Stack>
              <Badge
                bg={s.completedActivityCount > 0 ? "green.100" : "gray.100"}
                color={
                  s.completedActivityCount > 0 ? "green.700" : "charcoal.500"
                }
                fontFamily="heading"
              >
                {s.completedActivityCount} done
              </Badge>
              {s.sessionId && (
                <Link href={`/scholar/${s.sessionId}`}>
                  <Button size="xs" variant="ghost" color="violet.500">
                    <ArrowSquareOut size={12} />
                  </Button>
                </Link>
              )}
            </HStack>
          </Surface>
        ))
      )}
      {unitTitle && (
        <Text fontSize="2xs" color="charcoal.300" mt={3} textAlign="center">
          All scholars are working on {unitTitle} under this assignment.
        </Text>
      )}
    </Stack>
  );
}

// ─── Outline (lessons + activities) ─────────────────────────────────

function OutlineSection({
  assignmentId,
  rosterSize,
  progress,
  roster,
  timeZone,
  dueDateOptions,
}: {
  assignmentId: Id<"assignments">;
  rosterSize: number;
  progress: NonNullable<
    ReturnType<typeof useQuery<typeof api.assignments.activityProgress>>
  > | null;
  roster: { scholarId: Id<"users">; name: string }[];
  timeZone: string | null;
  dueDateOptions: HomeworkDueDateOptions | null;
}) {
  // "The turn, not the bell" (item 4): recently-turned class-focus pushes
  // within THIS assignment, for the lingering-awareness cards below. Called
  // unconditionally (before the early returns) — the rules of hooks.
  // Memoized on `progress` (Convex hands back a stable reference when the
  // data hasn't changed) — recomputing a fresh array on every render would
  // otherwise re-fire the tracking effect below every render forever (a new
  // Map reference each time → state "changes" → re-render → repeat).
  const liveClassFocusActivities = useMemo(
    () =>
      (progress?.lessons ?? []).flatMap((l) =>
        l.activities
          .filter((a) => a.schedule?.mode === "classFocus" && !a.schedule.planned)
          .map((a) => ({
            assignmentId,
            activityId: a.activityId,
            activityTitle: a.title,
          })),
      ),
    [progress, assignmentId],
  );
  const recentlyTurned = useRecentlyTurnedActivities(liveClassFocusActivities);
  // Everything on the schedule that hasn't reached a scholar yet. The rows
  // below each say "planned"; this line says what that COSTS — nobody can start
  // it yet — and releases the lot, which no single row can do.
  const plannedActivities = useMemo(
    () =>
      (progress?.lessons ?? []).flatMap((l) =>
        l.activities.flatMap((a) =>
          a.schedule?.planned
            ? [{ activityId: a.activityId, schedule: a.schedule }]
            : [],
        ),
      ),
    [progress],
  );

  if (!progress) {
    return <ActivityProgressSkeleton groups={2} />;
  }
  if (progress.lessons.length === 0 && progress.adHocActivities.length > 0) {
    // An ad-hoc dispatch has no lessons; its schedule is the outline, so the
    // teacher can see (and undo) who finished it on the same Done line.
    return (
      <Stack gap={2}>
        {progress.adHocActivities.map((a) => (
          <ActivityRow
            key={String(a.activityId)}
            assignmentId={assignmentId}
            activityId={a.activityId}
            title={a.title}
            kind={a.kind}
            defaultMode={a.defaultMode}
            schedule={a.schedule}
            completedCount={a.completedScholarIds.length}
            completedScholarIds={a.completedScholarIds}
            selfMarked={a.selfMarked}
            inProgressCount={a.inProgressCount}
            notStartedCount={a.notStartedCount}
            rosterSize={rosterSize}
            roster={roster}
            timeZone={timeZone}
            dueDateOptions={dueDateOptions}
          />
        ))}
      </Stack>
    );
  }
  if (progress.lessons.length === 0) {
    return (
      <Text fontSize="sm" color="charcoal.400" py={6} textAlign="center">
        This unit has no lessons yet.
      </Text>
    );
  }
  return (
    <Stack gap={4}>
      {plannedActivities.length > 0 && (
        <PlannedWorkLine
          assignmentId={assignmentId}
          planned={plannedActivities}
          timeZone={timeZone}
        />
      )}
      {progress.lessons.map((l) => (
        <Box key={String(l.lessonId)}>
          <SectionEyebrow>{l.lessonTitle}</SectionEyebrow>
          <Stack gap={2} mt={2}>
            {l.activities.map((a) => (
              <ActivityRow
                key={String(a.activityId)}
                assignmentId={assignmentId}
                activityId={a.activityId}
                title={a.title}
                kind={a.kind}
                defaultMode={a.defaultMode}
                schedule={a.schedule}
                completedCount={a.completedScholarIds.length}
                completedScholarIds={a.completedScholarIds}
                selfMarked={a.selfMarked}
                inProgressCount={a.inProgressCount}
                notStartedCount={a.notStartedCount}
                rosterSize={rosterSize}
                roster={roster}
                timeZone={timeZone}
                dueDateOptions={dueDateOptions}
              />
            ))}
          </Stack>
        </Box>
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
  );
}

/**
 * The planned-work line: one calm sentence above the outline whenever the
 * schedule holds work that hasn't reached scholars, plus a single release for
 * the whole set. Deliberately NOT a second badge — the rows already carry the
 * per-activity state; this carries the consequence and the bulk action.
 */
function PlannedWorkLine({
  assignmentId,
  planned,
  timeZone,
}: {
  assignmentId: Id<"assignments">;
  planned: { activityId: Id<"activities">; schedule: ActivityScheduleRow }[];
  timeZone: string | null;
}) {
  const pushActivity = useMutation(api.assignments.pushActivity);
  const [starting, setStarting] = useState(false);

  const onStartAll = async () => {
    setStarting(true);
    try {
      const now = Date.now();
      // Sequential on purpose: every push patches the SAME assignment doc, so
      // firing them together just buys write conflicts and retries.
      for (const entry of planned) {
        const releaseArgs = plannedReleaseArgs(entry.schedule, now);
        await pushActivity({
          assignmentId,
          activityId: entry.activityId,
          ...releaseArgs,
        });
      }
      toaster.success({
        title: `${planned.length} activities are live now`,
        description: bulkStartToastDescription(planned, timeZone, now),
      });
    } catch (error) {
      toaster.error({
        title: "Couldn't start the planned activities",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setStarting(false);
    }
  };

  return (
    <Flex
      align="center"
      gap={3}
      px={3}
      py={2}
      bg="gray.50"
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="lg"
    >
      <WarningCircle size={16} color="var(--chakra-colors-charcoal-400)" />
      <Text fontSize="xs" fontFamily="heading" color="charcoal.600" flex={1}>
        {plannedWorkNotice(planned.length)}
      </Text>
      {planned.length > 1 && (
        <Button
          size="xs"
          bg="violet.500"
          color="white"
          _hover={{ bg: "violet.600" }}
          fontFamily="heading"
          onClick={() => void onStartAll()}
          loading={starting}
        >
          <Play size={11} weight="fill" style={{ marginRight: 3 }} />
          Start them all now
        </Button>
      )}
    </Flex>
  );
}

/** Recently-turned class-focus activities within ONE assignment — see
 *  components/ScholarsStillWorkingNotice.tsx's nextTurnedMap for the shared policy. */
function useRecentlyTurnedActivities(
  live: TurnedPush[],
): TurnedPush[] {
  const prevRef = useRef<Map<string, TurnedPush>>(new Map());
  const [turned, setTurned] = useState<Map<string, TurnedPush & { turnedAt: number }>>(
    new Map(),
  );

  useEffect(() => {
    const current = new Map(
      live.map((t): [string, TurnedPush] => [`${t.assignmentId}::${t.activityId}`, t]),
    );
    setTurned((prev) => nextTurnedMap(prev, prevRef.current, current, Date.now()));
    prevRef.current = current;
  }, [live]);

  return Array.from(turned.values()).sort((a, b) => b.turnedAt - a.turnedAt);
}

export function activityCompletionNames(
  roster: { scholarId: Id<"users">; name: string }[],
  completedScholarIds: string[],
): { done: string[]; notDone: string[] } {
  const completed = new Set(completedScholarIds.map(String));
  return {
    done: roster
      .filter((scholar) => completed.has(String(scholar.scholarId)))
      .map((scholar) => scholar.name),
    notDone: roster
      .filter((scholar) => !completed.has(String(scholar.scholarId)))
      .map((scholar) => scholar.name),
  };
}

function formatDueDate(dueAt: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone,
  })
    .format(new Date(dueAt))
    .replace(",", "");
}

/**
 * The Run page header's eyebrow.
 *
 * Counts SENT (`setAt` stamped) and PLANNED (`setAt` null) separately,
 * because they are different states of the world and conflating them is
 * exactly how a teacher ends up believing tonight's homework went out. The
 * old eyebrow said "nothing pushed yet" above two planned homework rows.
 *
 * These two partition the schedule, so pass the server's `sentCount` — NOT
 * the live chip counts, which answer the narrower "is it holding the class
 * right now?" and would drop an overrun focus out of both halves.
 */
export function assignmentEyebrow(
  sentCount: number,
  plannedCount: number,
): string {
  if (plannedCount === 0) {
    return sentCount === 0 ? "Assignment · nothing sent yet" : "Assignment";
  }
  const planned = `${plannedCount} planned`;
  return sentCount === 0
    ? `Assignment · ${planned}, nothing sent yet`
    : `Assignment · ${sentCount} sent, ${planned}`;
}

/**
 * The one line above the outline when planned work is sitting there. States
 * the consequence the badges can't.
 *
 * "Can't start" and not "can't see": a planned entry DOES surface to the
 * scholar, as a dated, deliberately non-actionable preview in Coming up
 * (`ComingUpCard`). What it never does is reach tonight's actionable list or
 * open — that only happens once release stamps `setAt`. Saying "can't see it"
 * would be a second, wrong story about the same signal.
 */
export function plannedWorkNotice(plannedCount: number): string {
  return plannedCount === 1
    ? "1 activity is planned — scholars can't start it yet."
    : `${plannedCount} activities are planned — scholars can't start them yet.`;
}

export function homeworkDueToastDescription(
  dueAt: number,
  options: { timeZone: string } | null,
): string | undefined {
  return options ? `Due ${formatDueDate(dueAt, options.timeZone)}` : undefined;
}

function classFocusLiveToast(
  endsAt: number | null | undefined,
  timeZone: string | null,
): string {
  if (endsAt == null) return "Live now · fades after today";
  const time = formatRoomTurnTime(endsAt, timeZone ?? DEFAULT_TIMEZONE);
  return time ? `Live now · until ${time}` : "Live now";
}

/** Confirmation for releasing a planned entry — says both that it reached
 * scholars and, for class focus, when it will leave their screen. */
function startedToastTitle(
  mode: "classFocus" | "homework",
  endsAt: number | null | undefined,
  timeZone: string | null,
): string {
  return mode === "homework"
    ? "Sent — scholars can start it now"
    : classFocusLiveToast(endsAt, timeZone);
}

function bulkStartToastDescription(
  planned: { schedule: ActivityScheduleRow }[],
  timeZone: string | null,
  now: number,
): string | undefined {
  const focusLabels = Array.from(
    new Set(
      planned
        .filter((entry) => entry.schedule.mode === "classFocus")
        .map((entry) =>
          classFocusLiveToast(
            plannedReleaseArgs(entry.schedule, now).endsAt,
            timeZone,
          ),
        ),
    ),
  );
  if (focusLabels.length === 0) return undefined;
  return focusLabels.length === 1
    ? focusLabels[0]
    : "Class focuses use their planned lifetimes";
}

function HomeworkDueDatePopover({
  options,
  onConfirm,
}: {
  options: HomeworkDueDateOptions | null;
  onConfirm: (dueAt: number) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<"nextOpen" | "endOfWeek" | "custom">(
    "nextOpen",
  );
  const [customDayKey, setCustomDayKey] = useState("");
  const [saving, setSaving] = useState(false);

  const selectedDueAt = useMemo(() => {
    if (!options) return null;
    if (choice === "nextOpen") return options.nextOpen.dueAt;
    if (choice === "endOfWeek") return options.endOfWeek.dueAt;
    if (!customDayKey) return null;
    return (
      dayStartForDayKey(shiftDayKey(customDayKey, 1), options.timeZone) - 1
    );
  }, [choice, customDayKey, options]);

  const confirm = async () => {
    if (selectedDueAt == null) return;
    setSaving(true);
    try {
      await onConfirm(selectedDueAt);
      setOpen(false);
      setChoice("nextOpen");
      setCustomDayKey("");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(details) => setOpen(details.open)}
      positioning={{ placement: "bottom-end" }}
    >
      <Popover.Trigger asChild>
        <Button
          size="xs"
          variant="ghost"
          color="orange.500"
          _hover={{ bg: "orange.50" }}
          fontFamily="heading"
        >
          Send as homework
        </Button>
      </Popover.Trigger>
      <Portal>
        <Popover.Positioner>
          <Popover.Content
            w="330px"
            maxW="calc(100vw - 24px)"
            bg="white"
            borderColor="gray.200"
            shadow="xl"
            borderRadius="xl"
            onClick={(event) => event.stopPropagation()}
          >
            <Popover.Arrow />
            <Popover.Body p={4}>
              <Stack gap={3}>
                <Text fontFamily="heading" fontWeight="700" color="navy.600">
                  Due when?
                </Text>
                {!options ? (
                  <Flex justify="center" py={4}>
                    <Spinner size="sm" color="orange.500" />
                  </Flex>
                ) : (
                  <>
                    <DueChoice
                      selected={choice === "nextOpen"}
                      onClick={() => setChoice("nextOpen")}
                      label={options.nextOpen.label}
                      detail={formatDueDate(
                        options.nextOpen.dueAt,
                        options.timeZone,
                      )}
                    />
                    <DueChoice
                      selected={choice === "endOfWeek"}
                      onClick={() => setChoice("endOfWeek")}
                      label="End of the week"
                      detail={formatDueDate(
                        options.endOfWeek.dueAt,
                        options.timeZone,
                      )}
                    />
                    <DueChoice
                      selected={choice === "custom"}
                      onClick={() => setChoice("custom")}
                      label="Pick a date…"
                    />
                    {choice === "custom" && (
                      <chakra.input
                        type="date"
                        value={customDayKey}
                        onChange={(event) => setCustomDayKey(event.target.value)}
                        aria-label="Homework due date"
                        px={3}
                        py={2}
                        borderWidth="1px"
                        borderColor="gray.200"
                        borderRadius="md"
                        fontFamily="heading"
                        fontSize="sm"
                      />
                    )}
                    <Button
                      size="sm"
                      bg="orange.500"
                      color="white"
                      _hover={{ bg: "orange.600" }}
                      disabled={selectedDueAt == null || saving}
                      onClick={confirm}
                    >
                      {saving && <Spinner size="xs" />}
                      {selectedDueAt == null
                        ? "Choose a due date"
                        : `Send for ${formatDueDate(
                            selectedDueAt,
                            options.timeZone,
                          )}`}
                    </Button>
                  </>
                )}
              </Stack>
            </Popover.Body>
          </Popover.Content>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  );
}

function DueChoice({
  selected,
  onClick,
  label,
  detail,
}: {
  selected: boolean;
  onClick: () => void;
  label: string;
  detail?: string;
}) {
  return (
    <chakra.button
      type="button"
      display="flex"
      alignItems="center"
      gap={2.5}
      w="full"
      p={2.5}
      textAlign="left"
      borderWidth="1px"
      borderColor={selected ? "orange.300" : "gray.200"}
      borderRadius="md"
      bg={selected ? "orange.50" : "white"}
      _hover={{ bg: selected ? "orange.50" : "gray.50" }}
      onClick={onClick}
    >
      <Box
        w={3}
        h={3}
        borderRadius="full"
        borderWidth="1px"
        borderColor={selected ? "orange.500" : "gray.300"}
        bg={selected ? "orange.500" : "white"}
        flexShrink={0}
      />
      <Text flex={1} fontFamily="heading" fontWeight="600" fontSize="sm">
        {label}
      </Text>
      {detail && (
        <Text fontSize="xs" color="charcoal.400">
          {detail}
        </Text>
      )}
    </chakra.button>
  );
}

function ActivityRow({
  assignmentId,
  activityId,
  title,
  kind,
  defaultMode,
  schedule,
  completedCount,
  completedScholarIds,
  selfMarked,
  inProgressCount,
  notStartedCount,
  rosterSize,
  roster,
  timeZone,
  dueDateOptions,
}: {
  assignmentId: Id<"assignments">;
  activityId: Id<"activities">;
  title: string;
  kind: ActivityKind;
  defaultMode: "classFocus" | "homework" | "either";
  schedule: ActivityScheduleRow | null;
  completedCount: number;
  completedScholarIds: string[];
  selfMarked: { scholarId: Id<"users">; completedAt: number }[];
  inProgressCount: number;
  notStartedCount: number;
  rosterSize: number;
  roster: { scholarId: Id<"users">; name: string }[];
  timeZone: string | null;
  dueDateOptions: HomeworkDueDateOptions | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editScheduleOpen, setEditScheduleOpen] = useState(false);
  const pushActivity = useMutation(api.assignments.pushActivity);
  const clearActivityMut = useMutation(api.assignments.clearActivity);
  const readsLearningRecord = useReadsLearningRecord();
  const isShareBack = kind === "shareBack";
  const isOnline = kind === "online";
  // Use the shared Phosphor icon set (DRY with curriculum / outline /
  // navigator surfaces) instead of inline emoji.
  void isOnline;
  void isShareBack;

  // Planned vs sent is ONE server-owned bit (`planned` = `setAt` null), and
  // the row reads it directly. The whole bug was a row that badged any
  // schedule entry as pushed while the header counted only entries whose
  // window still held, so two planned homework activities looked exactly
  // like sent ones and nobody found out until the next morning.
  //
  // `sent` is the strict complement of that same bit — NOT a second reading
  // of liveness. It deliberately stays true for an overrun-but-unwrapped
  // class focus, which is still on scholars' screens (`isEntryShowing`) even
  // though its window has closed (`isLiveEntry` false). That entry keeps the
  // sent badge, picks up the existing "running long" tag below, and keeps
  // Extend / Wrap — the row must not pretend a focus the class is still
  // sitting in has vanished, and must never restyle it as planned.
  const planned = schedule?.planned === true;
  const sent = !!schedule && !planned;
  const pushedMode = schedule?.mode ?? null;
  const [starting, setStarting] = useState(false);
  const completionNames = useMemo(
    () => activityCompletionNames(roster, completedScholarIds),
    [roster, completedScholarIds],
  );

  // "The turn, not the bell" (item 4): a calm 30s tick — just enough to keep
  // the "running long" tag honest as time passes, never a per-second
  // countdown (teacher-only awareness; scholars never see a ticking clock).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const runningLong =
    pushedMode === "classFocus" &&
    schedule?.setAt != null &&
    isClassFocusRunningLong(now, schedule.setAt, schedule.endsAt);

  const onPushClassFocus = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await pushActivity({
      assignmentId,
      activityId,
      mode: "classFocus",
    });
    toaster.success({
      title: classFocusLiveToast(undefined, timeZone),
    });
  };
  const onPushHomework = async (dueAt: number) => {
    await pushActivity({
      assignmentId,
      activityId,
      mode: "homework",
      dueAt,
    });
    toaster.success({
      title: "Sent as homework",
      description: homeworkDueToastDescription(dueAt, dueDateOptions),
    });
  };
  // Release this planned entry: the same go-live path the header's ad-hoc
  // "Start now" already uses (`pushActivity`), so there is exactly one
  // activation mutation. A planned row on a UNIT assignment used to offer no
  // way to do this at all — the teacher had to clear it and re-send.
  const onStartNow = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!schedule) return;
    setStarting(true);
    try {
      const releaseArgs = plannedReleaseArgs(schedule, Date.now());
      await pushActivity({
        assignmentId,
        activityId,
        ...releaseArgs,
      });
      toaster.success({
        title: startedToastTitle(
          schedule.mode,
          releaseArgs.endsAt,
          timeZone,
        ),
      });
    } catch (error) {
      toaster.error({
        title: "Couldn't start that activity",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setStarting(false);
    }
  };
  const onClear = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await clearActivityMut({ assignmentId, activityId });
    toaster.success({ title: "Cleared" });
  };
  const onExtend = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await pushActivity({
      assignmentId,
      activityId,
      mode: "classFocus",
      endsAt: (schedule?.endsAt ?? Date.now()) + 10 * 60_000,
    });
    toaster.success({ title: "Extended 10 minutes" });
  };
  const onWrap = async (e: React.MouseEvent) => {
    e.stopPropagation();
    // "Wrap now" just lifts the lock — clearActivity is the clean, immediate
    // version of "endsAt = now" (unlike re-driving pushActivity with a past
    // endsAt, this never leaves an inert stale entry sitting in
    // activitySchedule forever). The scholar-side choice (item 3) then
    // applies exactly as it would for a natural auto-clear.
    await clearActivityMut({ assignmentId, activityId });
    toaster.success({ title: "Wrapped — room moved on" });
  };

  // Use a raw Box (not Surface) so we can override the border color
  // when this activity is currently LIVE — Surface intentionally locks its
  // border. A planned entry keeps the neutral border: the colored edge means
  // "scholars are looking at this", not "it's on the schedule".
  return (
    <Box
      p={3}
      bg="white"
      borderRadius="lg"
      shadow="xs"
      borderWidth="1px"
      borderColor={
        sent && pushedMode === "classFocus"
          ? "violet.300"
          : sent && pushedMode === "homework"
            ? "orange.300"
            : "gray.200"
      }
    >
      {/* Outer row isn't a button — the push controls are <button>s
          and you can't nest buttons. The title block is a clickable
          div with role=button + keyboard handler; the push controls
          live as siblings inside the same row. */}
      <Flex align="center" gap={3}>
        <Box
          role="button"
          tabIndex={0}
          onClick={() => setExpanded((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setExpanded((v) => !v);
            }
          }}
          cursor="pointer"
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          <ActivityKindIcon kind={kind} size={18} />
        </Box>
        <Stack
          gap={0}
          flex={1}
          minW={0}
          role="button"
          tabIndex={0}
          onClick={() => setExpanded((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setExpanded((v) => !v);
            }
          }}
          cursor="pointer"
        >
          <HStack gap={2}>
            <Text fontFamily="heading" fontWeight="600" color="navy.500" fontSize="sm">
              {title}
            </Text>
            {pushedMode === "classFocus" && (
              <ActivityModeBadge
                mode="classFocus"
                variant={planned ? "soft" : "solid"}
                suffix={planned ? " · planned" : ""}
              />
            )}
            {runningLong && (
              <Badge bg="gray.100" color="charcoal.500" fontFamily="heading" fontSize="2xs">
                running long
              </Badge>
            )}
            {pushedMode === "homework" && (
              <ActivityModeBadge
                mode="homework"
                variant={planned ? "soft" : "solid"}
                suffix={`${planned ? " · planned" : ""}${
                  schedule?.dueAt && timeZone
                    ? ` · ${dueStatus(schedule.dueAt, now, timeZone)?.phrase ?? ""}`
                    : ""
                }`}
              />
            )}
            {!schedule && defaultMode === "homework" && (
              <Badge bg="gray.100" color="charcoal.500" fontFamily="heading" fontSize="2xs">
                intended as homework
              </Badge>
            )}
            {!schedule && defaultMode === "classFocus" && (
              <Badge bg="gray.100" color="charcoal.500" fontFamily="heading" fontSize="2xs">
                intended for class
              </Badge>
            )}
          </HStack>
          <Text fontSize="2xs" color="charcoal.400" fontFamily="heading">
            {isShareBack
              ? "Share Back"
              : isOnline
                ? "Online activity"
                : kind === "web"
                  ? "Web activity"
                  : "Offline activity"}
            {!isShareBack && rosterSize > 0 && (
              <>
                {" · "}
                {[
                  completedCount > 0 ? `${completedCount} done` : null,
                  inProgressCount > 0 ? `${inProgressCount} in progress` : null,
                  notStartedCount > 0 ? `${notStartedCount} not started` : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || `0 of ${rosterSize} done`}
              </>
            )}
          </Text>
        </Stack>

        {/* Push controls — inline on the row, stop event prop so they
            don't toggle expansion. */}
        {!isShareBack && (
          <HStack gap={1} onClick={(e) => e.stopPropagation()}>
            {planned && (
              <Button
                size="xs"
                bg="violet.500"
                color="white"
                _hover={{ bg: "violet.600" }}
                fontFamily="heading"
                onClick={onStartNow}
                loading={starting}
              >
                <Play size={11} weight="fill" style={{ marginRight: 3 }} />
                Start now
              </Button>
            )}
            {pushedMode !== "classFocus" && (
              <Button
                size="xs"
                variant="ghost"
                color="violet.500"
                _hover={{ bg: "violet.50" }}
                fontFamily="heading"
                onClick={onPushClassFocus}
              >
                <span style={{ marginRight: 3, display: "inline-flex" }}>
                  <ActivityModeIcon mode="classFocus" size={11} />
                </span>
                Set as class focus
              </Button>
            )}
            {pushedMode !== "homework" && (
              <HomeworkDueDatePopover
                options={dueDateOptions}
                onConfirm={onPushHomework}
              />
            )}
            {sent && pushedMode === "classFocus" ? (
              <>
                <Button
                  size="xs"
                  variant="ghost"
                  color="violet.600"
                  _hover={{ bg: "violet.50" }}
                  fontFamily="heading"
                  onClick={onExtend}
                >
                  <span style={{ marginRight: 3, display: "inline-flex" }}>
                    <ArrowClockwise size={11} />
                  </span>
                  Extend +10
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  color="charcoal.400"
                  _hover={{ color: "charcoal.600", bg: "gray.100" }}
                  fontFamily="heading"
                  onClick={onWrap}
                >
                  Wrap now
                </Button>
              </>
            ) : (
              schedule && (
                <>
                  {pushedMode === "homework" && (
                    <Button
                      size="xs"
                      variant="ghost"
                      color="orange.600"
                      _hover={{ bg: "orange.50" }}
                      onClick={() => setEditScheduleOpen(true)}
                    >
                      Edit due date
                    </Button>
                  )}
                  <Button
                    size="xs"
                    variant="ghost"
                    color="charcoal.400"
                    _hover={{ color: "red.500", bg: "red.50" }}
                    onClick={onClear}
                  >
                    Clear
                  </Button>
                </>
              )
            )}
          </HStack>
        )}

        {!isShareBack && (
          <Badge
            bg={
              completedCount === rosterSize && rosterSize > 0
                ? "green.100"
                : "gray.100"
            }
            color={
              completedCount === rosterSize && rosterSize > 0
                ? "green.700"
                : "charcoal.500"
            }
          >
            {completedCount}/{rosterSize}
          </Badge>
        )}
      </Flex>
      {expanded && (
        <Box mt={3} pl={8}>
          {!isShareBack && roster.length > 0 && (
            <Stack
              gap={1}
              mb={3}
              pb={3}
              borderBottomWidth="1px"
              borderColor="gray.100"
            >
              <Text fontSize="xs" color="green.700">
                <Text as="span" fontWeight="700">
                  Done:
                </Text>{" "}
                <DoneNames
                  assignmentId={assignmentId}
                  activityId={activityId}
                  roster={roster}
                  completedScholarIds={completedScholarIds}
                  selfMarked={selfMarked}
                  timeZone={timeZone}
                />
              </Text>
              <Text fontSize="xs" color="charcoal.500">
                <Text as="span" fontWeight="700">
                  Not done:
                </Text>{" "}
                {/* Empty means everyone finished (the "no one done" case lists
                    every name), so the fallback reads "No one". */}
                {completionNames.notDone.join(", ") || "No one"}
              </Text>
            </Stack>
          )}
          {isShareBack && !readsLearningRecord ? null : isShareBack ? (
            <ShareBackActivityPanel
              assignmentId={assignmentId}
              activityId={activityId}
            />
          ) : kind === "problem_set" && !readsLearningRecord ? null : kind === "problem_set" ? (
            // Problem-set activities: show per-scholar practice mastery
            // instead of the submissions panel (practice sessions don't
            // produce deliverables — mastery progress is the signal).
            <PracticeMasteryRoster roster={roster} activityId={activityId} />
          ) : (
            // Online + offline both show submissions: online activities have
            // digital deliverables; offline activities collect scanned work
            // filed from the scanner (materialized into deliverables). The
            // class digest snippet sits above — glanceable synthesis first,
            // raw submissions a scroll below.
            <Stack gap={3}>
              {/* Digest covers online + offline (scanned) work; web
                  activities have no transcript/deliverable to synthesize.
                  A quiet line above the submissions, hairline-separated. */}
              {kind !== "web" && readsLearningRecord && (
                <Box pb={3} borderBottomWidth="1px" borderColor="gray.100">
                  <ClassDigestInline
                    scope="activity"
                    assignmentId={assignmentId}
                    activityId={activityId}
                  />
                </Box>
              )}
              <SubmissionsActivityPanel
                assignmentId={assignmentId}
                activityId={activityId}
                offline={!isOnline}
              />
            </Stack>
          )}
        </Box>
      )}
      <ScheduleActivityDialog
        open={editScheduleOpen}
        onClose={() => setEditScheduleOpen(false)}
        initialAssignmentId={assignmentId}
        initialActivityId={activityId}
        initialMode="homework"
        initialStartsAt={schedule?.startsAt ?? schedule?.setAt ?? now}
        initialDueAt={schedule?.dueAt ?? undefined}
      />
    </Box>
  );
}

/**
 * The Run page's "Done:" names, with a quiet "marked it <date>" chip on a
 * scholar who marked homework done themselves (TRA-458). The count and badge
 * above are unchanged — a self-mark counts the same; the chip is the
 * transparency, and its Undo puts the row back on the scholar's Home. The
 * teacher curates here; they never approve each mark.
 */
function DoneNames({
  assignmentId,
  activityId,
  roster,
  completedScholarIds,
  selfMarked,
  timeZone,
}: {
  assignmentId: Id<"assignments">;
  activityId: Id<"activities">;
  roster: { scholarId: Id<"users">; name: string }[];
  completedScholarIds: string[];
  selfMarked: { scholarId: Id<"users">; completedAt: number }[];
  timeZone: string | null;
}) {
  const unmark = useMutation(api.activityCompletions.unmarkComplete);
  const readsLearningRecord = useReadsLearningRecord();
  const [undoing, setUndoing] = useState<string | null>(null);
  const completed = new Set(completedScholarIds.map(String));
  const done = roster.filter((s) => completed.has(String(s.scholarId)));
  if (done.length === 0) return <>No one yet</>;
  const marks = new Map(selfMarked.map((m) => [String(m.scholarId), m]));
  const onUndo = async (scholarId: Id<"users">, name: string) => {
    setUndoing(String(scholarId));
    try {
      await unmark({ activityId, scholarId, assignmentId });
      toaster.success({ title: `Back on ${name}'s Home` });
    } catch (error) {
      toaster.error({
        title: "Couldn't undo that",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setUndoing(null);
    }
  };
  return (
    <>
      {done.map((s, index) => {
        const mark = marks.get(String(s.scholarId));
        return (
          <Fragment key={String(s.scholarId)}>
            {index > 0 && ", "}
            {s.name}
            {mark && (
              <Badge
                ml={1.5}
                bg="gray.100"
                color="charcoal.500"
                fontFamily="heading"
                fontSize="2xs"
                fontWeight="500"
                gap={1.5}
              >
                marked it{" "}
                {new Intl.DateTimeFormat("en-US", {
                  month: "short",
                  day: "numeric",
                  ...(timeZone ? { timeZone } : {}),
                }).format(new Date(mark.completedAt))}
                {readsLearningRecord && (<chakra.button
                  type="button"
                  color="violet.600"
                  fontWeight="600"
                  cursor="pointer"
                  _hover={{ textDecoration: "underline" }}
                  aria-label={`Undo ${s.name}'s mark`}
                  disabled={undoing === String(s.scholarId)}
                  onClick={() => void onUndo(s.scholarId, s.name)}
                >
                  Undo
                </chakra.button>)}
              </Badge>
            )}
          </Fragment>
        );
      })}
    </>
  );
}

// ─── Practice mastery (problem_set activities) ─────────────────────

/**
 * Per-scholar mastery readout for a problem_set activity. Each row
 * subscribes to its own compact summary query — real-time as scholars
 * practice. Growth-framed ("portrait, not report card"): shows how far
 * each scholar has come, not how they rank against each other.
 *
 * The summary is domain-scoped: a problem-set activity pins its own practice
 * domain (fraction-arithmetic, probability, …), so we resolve that domain once
 * for the roster and thread it into each row — otherwise every row would
 * summarize the default whole-number domain and a teacher on a fractions
 * assignment would see the wrong (or empty) mastery counts.
 */
function PracticeMasteryRoster({
  roster,
  activityId,
}: {
  roster: { scholarId: Id<"users">; name: string }[];
  activityId: Id<"activities">;
}) {
  const problemSet = useQuery(api.practiceSkills.problemSetSkills, { activityId });
  if (roster.length === 0) {
    return (
      <Text fontSize="xs" color="charcoal.400" fontStyle="italic">
        No scholars on this assignment yet.
      </Text>
    );
  }
  // Wait for the activity's domain before subscribing each row — avoids a flash
  // of default-domain (whole-number) counts on a non-default problem set.
  if (problemSet === undefined) {
    return (
      <Text fontSize="xs" color="charcoal.300" fontFamily="heading" fontStyle="italic">
        Loading…
      </Text>
    );
  }
  const domain = problemSet?.domain;
  return (
    <Stack gap={1.5}>
      <SectionEyebrow>Practice progress</SectionEyebrow>
      {roster.map((s) => (
        <ScholarPracticeRow
          key={String(s.scholarId)}
          scholarId={s.scholarId}
          name={s.name}
          domain={domain}
        />
      ))}
    </Stack>
  );
}

function ScholarPracticeRow({
  scholarId,
  name,
  domain,
}: {
  scholarId: Id<"users">;
  name: string;
  domain?: string;
}) {
  const summary = useQuery(api.practiceSkills.summaryForScholar, {
    scholarId,
    ...(domain ? { domain } : {}),
  });

  return (
    <Flex
      align="center"
      gap={3}
      p={2.5}
      bg="white"
      borderWidth="1px"
      borderColor="gray.100"
      borderRadius="md"
    >
      <Stack gap={0.5} flex={1} minW={0}>
        <Text fontFamily="heading" fontWeight="600" color="navy.500" fontSize="xs">
          {name}
        </Text>
        {summary === undefined ? (
          <Text fontSize="2xs" color="charcoal.300" fontFamily="heading">
            Loading…
          </Text>
        ) : (
          <HStack gap={3} flexWrap="wrap">
            {summary.fluentCount > 0 && (
              <Text fontSize="2xs" color="green.700" fontFamily="heading">
                {summary.fluentCount} fluent
              </Text>
            )}
            {summary.provisionalCount > 0 && (
              <Text fontSize="2xs" color="charcoal.500" fontFamily="heading">
                {summary.provisionalCount} placed
              </Text>
            )}
            {summary.frontierCount > 0 && (
              <Text fontSize="2xs" color="violet.600" fontFamily="heading">
                {summary.frontierCount} on frontier
              </Text>
            )}
            {summary.dueCount > 0 && (
              <Text fontSize="2xs" color="orange.600" fontFamily="heading">
                {summary.dueCount} due for review
              </Text>
            )}
            {summary.fluentCount === 0 &&
              summary.provisionalCount === 0 &&
              summary.frontierCount === 0 &&
              summary.dueCount === 0 && (
                <Text
                  fontSize="2xs"
                  color="charcoal.400"
                  fontFamily="heading"
                  fontStyle="italic"
                >
                  No practice yet
                </Text>
              )}
          </HStack>
        )}
      </Stack>
    </Flex>
  );
}

// ─── Scholar work (online activity, scoped to this assignment) ──────

function SubmissionsActivityPanel({
  assignmentId,
  activityId,
  offline = false,
}: {
  assignmentId: Id<"assignments">;
  activityId: Id<"activities">;
  offline?: boolean;
}) {
  const rows = useQuery(api.activities.collateDeliverablesForActivity, {
    activityId,
    assignmentId,
  });
  // A curriculum:run owner sees the hand-in itself; grading, family sharing,
  // scan assessment and the transcript drill-in stay with the teacher (the
  // server already withholds the session id from her).
  const readsLearningRecord = useReadsLearningRecord();
  if (rows === undefined) {
    return (
      <Flex justify="center" py={3}>
        <Spinner size="sm" color="violet.500" />
      </Flex>
    );
  }
  if (rows.length === 0) {
    return (
      <Text fontSize="xs" color="charcoal.400" fontStyle="italic">
        {offline
          ? "No scanned work filed to this activity yet — file scans to it from the scanner inbox."
          : "No checked or sent work from this cohort yet."}
      </Text>
    );
  }
  const downloadText = (filename: string, body: string) => {
    const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };
  const safeName = (s: string) =>
    s.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return (
    <Stack gap={1.5}>
      <SectionEyebrow>
        Scholar work · {rows.length} from this cohort
      </SectionEyebrow>
      {rows.map((r) => {
        const isPortfolio = r.contentKind === "portfolio";
        // Scanned work drills into the scan itself (most useful for the
        // teacher); digital work drills into the project.
        const drillHref =
          isPortfolio && r.fileUrl
            ? r.fileUrl
            : r.sessionId
              ? `/scholar/${r.sessionId}`
              : null;
        const drillExternal = isPortfolio && !!r.fileUrl;
        const inner = (
          <Stack
            gap={0.5}
            w="full"
            minW={0}
            textAlign="left"
            cursor="pointer"
          >
            <Text
              fontFamily="heading"
              fontWeight="600"
              color="navy.500"
              fontSize="xs"
            >
              {r.scholarName}
            </Text>
            {r.contentKind !== "portfolio" && (
              <Text fontSize="2xs" color="charcoal.400">
                {r.lastAction === "check" ? "Checked" : "Sent"}
              </Text>
            )}
            {r.textContent ? (
              <Text
                fontSize="2xs"
                color="charcoal.500"
                overflow="hidden"
                css={{
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                }}
              >
                {r.textContent.slice(0, 200)}
              </Text>
            ) : isPortfolio ? (
              <Text fontSize="2xs" color="charcoal.400" fontStyle="italic">
                Scanned work
              </Text>
            ) : r.contentKind === "file" ? (
              <Text
                fontSize="2xs"
                color="charcoal.400"
                fontStyle="italic"
              >
                File submission
              </Text>
            ) : r.contentKind === "map" ? (
              <Text fontSize="2xs" color="charcoal.400" fontStyle="italic">
                Map checkpoint
              </Text>
            ) : null}
            {r.hasTutorTranscription && <TutorTranscriptionChip />}
          </Stack>
        );
        return (
          <Flex
            key={r._id}
            gap={2}
            align="flex-start"
            p={2}
            bg="white"
            borderWidth="1px"
            borderColor="gray.200"
            borderRadius="md"
            _hover={{ borderColor: "violet.300" }}
          >
            {/* Interactive verdict: teachers grade here (the only assessment
                path for scanned work; an override for AI-graded work). */}
            {readsLearningRecord && (
              <Box flexShrink={0}>
                <DeliverableGradeControl
                  deliverableId={r._id}
                  overall={r.rubricPassed === true ? "full" : r.overall}
                  rubricFeedback={r.rubricFeedback ?? undefined}
                />
              </Box>
            )}
            {isPortfolio && (r.videoThumbUrl || r.thumbUrl) && (
              // A capture video renders its poster still + duration badge — the
              // same vocabulary as the uploads queue and the kiosk gallery
              // (shared/captureMedia), never a second one. A still renders as
              // the plain page thumbnail.
              <Box position="relative" flexShrink={0} w="40px" h="40px">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={r.videoThumbUrl ?? r.thumbUrl ?? undefined}
                  alt=""
                  style={{
                    width: 40,
                    height: 40,
                    objectFit: "cover",
                    borderRadius: 6,
                    background: "#f7f7f7",
                  }}
                />
                {r.videoThumbUrl && (
                  <HStack
                    position="absolute"
                    left="3px"
                    bottom="3px"
                    gap="2px"
                    px="4px"
                    borderRadius="full"
                    bg="blackAlpha.700"
                    pointerEvents="none"
                  >
                    <Play size={7} weight="fill" color="white" />
                    {r.videoDurationMs != null && (
                      <Text fontSize="8px" fontFamily="heading" fontWeight="600" color="white" lineHeight="1.4">
                        {formatCaptureDuration(r.videoDurationMs)}
                      </Text>
                    )}
                  </HStack>
                )}
              </Box>
            )}
            {drillHref === null ? (
              <Box flex={1} minW={0}>
                {inner}
              </Box>
            ) : drillExternal ? (
              <a
                href={drillHref}
                target="_blank"
                rel="noopener noreferrer"
                style={{ flex: 1, minWidth: 0, textDecoration: "none" }}
              >
                {inner}
              </a>
            ) : (
              <Link
                href={drillHref}
                style={{ flex: 1, minWidth: 0, textDecoration: "none" }}
              >
                {inner}
              </Link>
            )}
            {readsLearningRecord && (
              <DeliverableWorkActions
                deliverableId={r._id}
                scholarName={r.scholarName}
                mapContent={r.mapContent}
                familyVisibility={r.familyVisibility}
                familyShareable={r.familyShareable}
              />
            )}
            {r.contentKind === "text" && r.textContent && (
              <Button
                size="2xs"
                variant="ghost"
                color="charcoal.400"
                _hover={{ color: "violet.500", bg: "violet.50" }}
                onClick={() =>
                  downloadText(
                    `${safeName(r.scholarName)}.txt`,
                    r.textContent!,
                  )
                }
              >
                <Download size={12} />
              </Button>
            )}
            {isPortfolio && readsLearningRecord && (
              <AssessScanButton deliverableId={r._id} label="" />
            )}
            {(r.contentKind === "file" || isPortfolio) && r.fileUrl && (
              <Button
                size="2xs"
                variant="ghost"
                color="charcoal.400"
                _hover={{ color: "violet.500", bg: "violet.50" }}
                asChild
              >
                <a
                  href={r.fileUrl}
                  download
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Download size={12} />
                </a>
              </Button>
            )}
          </Flex>
        );
      })}
    </Stack>
  );
}

// ─── Share Back (cohort-scoped digest) ──────────────────────────────

function ShareBackActivityPanel({
  assignmentId,
  activityId,
}: {
  assignmentId: Id<"assignments">;
  activityId: Id<"activities">;
}) {
  const router = useRouter();
  const digest = useQuery(api.shareBack.getDigest, {
    activityId,
    assignmentId,
  });
  const requestDigest = useMutation(api.shareBack.requestDigest);
  const [requesting, setRequesting] = useState(false);
  const generate = async () => {
    setRequesting(true);
    try {
      await requestDigest({ activityId, assignmentId });
    } finally {
      setRequesting(false);
    }
  };
  const openFacilitation = () =>
    router.push(
      `/teacher/shareback/${activityId}/${assignmentId}`,
    );

  if (digest === undefined) {
    return (
      <Flex justify="center" py={3}>
        <Spinner size="sm" color="violet.500" />
      </Flex>
    );
  }
  if (!digest) {
    return (
      <Stack gap={2}>
        <Text fontSize="xs" color="charcoal.500">
          No digest yet for this cohort. Generate one to collate every
          submission and get a facilitation-ready summary.
        </Text>
        <Button
          size="sm"
          bg="violet.500"
          color="white"
          _hover={{ bg: "violet.600" }}
          fontFamily="heading"
          alignSelf="flex-start"
          onClick={generate}
          loading={requesting}
        >
          ✨ Generate digest
        </Button>
      </Stack>
    );
  }
  if (digest.status === "pending" || requesting) {
    return (
      <HStack gap={2} color="violet.600">
        <Spinner size="sm" />
        <Text fontSize="sm" fontFamily="heading" fontWeight="600">
          Generating digest…
        </Text>
      </HStack>
    );
  }
  if (digest.status === "error") {
    return (
      <Stack gap={2}>
        <HStack gap={1.5} color="red.500">
          <WarningCircle size={14} />
          <Text fontSize="sm" fontFamily="heading" fontWeight="600">
            Digest generation failed
          </Text>
        </HStack>
        {digest.error && (
          <Text fontSize="2xs" color="charcoal.400">
            {digest.error}
          </Text>
        )}
        <Button
          size="sm"
          variant="outline"
          colorPalette="violet"
          fontFamily="heading"
          alignSelf="flex-start"
          onClick={generate}
        >
          <ArrowClockwise size={12} style={{ marginRight: 4 }} />
          Retry
        </Button>
      </Stack>
    );
  }
  return (
    <Stack gap={2}>
      {digest.summary && (
        <Text fontSize="sm" color="navy.500" lineHeight="1.5">
          {digest.summary}
        </Text>
      )}
      <HStack gap={3}>
        <Text fontSize="2xs" color="charcoal.500" fontFamily="heading">
          {digest.highlights?.length ?? 0} highlight
          {(digest.highlights?.length ?? 0) === 1 ? "" : "s"} ·{" "}
          {digest.themes?.length ?? 0} theme
          {(digest.themes?.length ?? 0) === 1 ? "" : "s"}
        </Text>
      </HStack>
      {digest.stale && (
        <HStack gap={1.5} color="orange.600">
          <WarningCircle size={12} />
          <Text fontSize="2xs" fontFamily="heading">
            {digest.newSubmissions} new submission
            {digest.newSubmissions === 1 ? "" : "s"} since this was
            generated — regenerate.
          </Text>
        </HStack>
      )}
      <HStack gap={2}>
        <Button
          size="sm"
          bg="violet.500"
          color="white"
          _hover={{ bg: "violet.600" }}
          fontFamily="heading"
          onClick={openFacilitation}
        >
          <Play size={12} style={{ marginRight: 4 }} />
          Open facilitation view
        </Button>
        <Button
          size="sm"
          variant="ghost"
          fontFamily="heading"
          color="charcoal.500"
          onClick={generate}
          loading={requesting}
        >
          <ArrowClockwise size={12} style={{ marginRight: 4 }} />
          Regenerate
        </Button>
      </HStack>
    </Stack>
  );
}

// (local timeAgo dropped — use lib/relativeTime.ts instead)

// Re-export the type for satellite components if we add them.
export type { AssignmentData };

// Silence unused-import warnings for Check/leftover imports.
void Check;
