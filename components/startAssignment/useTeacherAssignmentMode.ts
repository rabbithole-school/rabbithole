"use client";

// The teacher-assignment mode of StartAssignmentDialog, as a hook that owns
// this mode's state, queries, mutations, derived values, validation, and
// submit. The shell calls it unconditionally and reads its result only when
// there is no programTarget; while inactive every query "skip"s exactly as it
// did when this lived inline (TRA-21).
//
// Submit delegates to the tested pure builder in submitPlans.ts; the async
// orchestration (await ordering, partial-failure toasts, navigation) stays
// here where the mutations live.

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { toaster } from "@/lib/toaster";
import { serverErrorMessage } from "@/lib/serverErrorMessage";
import { isStructurallyDraft } from "@/convex/lib/unitMaturity";
import {
  isSimulatorRunBudgetValid,
  type SimulatorRunBudgetValue,
} from "@/components/simulatorTeacher/SimulatorRunBudgetFields";
import {
  showsUpAt,
  useGiveChoices,
  useMinuteNow,
  type GiveFinish,
  type ShowsUp,
} from "@/components/GiveWindowFields";
import {
  initialRosterSelectionState,
  rosterSelectionReducer,
} from "@/components/startAssignmentRoster";
import type { RosterScholar } from "@/hooks/useScholarRoster";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { isTeacherRole } from "@/convex/lib/roles";
import { buildTeacherAssignmentPlan } from "./submitPlans";
import type { StartAssignmentProgramTarget } from "./types";

type UnitsList = NonNullable<
  ReturnType<typeof useQuery<typeof api.units.list>>
>;
type LessonsList = NonNullable<
  ReturnType<typeof useQuery<typeof api.lessons.listByUnit>>
>;

interface TeacherAssignmentModeArgs {
  open: boolean;
  /** Present only to skip this mode's queries when the dialog is in program
   *  mode; this mode's UI is never rendered then. */
  programTarget: StartAssignmentProgramTarget | undefined;
  viewingAsReadOnly: boolean;
  initialScholarIds: readonly Id<"users">[] | undefined;
  pickedUnitId: Id<"units"> | null;
  pickedLessonId: Id<"lessons"> | null | undefined;
  pickedActivityId: Id<"activities"> | null | undefined;
  effectivePickedLessonId: Id<"lessons"> | null | undefined;
  targetKind: "unit" | "lesson" | "activity";
  isSingleActivity: boolean;
  units: UnitsList | undefined;
  lessons: LessonsList | undefined;
  submitting: boolean;
  setSubmitting: (value: boolean) => void;
  onStarted?: () => void;
  onClose: () => void;
  router: ReturnType<typeof useRouter>;
}

export function useTeacherAssignmentMode(args: TeacherAssignmentModeArgs) {
  const {
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
  } = args;

  // The scholar selection is a small per-open state machine (seed on open,
  // settle once against the loaded roster, then it's the teacher's). It lives
  // in components/startAssignmentRoster.ts so those transitions are testable.
  const [roster, dispatchRoster] = useReducer(
    rosterSelectionReducer,
    initialRosterSelectionState,
  );
  const scholarSel = roster.selection;
  const [forSel, setForSel] = useState<Set<string> | null>(null);
  // Giving work asks two questions (TRA-571): when it shows up, and when
  // they should finish it. "Now" delivers a single activity live; a unit or
  // lesson plans at the chosen time. The finish starts unanswered, and the
  // Assign button stays disabled until the teacher picks one.
  const [now0, setNow0] = useState(() => Date.now());
  const nowMs = useMinuteNow();
  const [showsUp, setShowsUp] = useState<ShowsUp>({ kind: "now" });
  const [finish, setFinish] = useState<GiveFinish | null>(null);
  const [worldBudget, setWorldBudget_] = useState<SimulatorRunBudgetValue>({
    perBlock: 3,
    perWeek: 12,
    seasonTicks: null,
  });
  // Edge-detects closed→open so the per-open reset runs exactly once. A
  // re-render with new initial* props while open must never clobber the
  // teacher's in-progress edits.
  const wasOpenRef = useRef(false);

  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = open;
    if (!open || wasOpen) return;
    const now = Date.now();
    // Preselect the roster when opened with initialScholarIds (e.g. the
    // Concept Atlas "Assign to this group" cue). Seeded verbatim here; the
    // settle below drops any id absent from the loaded roster.
    dispatchRoster({ type: "opened", initialScholarIds });
    setForSel(null);
    setShowsUp({ kind: "now" });
    setFinish(null);
    setNow0(now);
    setWorldBudget_({ perBlock: 3, perWeek: 12, seasonTicks: null });
  }, [open, initialScholarIds]);

  // A curriculum:run holder is not a teacher: she has no roster read, only
  // the assignee picker for the picked unit's school (identity fields only).
  const { user } = useCurrentUser();
  const isCurriculumRunner =
    !!user &&
    !isTeacherRole(user.role) &&
    user.hasCurriculumRunAccess === true;
  const teacherScholars = useQuery(
    api.users.listScholars,
    open && !programTarget && !isCurriculumRunner ? {} : "skip",
  );
  const runnerScholars = useQuery(
    api.assignments.assignableScholarsForRunner,
    open && !programTarget && isCurriculumRunner
      ? pickedUnitId
        ? { unitId: pickedUnitId }
        : {}
      : "skip",
  );
  const scholars = isCurriculumRunner ? runnerScholars : teacherScholars;
  const runnerRoster = useMemo<RosterScholar[] | undefined>(
    () =>
      isCurriculumRunner
        ? runnerScholars?.map((scholar) => ({
            id: String(scholar.id),
            name: scholar.name,
            username: scholar.username,
            image: scholar.image,
            readingLevel: null,
            gradeLevel: null,
            dateOfBirth: null,
            lastMessageAt: null,
            groupIds: [],
            isMine: false,
            enrollmentStanding: scholar.enrollmentStanding,
          }))
        : undefined,
    [isCurriculumRunner, runnerScholars],
  );
  const teacherActivitiesInLesson = useQuery(
    api.activities.listByLesson,
    open && !programTarget && pickedLessonId
      ? { lessonId: pickedLessonId }
      : "skip",
  );
  const activitiesInLesson = teacherActivitiesInLesson;

  // Settle the selection once per open, as soon as the roster resolves: default
  // to everyone when the opener expressed no preference, otherwise keep the
  // preselection minus ids the roster doesn't contain (stale / out-of-lens) so
  // they can't reach assignWork. Driven by `roster.settled` rather than by
  // effect ordering, so a reopen re-settles no matter which effect React runs
  // first, and even when the cached roster array is identity-stable.
  useEffect(() => {
    if (!open || programTarget || !scholars || roster.settled) return;
    dispatchRoster({
      type: "rosterLoaded",
      rosterIds: scholars.map((s) => String(s.id)),
    });
  }, [open, programTarget, scholars, roster.settled]);

  const assignWork = useMutation(api.assignments.assignWork);
  // World cohorts can set a per-assignment run budget + season at Assign time
  // (plan §8). Detection reuses the already-loaded lesson activities (no separate
  // query): the budget block shows when the picked lesson/activity is a World.
  // Whole-unit assigns set the budget on the Run page (its canonical home).
  const setWorldBudget = useMutation(api.simulatorTeacher.setAssignmentWorldBudget);

  // World detection from already-loaded lesson activities: true when the picked
  // activity is a World, or the picked lesson contains one. (Whole-unit assigns
  // set the budget later on the Run page.)
  const hasWorldTarget = (activitiesInLesson ?? []).some((a) =>
    pickedActivityId
      ? a._id === pickedActivityId && a.kind === "simulator"
      : a.kind === "simulator",
  );

  const deliverNow = showsUp.kind === "now";
  const startsMs = showsUpAt(showsUp, nowMs);
  const isPast = showsUp.kind === "at" && startsMs <= now0;
  const forScholarIds = useMemo(() => Array.from(scholarSel), [scholarSel]);
  const effectiveForSel = useMemo(() => {
    if (forSel === null) return null;
    const allowed = new Set(forScholarIds);
    return new Set(Array.from(forSel).filter((id) => allowed.has(id)));
  }, [forSel, forScholarIds]);

  // The give form's choices: this roster's bell blocks, when "in that class"
  // ends, and what "the end of the unit" means for the assignment this give
  // would land on.
  const giveScholarIds = useMemo(
    () =>
      (isSingleActivity && effectiveForSel && effectiveForSel.size > 0
        ? Array.from(effectiveForSel)
        : forScholarIds) as Id<"users">[],
    [isSingleActivity, effectiveForSel, forScholarIds],
  );
  const giveChoices = useGiveChoices(
    open && !programTarget && pickedUnitId && giveScholarIds.length > 0
      ? {
          unitId: pickedUnitId,
          scholarIds: giveScholarIds,
          activityId: pickedActivityId ?? undefined,
          startsAt: startsMs,
        }
      : "skip",
    nowMs,
  );

  const handleForSelChange = (next: Set<string>) => {
    const allowed = new Set(scholarSel);
    setForSel(new Set(Array.from(next).filter((id) => allowed.has(id))));
  };

  const targetSummary = useMemo(() => {
    if (!pickedUnitId || !units) return null;
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
      activitiesInLesson?.find((aa) => aa._id === pickedActivityId)?.title ??
      "activity";
    return `${unitTitle} → ${lessonTitle} → ${actTitle}`;
  }, [
    pickedUnitId,
    effectivePickedLessonId,
    pickedActivityId,
    units,
    lessons,
    activitiesInLesson,
    targetKind,
  ]);

  const worldBudgetValid =
    !hasWorldTarget || isSimulatorRunBudgetValid(worldBudget);
  const canStart =
    scholarSel.size > 0 &&
    !!pickedUnitId &&
    !!finish &&
    (!isSingleActivity || !!pickedActivityId) &&
    worldBudgetValid &&
    !viewingAsReadOnly &&
    !submitting;

  // Structural Draft of the PICKED unit — cheap completeness check off the
  // unit + its lessons already in hand (the same pure helper the Quests board
  // uses), NOT the per-node maturity query. Drives a soft "assign anyway?"
  // confirm; false while lessons are still loading so it never blocks.
  const selectedUnitIsDraft = useMemo(() => {
    if (!pickedUnitId || !units || lessons === undefined) return false;
    const unit = units.find((uu) => uu._id === pickedUnitId);
    if (!unit) return false;
    return isStructurallyDraft(
      {
        bigIdea: unit.bigIdea,
        essentialQuestions: unit.essentialQuestions?.map((g) => g.text),
        enduringUnderstandings: unit.enduringUnderstandings?.map((g) => g.text),
      },
      lessons.map((l) => ({ strand: l.strand, systemPrompt: l.systemPrompt })),
    );
  }, [pickedUnitId, units, lessons]);

  const submit = async () => {
    if (viewingAsReadOnly || !canStart || !pickedUnitId || !finish) {
      return;
    }
    setSubmitting(true);
    try {
      const now = Date.now();
      const plan = buildTeacherAssignmentPlan({
        pickedUnitId,
        pickedLessonId,
        pickedActivityId,
        targetKind,
        isSingleActivity,
        deliverNow,
        finish,
        scholarSel,
        effectiveForSel,
        startsMs,
        now,
        hasWorldTarget,
        worldBudget,
        worldBudgetIsValid: isSimulatorRunBudgetValid(worldBudget),
      });
      // An answered give goes live inside assignWork when it shows up now.
      const liveNow = plan.liveNow;

      const newId = await assignWork(plan.assignWork);

      // A World cohort's per-scholar run budget + season is execution policy set
      // here at Assign; non-fatal if it fails — the Run page can set it too
      // (plan §8). Only for assigns whose target is/contains a World.
      if (plan.worldBudget) {
        try {
          await setWorldBudget({
            assignmentId: newId,
            ...plan.worldBudget,
          });
        } catch (budgetError) {
          toaster.error({
            title: "Assigned, but the Simulator run budget wasn't saved",
            description: `The assignment is using the default budget; adjust it on the Run page. ${budgetError instanceof Error ? budgetError.message : String(budgetError)}`,
          });
        }
      }

      const pushCount = plan.liveScholarCount;
      toaster.success(
        liveNow
          ? {
              title: "Started — it's live now",
              description: `Live for ${pushCount} scholar${pushCount === 1 ? "" : "s"}.`,
            }
          : {
              title: isPast
                ? "Assigned — start it manually (time is in the past)"
                : "Assigned",
              description: isSingleActivity
                ? `Scheduled for ${scholarSel.size} scholar${scholarSel.size === 1 ? "" : "s"}.`
                : `Laid out on the agenda for ${scholarSel.size} scholar${scholarSel.size === 1 ? "" : "s"}.`,
            },
      );
      onStarted?.();
      onClose();
      router.push(`/teacher/schedule/${newId}`);
    } catch (e) {
      toaster.error({
        title:
          isSingleActivity && deliverNow ? "Failed to start" : "Failed to assign",
        description: serverErrorMessage(e, "Check your connection and try again."),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return {
    scholarSel,
    /** Set only for a curriculum:run holder: the assignee picker's roster. */
    runnerRoster,
    onScholarSelChange: (selection: Set<string>) =>
      dispatchRoster({ type: "selectionChanged", selection }),
    forSel,
    setForSel,
    effectiveForSel,
    forScholarIds,
    handleForSelChange,
    /** Reset the per-activity "For" subset on a generic hierarchy pick. */
    onPickReset: () => setForSel(null),
    nowMs,
    giveChoices,
    showsUp,
    setShowsUp,
    finish,
    setFinish,
    deliverNow,
    worldBudget,
    setWorldBudget: setWorldBudget_,
    hasWorldTarget,
    isPast,
    activitiesInLesson,
    targetSummary,
    selectedUnitIsDraft,
    canStart,
    submit,
    requestClose: onClose,
  };
}
