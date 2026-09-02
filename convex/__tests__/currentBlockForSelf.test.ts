import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { dayKeyForTimezone } from "../../shared/institutionDay";

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

describe("masterSchedule.currentBlockForSelf", () => {
  test("returns only today's structural blocks for the scholar's groups", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", {
      name: "Ms. Rivera",
    });
    const otherTeacherId = await seedUser(t, "teacher", {
      name: "Mr. Other",
      username: "other-teacher",
    });
    const scholarId = await seedUser(t, "scholar");
    const otherScholarId = await seedUser(t, "scholar", {
      username: "other-scholar",
    });
    await seedUnitWithActivity(t, teacherId);
    const now = Date.now();
    const timeZone = "Pacific/Honolulu";
    const serverDayKey = dayKeyForTimezone(now, timeZone);
    const sundayBased = new Date(`${serverDayKey}T12:00:00Z`).getUTCDay();
    const weekday = sundayBased === 0 ? 7 : sundayBased;
    const otherWeekday = weekday === 7 ? 1 : weekday + 1;

    await t.run(async (ctx) => {
      const periodId = await ctx.db.insert("reportingPeriods", {
        label: "Current Term",
        startsAt: now - 30 * 86_400_000,
        endsAt: now + 30 * 86_400_000,
        status: "open",
      });
      const myGroupId = await ctx.db.insert("scholarGroups", {
        teacherId,
        name: "Geckos",
        scholarIds: [scholarId],
      });
      const otherGroupId = await ctx.db.insert("scholarGroups", {
        teacherId: otherTeacherId,
        name: "Honu",
        scholarIds: [otherScholarId],
      });
      const sharedBlockId = await ctx.db.insert("scheduleBlocks", {
        periodId,
        key: "block-a",
        label: "Block A",
        startLocal: "08:30",
        endLocal: "09:40",
        weekdays: [weekday],
        order: 0,
        kind: "class",
      });
      const wrongDayBlockId = await ctx.db.insert("scheduleBlocks", {
        periodId,
        key: "block-b",
        label: "Tomorrow's block",
        startLocal: "09:40",
        endLocal: "10:30",
        weekdays: [otherWeekday],
        order: 1,
      });
      const otherGroupBlockId = await ctx.db.insert("scheduleBlocks", {
        periodId,
        groupId: otherGroupId,
        key: "other-group",
        label: "Other group only",
        startLocal: "10:30",
        endLocal: "11:30",
        weekdays: [weekday],
        order: 2,
      });
      await ctx.db.insert("schedulePlacements", {
        periodId,
        groupId: myGroupId,
        weekday,
        blockId: sharedBlockId,
        subject: "Math Workshop",
        teacherId,
      });
      await ctx.db.insert("schedulePlacements", {
        periodId,
        groupId: myGroupId,
        weekday: otherWeekday,
        blockId: wrongDayBlockId,
        subject: "Science",
        teacherId,
      });
      await ctx.db.insert("schedulePlacements", {
        periodId,
        groupId: otherGroupId,
        weekday,
        blockId: otherGroupBlockId,
        subject: "Humanities",
        teacherId: otherTeacherId,
      });
    });

    const asScholar = await withUser(t, scholarId);
    const result = await asScholar.query(
      api.masterSchedule.currentBlockForSelf,
      { dayKey: "1900-01-01" },
    );

    expect(result.timeZone).toBe(timeZone);
    expect(result.blocks).toEqual([
      {
        key: "block-a",
        label: "Block A",
        startLocal: "08:30",
        endLocal: "09:40",
        kind: "class",
        subject: "Math Workshop",
        teacherName: "Ms. Rivera",
      },
    ]);
    expect(Object.keys(result.blocks[0]).sort()).toEqual(
      [
        "key",
        "label",
        "startLocal",
        "endLocal",
        "kind",
        "subject",
        "teacherName",
      ].sort(),
    );
  });

  test("emits each shared block once when the scholar is in more than one group", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", { name: "Ms. Rivera" });
    const scholarId = await seedUser(t, "scholar");
    const now = Date.now();
    const timeZone = "Pacific/Honolulu";
    const serverDayKey = dayKeyForTimezone(now, timeZone);
    const sundayBased = new Date(`${serverDayKey}T12:00:00Z`).getUTCDay();
    const weekday = sundayBased === 0 ? 7 : sundayBased;

    await t.run(async (ctx) => {
      const periodId = await ctx.db.insert("reportingPeriods", {
        label: "Current Term",
        startsAt: now - 30 * 86_400_000,
        endsAt: now + 30 * 86_400_000,
        status: "open",
      });
      // One cohort group carries the emoji but NO placements.
      await ctx.db.insert("scholarGroups", {
        teacherId,
        name: "Honu",
        emoji: "🐢",
        scholarIds: [scholarId],
      });
      // A second group the scholar is also in — the source of the placements.
      const scheduleGroupId = await ctx.db.insert("scholarGroups", {
        teacherId,
        name: "K-2",
        scholarIds: [scholarId],
      });
      const sharedBlockId = await ctx.db.insert("scheduleBlocks", {
        periodId,
        key: "block-a",
        label: "Block A",
        startLocal: "08:30",
        endLocal: "09:40",
        weekdays: [weekday],
        order: 0,
        kind: "class",
      });
      await ctx.db.insert("schedulePlacements", {
        periodId,
        groupId: scheduleGroupId,
        weekday,
        blockId: sharedBlockId,
        subject: "Math Workshop",
        teacherId,
      });
    });

    const asScholar = await withUser(t, scholarId);
    const result = await asScholar.query(
      api.masterSchedule.currentBlockForSelf,
      { dayKey: "1900-01-01" },
    );

    // Regression: iterating the second group used to re-emit block-a with null
    // subject/teacher, and that phantom sorted ahead of the real placement.
    expect(result.blocks).toEqual([
      {
        key: "block-a",
        label: "Block A",
        startLocal: "08:30",
        endLocal: "09:40",
        kind: "class",
        subject: "Math Workshop",
        teacherName: "Ms. Rivera",
      },
    ]);
  });
});
