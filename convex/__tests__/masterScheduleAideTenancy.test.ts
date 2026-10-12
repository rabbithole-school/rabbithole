import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { makeWorld } from "./factories/world";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const DAY = 86_400_000;

async function scheduleSnapshot(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => ({
    blocks: await ctx.db.query("scheduleBlocks").collect(),
    placements: await ctx.db.query("schedulePlacements").collect(),
    assignments: await ctx.db.query("assignments").collect(),
  }));
}

async function expectDeniedWithoutScheduleWrites(
  t: ReturnType<typeof convexTest>,
  run: () => Promise<unknown>,
  message: string,
) {
  const before = await scheduleSnapshot(t);
  await expect(run()).rejects.toThrow(message);
  expect(await scheduleSnapshot(t)).toEqual(before);
}

async function seedScheduleWorld(t: ReturnType<typeof convexTest>) {
  const world = await makeWorld(t, {
    scholarsPerSchool: 1,
    parentsPerSchool: 0,
    includePlatformAdmin: false,
  });
  const [schoolA, schoolB] = world.schools;

  const rows = await t.run(async (ctx) => {
    const periodA = await ctx.db.insert("reportingPeriods", {
      label: "Moli Fall 2026",
      startsAt: Date.now(),
      endsAt: Date.now() + 90 * DAY,
      status: "open",
      institutionId: schoolA.id,
    });
    const periodB = await ctx.db.insert("reportingPeriods", {
      label: "Kona Fall 2026",
      startsAt: Date.now(),
      endsAt: Date.now() + 90 * DAY,
      status: "open",
      institutionId: schoolB.id,
    });
    const groupA = await ctx.db.insert("scholarGroups", {
      teacherId: schoolA.teacher.id,
      institutionId: schoolA.id,
      name: "Moli Group",
      scholarIds: [schoolA.scholars[0].id],
    });
    const groupB = await ctx.db.insert("scholarGroups", {
      teacherId: schoolB.teacher.id,
      institutionId: schoolB.id,
      name: "Kona Group",
      scholarIds: [schoolB.scholars[0].id],
    });
    const blockA = await ctx.db.insert("scheduleBlocks", {
      periodId: periodA,
      key: "moli-block-a",
      label: "Block A",
      startLocal: "08:30",
      endLocal: "09:40",
      weekdays: [1, 2, 3, 4, 5],
      order: 0,
    });
    const blockB = await ctx.db.insert("scheduleBlocks", {
      periodId: periodB,
      key: "kona-block-a",
      label: "Block A",
      startLocal: "08:30",
      endLocal: "09:40",
      weekdays: [1, 2, 3, 4, 5],
      order: 0,
    });

    const seedAssignment = async (
      teacherId: Id<"users">,
      institutionId: Id<"institutions">,
      scholarId: Id<"users">,
      scholarGroupId: Id<"scholarGroups">,
      suffix: string,
    ) => {
      const unitId = await ctx.db.insert("units", {
        teacherId,
        institutionId,
        title: `${suffix} Unit`,
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: `${suffix} Lesson`,
        order: 0,
      });
      await ctx.db.insert("activities", {
        lessonId,
        title: `${suffix} Activity`,
        kind: "online",
        systemPrompt: "...",
        order: 0,
      });
      return await ctx.db.insert("assignments", {
        teacherId,
        unitId,
        scholarIds: [scholarId],
        scholarGroupId,
        startedAt: Date.now(),
        activitySchedule: [],
      });
    };

    const assignmentA = await seedAssignment(
      schoolA.teacher.id,
      schoolA.id,
      schoolA.scholars[0].id,
      groupA,
      "Moli",
    );
    const assignmentB = await seedAssignment(
      schoolB.teacher.id,
      schoolB.id,
      schoolB.scholars[0].id,
      groupB,
      "Kona",
    );

    return {
      periodA,
      periodB,
      groupA,
      groupB,
      blockA,
      blockB,
      assignmentA,
      assignmentB,
    };
  });

  return { schoolA, schoolB, ...rows };
}

describe("master-schedule aide tenancy", () => {
  test("place and block mutations reject foreign write keys while local writes succeed", async () => {
    const t = convexTest(schema, modules);
    const {
      schoolA,
      schoolB,
      periodA,
      periodB,
      groupA,
      groupB,
      assignmentA,
    } = await seedScheduleWorld(t);

    await expectDeniedWithoutScheduleWrites(
      t,
      () =>
        t.mutation(internal.masterSchedule.aideCreateBlock, {
          callerUserId: schoolB.teacher.id,
          periodId: periodA,
          label: "Foreign period block",
          startLocal: "10:00",
          endLocal: "11:00",
        }),
      "Forbidden: that institution",
    );
    await expectDeniedWithoutScheduleWrites(
      t,
      () =>
        t.mutation(internal.masterSchedule.aideCreateBlock, {
          callerUserId: schoolB.teacher.id,
          periodId: periodB,
          groupId: groupA,
          label: "Foreign block",
          startLocal: "10:00",
          endLocal: "11:00",
        }),
      "Forbidden: group",
    );

    await expectDeniedWithoutScheduleWrites(
      t,
      () =>
        t.mutation(internal.masterSchedule.aidePlaceClass, {
          callerUserId: schoolB.teacher.id,
          periodId: periodA,
          groupId: groupB,
          subject: "Foreign period",
        }),
      "Forbidden: that institution",
    );
    await expectDeniedWithoutScheduleWrites(
      t,
      () =>
        t.mutation(internal.masterSchedule.aidePlaceClass, {
          callerUserId: schoolB.teacher.id,
          periodId: periodB,
          groupId: groupA,
          subject: "Foreign group",
        }),
      "Forbidden: group",
    );
    await expectDeniedWithoutScheduleWrites(
      t,
      () =>
        t.mutation(internal.masterSchedule.aidePlaceClass, {
          callerUserId: schoolB.teacher.id,
          periodId: periodB,
          groupId: groupB,
          subject: "Foreign teacher",
          teacherId: schoolA.teacher.id,
        }),
      "Forbidden: staff member",
    );
    await expectDeniedWithoutScheduleWrites(
      t,
      () =>
        t.mutation(internal.masterSchedule.aidePlaceClass, {
          callerUserId: schoolB.teacher.id,
          periodId: periodB,
          groupId: groupB,
          subject: "Foreign assignment",
          assignmentId: assignmentA,
        }),
      "Forbidden: assignment",
    );

    await expectDeniedWithoutScheduleWrites(
      t,
      () =>
        t.mutation(internal.masterSchedule.aidePlaceHomework, {
          callerUserId: schoolB.teacher.id,
          periodId: periodA,
          groupId: groupB,
          subject: "Foreign period",
        }),
      "Forbidden: that institution",
    );
    await expectDeniedWithoutScheduleWrites(
      t,
      () =>
        t.mutation(internal.masterSchedule.aidePlaceHomework, {
          callerUserId: schoolB.teacher.id,
          periodId: periodB,
          groupId: groupA,
          subject: "Foreign group",
        }),
      "Forbidden: group",
    );
    await expectDeniedWithoutScheduleWrites(
      t,
      () =>
        t.mutation(internal.masterSchedule.aidePlaceHomework, {
          callerUserId: schoolB.teacher.id,
          periodId: periodB,
          groupId: groupB,
          subject: "Foreign teacher",
          teacherId: schoolA.teacher.id,
        }),
      "Forbidden: staff member",
    );
    await expectDeniedWithoutScheduleWrites(
      t,
      () =>
        t.mutation(internal.masterSchedule.aidePlaceHomework, {
          callerUserId: schoolB.teacher.id,
          periodId: periodB,
          groupId: groupB,
          subject: "Foreign assignment",
          assignmentId: assignmentA,
        }),
      "Forbidden: assignment",
    );

    const blockId = await t.mutation(
      internal.masterSchedule.aideCreateBlock,
      {
        callerUserId: schoolA.teacher.id,
        periodId: periodA,
        groupId: groupA,
        label: "Local block",
        startLocal: "10:00",
        endLocal: "11:00",
      },
    );
    const classPlacementId = await t.mutation(
      internal.masterSchedule.aidePlaceClass,
      {
        callerUserId: schoolA.teacher.id,
        periodId: periodA,
        groupId: groupA,
        subject: "Local class",
        teacherId: schoolA.teacher.id,
        assignmentId: assignmentA,
      },
    );
    const homeworkPlacementId = await t.mutation(
      internal.masterSchedule.aidePlaceHomework,
      {
        callerUserId: schoolA.teacher.id,
        periodId: periodA,
        groupId: groupA,
        subject: "Local homework",
        teacherId: schoolA.teacher.id,
        assignmentId: assignmentA,
      },
    );

    expect(blockId).toBeDefined();
    expect(classPlacementId).toBeDefined();
    expect(homeworkPlacementId).toBeDefined();
  });

  test("cascade and update reject foreign group, staff, and assignment keys", async () => {
    const t = convexTest(schema, modules);
    const {
      schoolA,
      schoolB,
      periodA,
      periodB,
      groupA,
      groupB,
      blockA,
      blockB,
      assignmentA,
      assignmentB,
    } = await seedScheduleWorld(t);

    await expectDeniedWithoutScheduleWrites(
      t,
      () =>
        t.mutation(internal.masterSchedule.aideCascadeUnit, {
          callerUserId: schoolB.teacher.id,
          periodId: periodA,
          groupId: groupB,
          assignmentId: assignmentB,
          startWeekday: 1,
          startBlockId: blockB,
        }),
      "Forbidden: that institution",
    );
    await expectDeniedWithoutScheduleWrites(
      t,
      () =>
        t.mutation(internal.masterSchedule.aideCascadeUnit, {
          callerUserId: schoolB.teacher.id,
          periodId: periodB,
          groupId: groupA,
          assignmentId: assignmentB,
          startWeekday: 1,
          startBlockId: blockB,
        }),
      "Forbidden: group",
    );
    await expectDeniedWithoutScheduleWrites(
      t,
      () =>
        t.mutation(internal.masterSchedule.aideCascadeUnit, {
          callerUserId: schoolB.teacher.id,
          periodId: periodB,
          groupId: groupB,
          assignmentId: assignmentB,
          startWeekday: 1,
          startBlockId: blockB,
          teacherId: schoolA.teacher.id,
        }),
      "Forbidden: staff member",
    );
    await expectDeniedWithoutScheduleWrites(
      t,
      () =>
        t.mutation(internal.masterSchedule.aideCascadeUnit, {
          callerUserId: schoolB.teacher.id,
          periodId: periodB,
          groupId: groupB,
          assignmentId: assignmentA,
          startWeekday: 1,
          startBlockId: blockB,
        }),
      "Forbidden: assignment",
    );

    const placementA = await t.mutation(
      internal.masterSchedule.aidePlaceClass,
      {
        callerUserId: schoolA.teacher.id,
        periodId: periodA,
        groupId: groupA,
        subject: "Moli class",
        teacherId: schoolA.teacher.id,
        assignmentId: assignmentA,
      },
    );
    const placementB = await t.mutation(
      internal.masterSchedule.aidePlaceClass,
      {
        callerUserId: schoolB.teacher.id,
        periodId: periodB,
        groupId: groupB,
        subject: "Kona class",
        teacherId: schoolB.teacher.id,
        assignmentId: assignmentB,
      },
    );

    await expectDeniedWithoutScheduleWrites(
      t,
      () =>
        t.mutation(internal.masterSchedule.aideUpdatePlacement, {
          callerUserId: schoolB.teacher.id,
          placementId: placementA,
          subject: "Foreign placement",
        }),
      "Forbidden: group",
    );
    await expectDeniedWithoutScheduleWrites(
      t,
      () =>
        t.mutation(internal.masterSchedule.aideUpdatePlacement, {
          callerUserId: schoolB.teacher.id,
          placementId: placementB,
          teacherId: schoolA.teacher.id,
        }),
      "Forbidden: staff member",
    );
    await expectDeniedWithoutScheduleWrites(
      t,
      () =>
        t.mutation(internal.masterSchedule.aideUpdatePlacement, {
          callerUserId: schoolB.teacher.id,
          placementId: placementB,
          assignmentId: assignmentA,
        }),
      "Forbidden: assignment",
    );

    const cascade = await t.mutation(
      internal.masterSchedule.aideCascadeUnit,
      {
        callerUserId: schoolA.teacher.id,
        periodId: periodA,
        groupId: groupA,
        assignmentId: assignmentA,
        startWeekday: 1,
        startBlockId: blockA,
        teacherId: schoolA.teacher.id,
        layout: "sameDay",
      },
    );
    await t.mutation(internal.masterSchedule.aideUpdatePlacement, {
      callerUserId: schoolA.teacher.id,
      placementId: placementA,
      subject: "Updated local class",
      teacherId: schoolA.teacher.id,
      assignmentId: assignmentA,
    });

    expect(cascade.placementIds).toHaveLength(1);
    expect(
      await t.run((ctx) => ctx.db.get(placementA)),
    ).toMatchObject({ subject: "Updated local class" });
  });

  test("reassign teacher checks both staff ids and the optional group", async () => {
    const t = convexTest(schema, modules);
    const { schoolA, schoolB, periodA, periodB, groupA } =
      await seedScheduleWorld(t);

    await expectDeniedWithoutScheduleWrites(
      t,
      () =>
        t.mutation(internal.masterSchedule.aideReassignTeacher, {
          callerUserId: schoolB.teacher.id,
          periodId: periodA,
          fromTeacherId: schoolB.teacher.id,
          toTeacherId: null,
        }),
      "Forbidden: that institution",
    );
    await expectDeniedWithoutScheduleWrites(
      t,
      () =>
        t.mutation(internal.masterSchedule.aideReassignTeacher, {
          callerUserId: schoolB.teacher.id,
          periodId: periodB,
          fromTeacherId: schoolA.teacher.id,
          toTeacherId: null,
        }),
      "Forbidden: staff member",
    );
    await expectDeniedWithoutScheduleWrites(
      t,
      () =>
        t.mutation(internal.masterSchedule.aideReassignTeacher, {
          callerUserId: schoolB.teacher.id,
          periodId: periodB,
          fromTeacherId: schoolB.teacher.id,
          toTeacherId: schoolA.admin.id,
        }),
      "Forbidden: staff member",
    );
    await expectDeniedWithoutScheduleWrites(
      t,
      () =>
        t.mutation(internal.masterSchedule.aideReassignTeacher, {
          callerUserId: schoolB.teacher.id,
          periodId: periodB,
          fromTeacherId: schoolB.teacher.id,
          toTeacherId: null,
          groupId: groupA,
        }),
      "Forbidden: group",
    );

    await t.mutation(internal.masterSchedule.aidePlaceClass, {
      callerUserId: schoolA.teacher.id,
      periodId: periodA,
      groupId: groupA,
      subject: "Needs coverage",
      teacherId: schoolA.teacher.id,
    });
    const result = await t.mutation(
      internal.masterSchedule.aideReassignTeacher,
      {
        callerUserId: schoolA.teacher.id,
        periodId: periodA,
        fromTeacherId: schoolA.teacher.id,
        toTeacherId: schoolA.admin.id,
        groupId: groupA,
      },
    );
    expect(result.count).toBe(1);
  });
});
