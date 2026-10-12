"use client";

// Modal: start a class assignment. Finder-style multi-column picker:
// Unit → Lesson → Activity. (Quests removed in the kill-quests
// refactor — the dialog now opens directly into the unit picker.)

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import {
  Box,
  Button,
  Dialog,
  Flex,
  Heading,
  HStack,
  Portal,
  Spinner,
  Stack,
  Text,
} from "@chakra-ui/react";
import { Warning } from "@phosphor-icons/react";
import { ACTIVITY_KIND } from "@/lib/activityKinds";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { ColumnSpinner } from "@/components/startAssignment/primitives";
import { UnitsList } from "@/components/startAssignment/UnitsList";
import {
  ProgramHandoutComposer,
  ProgramSearchBar,
  ProgramSettings,
} from "@/components/startAssignment/ProgramScheduleSection";
import { TeacherSettings } from "@/components/startAssignment/TeacherAssignmentSection";
import { useProgramScheduleMode } from "@/components/startAssignment/useProgramScheduleMode";
import { useTeacherAssignmentMode } from "@/components/startAssignment/useTeacherAssignmentMode";
import type { StartAssignmentProgramTarget } from "@/components/startAssignment/types";
import { HierarchyColumn, HierarchyRow } from "@/components/hierarchy";
import { useViewingContext } from "@/hooks/useViewingContext";

interface StartAssignmentDialogProps {
  open: boolean;
  onClose: () => void;
  /** If passed, called with the new focus id after a successful start. */
  onStarted?: () => void;
  /** Legacy prop — kept for caller back-compat but no longer used. */
  initialMode?: "pick-kind" | "unit" | "quest";
  /** Pre-scope the dialog to a unit (e.g. opened from the Curriculum
   *  unit preview's "Assign" button). The unit column starts on this
   *  unit so the teacher lands ready to pick scholars and Start. */
  initialUnitId?: Id<"units">;
  /** Pre-scope to a lesson (opened from a lesson's Assign tab) — assigns
   *  the whole lesson. Requires initialUnitId. */
  initialLessonId?: Id<"lessons">;
  /** Pre-scope to a single activity (opened from an activity's Assign tab).
   *  Requires initialUnitId + initialLessonId so the activity resolves and
   *  the single-activity scheduling UI shows. */
  initialActivityId?: Id<"activities">;
  /** Preselect the assignment roster (e.g. the scholars a Concept Atlas
   *  convergence lit up). Seeded into the scholar selection on open — mirroring
   *  the initialUnitId/initialLessonId/initialActivityId preselect pattern — and
   *  reconciled once against the loaded roster so stale / out-of-lens ids are
   *  dropped before they can reach assignWork. While set, it also suppresses the
   *  default "select everyone" behaviour. */
  initialScholarIds?: readonly Id<"users">[];
  /** Optional one-line context sentence rendered under the title (small,
   *  charcoal.500). Rendered VERBATIM — the caller owns the whole sentence. */
  contextText?: string;
  /** A capability-scoped program target. The group stays fixed and the dialog
   *  schedules exactly one existing activity or newly created Handout through
   *  the program authorization boundary instead of accepting a client roster. */
  programTarget?: StartAssignmentProgramTarget;
}

export function StartAssignmentDialog({
  open,
  onClose,
  onStarted,
  initialUnitId,
  initialLessonId,
  initialActivityId,
  initialScholarIds,
  contextText,
  programTarget,
}: StartAssignmentDialogProps) {
  const router = useRouter();
  const { mode: viewingMode, viewingPending } = useViewingContext();
  // Treat the unresolved overlay query as read-only too, so a View As session
  // never gets a one-render window to start a write.
  const viewingAsReadOnly = viewingMode === "actAs" || viewingPending;
  // ── Shared shell state ────────────────────────────────────────────
  // Genuinely cross-mode: the hierarchy picks both modes browse, the unit
  // column's author/subject filters, and the submit lock. `confirmDraft` is
  // reset by the shared unit-pick handler and read by the teacher footer; it
  // stays here because a generic pick clears it in every mode.
  const [pickedUnitId, setPickedUnitId] = useState<Id<"units"> | null>(null);
  // null = "Whole unit (no lesson lock)". undefined = no choice yet.
  const [pickedLessonId, setPickedLessonId] = useState<
    Id<"lessons"> | null | undefined
  >(undefined);
  const [pickedActivityId, setPickedActivityId] = useState<
    Id<"activities"> | null | undefined
  >(undefined);
  const [unitAuthorFilterOverride, setUnitAuthorFilterOverride] = useState<
    string | null
  >(null);
  const [unitSubjectFilter, setUnitSubjectFilter] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // One-tap soft confirm when the picked unit is still structurally Draft.
  // Surface, never a hard gate — assign-at-any-maturity is intentional.
  const [confirmDraft, setConfirmDraft] = useState(false);

  // Edge-detects closed→open so the shared per-open reset runs exactly once. A
  // re-render with new initial* props while open must never clobber the
  // teacher's in-progress edits. Each mode hook edge-detects the same trigger
  // for its own state.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = open;
    if (!open || wasOpen) return;
    setPickedUnitId(initialUnitId ?? null);
    // Prefill the node target when opened from a lesson/activity Assign tab
    // (undefined = "no choice yet / whole unit").
    setPickedLessonId(initialLessonId ?? undefined);
    setPickedActivityId(initialActivityId ?? undefined);
    setUnitAuthorFilterOverride(null);
    setUnitSubjectFilter(null);
    setSubmitting(false);
    setConfirmDraft(false);
  }, [open, initialUnitId, initialLessonId, initialActivityId]);

  // Shared hierarchy columns: the unit list (in program mode, only the units
  // the group can schedule — the same set its search returns) and its
  // lessons. Both modes render these; the per-mode activities come from the
  // active hook.
  const units = useQuery(
    api.units.list,
    open
      ? programTarget
        ? { programGroupId: programTarget.groupId }
        : {}
      : "skip",
  );
  const lessons = useQuery(
    api.lessons.listByUnit,
    open && pickedUnitId ? { unitId: pickedUnitId } : "skip",
  );
  const effectivePickedLessonId =
    programTarget && !pickedLessonId && lessons?.length === 1
      ? lessons[0]._id
      : pickedLessonId;

  // What granularity are we assigning? A concrete activity → schedule
  // that one; a whole lesson → cadence over its activities; otherwise
  // (just a unit, or "Whole unit") → cadence over the unit. `undefined`
  // lesson is treated as the whole unit so picking a unit + Start still
  // works in one move.
  const targetKind: "unit" | "lesson" | "activity" =
    pickedActivityId ? "activity" : effectivePickedLessonId ? "lesson" : "unit";
  const isSingleActivity = targetKind === "activity";

  // ── Per-mode state, queries, mutations, validation, and submit ────
  // Both hooks are called unconditionally; the inactive one "skip"s all its
  // queries and its UI is never rendered. The shell reads the ACTIVE mode's
  // shared surface (activitiesInLesson / targetSummary / canStart / submit /
  // requestClose) plus each mode's own fields where the render already branches.
  const program = useProgramScheduleMode({
    open,
    programTarget,
    viewingAsReadOnly,
    pickedUnitId,
    pickedActivityId,
    effectivePickedLessonId,
    targetKind,
    setPickedUnitId,
    setPickedLessonId,
    setPickedActivityId,
    units,
    lessons,
    submitting,
    setSubmitting,
    onStarted,
    onClose,
  });
  const teacher = useTeacherAssignmentMode({
    open,
    programTarget,
    viewingAsReadOnly,
    initialScholarIds,
    pickedUnitId,
    pickedLessonId,
    pickedActivityId,
    effectivePickedLessonId,
    targetKind,
    isSingleActivity,
    units,
    lessons,
    submitting,
    setSubmitting,
    onStarted,
    onClose,
    router,
  });

  const activitiesInLesson = programTarget
    ? program.activitiesInLesson
    : teacher.activitiesInLesson;
  const targetSummary = programTarget
    ? program.targetSummary
    : teacher.targetSummary;
  const canStart = programTarget ? program.canStart : teacher.canStart;
  const requestClose = programTarget ? program.requestClose : teacher.requestClose;

  const handleStart = () => {
    if (
      viewingAsReadOnly ||
      !canStart ||
      (!programTarget && !pickedUnitId)
    ) {
      return;
    }
    // Soft confirm on a draft unit: first Assign click arms the confirm
    // (banner + "Assign anyway" button); a second click goes through.
    if (!programTarget && teacher.selectedUnitIsDraft && !confirmDraft) {
      setConfirmDraft(true);
      return;
    }
    void (programTarget ? program.submit() : teacher.submit());
  };

  const showLessonsCol = pickedUnitId !== null;
  const showActivitiesCol =
    effectivePickedLessonId !== null &&
    effectivePickedLessonId !== undefined;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(details) => {
        if (!details.open) requestClose();
      }}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent maxW="980px" w="95vw">
            <Dialog.Header px={6} pt={6} pb={3}>
              <Stack gap={0}>
                <Text
                  fontSize="xs"
                  color="charcoal.400"
                  fontFamily="heading"
                  fontWeight="600"
                  textTransform="uppercase"
                  letterSpacing="0.05em"
                >
                  {programTarget ? "Schedule work" : "Assign work"}
                </Text>
                <Dialog.Title asChild>
                  <Heading size="md" color="navy.500" fontFamily="heading">
                    {programTarget
                      ? `Add work to ${programTarget.groupName}`
                      : "Pick what scholars work on — and when"}
                  </Heading>
                </Dialog.Title>
                {(programTarget?.scheduleTarget.mode === "classFocus"
                  ? program.scheduleLabel
                  : contextText) && (
                  <Text fontSize="xs" color="charcoal.500" mt={1.5}>
                    {programTarget?.scheduleTarget.mode === "classFocus"
                      ? program.scheduleLabel
                      : contextText}
                  </Text>
                )}
                {viewingAsReadOnly && (
                  <Text fontSize="sm" color="charcoal.500" mt={1.5}>
                    This view is read-only. Exit view-as to assign or schedule
                    work.
                  </Text>
                )}
              </Stack>
            </Dialog.Header>

            <Dialog.Body px={0} pb={0} pt={0}>
              <Stack gap={0}>
                {programTarget && !program.showCreatedHandoutComposer && (
                  <ProgramSearchBar
                    programSearch={program.programSearch}
                    setProgramSearch={program.setProgramSearch}
                    programSearchIndex={program.programSearchIndex}
                    setProgramSearchIndex={program.setProgramSearchIndex}
                    programSearchResults={program.programSearchResults}
                    curriculumAccessDenied={program.curriculumAccessDenied}
                    chooseProgramSearchResult={program.chooseProgramSearchResult}
                    viewingAsReadOnly={viewingAsReadOnly}
                    creatingHandout={program.creatingHandout}
                    createdHandoutId={program.createdHandoutId}
                    handleCreateHandout={program.handleCreateHandout}
                  />
                )}
              <Flex
                borderTop="1px solid"
                borderTopColor="gray.200"
                borderBottom="1px solid"
                borderBottomColor="gray.200"
                bg="gray.50"
                h="360px"
                overflowX="auto"
              >
                {program.createdHandoutId && program.showCreatedHandoutComposer ? (
                  <>
                    <ProgramHandoutComposer
                      createdHandoutId={program.createdHandoutId}
                      createdHandoutAssignmentId={program.createdHandoutAssignmentId}
                      createdHandoutTitle={program.createdHandoutTitle}
                      setCreatedHandoutTitle={program.setCreatedHandoutTitle}
                      viewingAsReadOnly={viewingAsReadOnly}
                      saveCreatedHandoutTitle={program.saveCreatedHandoutTitle}
                      setShowCreatedHandoutComposer={program.setShowCreatedHandoutComposer}
                      setPickedActivityId={setPickedActivityId}
                    />
                  </>
                ) : (
                  <>
                {/* Unit column */}
                <HierarchyColumn header="Unit" width="280px">
                  <UnitsList
                    units={units}
                    pickedUnitId={pickedUnitId}
                    authorFilterOverride={unitAuthorFilterOverride}
                    onAuthorFilterChange={setUnitAuthorFilterOverride}
                    selectedSubject={unitSubjectFilter}
                    onSubjectChange={setUnitSubjectFilter}
                    curriculumAccessDenied={
                      programTarget ? program.curriculumAccessDenied : null
                    }
                    onPick={(id) => {
                      setPickedUnitId(id);
                      setPickedLessonId(undefined);
                      setPickedActivityId(undefined);
                      teacher.onPickReset();
                      setConfirmDraft(false);
                    }}
                  />
                </HierarchyColumn>

                {/* Lessons column */}
                {showLessonsCol && (
                  <HierarchyColumn
                    header={programTarget ? "Lesson" : "Lesson (optional)"}
                    width="240px"
                  >
                    {lessons === undefined ? (
                      <ColumnSpinner />
                    ) : (
                      <>
                        {!programTarget && (
                          <HierarchyRow
                            variant="pseudo"
                            label="Whole unit"
                            sublabel="No lesson lock"
                            selected={pickedLessonId === null}
                            onClick={() => {
                              setPickedLessonId(null);
                              setPickedActivityId(undefined);
                              teacher.onPickReset();
                            }}
                            trailing={{ kind: "check" }}
                          />
                        )}
                        {lessons.map((l) => (
                          <HierarchyRow
                            key={l._id}
                            selected={effectivePickedLessonId === l._id}
                            onClick={() => {
                              setPickedLessonId(l._id);
                              setPickedActivityId(undefined);
                              teacher.onPickReset();
                            }}
                            label={l.title}
                            sublabel={l.strand ?? undefined}
                            trailing={{ kind: "chevron" }}
                          />
                        ))}
                      </>
                    )}
                  </HierarchyColumn>
                )}

                {/* Activities column */}
                {showActivitiesCol && (
                  <HierarchyColumn
                    header={
                      programTarget
                        ? "Activity or handout"
                        : "Activity (optional)"
                    }
                    width="240px"
                  >
                    {activitiesInLesson === undefined ? (
                      <ColumnSpinner />
                    ) : (
                      <>
                        {!programTarget && (
                          <HierarchyRow
                            variant="pseudo"
                            label="Whole lesson"
                            sublabel="No activity lock"
                            selected={pickedActivityId === null}
                            onClick={() => {
                              setPickedActivityId(null);
                              teacher.onPickReset();
                            }}
                            trailing={{ kind: "check" }}
                          />
                        )}
                        {activitiesInLesson.map((a) => (
                          <HierarchyRow
                            key={a._id}
                            selected={pickedActivityId === a._id}
                            onClick={() => {
                              setPickedActivityId(a._id);
                              if (a._id === program.createdHandoutId) {
                                program.setShowCreatedHandoutComposer(true);
                              }
                              teacher.onPickReset();
                            }}
                            label={a.title}
                            // A game's platform requirement belongs HERE, at
                            // assign time — not when a scholar on a laptop
                            // taps it and finds out. Same declaration the
                            // capability notice reads.
                            sublabel={
                              programTarget
                                ? (() => {
                                    const resourceCount =
                                      program.programUnitActivities?.find(
                                        (candidate) =>
                                          candidate._id === a._id,
                                      )?.resources?.length;
                                    if (resourceCount === undefined) {
                                      return "Checking materials…";
                                    }
                                    const kindLabel =
                                      a.kind === "game"
                                        ? `${ACTIVITY_KIND.game.label} · runs on iPad`
                                        : a.kind
                                          ? ACTIVITY_KIND[a.kind].label
                                          : "Activity";
                                    const materialsLabel =
                                      resourceCount === 0
                                        ? "No materials"
                                        : `${resourceCount} ${
                                            resourceCount === 1
                                              ? "material"
                                              : "materials"
                                          }`;
                                    return `${kindLabel} · ${materialsLabel}`;
                                  })()
                                : a.kind === "game"
                                  ? `${ACTIVITY_KIND.game.label} · runs on iPad`
                                  : a.kind
                            }
                          />
                        ))}
                      </>
                    )}
                  </HierarchyColumn>
                )}

                {/* Hint column before the hierarchy has a concrete lesson. */}
                {!showLessonsCol && (
                  <Flex
                    flex={1}
                    align="center"
                    justify="center"
                    color="charcoal.300"
                    fontFamily="body"
                    fontSize="sm"
                    px={6}
                  >
                    Pick a unit on the left to continue.
                  </Flex>
                )}
                {showLessonsCol && !showActivitiesCol && (
                  <Flex
                    flex={1}
                    align="center"
                    justify="center"
                    color="charcoal.300"
                    fontFamily="body"
                    fontSize="sm"
                    px={6}
                    textAlign="center"
                  >
                    Pick a lesson to choose an activity.
                  </Flex>
                )}
                  </>
                )}
              </Flex>
              </Stack>

              {/* Settings panel */}
              {(!programTarget || !!pickedActivityId) && (
                <Stack gap={4} px={6} py={5}>
                <Box>
                  <Text
                    fontSize="xs"
                    color="charcoal.400"
                    fontFamily="heading"
                    fontWeight="600"
                    textTransform="uppercase"
                    letterSpacing="0.04em"
                    mb={1}
                  >
                    Target
                  </Text>
                  {targetSummary ? (
                    <Text
                      fontSize="sm"
                      fontFamily="heading"
                      color="navy.500"
                      fontWeight="600"
                    >
                      {targetSummary}
                    </Text>
                  ) : (
                    <Text
                      fontSize="sm"
                      fontFamily="body"
                      color="charcoal.300"
                      fontStyle="italic"
                    >
                      {programTarget
                        ? "Pick an activity or handout above to continue."
                        : "Pick a target above to enable Assign."}
                    </Text>
                  )}
                  {programTarget && targetSummary && (
                    <Text fontSize="xs" color="charcoal.400" mt={1}>
                      {program.displayedProgramResourceCount === null
                        ? "Checking materials…"
                        : program.displayedProgramResourceCount === 0
                          ? "No materials"
                          : `${program.displayedProgramResourceCount} ${
                              program.displayedProgramResourceCount === 1
                                ? "material"
                                : "materials"
                            }`}
                    </Text>
                  )}
                  {targetSummary && teacher.selectedUnitIsDraft && !programTarget && (
                    <Text
                      fontSize="xs"
                      color="charcoal.400"
                      fontFamily="body"
                      mt={1}
                    >
                      Still a draft — some essentials aren&apos;t filled in yet.
                      You can assign it anyway.
                    </Text>
                  )}
                </Box>

                {programTarget ? (
                  <ProgramSettings
                    programTarget={programTarget}
                    homeworkDate={program.homeworkDate}
                    setHomeworkDate={program.setHomeworkDate}
                  />
                ) : (
                  <TeacherSettings
                    scholarSel={teacher.scholarSel}
                    onScholarSelChange={teacher.onScholarSelChange}
                    hasWorldTarget={teacher.hasWorldTarget}
                    worldBudget={teacher.worldBudget}
                    onWorldBudgetChange={teacher.setWorldBudget}
                    isSingleActivity={isSingleActivity}
                    deliverNow={teacher.deliverNow}
                    setDeliverNow={teacher.setDeliverNow}
                    mode={teacher.mode}
                    setMode={teacher.setMode}
                    startsAt={teacher.startsAt}
                    setStartsAt={teacher.setStartsAt}
                    durationMin={teacher.durationMin}
                    setDurationMin={teacher.setDurationMin}
                    dueAt={teacher.dueAt}
                    setDueAt={teacher.setDueAt}
                    effectiveForSel={teacher.effectiveForSel}
                    setForSel={teacher.setForSel}
                    forScholarIds={teacher.forScholarIds}
                    handleForSelChange={teacher.handleForSelChange}
                    isPast={teacher.isPast}
                    targetKind={targetKind}
                  />
                )}
                </Stack>
              )}
            </Dialog.Body>

            <Box
              borderTop="1px solid"
              borderTopColor="gray.200"
              bg="white"
              px={6}
              py={4}
            >
              {confirmDraft && teacher.selectedUnitIsDraft && (
                <HStack
                  gap={2}
                  px={3}
                  py={2}
                  mb={3}
                  bg="orange.50"
                  borderWidth="1px"
                  borderColor="orange.200"
                  borderRadius="md"
                >
                  <Warning
                    size={16}
                    color="var(--chakra-colors-orange-500)"
                  />
                  <Text fontSize="xs" color="orange.700" fontFamily="heading">
                    This unit is still a draft — assign anyway?
                  </Text>
                </HStack>
              )}
              <Flex justify="flex-end" gap={2}>
                <Button
                  variant="ghost"
                  onClick={requestClose}
                  disabled={submitting}
                >
                  Cancel
                </Button>
                <Button
                  bg="violet.500"
                  color="white"
                  _hover={{ bg: "violet.600" }}
                  disabled={!canStart}
                  onClick={handleStart}
                >
                  {submitting ? (
                    <>
                      <Spinner size="xs" mr={2} />{" "}
                      {programTarget
                        ? "Scheduling..."
                        : isSingleActivity && teacher.deliverNow
                          ? "Starting..."
                          : "Assigning..."}
                    </>
                  ) : programTarget ? (
                    programTarget.scheduleTarget.mode === "classFocus"
                      ? "Add to class"
                      : "Schedule homework"
                  ) : confirmDraft && teacher.selectedUnitIsDraft ? (
                    "Assign anyway"
                  ) : isSingleActivity && teacher.deliverNow ? (
                    "Start now"
                  ) : (
                    "Assign"
                  )}
                </Button>
              </Flex>
              {programTarget &&
                !!pickedActivityId &&
                !program.materialsReady && (
                  <Text
                    mt={2}
                    textAlign="right"
                    fontSize="xs"
                    color="charcoal.400"
                  >
                    {program.createdHandoutId === pickedActivityId
                      ? program.createdHandoutTitle.trim()
                        ? "Add at least one file, link, or video before scheduling this handout."
                        : "Name this handout before scheduling it."
                      : "This offline activity has no materials. Add materials in Curriculum before scheduling it."}
                  </Text>
                )}
            </Box>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

