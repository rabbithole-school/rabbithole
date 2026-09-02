import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { grantStaffAccessToScholars } from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" | "platform_admin" = "scholar",
  overrides: Partial<Doc<"users">> = {},
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("users", {
      name: overrides.name ?? (role === "scholar" ? "Test Scholar" : `Test ${role}`),
      username:
        overrides.username ??
        (role === "scholar" ? "testscholar" : `test${role}`),
      role,
      readingLevel: overrides.readingLevel,
      image: overrides.image,
    });
  });
}

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedUnitWithActivity(
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
      systemPrompt: "You are testing this activity.",
      order: 0,
    });
    return { unitId, lessonId, activityId };
  });
}

describe("teacherMoveStep", () => {
  test("__complete on an assignment-scoped session writes the completion ledger", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { unitId, lessonId, activityId } = await seedUnitWithActivity(
      t,
      teacherId,
    );
    const { assignmentId, sessionId } = await t.run(async (ctx) => {
      const institutionId = await ctx.db.insert("institutions", {
        name: "Moli School",
        slug: "moli",
        kind: "school",
      });
      await ctx.db.patch(scholarId, { institutionId });
      await ctx.db.insert("memberships", {
        userId: teacherId,
        role: "teacher",
        institutionId,
      });
      const assignmentId = await ctx.db.insert("assignments", {
        teacherId,
        unitId,
        scholarIds: [scholarId],
        startedAt: Date.now(),
      });
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholarId,
        unitId,
        lessonId,
        activityId,
        assignmentId,
        title: "Assigned activity",
        isArchived: false,
      });
      return { assignmentId, sessionId };
    });
    const asTeacher = await withUser(t, teacherId);

    await asTeacher.mutation(api.processState.teacherMoveStep, {
      sessionId,
      stepKey: "__complete",
    });

    const { completions, session } = await t.run(async (ctx) => ({
      completions: await ctx.db
        .query("activityCompletions")
        .withIndex("by_scholar_activity", (q) =>
          q.eq("scholarId", scholarId).eq("activityId", activityId),
        )
        .collect(),
      session: await ctx.db.get(sessionId),
    }));
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({
      scholarId,
      activityId,
      sessionId,
      assignmentId,
      lessonId,
      unitId,
    });
    expect(session?.activityCompletedAt).toEqual(expect.any(Number));

    const listed = await asTeacher.query(
      api.activityCompletions.listForScholarInUnit,
      { scholarId, unitId, assignmentId },
    );
    expect(listed).toEqual([
      expect.objectContaining({
        activityId,
      }),
    ]);
  });

  test("__complete on a test-drive session writes NO scholar completion", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { unitId, lessonId, activityId } = await seedUnitWithActivity(
      t,
      teacherId,
    );
    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId: teacherId,
        unitId,
        lessonId,
        activityId,
        title: "Test drive",
        isArchived: false,
        isTestDrive: true,
      }),
    );
    const asTeacher = await withUser(t, teacherId);

    await asTeacher.mutation(api.processState.teacherMoveStep, {
      sessionId,
      stepKey: "__complete",
    });

    const { completions, session } = await t.run(async (ctx) => ({
      completions: await ctx.db.query("activityCompletions").collect(),
      session: await ctx.db.get(sessionId),
    }));
    expect(completions).toHaveLength(0);
    expect(session?.activityCompletedAt).toEqual(expect.any(Number));
  });

  test("__complete still stamps the card when the activity was deleted out from under the session", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    await grantStaffAccessToScholars(t, {
      staffUserId: teacherId,
      scholarIds: [scholarId],
    });
    const { activityId } = await seedUnitWithActivity(t, teacherId);
    const sessionId = await t.run(async (ctx) => {
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholarId,
        activityId,
        title: "Orphaned activity",
        isArchived: false,
      });
      // Activity is removed after the session was created; the session keeps a
      // dangling activityId.
      await ctx.db.delete(activityId);
      return sessionId;
    });
    const asTeacher = await withUser(t, teacherId);

    await asTeacher.mutation(api.processState.teacherMoveStep, {
      sessionId,
      stepKey: "__complete",
    });

    const { completions, session } = await t.run(async (ctx) => ({
      completions: await ctx.db.query("activityCompletions").collect(),
      session: await ctx.db.get(sessionId),
    }));
    expect(completions).toHaveLength(0);
    expect(session?.activityCompletedAt).toEqual(expect.any(Number));
  });
});
