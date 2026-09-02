import { convexTest } from "convex-test";
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
  return await t.run(async (ctx) => {
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
    const assignmentId = await ctx.db.insert("assignments", {
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

  test("program guests cannot access work that has not been activated", async () => {
    const t = convexTest(schema, modules);
    const work = await seedProgramGuestWork(t);
    await t.run((ctx) =>
      ctx.db.patch(work.assignmentId, {
        activitySchedule: [
          { activityId: work.assignedActivity, mode: "homework" },
        ],
      }),
    );

    await expectInactiveProgramWorkDenied(t, work);
  });

  test("program guests cannot access work scheduled for the future", async () => {
    const t = convexTest(schema, modules);
    const work = await seedProgramGuestWork(t);
    await t.run((ctx) =>
      ctx.db.patch(work.assignmentId, {
        activitySchedule: [
          {
            activityId: work.assignedActivity,
            mode: "homework",
            startsAt: Date.now() + 60_000,
          },
        ],
      }),
    );

    await expectInactiveProgramWorkDenied(t, work);
  });

  test("program guests cannot access expired scheduled work", async () => {
    const t = convexTest(schema, modules);
    const work = await seedProgramGuestWork(t);
    await t.run((ctx) =>
      ctx.db.patch(work.assignmentId, {
        activitySchedule: [
          {
            activityId: work.assignedActivity,
            mode: "homework",
            setAt: Date.now() - 60_000,
            endsAt: Date.now() - 1,
          },
        ],
      }),
    );

    await expectInactiveProgramWorkDenied(t, work);
  });
});
