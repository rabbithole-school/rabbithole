import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" | "platform_admin" = "scholar",
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("users", {
      name: role === "scholar" ? "Test Scholar" : `Test ${role}`,
      username: role === "scholar" ? "testscholar" : `test${role}`,
      role,
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

describe("getBigPicture — progress views", () => {
  test("returns LessonProgress when the project's activity is in a lesson", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");

    // Seed unit + lesson + two activities.
    const { activityAId, activityBId, sessionId } = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "Unit",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Lesson 1",
        order: 0,
      });
      const activityAId = await ctx.db.insert("activities", {
        lessonId,
        title: "Activity A",
        kind: "online",
        systemPrompt: "A",
        order: 0,
      });
      const activityBId = await ctx.db.insert("activities", {
        lessonId,
        title: "Activity B",
        kind: "online",
        systemPrompt: "B",
        order: 1,
      });
      // Mark Activity A complete (scholar finished it).
      await ctx.db.insert("activityCompletions", {
        scholarId,
        activityId: activityAId,
        lessonId,
        unitId,
        completedAt: Date.now(),
      });
      // Create a project for the scholar on Activity B (the
      // current activity).
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholarId,
        unitId,
        lessonId,
        activityId: activityBId,
        title: "My project on B",
        isArchived: false,
      });
      return { activityAId, activityBId, sessionId };
    });

    const asScholar = await withUser(t, scholarId);
    const result = await asScholar.query(api.sessions.getBigPicture, {
      sessionId,
    });
    expect(result).not.toBeNull();
    const progress = result!.progress!;
    expect(progress.kind).toBe("lesson");
    if (progress.kind !== "lesson") return;
    expect(progress.activities).toHaveLength(2);
    expect(String(progress.activities[0].activityId)).toBe(String(activityAId));
    expect(progress.activities[0].status).toBe("passed");
    expect(progress.activities[0].isCurrent).toBe(false);
    expect(String(progress.activities[1].activityId)).toBe(String(activityBId));
    expect(progress.activities[1].status).toBe("in-progress");
    expect(progress.activities[1].isCurrent).toBe(true);
    expect(progress.currentActivityIndex).toBe(1);
    expect(progress.prevActivity?.activityId).toBe(activityAId);
    expect(progress.nextActivity).toBeNull();
  });

  // QuestProgress test removed — Quests entity dropped. Unit badges
  // replace quest badges and will get fresh coverage in Phase D.

  test("non-owner scholar cannot see another scholar's progress", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarA = await seedUser(t, "scholar");
    const scholarB = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        name: "Other",
        username: "other",
        role: "scholar",
      }),
    );

    const sessionId = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "Unit",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Lesson",
        order: 0,
      });
      const activityId = await ctx.db.insert("activities", {
        lessonId,
        title: "Activity",
        kind: "online",
        systemPrompt: "x",
        order: 0,
      });
      return await ctx.db.insert("sessions", {
        userId: scholarA,
        unitId,
        lessonId,
        activityId,
        title: "A's project",
        isArchived: false,
      });
    });

    const asScholarB = await withUser(t, scholarB);
    const result = await asScholarB.query(api.sessions.getBigPicture, {
      sessionId,
    });
    expect(result).toBeNull();
  });
});
