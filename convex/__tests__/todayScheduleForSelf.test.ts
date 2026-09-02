import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  dayKeyForTimezone,
  dayStartForTimezone,
  shiftDayKey,
  weekdayForDayKey,
} from "../../shared/institutionDay";

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
      institutionId: overrides.institutionId,
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
      subject: "Mathematics",
      emoji: "➗",
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

function nextWeekdayDayKey(dayKey: string): string {
  let candidate = dayKey;
  do {
    candidate = shiftDayKey(candidate, 1);
  } while (weekdayForDayKey(candidate) === 0 || weekdayForDayKey(candidate) === 6);
  return candidate;
}

describe("assignments.todayScheduleForSelf", () => {
  test("requires authentication", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.query(api.assignments.todayScheduleForSelf, {
        dayKey: "2026-07-20",
      }),
    ).rejects.toThrow();
  });

  test("returns only caller-targeted, active-assignment planned work for the server day", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const institutionId = await t.run((ctx) =>
      ctx.db.insert("institutions", {
        name: "Moli School",
        slug: "moli",
        kind: "school",
        timeZone: "Pacific/Honolulu",
      }),
    );
    const scholarId = await seedUser(t, "scholar", { institutionId });
    const otherScholarId = await seedUser(t, "scholar", {
      username: "other-scholar",
      institutionId,
    });
    const { unitId, lessonId, activityId } = await seedUnitWithActivity(
      t,
      teacherId,
    );
    const now = Date.now();
    const timeZone = "Pacific/Honolulu";
    const todayStart = dayStartForTimezone(now, timeZone);
    const todayAtNoon = todayStart + 12 * 60 * 60 * 1000;
    const tomorrowAtNoon = todayAtNoon + 24 * 60 * 60 * 1000;
    const dueAt = todayStart + 20 * 60 * 60 * 1000;

    await t.run(async (ctx) => {
      const tomorrowActivity = await ctx.db.insert("activities", {
        lessonId,
        title: "Tomorrow",
        kind: "online",
        systemPrompt: "...",
        order: 1,
      });
      const liveActivity = await ctx.db.insert("activities", {
        lessonId,
        title: "Already live",
        kind: "online",
        systemPrompt: "...",
        order: 2,
      });
      const otherActivity = await ctx.db.insert("activities", {
        lessonId,
        title: "Someone else's",
        kind: "online",
        systemPrompt: "...",
        order: 3,
      });
      const archivedActivity = await ctx.db.insert("activities", {
        lessonId,
        title: "Archived",
        kind: "online",
        systemPrompt: "...",
        order: 4,
      });
      await ctx.db.insert("assignments", {
        teacherId,
        unitId,
        scholarIds: [scholarId, otherScholarId],
        startedAt: now,
        activitySchedule: [
          {
            activityId,
            mode: "homework",
            startsAt: todayAtNoon,
            dueAt,
          },
          {
            activityId: tomorrowActivity,
            mode: "classFocus",
            startsAt: tomorrowAtNoon,
          },
          {
            activityId: liveActivity,
            mode: "classFocus",
            startsAt: todayAtNoon + 1,
            setAt: now,
          },
          {
            activityId: otherActivity,
            mode: "homework",
            startsAt: todayAtNoon + 2,
            scholarIds: [otherScholarId],
          },
        ],
      });
      await ctx.db.insert("assignments", {
        teacherId,
        unitId,
        scholarIds: [scholarId],
        startedAt: now,
        archivedAt: now,
        activitySchedule: [
          {
            activityId: archivedActivity,
            mode: "homework",
            startsAt: todayAtNoon + 3,
          },
        ],
      });
    });

    const asScholar = await withUser(t, scholarId);
    const result = await asScholar.query(
      api.assignments.todayScheduleForSelf,
      {
        // Deliberately stale: the server must ignore it for data scoping.
        dayKey: "1999-01-01",
      },
    );

    expect(result.timeZone).toBe(timeZone);
    expect(result.dayKey).toBe(dayKeyForTimezone(now, timeZone));
    expect(result.nextOpenSchoolDayKey).toBe(
      nextWeekdayDayKey(result.dayKey),
    );
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      activityId,
      activityTitle: "Test Activity",
      activityKind: "online",
      unitId,
      unitTitle: "Test Unit",
      unitEmoji: "➗",
      subject: "Mathematics",
      mode: "homework",
      startsAt: todayAtNoon,
      dueAt,
      completedByMe: false,
    });
    expect(Object.keys(result.entries[0]).sort()).toEqual(
      [
        "activityId",
        "activityKind",
        "activityTitle",
        "assignmentId",
        "completedByMe",
        "dueAt",
        "mode",
        "startsAt",
        "subject",
        "unitEmoji",
        "unitId",
        "unitTitle",
      ].sort(),
    );
  });

  test("returns the same day context for non-scholars", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const asTeacher = await withUser(t, teacherId);

    const result = await asTeacher.query(api.assignments.todayScheduleForSelf, {
      dayKey: "1999-01-01",
    });

    expect(result.entries).toEqual([]);
    expect(result.nextOpenSchoolDayKey).toBeNull();
  });

  test("returns no next open day instead of failing during a long closure", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("institutions", {
        name: "Moli School",
        slug: "moli",
        kind: "school",
        timeZone: "Pacific/Honolulu",
      });
      const today = dayKeyForTimezone(Date.now(), "Pacific/Honolulu");
      await ctx.db.insert("schoolClosures", {
        institutionId: id,
        startDayKey: today,
        endDayKey: shiftDayKey(today, 21),
        label: "Long break",
        kind: "holiday",
      });
      return id;
    });
    const scholarId = await seedUser(t, "scholar", { institutionId });
    const asScholar = await withUser(t, scholarId);

    const result = await asScholar.query(api.assignments.todayScheduleForSelf, {
      dayKey: "1999-01-01",
    });

    expect(result.nextOpenSchoolDayKey).toBeNull();
    expect(result.entries).toEqual([]);
  });
});
