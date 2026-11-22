// The pure "what mutations does Submit fire, with which arguments" core of
// StartAssignmentDialog's two modes. It lives out here — mirroring
// startAssignmentRoster.ts — because the argument construction (which target
// shape, which optional keys, live-now vs planned, handout-abandon vs place)
// is exactly where a decomposition could silently drift, and here it's
// testable without a DOM ("split the pure core out" —
// .claude/rules/rabbithole-test-strategy.md).
//
// Only the argument-building decisions are pure. The async orchestration
// around them (awaiting each mutation, restoring handout state when a discard
// throws, toasting partial failures) stays in the mode components — this
// module answers "which calls, with what args", not "in what try/catch".

import type { Id } from "@/convex/_generated/dataModel";
import type { SimulatorRunBudgetValue } from "@/components/simulatorTeacher/SimulatorRunBudgetFields";
import type { GiveFinish } from "@/components/GiveWindowFields";

type AssignWorkTarget =
  | { kind: "unit" }
  | { kind: "lesson"; lessonId: Id<"lessons"> }
  | {
      kind: "activity";
      activityId: Id<"activities">;
      scholarIds?: Id<"users">[];
    };

export interface TeacherAssignmentInputs {
  pickedUnitId: Id<"units">;
  pickedLessonId: Id<"lessons"> | null | undefined;
  pickedActivityId: Id<"activities"> | null | undefined;
  targetKind: "unit" | "lesson" | "activity";
  isSingleActivity: boolean;
  /** "Shows up: now". A single activity goes live; a unit/lesson plans at now. */
  deliverNow: boolean;
  /** "Finish" — the teacher's answer, sent as-is (TRA-571). */
  finish: GiveFinish;
  scholarSel: Set<string>;
  effectiveForSel: Set<string> | null;
  startsMs: number;
  now: number;
  hasWorldTarget: boolean;
  worldBudget: SimulatorRunBudgetValue;
  /** `isSimulatorRunBudgetValid(worldBudget)`, passed in so this module stays
   *  free of the Chakra field module it lives beside. */
  worldBudgetIsValid: boolean;
}

interface TeacherAssignmentPlan {
  assignWork: {
    unitId: Id<"units">;
    scholarIds: Id<"users">[];
    startsAt: number;
    target: AssignWorkTarget;
    finish: GiveFinish;
  };
  /** Non-null → call `setAssignmentWorldBudget` with the assignment id added. */
  worldBudget: {
    perScholarBlock: number;
    perScholarWeek: number;
    seasonTicks: number | undefined;
  } | null;
  /** A single activity shown up "now": assignWork already makes it live
   *  (one write, TRA-571), so there's no second push to make or to fail. */
  liveNow: boolean;
  /** How many scholars that live give reaches. */
  liveScholarCount: number;
}

/**
 * The teacher-assignment mode's submit, as arguments. Mirrors the original
 * `doAssign` non-program branch exactly: assignWork always; a World cohort's
 * per-scholar run budget when the picked target is a World; a live push when a
 * single activity is delivered "now".
 */
export function buildTeacherAssignmentPlan(
  inputs: TeacherAssignmentInputs,
): TeacherAssignmentPlan {
  const {
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
    worldBudgetIsValid,
  } = inputs;

  const liveNow = isSingleActivity && deliverNow;
  const scholarIds = Array.from(scholarSel).map((s) => s as Id<"users">);
  const activityScholarIds =
    isSingleActivity &&
    effectiveForSel !== null &&
    effectiveForSel.size > 0 &&
    effectiveForSel.size < scholarSel.size
      ? Array.from(effectiveForSel).map((s) => s as Id<"users">)
      : undefined;
  const effStartsMs = deliverNow ? now : startsMs;

  const target: AssignWorkTarget =
    targetKind === "activity"
      ? {
          kind: "activity",
          activityId: pickedActivityId as Id<"activities">,
          ...(activityScholarIds ? { scholarIds: activityScholarIds } : {}),
        }
      : targetKind === "lesson"
        ? { kind: "lesson", lessonId: pickedLessonId as Id<"lessons"> }
        : { kind: "unit" };

  return {
    assignWork: {
      unitId: pickedUnitId,
      scholarIds,
      startsAt: effStartsMs,
      target,
      finish,
    },
    worldBudget:
      hasWorldTarget && worldBudgetIsValid
        ? {
            perScholarBlock: worldBudget.perBlock,
            perScholarWeek: worldBudget.perWeek,
            seasonTicks: worldBudget.seasonTicks ?? undefined,
          }
        : null,
    liveNow,
    liveScholarCount: activityScholarIds?.length ?? scholarIds.length,
  };
}

type ProgramHandoutTarget =
  | {
      mode: "classFocus";
      blockId: Id<"scheduleBlocks">;
      weekday: number;
      weekStartMs: number;
    }
  | { mode: "homework"; dueDateMs: number };

interface ProgramScheduleInputs {
  createdHandoutId: Id<"activities"> | null;
  createdHandoutAssignmentId: Id<"assignments"> | null;
  pickedActivityId: Id<"activities"> | null | undefined;
  periodId: Id<"reportingPeriods">;
  groupId: Id<"scholarGroups">;
  subject: string | undefined;
  groupName: string;
  /** The already-resolved schedule target (homework's dueDateMs is the
   *  dialog's chosen date in ms). */
  scheduleTarget: ProgramHandoutTarget;
}

interface ProgramSchedulePlan {
  /** Non-null → discard this now-stale draft (the teacher picked other work)
   *  before scheduling. */
  abandonDraft: {
    activityId: Id<"activities">;
    assignmentId: Id<"assignments">;
  } | null;
  /** Non-null → the picked target IS this handout draft; save its title, then
   *  place it as a handout. */
  keptDraft: {
    activityId: Id<"activities">;
    assignmentId: Id<"assignments">;
  } | null;
  place:
    | {
        kind: "handout";
        args: {
          periodId: Id<"reportingPeriods">;
          groupId: Id<"scholarGroups">;
          activityId: Id<"activities">;
          assignmentId: Id<"assignments">;
          target: ProgramHandoutTarget;
        };
      }
    | {
        kind: "activity";
        args: {
          groupId: Id<"scholarGroups">;
          activityId: Id<"activities">;
          periodId: Id<"reportingPeriods">;
          target: ProgramHandoutTarget;
          subject: string;
        };
      };
}

/**
 * The program schedule / Handout mode's submit, as decisions + arguments.
 * Mirrors the original `doAssign` program branch: a handout draft that no
 * longer matches the picked target is abandoned; a still-matching draft is
 * placed as a handout (after saving its title); otherwise the picked existing
 * activity is placed.
 */
export function buildProgramSchedulePlan(
  inputs: ProgramScheduleInputs,
): ProgramSchedulePlan {
  const {
    createdHandoutId,
    createdHandoutAssignmentId,
    pickedActivityId,
    periodId,
    groupId,
    subject,
    groupName,
    scheduleTarget,
  } = inputs;

  const rawDraft =
    createdHandoutId && createdHandoutAssignmentId
      ? { activityId: createdHandoutId, assignmentId: createdHandoutAssignmentId }
      : null;
  const abandonDraft =
    rawDraft && rawDraft.activityId !== pickedActivityId ? rawDraft : null;
  const keptDraft = abandonDraft ? null : rawDraft;

  const resolvedTarget: ProgramHandoutTarget =
    scheduleTarget.mode === "classFocus"
      ? {
          mode: "classFocus",
          blockId: scheduleTarget.blockId,
          weekday: scheduleTarget.weekday,
          weekStartMs: scheduleTarget.weekStartMs,
        }
      : { mode: "homework", dueDateMs: scheduleTarget.dueDateMs };

  return {
    abandonDraft,
    keptDraft,
    place: keptDraft
      ? {
          kind: "handout",
          args: {
            periodId,
            groupId,
            activityId: keptDraft.activityId,
            assignmentId: keptDraft.assignmentId,
            target: resolvedTarget,
          },
        }
      : {
          kind: "activity",
          args: {
            groupId,
            activityId: pickedActivityId as Id<"activities">,
            periodId,
            target: resolvedTarget,
            subject: subject ?? groupName,
          },
        },
  };
}
