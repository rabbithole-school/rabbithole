"use client";

// The program schedule / Handout mode of StartAssignmentDialog, as a hook that
// owns this mode's state, queries, mutations, derived values, validation, and
// submit. The shell calls it unconditionally and reads its result only when a
// programTarget is present; while inactive every query "skip"s exactly as it
// did when this lived inline (TRA-21).
//
// The teacher-only resets the original inline handlers performed (setForSel,
// setConfirmDraft) are intentionally omitted here: programTarget is fixed for a
// dialog's lifetime, so those teacher states are never read in this mode and
// stay at their opened values. Submit delegates to the tested pure builder in
// submitPlans.ts; the async orchestration stays here where the mutations live.

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { toaster } from "@/lib/toaster";
import { fmtTimeRange } from "@/components/MasterSchedule/timeFormat";
import { buildProgramSchedulePlan } from "./submitPlans";
import type { ProgramSearchResult } from "./ProgramScheduleSection";
import type { StartAssignmentProgramTarget } from "./types";

type UnitsList = NonNullable<
  ReturnType<typeof useQuery<typeof api.units.list>>
>;
type LessonsList = NonNullable<
  ReturnType<typeof useQuery<typeof api.lessons.listByUnit>>
>;

interface ProgramScheduleModeArgs {
  open: boolean;
  /** Present when the dialog is in program mode; absent means this mode is
   *  inactive and every query below "skip"s. */
  programTarget: StartAssignmentProgramTarget | undefined;
  viewingAsReadOnly: boolean;
  pickedUnitId: Id<"units"> | null;
  pickedActivityId: Id<"activities"> | null | undefined;
  effectivePickedLessonId: Id<"lessons"> | null | undefined;
  targetKind: "unit" | "lesson" | "activity";
  setPickedUnitId: (value: Id<"units"> | null) => void;
  setPickedLessonId: (value: Id<"lessons"> | null | undefined) => void;
  setPickedActivityId: (value: Id<"activities"> | null | undefined) => void;
  units: UnitsList | undefined;
  lessons: LessonsList | undefined;
  submitting: boolean;
  setSubmitting: (value: boolean) => void;
  onStarted?: () => void;
  onClose: () => void;
}

export function useProgramScheduleMode(args: ProgramScheduleModeArgs) {
  const {
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
  } = args;

  const [programSearch, setProgramSearch] = useState("");
  const [programSearchIndex, setProgramSearchIndex] = useState(0);
  const [homeworkDate, setHomeworkDate] = useState(() => new Date());
  const [createdHandoutId, setCreatedHandoutId] =
    useState<Id<"activities"> | null>(null);
  const [createdHandoutAssignmentId, setCreatedHandoutAssignmentId] =
    useState<Id<"assignments"> | null>(null);
  const [showCreatedHandoutComposer, setShowCreatedHandoutComposer] =
    useState(false);
  const [createdHandoutTitle, setCreatedHandoutTitle] = useState("");
  const [creatingHandout, setCreatingHandout] = useState(false);

  // Edge-detects closed→open so the per-open reset runs exactly once — the same
  // trigger as the shell's and teacher hook's reset effects, each resetting its
  // own state to identical initial values.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = open;
    if (!open || wasOpen) return;
    const now = Date.now();
    setProgramSearch("");
    setProgramSearchIndex(0);
    setHomeworkDate(
      new Date(
        programTarget?.scheduleTarget.mode === "homework"
          ? programTarget.scheduleTarget.dueDateMs
          : now,
      ),
    );
    setCreatedHandoutId(null);
    setCreatedHandoutAssignmentId(null);
    setShowCreatedHandoutComposer(false);
    setCreatedHandoutTitle("");
    setCreatingHandout(false);
  }, [open, programTarget?.scheduleTarget]);

  const programUnitActivities = useQuery(
    api.activities.listByUnitPublic,
    open && programTarget && pickedUnitId
      ? { unitId: pickedUnitId, includeResources: true }
      : "skip",
  );
  const programSearchResults = useQuery(
    api.masterSchedule.searchProgramCurriculum,
    open && programTarget && programSearch.trim().length >= 2
      ? {
          groupId: programTarget.groupId,
          query: programSearch.trim(),
          limit: 20,
        }
      : "skip",
  );
  // The single source for "no curriculum access at this group's school" —
  // checked independently of any search string so the unit column (which
  // never calls the search query) can show the same explanation as soon as
  // the dialog opens, instead of a silent empty units list (TRA-327).
  // `searchProgramCurriculum` deliberately does not carry a second copy of
  // this signal.
  const programCurriculumAccess = useQuery(
    api.masterSchedule.programGroupCurriculumAccess,
    open && programTarget ? { groupId: programTarget.groupId } : "skip",
  );
  const curriculumAccessDenied =
    programCurriculumAccess && !programCurriculumAccess.hasCurriculumAccess
      ? { institutionName: programCurriculumAccess.institutionName }
      : null;
  const createdHandoutResources = useQuery(
    api.activityResources.listForActivity,
    open && createdHandoutId
      ? {
          activityId: createdHandoutId,
          ...(createdHandoutAssignmentId
            ? { assignmentId: createdHandoutAssignmentId }
            : {}),
        }
      : "skip",
  );

  const activitiesInLesson = useMemo(
    () =>
      programUnitActivities?.filter(
        (activity) => activity.lessonId === effectivePickedLessonId,
      ),
    [effectivePickedLessonId, programUnitActivities],
  );

  const createProgramHandoutDraft = useMutation(
    api.masterSchedule.createProgramHandoutDraft,
  );
  const updateProgramHandout = useMutation(
    api.masterSchedule.updateProgramHandout,
  );
  const placeProgramHandout = useMutation(
    api.masterSchedule.placeProgramHandout,
  );
  const placeProgramActivity = useMutation(
    api.masterSchedule.placeProgramActivity,
  );
  const discardProgramHandoutDraft = useMutation(
    api.masterSchedule.discardProgramHandoutDraft,
  );

  const selectedProgramActivity = useMemo(() => {
    if (!pickedActivityId || !programUnitActivities) return null;
    return (
      programUnitActivities.find(
        (candidate) => candidate._id === pickedActivityId,
      ) ?? null
    );
  }, [pickedActivityId, programUnitActivities]);
  const programResourceCount =
    selectedProgramActivity?.resources?.length ?? null;
  const createdHandoutMaterialCount =
    createdHandoutResources === undefined
      ? null
      : createdHandoutResources.length;
  const displayedProgramResourceCount =
    createdHandoutId && pickedActivityId === createdHandoutId
      ? createdHandoutMaterialCount
      : programResourceCount;

  const programScheduleLabel = useMemo(() => {
    if (!programTarget) return null;
    const target = programTarget.scheduleTarget;
    const dateLabel = new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: "Pacific/Honolulu",
    }).format(
      target.mode === "homework" ? homeworkDate : new Date(target.dateMs),
    );
    return target.mode === "homework"
      ? `Homework due ${dateLabel}`
      : `${dateLabel} · ${target.blockLabel}, ${fmtTimeRange(
          target.startLocal,
          target.endLocal,
        )}`;
  }, [homeworkDate, programTarget]);

  const targetSummary = useMemo(() => {
    if (createdHandoutId && pickedActivityId === createdHandoutId) {
      return createdHandoutTitle.trim() || "Untitled handout";
    }
    if (!pickedUnitId || !units) return null;
    if (!pickedActivityId) return null;
    const unitTitle =
      units.find((uu) => uu._id === pickedUnitId)?.title ?? "(unknown)";
    if (targetKind === "unit") return `Whole unit: ${unitTitle}`;
    const lessonTitle =
      lessons?.find((ll) => ll._id === effectivePickedLessonId)?.title ??
      "lesson";
    if (targetKind === "lesson") {
      return `${unitTitle} → ${lessonTitle} (whole lesson)`;
    }
    const actTitle =
      createdHandoutId && pickedActivityId === createdHandoutId
        ? createdHandoutTitle.trim() || "Untitled handout"
        : (activitiesInLesson?.find((aa) => aa._id === pickedActivityId)
            ?.title ?? "activity");
    return `${unitTitle} → ${lessonTitle} → ${actTitle}`;
  }, [
    pickedUnitId,
    effectivePickedLessonId,
    pickedActivityId,
    units,
    lessons,
    activitiesInLesson,
    createdHandoutId,
    createdHandoutTitle,
    targetKind,
  ]);

  const materialsReady =
    !pickedActivityId ||
    (createdHandoutId === pickedActivityId
      ? createdHandoutTitle.trim().length > 0 &&
        (createdHandoutMaterialCount ?? 0) > 0
      : selectedProgramActivity?.kind !== "offline" ||
        (programResourceCount ?? 0) > 0);
  // In program mode the teacher-only terms of the original shared `canStart`
  // (deliver-now, startsAt finiteness, world-budget validity) are constant —
  // this mode never renders that UI — so they reduce to the two conditions below
  // exactly as the shared expression did under a programTarget.
  const canStart =
    !!pickedActivityId && materialsReady && !viewingAsReadOnly && !submitting;

  const saveCreatedHandoutTitle = async () => {
    if (viewingAsReadOnly || !createdHandoutId || !createdHandoutAssignmentId) {
      return;
    }
    const title = createdHandoutTitle.trim();
    if (!title) throw new Error("Name this handout before scheduling it.");
    setCreatedHandoutTitle(title);
    await updateProgramHandout({
      activityId: createdHandoutId,
      assignmentId: createdHandoutAssignmentId,
      title,
    });
  };

  const handleCreateHandout = async () => {
    if (!programTarget || creatingHandout || viewingAsReadOnly) return;
    if (createdHandoutId && createdHandoutAssignmentId) {
      setPickedUnitId(null);
      setPickedLessonId(undefined);
      setPickedActivityId(createdHandoutId);
      setShowCreatedHandoutComposer(true);
      return;
    }
    setCreatingHandout(true);
    try {
      const draft = await createProgramHandoutDraft({
        periodId: programTarget.periodId,
        groupId: programTarget.groupId,
        title: "Handout",
      });
      setCreatedHandoutId(draft.activityId);
      setCreatedHandoutAssignmentId(draft.assignmentId);
      setShowCreatedHandoutComposer(true);
      setCreatedHandoutTitle("");
      setPickedUnitId(null);
      setPickedLessonId(undefined);
      setPickedActivityId(draft.activityId);
    } catch (error) {
      toaster.error({
        title: "Couldn’t create handout",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setCreatingHandout(false);
    }
  };

  const chooseProgramSearchResult = (result: ProgramSearchResult) => {
    setPickedUnitId(result.unitId);
    setPickedLessonId(result.kind === "unit" ? undefined : result.lessonId);
    setPickedActivityId(
      result.kind === "activity" ? result.activityId : undefined,
    );
    setProgramSearch("");
    setProgramSearchIndex(0);
  };

  const requestClose = () => {
    const draft =
      createdHandoutId && createdHandoutAssignmentId
        ? { activityId: createdHandoutId, assignmentId: createdHandoutAssignmentId }
        : null;
    setCreatedHandoutId(null);
    setCreatedHandoutAssignmentId(null);
    onClose();
    if (draft && !viewingAsReadOnly) {
      void discardProgramHandoutDraft(draft).catch((error) => {
        toaster.error({
          title: "Couldn’t discard the unfinished handout",
          description: error instanceof Error ? error.message : String(error),
        });
      });
    }
  };

  const submit = async () => {
    if (!programTarget || viewingAsReadOnly || !canStart) {
      return;
    }
    setSubmitting(true);
    try {
      const plan = buildProgramSchedulePlan({
        createdHandoutId,
        createdHandoutAssignmentId,
        pickedActivityId,
        periodId: programTarget.periodId,
        groupId: programTarget.groupId,
        subject: programTarget.subject,
        groupName: programTarget.groupName,
        scheduleTarget:
          programTarget.scheduleTarget.mode === "classFocus"
            ? {
                mode: "classFocus",
                blockId: programTarget.scheduleTarget
                  .blockId as Id<"scheduleBlocks">,
                weekday: programTarget.scheduleTarget.weekday,
                weekStartMs: programTarget.scheduleTarget.weekStartMs,
              }
            : {
                mode: "homework",
                dueDateMs: homeworkDate.getTime(),
              },
      });
      if (plan.abandonDraft) {
        const abandonedDraft = plan.abandonDraft;
        setCreatedHandoutId(null);
        setCreatedHandoutAssignmentId(null);
        try {
          await discardProgramHandoutDraft(abandonedDraft);
        } catch (error) {
          setCreatedHandoutId(abandonedDraft.activityId);
          setCreatedHandoutAssignmentId(abandonedDraft.assignmentId);
          throw error;
        }
      }
      if (plan.keptDraft) {
        await saveCreatedHandoutTitle();
      }
      if (plan.place.kind === "handout") {
        await placeProgramHandout(plan.place.args);
      } else {
        await placeProgramActivity(plan.place.args);
      }
      toaster.success({
        title:
          programTarget.scheduleTarget.mode === "classFocus"
            ? "Work added to class"
            : "Homework scheduled",
        description: `${programTarget.groupName} · ${programScheduleLabel}.`,
      });
      onStarted?.();
      onClose();
    } catch (e) {
      toaster.error({
        title: "Couldn’t schedule work",
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return {
    programSearch,
    setProgramSearch,
    programSearchIndex,
    setProgramSearchIndex,
    programSearchResults,
    curriculumAccessDenied,
    chooseProgramSearchResult,
    homeworkDate,
    setHomeworkDate,
    createdHandoutId,
    createdHandoutAssignmentId,
    createdHandoutTitle,
    setCreatedHandoutTitle,
    showCreatedHandoutComposer,
    setShowCreatedHandoutComposer,
    creatingHandout,
    handleCreateHandout,
    saveCreatedHandoutTitle,
    programUnitActivities,
    displayedProgramResourceCount,
    materialsReady,
    scheduleLabel: programScheduleLabel,
    activitiesInLesson,
    targetSummary,
    canStart,
    submit,
    requestClose,
  };
}
