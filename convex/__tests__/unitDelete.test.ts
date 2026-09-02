import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// ─── Standard fixtures (copied verbatim from the test-drive suites) ──

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role = "scholar",
  overrides: { name?: string; username?: string } = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: overrides.name ?? `Test ${role}`,
      username: overrides.username ?? `test${role}`,
      role,
    }),
  );
}

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

/** Unit + one lesson + one online activity, owned by `teacherId`. */
async function seedUnit(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Test Unit",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Test Lesson",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Test Activity",
      kind: "online",
      systemPrompt: "...",
      order: 0,
    });
    return { unitId, lessonId, activityId };
  });
}

describe("units.remove — hard delete + cascade", () => {
  test("deletes a never-run unit and cascades its design content", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const asTeacher = await withUser(t, teacher);
    const { unitId, lessonId, activityId } = await seedUnit(t, teacher);

    // Curriculum Bot threads scoped to this unit — should be swept.
    const { msgId, sessionId } = await t.run(async (ctx) => {
      const msgId = await ctx.db.insert("curriculumMessages", {
        teacherId: teacher,
        unitId,
        role: "user",
        content: "design chat",
      });
      const sessionId = await ctx.db.insert("chats", {
        teacherId: teacher,
        title: "Bot thread",
        unitId,
        pinned: false,
        lastMessageAt: Date.now(),
      });
      return { msgId, sessionId };
    });

    await asTeacher.mutation(api.units.remove, { id: unitId });

    const after = await t.run(async (ctx) => ({
      unit: await ctx.db.get(unitId),
      lesson: await ctx.db.get(lessonId),
      activity: await ctx.db.get(activityId),
      msg: await ctx.db.get(msgId),
      session: await ctx.db.get(sessionId),
    }));
    expect(after.unit).toBeNull();
    expect(after.lesson).toBeNull();
    expect(after.activity).toBeNull();
    expect(after.msg).toBeNull();
    expect(after.session).toBeNull();
  });

  test("purges leftover test-drive projects (and their messages)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const asTeacher = await withUser(t, teacher);
    const { unitId } = await seedUnit(t, teacher);

    const { sessionId, messageId } = await t.run(async (ctx) => {
      const sessionId = await ctx.db.insert("sessions", {
        userId: teacher,
        title: "Test Drive",
        isArchived: false,
        unitId,
        isTestDrive: true,
      });
      const messageId = await ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: "hi",
        flagged: false,
      });
      return { sessionId, messageId };
    });

    await asTeacher.mutation(api.units.remove, { id: unitId });

    const after = await t.run(async (ctx) => ({
      unit: await ctx.db.get(unitId),
      session: await ctx.db.get(sessionId),
      message: await ctx.db.get(messageId),
    }));
    expect(after.unit).toBeNull();
    expect(after.session).toBeNull();
    expect(after.message).toBeNull();
  });

  test("blocks delete when the unit has an assignment", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "s1" });
    const asTeacher = await withUser(t, teacher);
    const { unitId } = await seedUnit(t, teacher);

    await t.run(async (ctx) =>
      ctx.db.insert("assignments", {
        teacherId: teacher,
        unitId,
        scholarIds: [scholar],
        startedAt: Date.now(),
        activitySchedule: [],
      }),
    );

    await expect(
      asTeacher.mutation(api.units.remove, { id: unitId }),
    ).rejects.toThrow(/assignment/i);
    // Unit survives a blocked delete.
    expect(await t.run((ctx) => ctx.db.get(unitId))).not.toBeNull();
  });

  test("blocks delete when a real scholar project references the unit", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "s2" });
    const asTeacher = await withUser(t, teacher);
    const { unitId } = await seedUnit(t, teacher);

    await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId: scholar,
        title: "Real work",
        isArchived: false,
        unitId,
        isTestDrive: false,
      }),
    );

    await expect(
      asTeacher.mutation(api.units.remove, { id: unitId }),
    ).rejects.toThrow(/scholar project/i);
    expect(await t.run((ctx) => ctx.db.get(unitId))).not.toBeNull();
  });

  test("forbids a non-author scholar from deleting a unit", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "intruder" });
    const asScholar = await withUser(t, scholar);
    const { unitId } = await seedUnit(t, teacher);

    await expect(
      asScholar.mutation(api.units.remove, { id: unitId }),
    ).rejects.toThrow(/forbidden|not allowed/i);
    expect(await t.run((ctx) => ctx.db.get(unitId))).not.toBeNull();
  });
});

describe("units.reactivate", () => {
  test("flips an archived unit back to active", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const asTeacher = await withUser(t, teacher);
    const { unitId } = await seedUnit(t, teacher);

    await asTeacher.mutation(api.units.deactivate, { id: unitId });
    expect(await t.run((ctx) => ctx.db.get(unitId))).toMatchObject({
      isActive: false,
    });

    await asTeacher.mutation(api.units.reactivate, { id: unitId });
    expect(await t.run((ctx) => ctx.db.get(unitId))).toMatchObject({
      isActive: true,
    });
  });
});

describe("units.deletionImpact", () => {
  test("reports counts and allows delete for a clean unit", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const asTeacher = await withUser(t, teacher);
    const { unitId } = await seedUnit(t, teacher);

    const impact = await asTeacher.query(api.units.deletionImpact, {
      id: unitId,
    });
    expect(impact).toMatchObject({
      title: "Test Unit",
      isActive: true,
      lessonCount: 1,
      activityCount: 1,
      assignmentCount: 0,
      sessionCount: 0,
      canDelete: true,
    });
  });

  test("blocks delete (canDelete=false) when an assignment exists", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "s3" });
    const asTeacher = await withUser(t, teacher);
    const { unitId } = await seedUnit(t, teacher);

    await t.run(async (ctx) =>
      ctx.db.insert("assignments", {
        teacherId: teacher,
        unitId,
        scholarIds: [scholar],
        startedAt: Date.now(),
        activitySchedule: [],
      }),
    );

    const impact = await asTeacher.query(api.units.deletionImpact, {
      id: unitId,
    });
    expect(impact).toMatchObject({ assignmentCount: 1, canDelete: false });
  });

  test("ignores test-drive sessions in the sessionCount gate", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const asTeacher = await withUser(t, teacher);
    const { unitId } = await seedUnit(t, teacher);

    await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId: teacher,
        title: "Test Drive",
        isArchived: false,
        unitId,
        isTestDrive: true,
      }),
    );

    const impact = await asTeacher.query(api.units.deletionImpact, {
      id: unitId,
    });
    expect(impact).toMatchObject({ sessionCount: 0, canDelete: true });
  });
});
