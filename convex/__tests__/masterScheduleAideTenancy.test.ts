import { convexTest } from "convex-test";
import { placeHomeworkCard } from "./legacyCards";
import { insertAssignmentWithSchedule } from "./scheduleFixtures";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { makeWorld } from "./factories/world";
import { grantInstitutionMembership } from "./institutionTestHelpers";

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
      return await insertAssignmentWithSchedule(ctx, {
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

  return { schoolA, schoolB, as: world.as, ...rows };
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
      blockA,
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
    // Work on a cell is a give to the class there (TRA-582): another
    // school's group is refused before anything is given.
    const activityA = await t.run(async (ctx) => (await ctx.db.query("activities").first())!._id);
    await expectDeniedWithoutScheduleWrites(
      t,
      () =>
        t.mutation(internal.gridGiveActions.aideGiveToClass, {
          callerUserId: schoolB.teacher.id,
          periodId: periodA,
          groupId: groupA,
          blockId: blockA,
          dayKey: "2026-11-16",
          activityId: activityA,
          finish: "inClass",
        }),
      "Forbidden",
    );


    // The bell schedule is school-admin-only (2026-11-08): school A's admin
    // makes the local block.
    const blockId = await t.mutation(
      internal.masterSchedule.aideCreateBlock,
      {
        callerUserId: schoolA.admin.id,
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
        weekday: 1,
        blockId: blockA,
      },
    );

    expect(blockId).toBeDefined();
    expect(classPlacementId).toBeDefined();
  });

  test("update rejects foreign group and staff keys", async () => {
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
    } = await seedScheduleWorld(t);

    const placementA = await t.mutation(
      internal.masterSchedule.aidePlaceClass,
      {
        callerUserId: schoolA.teacher.id,
        periodId: periodA,
        groupId: groupA,
        subject: "Moli class",
        teacherId: schoolA.teacher.id,
        weekday: 1,
        blockId: blockA,
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
        weekday: 1,
        blockId: blockB,
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

    await t.mutation(internal.masterSchedule.aideUpdatePlacement, {
      callerUserId: schoolA.teacher.id,
      placementId: placementA,
      subject: "Updated local class",
      teacherId: schoolA.teacher.id,
    });

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

  test("grid reads refuse a term from a school the caller cannot see", async () => {
    const t = convexTest(schema, modules);
    const { schoolA, schoolB, as, periodA, periodB } = await seedScheduleWorld(t);
    const teacherA = await as.staffOf(schoolA, "teacher");
    const teacherB = await as.staffOf(schoolB, "teacher");

    await expect(
      teacherB.query(api.masterSchedule.grid, { periodId: periodA }),
    ).rejects.toThrow("Forbidden: that institution");
    await expect(
      t.query(internal.masterSchedule.aideGrid, {
        callerUserId: schoolB.teacher.id,
        periodId: periodA,
      }),
    ).rejects.toThrow("Forbidden: that institution");
    await expect(
      teacherB.query(api.masterSchedule.periodClock, { periodId: periodA }),
    ).rejects.toThrow("Forbidden: that institution");
    await expectDeniedWithoutScheduleWrites(
      t,
      () => teacherB.mutation(api.masterSchedule.ensureHomeworkRail, { periodId: periodA }),
      "Forbidden: that institution",
    );

    const ownGrid = await teacherA.query(api.masterSchedule.grid, { periodId: periodA });
    expect(ownGrid.blocks.map((block) => block.label)).toContain("Block A");
    const ownAideGrid = await t.query(internal.masterSchedule.aideGrid, {
      callerUserId: schoolB.teacher.id,
      periodId: periodB,
    });
    expect(ownAideGrid.blocks.map((block) => block.label)).toContain("Block A");
    await teacherA.query(api.masterSchedule.periodClock, { periodId: periodA });
  });

  test("a legacy unstamped term reads as the primary school's", async () => {
    const t = convexTest(schema, modules);
    const { schoolA, schoolB, as } = await seedScheduleWorld(t);
    const legacyPeriod = await t.run((ctx) =>
      ctx.db.insert("reportingPeriods", {
        label: "Legacy term",
        startsAt: Date.now(),
        endsAt: Date.now() + 90 * DAY,
        status: "open",
      }),
    );
    const teacherA = await as.staffOf(schoolA, "teacher");
    const teacherB = await as.staffOf(schoolB, "teacher");

    await expect(
      teacherB.query(api.masterSchedule.grid, { periodId: legacyPeriod }),
    ).rejects.toThrow("Forbidden: that institution");
    const primaryGrid = await teacherA.query(api.masterSchedule.grid, {
      periodId: legacyPeriod,
    });
    expect(primaryGrid.blocks).toEqual([]);
  });

  test("the aide's term list holds only the caller's schools", async () => {
    const t = convexTest(schema, modules);
    const { schoolA, schoolB, periodA, periodB } = await seedScheduleWorld(t);
    const legacyPeriod = await t.run((ctx) =>
      ctx.db.insert("reportingPeriods", {
        label: "Legacy term",
        startsAt: Date.now(),
        endsAt: Date.now() + 90 * DAY,
        status: "open",
      }),
    );

    const termsB = await t.query(internal.masterSchedule.aideListTerms, {
      callerUserId: schoolB.teacher.id,
    });
    expect(termsB.map((term) => term._id)).toEqual([periodB]);

    const termsA = await t.query(internal.masterSchedule.aideListTerms, {
      callerUserId: schoolA.teacher.id,
    });
    expect(termsA.map((term) => term._id).sort()).toEqual(
      [periodA, legacyPeriod].sort(),
    );
  });

  test("teacher place mutations refuse a foreign term or another term's block", async () => {
    const t = convexTest(schema, modules);
    const { schoolA, schoolB, as, periodA, periodB, groupA, groupB } =
      await seedScheduleWorld(t);
    const teacherA = await as.staffOf(schoolA, "teacher");
    const teacherB = await as.staffOf(schoolB, "teacher");

    await expectDeniedWithoutScheduleWrites(
      t,
      () =>
        teacherB.mutation(api.masterSchedule.placeClass, {
          periodId: periodA,
          groupId: groupB,
          subject: "Foreign term class",
        }),
      "Forbidden: that institution",
    );

    // A second term at school A: its block can't be named under periodA.
    const otherTermBlock = await t.run(async (ctx) => {
      const periodA2 = await ctx.db.insert("reportingPeriods", {
        label: "Moli Spring 2027",
        startsAt: Date.now() + 100 * DAY,
        endsAt: Date.now() + 190 * DAY,
        status: "upcoming",
        institutionId: schoolA.id,
      });
      return ctx.db.insert("scheduleBlocks", {
        periodId: periodA2,
        key: "moli-spring-block-a",
        label: "Block A",
        startLocal: "08:30",
        endLocal: "09:40",
        weekdays: [1, 2, 3, 4, 5],
        order: 0,
      });
    });
    await expectDeniedWithoutScheduleWrites(
      t,
      () =>
        teacherA.mutation(api.masterSchedule.placeClass, {
          periodId: periodA,
          groupId: groupA,
          subject: "Wrong-term block",
          weekday: 1,
          blockId: otherTermBlock,
        }),
      "Forbidden: that block belongs to a different term",
    );
    await expectDeniedWithoutScheduleWrites(
      t,
      () =>
        t.mutation(internal.masterSchedule.aidePlaceClass, {
          callerUserId: schoolA.teacher.id,
          periodId: periodA,
          groupId: groupA,
          subject: "Wrong-term block",
          weekday: 1,
          blockId: otherTermBlock,
        }),
      "Forbidden: that block belongs to a different term",
    );

    // Local writes still land.
    await placeHomeworkCard(teacherA, {
      periodId: periodA,
      groupId: groupA,
      subject: "Local homework",
    });
    await teacherB.mutation(api.masterSchedule.placeClass, {
      periodId: periodB,
      groupId: groupB,
      subject: "Local class",
    });
    const subjects = await t.run(async (ctx) =>
      (await ctx.db.query("schedulePlacements").collect()).map((p) => p.subject),
    );
    expect(subjects).toEqual(expect.arrayContaining(["Local homework", "Local class"]));
  });

  test("a platform admin and a two-school teacher read both schools' grids", async () => {
    const t = convexTest(schema, modules);
    const { schoolA, schoolB, as, periodA, periodB } = await seedScheduleWorld(t);
    const admin = await as.platformAdmin();
    for (const periodId of [periodA, periodB]) {
      const grid = await admin.query(api.masterSchedule.grid, { periodId });
      expect(grid.blocks.map((block) => block.label)).toContain("Block A");
    }

    await grantInstitutionMembership(t, schoolB.teacher.id, schoolA.id);
    const twoSchoolTeacher = await as.staffOf(schoolB, "teacher");
    for (const periodId of [periodA, periodB]) {
      const grid = await twoSchoolTeacher.query(api.masterSchedule.grid, { periodId });
      expect(grid.blocks.map((block) => block.label)).toContain("Block A");
    }
  });
});
