import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { grantInstitutionMembership, seedTestInstitution } from "./institutionTestHelpers";
import { api } from "../_generated/api";
import { DEFAULT_TIMEZONE, dueStatus } from "../../shared/institutionDay";
import type { Doc, Id } from "../_generated/dataModel";

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

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" = "scholar",
  overrides: Partial<Doc<"users">> = {},
) {
  const institutionId = overrides.institutionId ?? (await seedTestInstitution(t));
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: overrides.name ?? `Test ${role}`,
      username: overrides.username ?? `test${role}`,
      role,
      institutionId: overrides.institutionId,
    }),
  );

  await t.run((ctx) => ctx.db.patch(userId, { institutionId }));
  if (role === "teacher") {
    await grantInstitutionMembership(t, userId, institutionId, role);
  }
  return userId;
}

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
      defaultMode: "classFocus",
    });
    return { unitId, activityId };
  });
}

describe("class-focus reads carry an institution timeZone", () => {
  test("currentClassFocusForMe defaults to Pacific/Honolulu with no institution set", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { unitId, activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const asScholar = await withUser(t, scholarId);

    const assignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarId],
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
    const institutionId = await t.run(async (ctx) =>
      ctx.db.insert("institutions", {
        name: "Test School",
        slug: "test-school",
        kind: "school",
        timeZone: "America/New_York",
      }),
    );
    const teacherId = await seedUser(t, "teacher", { institutionId });
    const scholarId = await seedUser(t, "scholar", { institutionId });
    const { unitId, activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const asScholar = await withUser(t, scholarId);

    const assignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarId],
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
    const institutionId = await t.run(async (ctx) =>
      ctx.db.insert("institutions", {
        name: "Test School",
        slug: "test-school",
        kind: "school",
        timeZone: "America/Chicago",
      }),
    );
    const teacherId = await seedUser(t, "teacher", { institutionId });
    const scholarId = await seedUser(t, "scholar", { institutionId });
    const { unitId, activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);

    const assignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarId],
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
    await t.run(async (ctx) => {
      await ctx.db.insert("institutions", {
        name: "Primary School",
        slug: "primary-school",
        kind: "school",
        isPrimary: true,
        timeZone: "Pacific/Honolulu",
      });
    });
    const institutionId = await t.run(async (ctx) =>
      ctx.db.insert("institutions", {
        name: "Second School",
        slug: "second-school",
        kind: "school",
        timeZone: "America/New_York",
      }),
    );
    const teacherId = await seedUser(t, "teacher", { institutionId });
    const scholarId = await seedUser(t, "scholar", { institutionId });
    const { unitId, activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const asScholar = await withUser(t, scholarId);
    const assignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarId],
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
    const secondId = await t.run(async (ctx) => {
      await ctx.db.insert("institutions", {
        name: "Primary School",
        slug: "primary-school",
        kind: "school",
        isPrimary: true,
        timeZone: "America/Chicago",
      });
      return await ctx.db.insert("institutions", {
        name: "Second School",
        slug: "second-school",
        kind: "school",
      });
    });
    const teacherId = await seedUser(t, "teacher", { institutionId: secondId });
    const scholarId = await seedUser(t, "scholar", { institutionId: secondId });
    const { unitId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const assignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarId],
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
    const { teacherId, assignmentId } = await t.run(async (ctx) => {
      const institutionId = await ctx.db.insert("institutions", {
        name: "Test School",
        slug: "test-school",
        kind: "school",
        timeZone: "America/New_York",
      });
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
      const institutionScholarId = await ctx.db.insert("users", {
        name: "Institution Scholar",
        username: "institution-scholar",
        role: "scholar",
        institutionId,
      });
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "Mixed Unit",
        isActive: true,
      });
      const assignmentId = await ctx.db.insert("assignments", {
        teacherId,
        unitId,
        scholarIds: [legacyScholarId, institutionScholarId],
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
