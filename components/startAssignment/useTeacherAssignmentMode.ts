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
import { isStructurallyDraft } from "@/convex/lib/unitMaturity";
import {
  isSimulatorRunBudgetValid,
  type SimulatorRunBudgetValue,
} from "@/components/simulatorTeacher/SimulatorRunBudgetFields";
import type { ActivityMode } from "@/lib/activityMode";
import {
  initialRosterSelectionState,
  rosterSelectionReducer,
} from "@/components/startAssignmentRoster";
import type { RosterScholar } from "@/hooks/useScholarRoster";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { isTeacherRole } from "@/convex/lib/roles";
import { buildTeacherAssignmentPlan } from "./submitPlans";
import { DAY, nextNineAm, toLocalInputValue } from "./scheduling";
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
  // Scheduling — assigning ALWAYS picks a time now (no more dateless,
  // inert assignments). Mode/duration/due apply to a single-activity
  // assign; cadence applies when laying out a whole unit/lesson.
  const [now0, setNow0] = useState(() => Date.now());
  const [mode, setMode] = useState<ActivityMode>("classFocus");
  // Single-activity delivery: start it live right now vs plan it on the
  // calendar (the classic behaviour). Only consulted when the picked target
  // is one activity; unit/lesson always plan. Defaults to "now" — the whole
  // point of assigning an activity from here is to reach scholars.
  const [deliverNow, setDeliverNow] = useState(true);
  const [startsAt, setStartsAt] = useState<string>(() =>
    toLocalInputValue(nextNineAm(Date.now())),
  );
  const [durationMin, setDurationMin] = useState(60);
  const [dueAt, setDueAt] = useState<string>(() =>
    toLocalInputValue(nextNineAm(Date.now()) + 7 * DAY),
  );
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
    setMode("classFocus");
    setDeliverNow(true);
    setNow0(now);
    setStartsAt(toLocalInputValue(nextNineAm(now)));
    setDueAt(toLocalInputValue(nextNineAm(now) + 7 * DAY));
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
  const pushActivity = useMutation(api.assignments.pushActivity);

  // World detection from already-loaded lesson activities: true when the picked
  // activity is a World, or the picked lesson contains one. (Whole-unit assigns
  // set the budget later on the Run page.)
  const hasWorldTarget = (activitiesInLesson ?? []).some((a) =>
    pickedActivityId
      ? a._id === pickedActivityId && a.kind === "simulator"
      : a.kind === "simulator",
  );

  const startsMs = useMemo(() => new Date(startsAt).getTime(), [startsAt]);
  const isPast = Number.isFinite(startsMs) && startsMs <= now0;
  const forScholarIds = useMemo(() => Array.from(scholarSel), [scholarSel]);
  const effectiveForSel = useMemo(() => {
    if (forSel === null) return null;
    const allowed = new Set(forScholarIds);
    return new Set(Array.from(forSel).filter((id) => allowed.has(id)));
  }, [forSel, forScholarIds]);

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
    ((isSingleActivity && deliverNow) || Number.isFinite(startsMs)) &&
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
    if (viewingAsReadOnly || !canStart || !pickedUnitId) {
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
        mode,
        durationMin,
        dueAt,
        scholarSel,
        effectiveForSel,
        startsMs,
        now,
        hasWorldTarget,
        worldBudget,
        worldBudgetIsValid: isSimulatorRunBudgetValid(worldBudget),
      });
      // A single activity can be delivered live now; unit/lesson always plan.
      const liveNow = plan.pushActivity !== null;

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

      // Live delivery: stamp the activity live now so scholars see it
      // immediately (assignWork alone only PLANS it). Mirrors the Schedule
      // page's "Assign now" path (assignWork → pushActivity). A push failure
      // after assignWork succeeded is a PARTIAL result — the assignment
      // exists, planned — so it must not be reported as "nothing happened".
      if (plan.pushActivity) {
        try {
          await pushActivity({
            assignmentId: newId,
            ...plan.pushActivity,
          });
        } catch (pushErr) {
          toaster.error({
            title: "Assigned, but couldn't start it live",
            description: `The assignment was created (planned) — use Start now on its Run page. ${pushErr instanceof Error ? pushErr.message : String(pushErr)}`,
          });
          onStarted?.();
          onClose();
          router.push(`/teacher/schedule/${newId}`);
          return;
        }
      }

      const pushCount = plan.pushActivity?.scholarIds
        ? plan.pushActivity.scholarIds.length
        : scholarSel.size;
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
        description: e instanceof Error ? e.message : String(e),
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
    mode,
    setMode,
    deliverNow,
    setDeliverNow,
    startsAt,
    setStartsAt,
    durationMin,
    setDurationMin,
    dueAt,
    setDueAt,
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
