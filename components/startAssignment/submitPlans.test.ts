// Characterization tests for StartAssignmentDialog's two submit paths. They
// pin the exact mutation arguments each mode fires so the dialog's
// decomposition into per-mode modules can't silently change what reaches the
// backend. Written against the payload builders the original dialog was wired
// to use, then kept green through the split (TRA-21).

import { describe, expect, test } from "vitest";
import type { Id, TableNames } from "@/convex/_generated/dataModel";
import {
  buildProgramSchedulePlan,
  buildTeacherAssignmentPlan,
  type TeacherAssignmentInputs,
} from "./submitPlans";

const id = <T extends TableNames>(value: string): Id<T> =>
  value as unknown as Id<T>;

const baseTeacher: TeacherAssignmentInputs = {
  pickedUnitId: id<"units">("unit_1"),
  pickedLessonId: undefined,
  pickedActivityId: undefined,
  targetKind: "unit",
  isSingleActivity: false,
  deliverNow: true,
  mode: "classFocus",
  durationMin: 60,
  dueAt: "2026-10-01T09:00",
  scholarSel: new Set(["kai", "lani"]),
  effectiveForSel: null,
  startsMs: 1_000,
  now: 500,
  hasWorldTarget: false,
  worldBudget: { perBlock: 3, perWeek: 12, seasonTicks: null },
  worldBudgetIsValid: true,
};

describe("buildTeacherAssignmentPlan", () => {
  test("whole unit: plans assignWork with a unit target, no push/budget", () => {
    const plan = buildTeacherAssignmentPlan(baseTeacher);
    expect(plan.assignWork).toEqual({
      unitId: id<"units">("unit_1"),
      scholarIds: ["kai", "lani"],
      startsAt: 1_000, // not liveNow → scheduled startsMs, not `now`
      target: { kind: "unit" },
    });
    expect(plan.worldBudget).toBeNull();
    expect(plan.pushActivity).toBeNull();
  });

  test("whole lesson: lesson target carries the picked lesson id", () => {
    const plan = buildTeacherAssignmentPlan({
      ...baseTeacher,
      targetKind: "lesson",
      pickedLessonId: id<"lessons">("lesson_9"),
    });
    expect(plan.assignWork.target).toEqual({
      kind: "lesson",
      lessonId: id<"lessons">("lesson_9"),
    });
    expect(plan.pushActivity).toBeNull();
  });

  test("single activity, start now, classFocus: live push from `now`", () => {
    const plan = buildTeacherAssignmentPlan({
      ...baseTeacher,
      targetKind: "activity",
      isSingleActivity: true,
      deliverNow: true,
      mode: "classFocus",
      durationMin: 45,
      pickedActivityId: id<"activities">("act_7"),
    });
    expect(plan.assignWork.startsAt).toBe(500); // liveNow → measured from now
    expect(plan.assignWork.target).toEqual({
      kind: "activity",
      activityId: id<"activities">("act_7"),
      mode: "classFocus",
      endsAt: 500 + 45 * 60_000,
      dueAt: undefined,
    });
    expect(plan.pushActivity).toEqual({
      activityId: id<"activities">("act_7"),
      mode: "classFocus",
      endsAt: 500 + 45 * 60_000,
    });
  });

  test("single activity, scheduled, homework: no push, dueAt from string", () => {
    const plan = buildTeacherAssignmentPlan({
      ...baseTeacher,
      targetKind: "activity",
      isSingleActivity: true,
      deliverNow: false,
      mode: "homework",
      dueAt: "2026-10-05T15:30",
      pickedActivityId: id<"activities">("act_7"),
    });
    const dueMs = new Date("2026-10-05T15:30").getTime();
    expect(plan.assignWork.startsAt).toBe(1_000);
    expect(plan.assignWork.target).toEqual({
      kind: "activity",
      activityId: id<"activities">("act_7"),
      mode: "homework",
      endsAt: undefined,
      dueAt: dueMs,
    });
    expect(plan.pushActivity).toBeNull();
  });

  test("a proper subset 'For' selection narrows scholarIds on target + push", () => {
    const plan = buildTeacherAssignmentPlan({
      ...baseTeacher,
      targetKind: "activity",
      isSingleActivity: true,
      deliverNow: true,
      mode: "classFocus",
      scholarSel: new Set(["kai", "lani", "mika"]),
      effectiveForSel: new Set(["kai"]),
      pickedActivityId: id<"activities">("act_7"),
    });
    expect(
      (plan.assignWork.target as { scholarIds?: Id<"users">[] }).scholarIds,
    ).toEqual(["kai"]);
    expect(plan.pushActivity?.scholarIds).toEqual(["kai"]);
  });

  test("a full 'For' selection is not treated as a subset (no scholarIds)", () => {
    const plan = buildTeacherAssignmentPlan({
      ...baseTeacher,
      targetKind: "activity",
      isSingleActivity: true,
      deliverNow: true,
      scholarSel: new Set(["kai", "lani"]),
      effectiveForSel: new Set(["kai", "lani"]),
      pickedActivityId: id<"activities">("act_7"),
    });
    expect(plan.assignWork.target).not.toHaveProperty("scholarIds");
    expect(plan.pushActivity).not.toHaveProperty("scholarIds");
  });

  test("a World target with a valid budget plans the per-scholar budget", () => {
    const plan = buildTeacherAssignmentPlan({
      ...baseTeacher,
      hasWorldTarget: true,
      worldBudgetIsValid: true,
      worldBudget: { perBlock: 2, perWeek: 8, seasonTicks: 30 },
    });
    expect(plan.worldBudget).toEqual({
      perScholarBlock: 2,
      perScholarWeek: 8,
      seasonTicks: 30,
    });
  });

  test("an invalid World budget is not planned", () => {
    const plan = buildTeacherAssignmentPlan({
      ...baseTeacher,
      hasWorldTarget: true,
      worldBudgetIsValid: false,
    });
    expect(plan.worldBudget).toBeNull();
  });

  test("null season ticks become undefined", () => {
    const plan = buildTeacherAssignmentPlan({
      ...baseTeacher,
      hasWorldTarget: true,
      worldBudgetIsValid: true,
      worldBudget: { perBlock: 3, perWeek: 12, seasonTicks: null },
    });
    expect(plan.worldBudget?.seasonTicks).toBeUndefined();
  });
});

const baseProgram = {
  createdHandoutId: null,
  createdHandoutAssignmentId: null,
  pickedActivityId: id<"activities">("act_7"),
  periodId: id<"reportingPeriods">("period_1"),
  groupId: id<"scholarGroups">("group_1"),
  subject: "Aviation",
  groupName: "Aviation 101",
  scheduleTarget: {
    mode: "classFocus" as const,
    blockId: id<"scheduleBlocks">("block_1"),
    weekday: 2,
    weekStartMs: 5_000,
  },
};

describe("buildProgramSchedulePlan", () => {
  test("existing activity, class focus: places the activity", () => {
    const plan = buildProgramSchedulePlan(baseProgram);
    expect(plan.abandonDraft).toBeNull();
    expect(plan.keptDraft).toBeNull();
    expect(plan.place).toEqual({
      kind: "activity",
      args: {
        groupId: id<"scholarGroups">("group_1"),
        activityId: id<"activities">("act_7"),
        periodId: id<"reportingPeriods">("period_1"),
        target: {
          mode: "classFocus",
          blockId: id<"scheduleBlocks">("block_1"),
          weekday: 2,
          weekStartMs: 5_000,
        },
        subject: "Aviation",
      },
    });
  });

  test("missing subject falls back to the group name", () => {
    const plan = buildProgramSchedulePlan({ ...baseProgram, subject: undefined });
    expect(
      (plan.place as { args: { subject: string } }).args.subject,
    ).toBe("Aviation 101");
  });

  test("homework target carries the chosen due date", () => {
    const plan = buildProgramSchedulePlan({
      ...baseProgram,
      scheduleTarget: { mode: "homework", dueDateMs: 42_000 },
    });
    expect(plan.place.args.target).toEqual({
      mode: "homework",
      dueDateMs: 42_000,
    });
  });

  test("draft matching the picked target is placed as a handout", () => {
    const plan = buildProgramSchedulePlan({
      ...baseProgram,
      createdHandoutId: id<"activities">("act_7"),
      createdHandoutAssignmentId: id<"assignments">("asg_3"),
      pickedActivityId: id<"activities">("act_7"),
    });
    expect(plan.abandonDraft).toBeNull();
    expect(plan.keptDraft).toEqual({
      activityId: id<"activities">("act_7"),
      assignmentId: id<"assignments">("asg_3"),
    });
    expect(plan.place).toEqual({
      kind: "handout",
      args: {
        periodId: id<"reportingPeriods">("period_1"),
        groupId: id<"scholarGroups">("group_1"),
        activityId: id<"activities">("act_7"),
        assignmentId: id<"assignments">("asg_3"),
        target: {
          mode: "classFocus",
          blockId: id<"scheduleBlocks">("block_1"),
          weekday: 2,
          weekStartMs: 5_000,
        },
      },
    });
  });

  test("a stale draft (teacher picked other work) is abandoned, then activity placed", () => {
    const plan = buildProgramSchedulePlan({
      ...baseProgram,
      createdHandoutId: id<"activities">("handout_old"),
      createdHandoutAssignmentId: id<"assignments">("asg_old"),
      pickedActivityId: id<"activities">("act_7"),
    });
    expect(plan.abandonDraft).toEqual({
      activityId: id<"activities">("handout_old"),
      assignmentId: id<"assignments">("asg_old"),
    });
    expect(plan.keptDraft).toBeNull();
    expect(plan.place.kind).toBe("activity");
    expect(plan.place.args.activityId).toBe(id<"activities">("act_7"));
  });
});
