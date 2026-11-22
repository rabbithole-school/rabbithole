"use client";

/**
 * Schedule (plan) an activity onto the calendar/agenda. The calendar
 * counterpart to the Run page's "Give…": here a teacher picks an assignment
 * (cohort × unit), an activity within it, and answers the two give questions
 * (components/GiveWindowFields.tsx, TRA-571): when it shows up and when they
 * should finish it. A later time writes a PLANNED entry (startsAt set, setAt
 * null) via api.assignments.scheduleActivity — invisible to scholars until it
 * activates at startsAt (or the teacher hits Start now); "Now" goes live
 * through pushActivity. A time in the past stays planned and is called out
 * as "won't auto-start".
 *
 * Used both for fresh scheduling (from the agenda's "+ Schedule") and
 * for editing an existing entry (prefilled). Submitting always calls
 * scheduleActivity, which replaces any existing entry for that activity
 * (cancelling its pending job) — so "edit" is just "re-schedule".
 */
import { useMemo, useState } from "react";
import {
  Box,
  Button,
  Dialog,
  Flex,
  HStack,
  Portal,
  Spinner,
  Stack,
  Text,
} from "@chakra-ui/react";
import { CalendarPlus, Warning } from "@phosphor-icons/react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ActivityKindIcon } from "@/components/ActivityKindIcon";
import type { ActivityMode } from "@/lib/activityMode";
import {
  GiveWindowFields,
  giveButtonLabel,
  showsUpAt,
  usableGiveChoices,
  useGiveChoices,
  useMinuteNow,
  type GiveFinish,
  type ShowsUp,
} from "@/components/GiveWindowFields";
import { ScholarFacepile } from "@/components/ScholarFacepile";
import { toaster } from "@/lib/toaster";
import { serverErrorMessage } from "@/lib/serverErrorMessage";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function toLocalInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

export function initialHomeworkDueInputValue(initialDueAt?: number): string {
  return initialDueAt ? toLocalInputValue(initialDueAt) : "";
}

type ScheduleActivityDialogProps = {
  open: boolean;
  onClose: () => void;
  initialAssignmentId?: Id<"assignments">;
  initialActivityId?: Id<"activities">;
  initialMode?: ActivityMode;
  initialStartsAt?: number;
  initialDueAt?: number;
  // From the agenda's "View as": auto-pick the assignment whose roster
  // intersects these scholars when none is explicitly chosen.
  preferScholarIds?: Id<"users">[];
  onScheduled?: () => void;
};

/**
 * Shell: owns ONLY the Chakra Dialog scope, mounted stably (never
 * remounted while open). The form + all its state live in the inner
 * ScheduleActivityForm, which is mounted only while `open` — so it
 * re-seeds from props on every open (fresh mount → lazy initializers
 * re-run), no reset effect needed.
 *
 * Why the split: Ark's Dialog locks document.body on open
 * (overflow:hidden + pointer-events:none) and balances that lock across
 * the open→close lifecycle. If you REMOUNT the Dialog.Root via a changing
 * `key` while it's open (the old shape of this component), the lock is
 * applied on a mount-already-open and the cleanup ref-count never
 * balances — so on close the body keeps `overflow:hidden;
 * pointer-events:none` and the whole page goes unscrollable + unclickable.
 * Keeping Dialog.Root stable and re-seeding via the inner mount avoids
 * that entirely. (Reproduced live from the agenda "+"; this is the same
 * body-lock-leak class as #81, here triggered by remount-while-open rather
 * than a modal stacked over a drawer.)
 */
export function ScheduleActivityDialog(props: ScheduleActivityDialogProps) {
  const { open, onClose } = props;
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(d) => !d.open && onClose()}
      placement="center"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content maxW="560px" w="92vw" borderRadius="xl" overflow="hidden">
            {open && <ScheduleActivityForm {...props} />}
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function ScheduleActivityForm({
  onClose,
  initialAssignmentId,
  initialActivityId,
  initialMode,
  initialStartsAt,
  initialDueAt,
  preferScholarIds,
  onScheduled,
}: ScheduleActivityDialogProps) {
  const assignments = useQuery(api.assignments.listForTeacher, {});
  const scheduleActivity = useMutation(api.assignments.scheduleActivity);
  const pushActivity = useMutation(api.assignments.pushActivity);

  // This form is mounted fresh on every open (parent renders it only while
  // `open`), so these lazy initializers re-seed from props each time — no
  // reset effect needed. Date.now() is allowed in a lazy initializer, just
  // not the render body (impure-during-render lint).
  const [now0] = useState(() => Date.now());
  const nowMs = useMinuteNow();
  const [assignmentId, setAssignmentId] = useState<Id<"assignments"> | null>(
    initialAssignmentId ?? null,
  );
  const [activityId, setActivityId] = useState<Id<"activities"> | null>(
    initialActivityId ?? null,
  );
  const [showsUp, setShowsUp] = useState<ShowsUp>(() => ({
    kind: "at",
    at: initialStartsAt ?? Date.now() + HOUR,
  }));
  // Nothing is pre-selected for a new give. Editing an existing homework
  // entry starts from its due day (seeded once the school's zone is known).
  const [finishPick, setFinishPick] = useState<GiveFinish | null>(null);
  const [saving, setSaving] = useState(false);

  // Effective selection: the user's explicit pick, else auto-match the
  // first assignment whose roster intersects preferScholarIds (the
  // agenda's "View as"). Derived — no reset effect.
  const autoAssignmentId = useMemo(() => {
    if (assignmentId || !assignments || !preferScholarIds?.length) return null;
    const want = new Set(preferScholarIds.map(String));
    const match = assignments.find((a) =>
      a.scholarIds.some((id) => want.has(String(id))),
    );
    return match?._id ?? null;
  }, [assignmentId, assignments, preferScholarIds]);
  const selectedAssignmentId = assignmentId ?? autoAssignmentId;
  const startsMs = showsUpAt(showsUp, nowMs);
  const choices = useGiveChoices(
    selectedAssignmentId
      ? {
          assignmentId: selectedAssignmentId,
          activityId: activityId ?? undefined,
          startsAt: startsMs,
        }
      : "skip",
    nowMs,
  );
  const seededFinish: GiveFinish | null =
    initialMode === "homework" && initialDueAt && usableGiveChoices(choices)
      ? {
          kind: "by",
          dayKey: new Intl.DateTimeFormat("en-CA", {
            timeZone: usableGiveChoices(choices)!.timeZone,
          }).format(new Date(initialDueAt)),
        }
      : null;
  const finish = finishPick ?? seededFinish;

  const progress = useQuery(
    api.assignments.activityProgress,
    selectedAssignmentId ? { assignmentId: selectedAssignmentId } : "skip",
  );

  const isPast = showsUp.kind === "at" && startsMs <= now0;
  const editingExisting = initialActivityId != null;

  const canSubmit =
    !!selectedAssignmentId && !!activityId && !!finish && !saving;

  const submit = async () => {
    if (!selectedAssignmentId || !activityId || !finish) return;
    setSaving(true);
    try {
      if (showsUp.kind === "now") {
        await pushActivity({
          assignmentId: selectedAssignmentId,
          activityId,
          finish,
        });
      } else {
        await scheduleActivity({
          assignmentId: selectedAssignmentId,
          activityId,
          startsAt: showsUp.at,
          finish,
        });
      }
      toaster.success({
        title:
          showsUp.kind === "now"
            ? "Given"
            : editingExisting
              ? "Schedule updated"
              : isPast
                ? "Scheduled (start it manually — time is in the past)"
                : "Scheduled",
      });
      onScheduled?.();
      onClose();
    } catch (err) {
      toaster.error({
        title: "Couldn't schedule",
        description: serverErrorMessage(err, "Check your connection and try again."),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Dialog.Header px={6} pt={5} pb={3}>
              <HStack gap={2}>
                <CalendarPlus size={20} weight="duotone" />
                <Text fontFamily="heading" fontWeight="700" color="navy.500">
                  {initialActivityId ? "Edit scheduled activity" : "Schedule an activity"}
                </Text>
              </HStack>
            </Dialog.Header>
            <Dialog.Body px={6} pb={6} pt={0}>
              <Stack gap={4}>
                {/* 1 — Assignment */}
                <Field label="Assignment">
                  {assignments === undefined ? (
                    <Spinner size="sm" color="violet.500" />
                  ) : assignments.length === 0 ? (
                    <Empty>No active assignments. Assign a unit first.</Empty>
                  ) : (
                    <Stack gap={1} maxH="150px" overflowY="auto">
                      {assignments.map((a) => (
                        <PickRow
                          key={String(a._id)}
                          active={String(a._id) === String(selectedAssignmentId)}
                          onClick={() => {
                            setAssignmentId(a._id);
                            setActivityId(null);
                          }}
                        >
                          <Text fontSize="md" lineHeight="1">
                            {a.unitEmoji ?? "📘"}
                          </Text>
                          <Text
                            fontFamily="heading"
                            fontWeight="600"
                            fontSize="sm"
                            color="navy.600"
                            flex={1}
                            truncate
                          >
                            {a.title ?? a.unitTitle}
                          </Text>
                          <ScholarFacepile
                            scholars={a.facepile}
                            total={a.scholarCount}
                            size="xs"
                            max={3}
                          />
                        </PickRow>
                      ))}
                    </Stack>
                  )}
                </Field>

                {/* 2 — Activity */}
                {selectedAssignmentId && (
                  <Field label="Activity">
                    {progress === undefined ? (
                      <Spinner size="sm" color="violet.500" />
                    ) : !progress || progress.lessons.length === 0 ? (
                      <Empty>This unit has no activities yet.</Empty>
                    ) : (
                      <Stack gap={2} maxH="220px" overflowY="auto">
                        {progress.lessons.map((l) => (
                          <Box key={String(l.lessonId)}>
                            <Text
                              fontSize="2xs"
                              fontFamily="heading"
                              fontWeight="700"
                              letterSpacing="0.04em"
                              textTransform="uppercase"
                              color="charcoal.400"
                              mb={1}
                            >
                              {l.lessonTitle}
                            </Text>
                            <Stack gap={1}>
                              {l.activities.map((act) => (
                                <PickRow
                                  key={String(act.activityId)}
                                  active={
                                    String(act.activityId) === String(activityId)
                                  }
                                  onClick={() => setActivityId(act.activityId)}
                                >
                                  <ActivityKindIcon kind={act.kind} size={16} />
                                  <Text
                                    fontFamily="heading"
                                    fontWeight="600"
                                    fontSize="sm"
                                    color="navy.600"
                                    flex={1}
                                    truncate
                                  >
                                    {act.title}
                                  </Text>
                                  {act.schedule && (
                                    <Text
                                      fontSize="2xs"
                                      color="charcoal.400"
                                      fontFamily="heading"
                                    >
                                      {act.schedule.planned
                                        ? "planned"
                                        : "live"}
                                    </Text>
                                  )}
                                </PickRow>
                              ))}
                            </Stack>
                          </Box>
                        ))}
                      </Stack>
                    )}
                  </Field>
                )}

                {/* 3 — When it shows up, and when it's finished */}
                {selectedAssignmentId && (
                  <GiveWindowFields
                    choices={choices}
                    nowMs={nowMs}
                    showsUp={showsUp}
                    onShowsUpChange={setShowsUp}
                    finish={finish}
                    onFinishChange={setFinishPick}
                  />
                )}

                {isPast && !editingExisting && (
                  <HStack
                    gap={2}
                    px={3}
                    py={2}
                    bg="orange.50"
                    borderWidth="1px"
                    borderColor="orange.200"
                    borderRadius="md"
                  >
                    <Warning size={16} color="var(--chakra-colors-orange-500)" />
                    <Text fontSize="xs" color="orange.700" fontFamily="heading">
                      That time is in the past — it won&apos;t auto-start. It
                      stays planned until you hit Start now.
                    </Text>
                  </HStack>
                )}

                <Flex justify="flex-end" gap={2} pt={1}>
                  <Button variant="ghost" size="sm" onClick={onClose}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    bg="violet.600"
                    color="white"
                    _hover={{ bg: "violet.700" }}
                    disabled={!canSubmit}
                    onClick={submit}
                  >
                    {saving ? (
                      <Spinner size="sm" />
                    ) : initialActivityId ? (
                      giveButtonLabel(finish, "Save changes")
                    ) : (
                      giveButtonLabel(finish)
                    )}
                  </Button>
                </Flex>
              </Stack>
            </Dialog.Body>
    </>
  );
}

function Field({
  label,
  children,
  flex,
  minW,
}: {
  label: string;
  children: React.ReactNode;
  flex?: number;
  minW?: string;
}) {
  return (
    <Box flex={flex} minW={minW}>
      <Text
        fontSize="2xs"
        fontFamily="heading"
        fontWeight="700"
        letterSpacing="0.04em"
        textTransform="uppercase"
        color="charcoal.400"
        mb={1.5}
      >
        {label}
      </Text>
      {children}
    </Box>
  );
}

function PickRow({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <HStack
      as="button"
      onClick={onClick}
      gap={2}
      w="full"
      px={2.5}
      py={2}
      borderRadius="md"
      borderWidth="1px"
      borderColor={active ? "violet.300" : "gray.200"}
      bg={active ? "violet.50" : "white"}
      cursor="pointer"
      _hover={{ bg: active ? "violet.50" : "gray.50" }}
      textAlign="left"
    >
      {children}
    </HStack>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <Text
      fontSize="xs"
      color="charcoal.400"
      fontFamily="heading"
      fontStyle="italic"
    >
      {children}
    </Text>
  );
}
