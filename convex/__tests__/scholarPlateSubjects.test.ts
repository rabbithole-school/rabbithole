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
      subject: "Interdisciplinary Science",
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

describe("scholarPlate.activeForMe subject enrichment", () => {
  test("uses placement subjects and exposes matching due/end metadata", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { unitId, lessonId, activityId: homeworkActivityId } =
      await seedUnitWithActivity(t, teacherId);
    const now = Date.now();
    const dueAt = now + 8 * 60 * 60 * 1000;
    const endsAt = now + 60 * 60 * 1000;

    const { classActivityId } = await t.run(async (ctx) => {
      const classActivityId = await ctx.db.insert("activities", {
        lessonId,
        title: "Class Activity",
        kind: "online",
        systemPrompt: "...",
        order: 1,
      });
      const assignmentId = await ctx.db.insert("assignments", {
        teacherId,
        unitId,
        scholarIds: [scholarId],
        startedAt: now,
        activitySchedule: [
          {
            activityId: homeworkActivityId,
            mode: "homework",
            setAt: now - 1_000,
            dueAt,
          },
          {
            activityId: classActivityId,
            mode: "classFocus",
            setAt: now - 500,
            endsAt,
          },
        ],
      });
      const periodId = await ctx.db.insert("reportingPeriods", {
        label: "Current Term",
        startsAt: now - 86_400_000,
        endsAt: now + 86_400_000,
        status: "open",
      });
      const groupId = await ctx.db.insert("scholarGroups", {
        teacherId,
        name: "Geckos",
        scholarIds: [scholarId],
      });
      await ctx.db.insert("schedulePlacements", {
        periodId,
        groupId,
        subject: "Science",
        assignmentId,
        activityId: homeworkActivityId,
      });
      await ctx.db.insert("schedulePlacements", {
        periodId,
        groupId,
        subject: "Math Workshop",
        assignmentId,
        activityId: classActivityId,
      });
      return { classActivityId };
    });

    const asScholar = await withUser(t, scholarId);
    const result = await asScholar.query(api.scholarPlate.activeForMe, {});
    const homework = result.rows.find(
      (row) => row.activityId === homeworkActivityId,
    );
    const classFocus = result.rows.find(
      (row) => row.activityId === classActivityId,
    );

    expect(result.subjectTabs).toEqual(["Math Workshop", "Science"]);
    expect(homework).toMatchObject({
      subject: "Science",
      dueAt,
      endsAt: null,
    });
    expect(classFocus).toMatchObject({
      subject: "Math Workshop",
      dueAt: null,
      endsAt,
    });
  });

  test("falls back to assigned unit subjects when no timetable exists", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { unitId, activityId } = await seedUnitWithActivity(t, teacherId);
    const now = Date.now();

    await t.run(async (ctx) => {
      await ctx.db.insert("assignments", {
        teacherId,
        unitId,
        scholarIds: [scholarId],
        startedAt: now,
        activitySchedule: [
          {
            activityId,
            mode: "homework",
            setAt: now - 1_000,
          },
        ],
      });
    });

    const asScholar = await withUser(t, scholarId);
    const result = await asScholar.query(api.scholarPlate.activeForMe, {});

    expect(result.subjectTabs).toEqual(["Interdisciplinary Science"]);
    expect(result.rows.find((row) => row.activityId === activityId)?.subject).toBe(
      "Interdisciplinary Science",
    );
  });
});
