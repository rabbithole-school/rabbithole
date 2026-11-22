import { convexTest } from "convex-test";
import { insertAssignmentWithSchedule, setSchedule } from "./scheduleFixtures";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { seedTestInstitution } from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function asUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 3_600_000,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedProgramGuestWork(t: ReturnType<typeof convexTest>) {
  const institutionId = await seedTestInstitution(t, {
    slug: "program-guest-unit-access",
  });
  const __mirrored = await t.run(async (ctx) => {
    const teacher = await ctx.db.insert("users", {
      name: "Program teacher",
      username: "program-unit-teacher",
      role: "teacher",
    });
    const guest = await ctx.db.insert("users", {
      name: "Program guest",
      username: "program-unit-guest",
      role: "scholar",
      institutionId,
      enrollmentStanding: "program_guest",
    });
    const groupId = await ctx.db.insert("scholarGroups", {
      teacherId: teacher,
      institutionId,
      name: "Robotics",
      participation: "includes_program_guests",
      scholarIds: [guest],
    });
    const assignedUnit = await ctx.db.insert("units", {
      teacherId: teacher,
      institutionId,
      title: "Assigned robotics work",
      isActive: true,
    });
    const ordinaryUnit = await ctx.db.insert("units", {
      teacherId: teacher,
      institutionId,
      title: "Ordinary school work",
      isActive: true,
    });
    const assignedLesson = await ctx.db.insert("lessons", {
      unitId: assignedUnit,
      title: "Build",
      order: 0,
    });
    const assignedActivity = await ctx.db.insert("activities", {
      lessonId: assignedLesson,
      title: "Program activity",
      kind: "online",
      order: 0,
    });
    const ordinaryLesson = await ctx.db.insert("lessons", {
      unitId: ordinaryUnit,
      title: "Ordinary lesson",
      order: 0,
    });
    const ordinaryActivity = await ctx.db.insert("activities", {
      lessonId: ordinaryLesson,
      title: "Ordinary activity",
      kind: "online",
      order: 0,
    });
    const unassignedActivity = await ctx.db.insert("activities", {
      lessonId: assignedLesson,
      title: "Unassigned program-unit activity",
      kind: "online",
      order: 1,
    });
    const assignmentId = await insertAssignmentWithSchedule(ctx, {
      teacherId: teacher,
      unitId: assignedUnit,
      scholarGroupId: groupId,
      scholarIds: [guest],
      startedAt: Date.now(),
      selfPaced: true,
      activitySchedule: [
        {
          activityId: assignedActivity,
          mode: "homework",
          setAt: Date.now(),
        },
      ],
    });
    return {
      guest,
      assignmentId,
      assignedUnit,
      assignedActivity,
      unassignedActivity,
      ordinaryUnit,
      ordinaryActivity,
    };
  });
  return __mirrored;
}

async function expectInactiveProgramWorkDenied(
  t: ReturnType<typeof convexTest>,
  work: Awaited<ReturnType<typeof seedProgramGuestWork>>,
) {
  const asGuest = await asUser(t, work.guest);
  const units = await asGuest.query(api.units.list, {});
  expect(units.map((unit) => unit._id)).not.toContain(work.assignedUnit);
  await expect(
    asGuest.mutation(api.sessions.startUnit, { unitId: work.assignedUnit }),
  ).rejects.toThrow(/assigned program work/i);
  await expect(
    asGuest.mutation(api.sessions.create, {
      unitId: work.assignedUnit,
      activityId: work.assignedActivity,
    }),
  ).rejects.toThrow(/assigned program work/i);
}

describe("program guest unit boundary", () => {
  test("units.list exposes only assigned program units to a program guest", async () => {
    const t = convexTest(schema, modules);
    const { guest, assignedUnit, ordinaryUnit } = await seedProgramGuestWork(t);

    const units = await (await asUser(t, guest)).query(api.units.list, {});

    expect(units.map((unit) => unit._id)).toContain(assignedUnit);
    expect(units.map((unit) => unit._id)).not.toContain(ordinaryUnit);
  });

  test("sessions.startUnit rejects ordinary units but starts assigned program work", async () => {
    const t = convexTest(schema, modules);
    const { guest, assignedUnit, ordinaryUnit } = await seedProgramGuestWork(t);
    const asGuest = await asUser(t, guest);

    await expect(
      asGuest.mutation(api.sessions.startUnit, { unitId: ordinaryUnit }),
    ).rejects.toThrow(/assigned program work/i);
    const { id } = await asGuest.mutation(api.sessions.startUnit, {
      unitId: assignedUnit,
    });
    const session = await t.run((ctx) => ctx.db.get(id));
    expect(session).toMatchObject({
      userId: guest,
      unitId: assignedUnit,
      assignmentId: expect.any(String),
    });
  });

  test("sessions.create stamps assigned program work and rejects omitted-assignment bypasses", async () => {
    const t = convexTest(schema, modules);
    const {
      guest,
      assignedUnit,
      assignedActivity,
      unassignedActivity,
      ordinaryUnit,
      ordinaryActivity,
    } = await seedProgramGuestWork(t);
    const asGuest = await asUser(t, guest);

    await expect(
      asGuest.mutation(api.sessions.create, {
        unitId: ordinaryUnit,
        activityId: ordinaryActivity,
      }),
    ).rejects.toThrow(/assigned program work/i);
    await expect(
      asGuest.mutation(api.sessions.create, { unitId: assignedUnit }),
    ).rejects.toThrow(/assigned program work/i);
    await expect(
      asGuest.mutation(api.sessions.create, {
        unitId: assignedUnit,
        activityId: unassignedActivity,
      }),
    ).rejects.toThrow(/assigned program work/i);

    const { id } = await asGuest.mutation(api.sessions.create, {
      unitId: assignedUnit,
      activityId: assignedActivity,
    });
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({
      userId: guest,
      unitId: assignedUnit,
      activityId: assignedActivity,
      assignmentId: expect.any(String),
    });
  });

  test("a program guest can make, list, and run their own Quest", async () => {
    const t = convexTest(schema, modules);
    const { guest } = await seedProgramGuestWork(t);
    const asGuest = await asUser(t, guest);

    // The Custom Quest dialog's sequence: mint the unit, then open a session.
    const { unitId } = await asGuest.mutation(api.units.createQuest, {
      title: "How do black holes work?",
    });
    const { id } = await asGuest.mutation(api.sessions.create, { unitId });
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({
      userId: guest,
      unitId,
    });

    const units = await asGuest.query(api.units.list, {});
    expect(units.map((unit) => unit._id)).toContain(unitId);
    const reopened = await asGuest.mutation(api.sessions.startUnit, { unitId });
    expect(await t.run((ctx) => ctx.db.get(reopened.id))).toMatchObject({
      userId: guest,
      unitId,
    });

    // A free-form chat mints its own Quest the same way.
    const freeForm = await asGuest.mutation(api.sessions.create, {});
    const freeFormSession = await t.run((ctx) => ctx.db.get(freeForm.id));
    const freeFormUnit = await t.run((ctx) =>
      ctx.db.get(freeFormSession!.unitId!),
    );
    expect(freeFormUnit?.authorScholarId).toBe(guest);
  });

  test("an own Quest cannot carry in an unassigned activity or lesson", async () => {
    const t = convexTest(schema, modules);
    const { guest, ordinaryActivity, ordinaryUnit } = await seedProgramGuestWork(t);
    const asGuest = await asUser(t, guest);
    const { unitId } = await asGuest.mutation(api.units.createQuest, {
      title: "How do black holes work?",
    });
    const ordinaryLesson = await t.run(
      async (ctx) => (await ctx.db.get(ordinaryActivity))!.lessonId!,
    );
    expect(ordinaryLesson).toBeDefined();
    expect(ordinaryUnit).toBeDefined();

    // Refused at the anchors now, for every scholar (sessions.ts
    // requireConsistentSessionAnchors, TRA-685).
    await expect(
      asGuest.mutation(api.sessions.create, {
        unitId,
        activityId: ordinaryActivity,
      }),
    ).rejects.toThrow(/isn't part of this unit/i);
    await expect(
      asGuest.mutation(api.sessions.create, { unitId, lessonId: ordinaryLesson }),
    ).rejects.toThrow(/isn't part of this unit/i);
  });

  test("a program guest still cannot open another scholar's Quest", async () => {
    const t = convexTest(schema, modules);
    const { guest } = await seedProgramGuestWork(t);
    const otherQuest = await t.run(async (ctx) => {
      const guestRow = await ctx.db.get(guest);
      const other = await ctx.db.insert("users", {
        name: "Other scholar",
        username: "program-unit-other",
        role: "scholar",
        institutionId: guestRow!.institutionId,
      });
      return await ctx.db.insert("units", {
        teacherId: other,
        institutionId: guestRow!.institutionId,
        authorScholarId: other,
        title: "Someone else's Quest",
        isActive: true,
      });
    });

    await expect(
      (await asUser(t, guest)).mutation(api.sessions.create, {
        unitId: otherQuest,
      }),
    ).rejects.toThrow(/assigned program work/i);
  });

  test("program guests cannot access work that has not been activated", async () => {
    const t = convexTest(schema, modules);
    const work = await seedProgramGuestWork(t);
    await t.run((ctx) =>
      setSchedule(ctx, work.assignmentId, [
          { activityId: work.assignedActivity, mode: "homework" },
        ]),
    );

    await expectInactiveProgramWorkDenied(t, work);
  });

  test("program guests cannot access work scheduled for the future", async () => {
    const t = convexTest(schema, modules);
    const work = await seedProgramGuestWork(t);
    await t.run((ctx) =>
      setSchedule(ctx, work.assignmentId, [
          {
            activityId: work.assignedActivity,
            mode: "homework",
            startsAt: Date.now() + 60_000,
          },
        ]),
    );

    await expectInactiveProgramWorkDenied(t, work);
  });

  test("program guests cannot access expired scheduled work", async () => {
    const t = convexTest(schema, modules);
    const work = await seedProgramGuestWork(t);
    await t.run((ctx) =>
      setSchedule(ctx, work.assignmentId, [
          {
            activityId: work.assignedActivity,
            mode: "homework",
            setAt: Date.now() - 60_000,
            endsAt: Date.now() - 1,
          },
        ]),
    );

    await expectInactiveProgramWorkDenied(t, work);
  });
});
