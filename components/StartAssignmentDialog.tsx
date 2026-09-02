"use client";

// Modal: start a class assignment. Finder-style multi-column picker:
// Unit → Lesson → Activity. (Quests removed in the kill-quests
// refactor — the dialog now opens directly into the unit picker.)

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import {
  Box,
  Button,
  chakra,
  Dialog,
  Flex,
  Heading,
  HStack,
  IconButton,
  Input,
  Portal,
  Spinner,
  Stack,
  Text,
  Tooltip,
} from "@chakra-ui/react";
import {
  ArrowLeft,
  FileText,
  MagnifyingGlass,
  Warning,
  X,
} from "@phosphor-icons/react";
import { ACTIVITY_KIND } from "@/lib/activityKinds";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { ScholarPicker } from "@/components/ScholarPicker";
import {
  initialRosterSelectionState,
  rosterSelectionReducer,
} from "@/components/startAssignmentRoster";
import {
  SimulatorRunBudgetFields,
  isSimulatorRunBudgetValid,
  type SimulatorRunBudgetValue,
} from "@/components/simulatorTeacher/SimulatorRunBudgetFields";
import { ActivityModeBadge, type ActivityMode } from "@/lib/activityMode";
import { toaster } from "@/lib/toaster";
import { isStructurallyDraft } from "@/convex/lib/unitMaturity";
import {
  EmojiPlaceholder,
  HierarchyColumn,
  HierarchyRow,
} from "@/components/hierarchy";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useViewingContext } from "@/hooks/useViewingContext";
import {
  SubjectFilterChips,
  UnitAuthorFilterMenu,
  unitAuthorOptions,
  unitMatchesFilters,
} from "@/components/SubjectFilterChips";
import { uniqueSubjects } from "@/lib/subjects";
import { ResourcesEditor } from "@/components/nodeEditor/ResourcesSection";
import { CalendarDatePicker } from "@/components/ui/CalendarDatePicker";
import { fmtTimeRange } from "@/components/MasterSchedule/timeFormat";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const DURATIONS = [
  { label: "30 min", min: 30 },
  { label: "45 min", min: 45 },
  { label: "1 hour", min: 60 },
  { label: "90 min", min: 90 },
  { label: "2 hours", min: 120 },
];

function toLocalInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/** A sensible future default: the next time it's 9:00 AM (today if it's
 *  still before 9, else tomorrow) — so the dialog never opens on a past
 *  time. */
function nextNineAm(now: number): number {
  const d = new Date(now);
  if (d.getHours() >= 9) d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}

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
  programTarget?: {
    groupId: Id<"scholarGroups">;
    groupName: string;
    institutionScope?: string;
    periodId: Id<"reportingPeriods">;
    subject?: string;
    scheduleTarget:
      | {
          mode: "classFocus";
          placementId: string;
          blockId: string;
          weekday: number;
          dateMs: number;
          weekStartMs: number;
          blockLabel: string;
          startLocal: string;
          endLocal: string;
        }
      | {
          mode: "homework";
          dueDateMs: number;
        };
  };
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
  const [pickedUnitId, setPickedUnitId] = useState<Id<"units"> | null>(null);
  // null = "Whole unit (no lesson lock)". undefined = no choice yet.
  const [pickedLessonId, setPickedLessonId] = useState<
    Id<"lessons"> | null | undefined
  >(undefined);
  const [pickedActivityId, setPickedActivityId] = useState<
    Id<"activities"> | null | undefined
  >(undefined);
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
  const [unitAuthorFilterOverride, setUnitAuthorFilterOverride] = useState<
    string | null
  >(null);
  const [unitSubjectFilter, setUnitSubjectFilter] = useState<string | null>(null);
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
  const [submitting, setSubmitting] = useState(false);
  // One-tap soft confirm when the picked unit is still structurally Draft.
  // Surface, never a hard gate — assign-at-any-maturity is intentional.
  const [confirmDraft, setConfirmDraft] = useState(false);
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
    setPickedUnitId(initialUnitId ?? null);
    // Prefill the node target when opened from a lesson/activity Assign tab
    // (undefined = "no choice yet / whole unit").
    setPickedLessonId(initialLessonId ?? undefined);
    setPickedActivityId(initialActivityId ?? undefined);
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
    setUnitAuthorFilterOverride(null);
    setUnitSubjectFilter(null);
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
    setSubmitting(false);
    setConfirmDraft(false);
  }, [
    open,
    initialUnitId,
    initialLessonId,
    initialActivityId,
    initialScholarIds,
    programTarget?.scheduleTarget,
  ]);

  const units = useQuery(
    api.units.list,
    open
      ? programTarget
        ? { scope: programTarget.institutionScope }
        : {}
      : "skip",
  );
  const scholars = useQuery(
    api.users.listScholars,
    open && !programTarget ? {} : "skip",
  );
  const lessons = useQuery(
    api.lessons.listByUnit,
    open && pickedUnitId ? { unitId: pickedUnitId } : "skip",
  );
  const teacherActivitiesInLesson = useQuery(
    api.activities.listByLesson,
    open && !programTarget && pickedLessonId
      ? { lessonId: pickedLessonId }
      : "skip",
  );
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
  const effectivePickedLessonId =
    programTarget && !pickedLessonId && lessons?.length === 1
      ? lessons[0]._id
      : pickedLessonId;
  const activitiesInLesson = useMemo(
    () =>
      programTarget
        ? programUnitActivities?.filter(
            (activity) => activity.lessonId === effectivePickedLessonId,
          )
        : teacherActivitiesInLesson,
    [
      effectivePickedLessonId,
      programTarget,
      programUnitActivities,
      teacherActivitiesInLesson,
    ],
  );

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
  const placeProgramActivity = useMutation(
    api.masterSchedule.placeProgramActivity,
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
  const discardProgramHandoutDraft = useMutation(
    api.masterSchedule.discardProgramHandoutDraft,
  );
  // World cohorts can set a per-assignment run budget + season at Assign time
  // (plan §8). Detection reuses the already-loaded lesson activities (no separate
  // query): the budget block shows when the picked lesson/activity is a World.
  // Whole-unit assigns set the budget on the Run page (its canonical home).
  const setWorldBudget = useMutation(api.simulatorTeacher.setAssignmentWorldBudget);
  const pushActivity = useMutation(api.assignments.pushActivity);
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

  // What granularity are we assigning? A concrete activity → schedule
  // that one; a whole lesson → cadence over its activities; otherwise
  // (just a unit, or "Whole unit") → cadence over the unit. `undefined`
  // lesson is treated as the whole unit so picking a unit + Start still
  // works in one move.
  const targetKind: "unit" | "lesson" | "activity" =
    pickedActivityId ? "activity" : effectivePickedLessonId ? "lesson" : "unit";
  const isSingleActivity = targetKind === "activity";
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
    if (
      programTarget &&
      createdHandoutId &&
      pickedActivityId === createdHandoutId
    ) {
      return createdHandoutTitle.trim() || "Untitled handout";
    }
    if (!pickedUnitId || !units) return null;
    if (programTarget && !pickedActivityId) return null;
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
    programTarget,
  ]);

  const worldBudgetValid = !hasWorldTarget || isSimulatorRunBudgetValid(worldBudget);
  const programMaterialsReady =
    !programTarget ||
    !pickedActivityId ||
    (createdHandoutId === pickedActivityId
      ? createdHandoutTitle.trim().length > 0 &&
        (createdHandoutMaterialCount ?? 0) > 0
      : selectedProgramActivity?.kind !== "offline" ||
        (programResourceCount ?? 0) > 0);
  const canStart =
    (programTarget
      ? !!pickedActivityId && programMaterialsReady
      : scholarSel.size > 0) &&
    (!!programTarget || !!pickedUnitId) &&
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

  const saveCreatedHandoutTitle = async () => {
    if (
      viewingAsReadOnly ||
      !createdHandoutId ||
      !createdHandoutAssignmentId
    ) {
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
      setForSel(null);
    } catch (error) {
      toaster.error({
        title: "Couldn’t create handout",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setCreatingHandout(false);
    }
  };

  const requestClose = () => {
    const draft =
      createdHandoutId && createdHandoutAssignmentId
        ? {
            activityId: createdHandoutId,
            assignmentId: createdHandoutAssignmentId,
          }
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

  const doAssign = async () => {
    if (
      viewingAsReadOnly ||
      !canStart ||
      (!programTarget && !pickedUnitId)
    ) {
      return;
    }
    setSubmitting(true);
    try {
      if (programTarget) {
        let draft =
          createdHandoutId && createdHandoutAssignmentId
            ? {
                activityId: createdHandoutId,
                assignmentId: createdHandoutAssignmentId,
              }
            : null;
        if (draft && draft.activityId !== pickedActivityId) {
          const abandonedDraft = draft;
          draft = null;
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
        if (draft) {
          await saveCreatedHandoutTitle();
        }
        const scheduleTarget =
          programTarget.scheduleTarget.mode === "classFocus"
            ? {
                mode: "classFocus" as const,
                blockId: programTarget.scheduleTarget
                  .blockId as Id<"scheduleBlocks">,
                weekday: programTarget.scheduleTarget.weekday,
                weekStartMs: programTarget.scheduleTarget.weekStartMs,
              }
            : {
                mode: "homework" as const,
                dueDateMs: homeworkDate.getTime(),
              };
        if (draft) {
          await placeProgramHandout({
            periodId: programTarget.periodId,
            groupId: programTarget.groupId,
            ...draft,
            target: scheduleTarget,
          });
        } else {
          await placeProgramActivity({
            groupId: programTarget.groupId,
            activityId: pickedActivityId as Id<"activities">,
            periodId: programTarget.periodId,
            target: scheduleTarget,
            subject: programTarget.subject ?? programTarget.groupName,
          });
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
        return;
      }
      if (!pickedUnitId) return;
      const now = Date.now();
      // A single activity can be delivered live now; unit/lesson always plan.
      const liveNow = isSingleActivity && deliverNow;
      const scholarIds = Array.from(scholarSel).map((s) => s as Id<"users">);
      const activityScholarIds =
        isSingleActivity &&
        effectiveForSel !== null &&
        effectiveForSel.size > 0 &&
        effectiveForSel.size < scholarSel.size
          ? Array.from(effectiveForSel).map((s) => s as Id<"users">)
          : undefined;
      // For a live push the activity goes out immediately, so the assignment's
      // startsAt and the classFocus auto-clear are measured from now — not the
      // (hidden) scheduled time.
      const effStartsMs = liveNow ? now : startsMs;
      const endsAtMs =
        mode === "classFocus" ? effStartsMs + durationMin * MINUTE : undefined;
      const dueAtMs = mode === "homework" ? new Date(dueAt).getTime() : undefined;
      const target =
        targetKind === "activity"
          ? {
              kind: "activity" as const,
              activityId: pickedActivityId as Id<"activities">,
              mode,
              endsAt: endsAtMs,
              dueAt: dueAtMs,
              ...(activityScholarIds
                ? { scholarIds: activityScholarIds }
                : {}),
            }
          : targetKind === "lesson"
            ? { kind: "lesson" as const, lessonId: pickedLessonId as Id<"lessons"> }
            : { kind: "unit" as const };

      const newId = await assignWork({
        unitId: pickedUnitId,
        scholarIds,
        startsAt: effStartsMs,
        target,
      });

      // A World cohort's per-scholar run budget + season is execution policy set
      // here at Assign; non-fatal if it fails — the Run page can set it too
      // (plan §8). Only for assigns whose target is/contains a World.
      if (hasWorldTarget && isSimulatorRunBudgetValid(worldBudget)) {
        try {
          await setWorldBudget({
            assignmentId: newId,
            perScholarBlock: worldBudget.perBlock,
            perScholarWeek: worldBudget.perWeek,
            seasonTicks: worldBudget.seasonTicks ?? undefined,
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
      if (liveNow) {
        try {
          await pushActivity({
            assignmentId: newId,
            activityId: pickedActivityId as Id<"activities">,
            mode,
            ...(endsAtMs ? { endsAt: endsAtMs } : {}),
            ...(dueAtMs ? { dueAt: dueAtMs } : {}),
            ...(activityScholarIds ? { scholarIds: activityScholarIds } : {}),
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

      const pushCount = activityScholarIds
        ? activityScholarIds.length
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
          programTarget
            ? "Couldn’t schedule work"
            : isSingleActivity && deliverNow
              ? "Failed to start"
              : "Failed to assign",
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSubmitting(false);
    }
  };

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
    if (!programTarget && selectedUnitIsDraft && !confirmDraft) {
      setConfirmDraft(true);
      return;
    }
    void doAssign();
  };

  const showLessonsCol = pickedUnitId !== null;
  const showActivitiesCol =
    effectivePickedLessonId !== null &&
    effectivePickedLessonId !== undefined;
  const chooseProgramSearchResult = (
    result: NonNullable<typeof programSearchResults>[number],
  ) => {
    setPickedUnitId(result.unitId);
    setPickedLessonId(
      result.kind === "unit" ? undefined : result.lessonId,
    );
    setPickedActivityId(
      result.kind === "activity" ? result.activityId : undefined,
    );
    setForSel(null);
    setConfirmDraft(false);
    setProgramSearch("");
    setProgramSearchIndex(0);
  };

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
                  ? programScheduleLabel
                  : contextText) && (
                  <Text fontSize="xs" color="charcoal.500" mt={1.5}>
                    {programTarget?.scheduleTarget.mode === "classFocus"
                      ? programScheduleLabel
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
                {programTarget && !showCreatedHandoutComposer && (
                  <Flex
                    direction={{ base: "column", md: "row" }}
                    gap={2}
                    px={4}
                    py={3}
                    borderTopWidth="1px"
                    borderColor="gray.200"
                    bg="white"
                    align={{ base: "stretch", md: "center" }}
                  >
                    <Box position="relative" flex={1}>
                      <Box
                        position="absolute"
                        left={3}
                        top="50%"
                        transform="translateY(-50%)"
                        color="charcoal.300"
                        zIndex={1}
                        pointerEvents="none"
                      >
                        <MagnifyingGlass size={16} />
                      </Box>
                      <Input
                        value={programSearch}
                        onChange={(event) => {
                          setProgramSearch(event.target.value);
                          setProgramSearchIndex(0);
                        }}
                        onKeyDown={(event) => {
                          const results = programSearchResults ?? [];
                          if (event.key === "Escape" && programSearch) {
                            event.preventDefault();
                            event.stopPropagation();
                            setProgramSearch("");
                            setProgramSearchIndex(0);
                          } else if (
                            event.key === "ArrowDown" &&
                            results.length > 0
                          ) {
                            event.preventDefault();
                            setProgramSearchIndex((index) =>
                              Math.min(index + 1, results.length - 1),
                            );
                          } else if (
                            event.key === "ArrowUp" &&
                            results.length > 0
                          ) {
                            event.preventDefault();
                            setProgramSearchIndex((index) =>
                              Math.max(index - 1, 0),
                            );
                          } else if (
                            event.key === "Enter" &&
                            results[programSearchIndex]
                          ) {
                            event.preventDefault();
                            chooseProgramSearchResult(
                              results[programSearchIndex],
                            );
                          }
                        }}
                        placeholder="Search units, lessons, or activities"
                        aria-label="Search units, lessons, or activities"
                        role="combobox"
                        aria-autocomplete="list"
                        aria-expanded={programSearch.trim().length >= 2}
                        aria-controls="program-curriculum-results"
                        aria-activedescendant={
                          programSearchResults?.[programSearchIndex]
                            ? `program-result-${programSearchIndex}`
                            : undefined
                        }
                        ps={9}
                        pe={9}
                        autoFocus
                      />
                      {programSearch && (
                        <IconButton
                          aria-label="Clear curriculum search"
                          size="xs"
                          variant="ghost"
                          position="absolute"
                          right={1.5}
                          top="50%"
                          transform="translateY(-50%)"
                          zIndex={2}
                          onClick={() => {
                            setProgramSearch("");
                            setProgramSearchIndex(0);
                          }}
                        >
                          <X size={14} />
                        </IconButton>
                      )}
                      {programSearch.trim().length >= 2 && (
                        <Box
                          id="program-curriculum-results"
                          role="listbox"
                          position="absolute"
                          top="calc(100% + 6px)"
                          left={0}
                          right={0}
                          zIndex={20}
                          bg="white"
                          borderWidth="1px"
                          borderColor="gray.200"
                          borderRadius="md"
                          boxShadow="lg"
                          maxH="240px"
                          overflowY="auto"
                        >
                          {programSearchResults === undefined ? (
                            <Flex justify="center" py={5}>
                              <Spinner size="sm" color="violet.500" />
                            </Flex>
                          ) : programSearchResults.length === 0 ? (
                            <Text
                              px={4}
                              py={4}
                              fontSize="sm"
                              color="charcoal.400"
                            >
                              No matching curriculum
                            </Text>
                          ) : (
                            programSearchResults.map((result, index) => {
                              const title =
                                result.kind === "unit"
                                  ? result.unitTitle
                                  : result.kind === "lesson"
                                    ? result.lessonTitle
                                    : result.activityTitle;
                              const context =
                                result.kind === "unit"
                                  ? "Unit"
                                  : result.kind === "lesson"
                                    ? `Lesson · ${result.unitTitle}`
                                    : `Activity · ${result.unitTitle} → ${result.lessonTitle}`;
                              const key =
                                result.kind === "unit"
                                  ? `unit-${result.unitId}`
                                  : result.kind === "lesson"
                                    ? `lesson-${result.lessonId}`
                                    : `activity-${result.activityId}`;
                              return (
                                <Box
                                  as="button"
                                  id={`program-result-${index}`}
                                  role="option"
                                  aria-selected={programSearchIndex === index}
                                  key={key}
                                  display="block"
                                  w="full"
                                  px={4}
                                  py={2.5}
                                  textAlign="left"
                                  borderBottomWidth="1px"
                                  borderColor="gray.100"
                                  _last={{ borderBottomWidth: 0 }}
                                  bg={
                                    programSearchIndex === index
                                      ? "violet.50"
                                      : "white"
                                  }
                                  _hover={{ bg: "gray.50" }}
                                  onMouseEnter={() =>
                                    setProgramSearchIndex(index)
                                  }
                                  onClick={() =>
                                    chooseProgramSearchResult(result)
                                  }
                                >
                                  <Text
                                    fontFamily="heading"
                                    fontSize="sm"
                                    fontWeight="600"
                                    color="navy.500"
                                  >
                                    {title}
                                  </Text>
                                  <Text fontSize="xs" color="charcoal.400">
                                    {context}
                                  </Text>
                                </Box>
                              );
                            })
                          )}
                        </Box>
                      )}
                    </Box>
                    {viewingAsReadOnly ? (
                      <Tooltip.Root openDelay={300} closeDelay={0}>
                        <Tooltip.Trigger asChild>
                          <Box display={{ base: "block", md: "inline-flex" }}>
                            <Button
                              variant="outline"
                              colorPalette="violet"
                              disabled
                              flexShrink={0}
                              w={{ base: "full", md: "auto" }}
                            >
                              <FileText size={18} />
                              New handout
                            </Button>
                          </Box>
                        </Tooltip.Trigger>
                        <Tooltip.Positioner>
                          <Tooltip.Content fontSize="xs">
                            Exit view-as to create a handout.
                          </Tooltip.Content>
                        </Tooltip.Positioner>
                      </Tooltip.Root>
                    ) : (
                      <Button
                        variant="outline"
                        colorPalette="violet"
                        onClick={() => void handleCreateHandout()}
                        disabled={creatingHandout}
                        flexShrink={0}
                        w={{ base: "full", md: "auto" }}
                      >
                        {creatingHandout ? (
                          <Spinner size="xs" />
                        ) : (
                          <FileText size={18} />
                        )}
                        {createdHandoutId
                          ? "Back to handout"
                          : "New handout"}
                      </Button>
                    )}
                  </Flex>
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
                {createdHandoutId && showCreatedHandoutComposer ? (
                  <>
                    <Flex
                      direction="column"
                      flex={1}
                      minW="420px"
                      minH={0}
                      bg="white"
                    >
                      <Flex
                        px={4}
                        py={2}
                        align="center"
                        justify="space-between"
                        borderBottom="1px solid"
                        borderBottomColor="gray.100"
                        bg="gray.50"
                      >
                        <Text
                          fontSize="2xs"
                          color="charcoal.400"
                          fontFamily="heading"
                          fontWeight="700"
                          textTransform="uppercase"
                          letterSpacing="0.05em"
                        >
                          Handout
                        </Text>
                        <Button
                          size="xs"
                          variant="ghost"
                          color="charcoal.500"
                          onClick={() => {
                            setShowCreatedHandoutComposer(false);
                            setPickedActivityId(undefined);
                          }}
                        >
                          <ArrowLeft />
                          Choose different work
                        </Button>
                      </Flex>
                      <Box overflowY="auto" minH={0}>
                        <Box
                          px={6}
                          py={4}
                          borderBottomWidth="1px"
                          borderColor="gray.100"
                        >
                          <Text
                            fontFamily="heading"
                            fontSize="sm"
                            fontWeight="600"
                            color="navy.500"
                            mb={2}
                          >
                            Handout name
                          </Text>
                          <Input
                            value={createdHandoutTitle}
                            disabled={viewingAsReadOnly}
                            onChange={(event) =>
                              setCreatedHandoutTitle(event.target.value)
                            }
                            onFocus={(event) => event.currentTarget.select()}
                            onBlur={() => {
                              if (!createdHandoutTitle.trim()) return;
                              void saveCreatedHandoutTitle().catch((error) => {
                                toaster.error({
                                  title: "Couldn’t rename handout",
                                  description:
                                    error instanceof Error
                                      ? error.message
                                      : String(error),
                                });
                              });
                            }}
                            placeholder="e.g. Robotics safety checklist"
                            aria-label="Handout name"
                          />
                        </Box>
                        {viewingAsReadOnly ? (
                          <Text px={6} py={4} fontSize="sm" color="charcoal.500">
                            Exit view-as to manage handout materials.
                          </Text>
                        ) : (
                          <ResourcesEditor
                            activityId={createdHandoutId}
                            assignmentId={createdHandoutAssignmentId ?? undefined}
                            onSuggestedTitle={(suggestedTitle) =>
                              setCreatedHandoutTitle((currentTitle) =>
                                currentTitle.trim()
                                  ? currentTitle
                                  : suggestedTitle,
                              )
                            }
                          />
                        )}
                      </Box>
                    </Flex>
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
                    onPick={(id) => {
                      setPickedUnitId(id);
                      setPickedLessonId(undefined);
                      setPickedActivityId(undefined);
                      setForSel(null);
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
                              setForSel(null);
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
                              setForSel(null);
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
                              setForSel(null);
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
                              if (a._id === createdHandoutId) {
                                setShowCreatedHandoutComposer(true);
                              }
                              setForSel(null);
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
                                      programUnitActivities?.find(
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
                      {displayedProgramResourceCount === null
                        ? "Checking materials…"
                        : displayedProgramResourceCount === 0
                          ? "No materials"
                          : `${displayedProgramResourceCount} ${
                              displayedProgramResourceCount === 1
                                ? "material"
                                : "materials"
                            }`}
                    </Text>
                  )}
                  {targetSummary && selectedUnitIsDraft && !programTarget && (
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

                {programTarget?.scheduleTarget.mode === "homework" && (
                  <Box>
                    <Text
                      fontSize="xs"
                      color="charcoal.400"
                      fontFamily="heading"
                      fontWeight="600"
                      textTransform="uppercase"
                      letterSpacing="0.04em"
                      mb={2}
                    >
                      Timing
                    </Text>
                    <CalendarDatePicker
                      value={homeworkDate}
                      onChange={setHomeworkDate}
                      ariaLabel="Choose homework due date"
                    />
                    <Text fontSize="xs" color="charcoal.400" mt={2}>
                      Available at 8:00 AM and due at the end of that day.
                    </Text>
                  </Box>
                )}

                {!programTarget && (
                  <Box>
                    <Text
                      fontSize="xs"
                      color="charcoal.400"
                      fontFamily="heading"
                      fontWeight="600"
                      textTransform="uppercase"
                      letterSpacing="0.04em"
                      mb={2}
                    >
                      Scholars
                    </Text>
                    <ScholarPicker
                      mode="multi"
                      selected={scholarSel}
                      onChange={(selection) =>
                        dispatchRoster({ type: "selectionChanged", selection })
                      }
                      maxH="220px"
                    />
                  </Box>
                )}

                {programTarget && (
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
                      Program
                    </Text>
                    <Text
                      fontSize="sm"
                      fontFamily="heading"
                      color="navy.500"
                      fontWeight="600"
                    >
                      {programTarget.groupName}
                    </Text>
                    <Text fontSize="xs" color="charcoal.400" mt={1}>
                      Everyone currently in this program gets this work and its
                      materials. The roster stays managed in School.
                    </Text>
                  </Box>
                )}

                {/* World run budget + season — per-scholar execution policy for
                    the cohort's Workbench Worlds (plan §8 Assign). Uses the ONE
                    shared budget primitive; shown when the picked target is a
                    World. */}
                {!programTarget && hasWorldTarget && (
                  <Box>
                    <Text
                      fontSize="xs"
                      color="charcoal.400"
                      fontFamily="heading"
                      fontWeight="600"
                      textTransform="uppercase"
                      letterSpacing="0.04em"
                      mb={2}
                    >
                      🌍 Simulator run budget &amp; season (per scholar)
                    </Text>
                    <SimulatorRunBudgetFields value={worldBudget} onChange={setWorldBudget_} />
                  </Box>
                )}

                {/* When — a single activity can go live now or be planned;
                    a unit/lesson always lands on the calendar. */}
                {!programTarget && (
                  <Box>
                  <Text
                    fontSize="xs"
                    color="charcoal.400"
                    fontFamily="heading"
                    fontWeight="600"
                    textTransform="uppercase"
                    letterSpacing="0.04em"
                    mb={2}
                  >
                    When
                  </Text>

                  {isSingleActivity && (
                    <HStack gap={2} mb={3}>
                      {(
                        [
                          { key: true, label: "Start now" },
                          { key: false, label: "Schedule" },
                        ] as const
                      ).map((opt) => (
                        <Box
                          as="button"
                          key={opt.label}
                          onClick={() => setDeliverNow(opt.key)}
                          aria-pressed={deliverNow === opt.key}
                          px={3}
                          py={1.5}
                          borderRadius="md"
                          borderWidth="1px"
                          borderColor={
                            deliverNow === opt.key ? "violet.300" : "gray.200"
                          }
                          bg={deliverNow === opt.key ? "violet.50" : "white"}
                          cursor="pointer"
                          _hover={{
                            bg: deliverNow === opt.key ? undefined : "gray.50",
                          }}
                          fontFamily="heading"
                          fontWeight="700"
                          fontSize="sm"
                          color={
                            deliverNow === opt.key ? "violet.700" : "charcoal.500"
                          }
                        >
                          {opt.label}
                        </Box>
                      ))}
                    </HStack>
                  )}

                  {isSingleActivity && (
                    <HStack gap={2} mb={3}>
                      {(["classFocus", "homework"] as ActivityMode[]).map(
                        (m) => (
                          <Box
                            as="button"
                            key={m}
                            onClick={() => setMode(m)}
                            px={3}
                            py={1.5}
                            borderRadius="md"
                            borderWidth="1px"
                            borderColor={
                              mode === m
                                ? m === "classFocus"
                                  ? "violet.300"
                                  : "orange.300"
                                : "gray.200"
                            }
                            bg={
                              mode === m
                                ? m === "classFocus"
                                  ? "violet.50"
                                  : "orange.50"
                                : "white"
                            }
                            cursor="pointer"
                            _hover={{ bg: mode === m ? undefined : "gray.50" }}
                          >
                            <ActivityModeBadge mode={m} variant="soft" />
                          </Box>
                        ),
                      )}
                    </HStack>
                  )}

                  <HStack gap={4} align="flex-start" flexWrap="wrap">
                    {!(isSingleActivity && deliverNow) && (
                      <Box flex={1} minW="200px">
                        <SubLabel>
                          {isSingleActivity && mode === "homework"
                            ? "Assign at"
                            : "Starts"}
                        </SubLabel>
                        <DateTimeInput value={startsAt} onChange={setStartsAt} />
                      </Box>
                    )}
                    {isSingleActivity && mode === "classFocus" && (
                      <Box minW="140px">
                        <SubLabel>Duration</SubLabel>
                        <PlainSelect
                          value={String(durationMin)}
                          onChange={(v) => setDurationMin(Number(v))}
                        >
                          {DURATIONS.map((d) => (
                            <option key={d.min} value={d.min}>
                              {d.label}
                            </option>
                          ))}
                        </PlainSelect>
                      </Box>
                    )}
                    {isSingleActivity && mode === "homework" && (
                      <Box flex={1} minW="200px">
                        <SubLabel>Due</SubLabel>
                        <DateTimeInput value={dueAt} onChange={setDueAt} />
                      </Box>
                    )}
                  </HStack>

                  {isSingleActivity && (
                    <Box
                      mt={4}
                      p={3}
                      bg="white"
                      borderWidth="1px"
                      borderColor="gray.200"
                      borderRadius="md"
                    >
                      <Flex align="flex-start" justify="space-between" gap={3}>
                        <Box flex={1} minW={0}>
                          <SubLabel>For</SubLabel>
                          <Text
                            fontSize="sm"
                            fontFamily="heading"
                            fontWeight={
                              effectiveForSel === null ? "500" : "600"
                            }
                            color={
                              effectiveForSel === null
                                ? "charcoal.400"
                                : "navy.500"
                            }
                          >
                            {effectiveForSel === null
                              ? "Everyone in this assignment"
                              : effectiveForSel.size === 0
                                ? "Everyone (no specific scholars selected)"
                                : effectiveForSel.size === scholarSel.size
                                  ? "Everyone selected"
                                  : `${effectiveForSel.size} specific scholar${effectiveForSel.size === 1 ? "" : "s"}`}
                          </Text>
                        </Box>
                        <Button
                          size="2xs"
                          variant={
                            effectiveForSel === null ? "outline" : "ghost"
                          }
                          color={
                            effectiveForSel === null
                              ? "violet.600"
                              : "charcoal.500"
                          }
                          borderColor="violet.200"
                          fontFamily="heading"
                          onClick={() =>
                            setForSel(
                              effectiveForSel === null
                                ? new Set(scholarSel)
                                : null,
                            )
                          }
                        >
                          {effectiveForSel === null
                            ? "Choose specific scholars"
                            : "Use everyone"}
                        </Button>
                      </Flex>

                      {effectiveForSel !== null && (
                        <Box mt={3}>
                          <ScholarPicker
                            mode="multi"
                            selected={effectiveForSel}
                            onChange={handleForSelChange}
                            scholarIds={forScholarIds}
                            maxH="180px"
                            emptyHint={
                              scholarSel.size === 0
                                ? "Pick scholars above first."
                                : "No scholars in this assignment."
                            }
                          />
                        </Box>
                      )}

                      <Text
                        fontSize="xs"
                        color="charcoal.400"
                        fontFamily="body"
                        mt={2}
                      >
                        Only these scholars will see this activity. Leave as
                        Everyone to assign it to the whole group.
                      </Text>
                    </Box>
                  )}

                  {!isSingleActivity && (
                    <Text
                      fontSize="xs"
                      color="charcoal.400"
                      fontFamily="body"
                      mt={2}
                    >
                      The {targetKind === "lesson" ? "lesson" : "unit"}&apos;s
                      activities lay onto the agenda from this date using the
                      pacing set in the curriculum. Anything without a set
                      gap lands on the start date — push those to the class
                      with &ldquo;Start now&rdquo; as you reach them.
                    </Text>
                  )}

                  {isSingleActivity && deliverNow && (
                    <Text
                      fontSize="xs"
                      color="charcoal.400"
                      fontFamily="body"
                      mt={2}
                    >
                      Scholars see this activity right away.
                      {mode === "classFocus"
                        ? " It clears from class focus after the duration above."
                        : " It lands on their plate with the due date above."}
                    </Text>
                  )}

                  {isPast && !(isSingleActivity && deliverNow) && (
                    <HStack
                      gap={2}
                      px={3}
                      py={2}
                      mt={2}
                      bg="orange.50"
                      borderWidth="1px"
                      borderColor="orange.200"
                      borderRadius="md"
                    >
                      <Warning
                        size={16}
                        color="var(--chakra-colors-orange-500)"
                      />
                      <Text
                        fontSize="xs"
                        color="orange.700"
                        fontFamily="heading"
                      >
                        That time is in the past — it won&apos;t auto-start. It
                        stays planned until you hit Start now.
                      </Text>
                    </HStack>
                  )}
                  </Box>
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
              {confirmDraft && selectedUnitIsDraft && (
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
                        : isSingleActivity && deliverNow
                          ? "Starting..."
                          : "Assigning..."}
                    </>
                  ) : programTarget ? (
                    programTarget.scheduleTarget.mode === "classFocus"
                      ? "Add to class"
                      : "Schedule homework"
                  ) : confirmDraft && selectedUnitIsDraft ? (
                    "Assign anyway"
                  ) : isSingleActivity && deliverNow ? (
                    "Start now"
                  ) : (
                    "Assign"
                  )}
                </Button>
              </Flex>
              {programTarget &&
                !!pickedActivityId &&
                !programMaterialsReady && (
                  <Text
                    mt={2}
                    textAlign="right"
                    fontSize="xs"
                    color="charcoal.400"
                  >
                    {createdHandoutId === pickedActivityId
                      ? createdHandoutTitle.trim()
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

// ── Form helpers ─────────────────────────────────────────────────────

function SubLabel({ children }: { children: React.ReactNode }) {
  return (
    <Text
      fontSize="2xs"
      fontFamily="heading"
      fontWeight="700"
      letterSpacing="0.04em"
      textTransform="uppercase"
      color="charcoal.400"
      mb={1.5}
    >
      {children}
    </Text>
  );
}

function DateTimeInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <chakra.input
      type="datetime-local"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      w="full"
      px={3}
      py={2}
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="md"
      fontFamily="heading"
      fontSize="sm"
      bg="white"
    />
  );
}

function PlainSelect({
  value,
  onChange,
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
}) {
  return (
    <chakra.select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      w="full"
      px={3}
      py={2}
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="md"
      fontFamily="heading"
      fontSize="sm"
      bg="white"
      cursor="pointer"
    >
      {children}
    </chakra.select>
  );
}

// ── Column body helpers ──────────────────────────────────────────────

function ColumnSpinner() {
  return (
    <Flex justify="center" py={6}>
      <Spinner size="sm" color="violet.500" />
    </Flex>
  );
}

function UnitsList({
  units,
  pickedUnitId,
  authorFilterOverride,
  onAuthorFilterChange,
  selectedSubject,
  onSubjectChange,
  onPick,
}: {
  units:
    | NonNullable<ReturnType<typeof useQuery<typeof api.units.list>>>
    | undefined;
  pickedUnitId: Id<"units"> | null;
  authorFilterOverride: string | null;
  onAuthorFilterChange: (value: string) => void;
  selectedSubject: string | null;
  onSubjectChange: (value: string | null) => void;
  onPick: (id: Id<"units">) => void;
}) {
  const { user: currentUser, isLoading: currentUserLoading } = useCurrentUser();

  if (units === undefined || currentUserLoading) return <ColumnSpinner />;
  const allActive = units.filter(
    (u) => u.isActive && (u.lessonCount ?? 0) > 0,
  );
  const meId = currentUser?._id ? String(currentUser._id) : "";
  const pickedUnit = allActive.find((unit) => unit._id === pickedUnitId);
  const defaultAuthorId =
    pickedUnit && String(pickedUnit.teacherId) !== meId
      ? String(pickedUnit.teacherId)
      : meId || "all";
  const authorFilter = authorFilterOverride ?? defaultAuthorId;
  const authors = unitAuthorOptions(allActive);
  const subjects = uniqueSubjects(allActive);
  const activeUnits = allActive.filter((unit) =>
    unitMatchesFilters(unit, authorFilter, selectedSubject),
  );
  if (allActive.length === 0) {
    // Only assignable units (active + ≥1 lesson) show here. Distinguish
    // "you have no units at all" from "you have units but none with
    // lessons yet" — the old copy claimed the former even when 35 empty
    // units existed.
    const hasAnyUnits = units.length > 0;
    return (
      <Stack gap={1} align="center" py={6} px={3} color="charcoal.400" textAlign="center">
        <Text fontFamily="heading" fontSize="sm" fontWeight="600">
          {hasAnyUnits ? "No units with lessons yet" : "No units yet"}
        </Text>
        <Text fontSize="xs" fontFamily="body">
          {hasAnyUnits
            ? "A unit needs at least one lesson before you can assign it. Add lessons in Curriculum."
            : "Create one in Curriculum."}
        </Text>
      </Stack>
    );
  }
  return (
    <>
      <HStack px={2} py={2} gap={1} flexWrap="wrap">
        <UnitAuthorFilterMenu
          authors={authors}
          value={authorFilter}
          onChange={onAuthorFilterChange}
          meId={meId}
          meName={currentUser?.name ?? undefined}
        />
        <SubjectFilterChips
          subjects={subjects}
          selected={selectedSubject}
          onSelect={onSubjectChange}
        />
      </HStack>
      {activeUnits.length === 0 ? (
        <Stack gap={1} align="center" py={4} color="charcoal.400">
          <Text fontSize="xs" fontFamily="body" fontStyle="italic">
            {selectedSubject
              ? "No units match these filters."
              : authorFilter === meId
                ? "No units authored by you."
                : "No units by this author."}
          </Text>
        </Stack>
      ) : (
        activeUnits.map((u) => (
          <HierarchyRow
            key={u._id}
            leading={u.emoji ? u.emoji : <EmojiPlaceholder />}
            selected={pickedUnitId === u._id}
            onClick={() => onPick(u._id)}
            label={u.title}
            sublabel={`${u.lessonCount} lesson${u.lessonCount === 1 ? "" : "s"}`}
            trailing={{ kind: "chevron" }}
          />
        ))
      )}
    </>
  );
}
