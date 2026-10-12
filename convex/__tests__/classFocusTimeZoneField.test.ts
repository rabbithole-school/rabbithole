import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import { DEFAULT_TIMEZONE, dueStatus } from "../../shared/institutionDay";
import type { Id } from "../_generated/dataModel";
import {
  makeActivity,
  makeLesson,
  makeUnit,
  makeWorld,
} from "./factories/world";

// "The turn, not the bell" (item 1): every class-focus entry a scholar or
// teacher can see must carry the INSTITUTION's timezone, so the frontend can
// render a soft local wall-clock instant ("with the class until ~10:25")
// instead of a bare, timeless "paused until then". This covers both the
// default (no institution set) and a scholar with a real, non-default
// institution timezone.

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
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

async function seedUnitWithActivity(
  t: ReturnType<typeof convexTest>,
  school: Awaited<ReturnType<typeof makeWorld>>["schools"][number],
) {
  const unitId = await makeUnit(t, school.teacher, school, {
    title: "Test Unit",
    isActive: true,
  });
  const lessonId = await makeLesson(t, unitId, {
    title: "Test Lesson",
    order: 0,
  });
  const activityId = await makeActivity(t, lessonId, {
    title: "Test Activity",
    kind: "online",
    systemPrompt: "...",
    order: 0,
    defaultMode: "classFocus",
  });
  return { unitId, activityId };
}

describe("class-focus reads carry an institution timeZone", () => {
  test("currentClassFocusForMe defaults to Pacific/Honolulu with no institution set", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 1,
      scholarsPerSchool: 1,
      parentsPerSchool: 0,
      includePlatformAdmin: false,
    });
    const school = world.schools[0];
    const { unitId, activityId } = await seedUnitWithActivity(t, school);
    const asTeacher = await world.as.staffOf(school);
    const asScholar = await world.as.scholar(school.scholars[0]);

    const assignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [school.scholars[0].id],
    });
    await asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId,
      activityId,
      mode: "classFocus",
      endsAt: Date.now() + 60_000,
    });

    const focus = await asScholar.query(api.assignments.currentClassFocusForMe, {});
    expect(focus).toHaveLength(1);
    expect(focus[0].timeZone).toBe(DEFAULT_TIMEZONE);
    expect(focus[0].endsAt).not.toBeNull();
  });

  test("currentClassFocusForMe reflects the scholar's OWN institution timezone", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 1,
      scholarsPerSchool: 1,
      parentsPerSchool: 0,
      includePlatformAdmin: false,
    });
    const school = world.schools[0];
    await t.run((ctx) =>
      ctx.db.patch(school.id, { timeZone: "America/New_York" }),
    );
    const { unitId, activityId } = await seedUnitWithActivity(t, school);
    const asTeacher = await world.as.staffOf(school);
    const asScholar = await world.as.scholar(school.scholars[0]);

    const assignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [school.scholars[0].id],
    });
    await asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId,
      activityId,
      mode: "classFocus",
      endsAt: Date.now() + 60_000,
    });

    const focus = await asScholar.query(api.assignments.currentClassFocusForMe, {});
    expect(focus).toHaveLength(1);
    expect(focus[0].timeZone).toBe("America/New_York");
  });

  test("activePushesForTeacher carries the teacher's own institution timezone", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 1,
      scholarsPerSchool: 1,
      parentsPerSchool: 0,
      includePlatformAdmin: false,
    });
    const school = world.schools[0];
    await t.run((ctx) =>
      ctx.db.patch(school.id, { timeZone: "America/Chicago" }),
    );
    const { unitId, activityId } = await seedUnitWithActivity(t, school);
    const asTeacher = await world.as.staffOf(school);

    const assignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [school.scholars[0].id],
    });
    await asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId,
      activityId,
      mode: "classFocus",
      endsAt: Date.now() + 60_000,
    });

    const pushes = await asTeacher.query(api.assignments.activePushesForTeacher, {});
    expect(pushes).toHaveLength(1);
    expect(pushes[0].timeZone).toBe("America/Chicago");
  });

  test("second-school homework carries its calendar through both plate and assignment reads at midnight", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 2,
      scholarsPerSchool: 1,
      parentsPerSchool: 0,
      includePlatformAdmin: false,
    });
    const [primary, second] = world.schools;
    await t.run(async (ctx) => {
      await ctx.db.patch(primary.id, {
        name: "Primary School",
        slug: "primary-school",
        timeZone: "Pacific/Honolulu",
      });
      await ctx.db.patch(second.id, {
        name: "Second School",
        slug: "second-school",
        timeZone: "America/New_York",
      });
    });
    const { unitId, activityId } = await seedUnitWithActivity(t, second);
    const asTeacher = await world.as.staffOf(second);
    const asScholar = await world.as.scholar(second.scholars[0]);
    const assignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [second.scholars[0].id],
    });
    const dueAt = Date.parse("2026-06-15T16:00:00.000Z");
    await asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId,
      activityId,
      mode: "homework",
      dueAt,
    });

    const assignment = await asTeacher.query(api.assignments.get, { assignmentId });
    const plate = await asScholar.query(api.scholarPlate.activeForMe, {});
    const row = plate.rows.find((candidate) => candidate.activityId === activityId);

    expect(assignment?.timeZone).toBe("America/New_York");
    expect(row?.timeZone).toBe("America/New_York");
    expect(row?.dueAt).toBe(dueAt);

    // New York reaches June 16 at 04:00Z; Honolulu is still June 15 then.
    // The plate's own timezone must control this date rollover.
    expect(dueStatus(row?.dueAt, Date.parse("2026-06-16T03:59:59.000Z"), row!.timeZone))
      .toMatchObject({ status: "dueToday", phrase: "due today" });
    expect(dueStatus(row?.dueAt, Date.parse("2026-06-16T04:00:01.000Z"), row!.timeZone))
      .toMatchObject({ status: "overdue", phrase: "was due yesterday" });
  });

  test("a second school missing a timezone uses only the static legacy default", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 2,
      scholarsPerSchool: 1,
      parentsPerSchool: 0,
      includePlatformAdmin: false,
    });
    const [primary, second] = world.schools;
    await t.run(async (ctx) => {
      await ctx.db.patch(primary.id, {
        name: "Primary School",
        slug: "primary-school",
        timeZone: "America/Chicago",
      });
      await ctx.db.patch(second.id, {
        name: "Second School",
        slug: "second-school",
      });
    });
    const { unitId } = await seedUnitWithActivity(t, second);
    const asTeacher = await world.as.staffOf(second);
    const assignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [second.scholars[0].id],
    });
    const assignment = await asTeacher.query(api.assignments.get, {
      assignmentId,
    });

    expect(assignment?.timeZone).toBe(DEFAULT_TIMEZONE);
    expect(assignment?.timeZone).not.toBe("America/Chicago");
  });

  test("an all-legacy roster uses the legacy default timezone", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, assignmentId } = await t.run(
      async (ctx) => {
        const teacherId = await ctx.db.insert("users", {
          name: "Legacy Teacher",
          username: "legacy-teacher",
          role: "teacher",
        });
        const scholarId = await ctx.db.insert("users", {
          name: "Legacy Scholar",
          username: "legacy-scholar",
          role: "scholar",
        });
        const unitId = await ctx.db.insert("units", {
          teacherId,
          title: "Legacy Unit",
          isActive: true,
        });
        const assignmentId = await ctx.db.insert("assignments", {
          teacherId,
          unitId,
          scholarIds: [scholarId],
          startedAt: Date.now(),
          activitySchedule: [],
        });
        return { teacherId, assignmentId };
      },
    );

    const assignment = await (await withUser(t, teacherId)).query(
      api.assignments.get,
      { assignmentId },
    );
    expect(assignment?.timeZone).toBe(DEFAULT_TIMEZONE);
  });

  test("a roster mixing legacy and institution scholars has no timezone", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 1,
      scholarsPerSchool: 1,
      parentsPerSchool: 0,
      includePlatformAdmin: false,
    });
    const school = world.schools[0];
    await t.run((ctx) =>
      ctx.db.patch(school.id, {
        name: "Test School",
        slug: "test-school",
        timeZone: "America/New_York",
      }),
    );
    const { teacherId, assignmentId } = await t.run(async (ctx) => {
      const teacherId = await ctx.db.insert("users", {
        name: "Teacher",
        username: "teacher",
        role: "teacher",
      });
      const legacyScholarId = await ctx.db.insert("users", {
        name: "Legacy Scholar",
        username: "legacy-scholar",
        role: "scholar",
      });
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "Mixed Unit",
        isActive: true,
      });
      const assignmentId = await ctx.db.insert("assignments", {
        teacherId,
        unitId,
        scholarIds: [legacyScholarId, school.scholars[0].id],
        startedAt: Date.now(),
        activitySchedule: [],
      });
      return { teacherId, assignmentId };
    });

    const assignment = await (await withUser(t, teacherId)).query(
      api.assignments.get,
      { assignmentId },
    );
    expect(assignment?.timeZone).toBeNull();
  });
});
