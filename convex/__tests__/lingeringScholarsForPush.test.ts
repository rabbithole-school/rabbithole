import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

// "The turn, not the bell" (item 4): the teacher's quiet "still finishing
// their thought" awareness after a class-focus push turns — names only, no
// durations, derived from EXISTING session data (lastMessageAt, completion),
// never a new presence-tracking mechanism.

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
  const institutionId = await seedTestInstitution(t);
  const options = {
    institutionId,
    name: overrides.name ?? `Test ${role}`,
    username: overrides.username ?? `test${role}`,
  };
  return role === "teacher"
    ? seedStaffWithMembership(t, options)
    : seedScholarInInstitution(t, options);
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

async function seedSession(
  t: ReturnType<typeof convexTest>,
  overrides: Partial<Doc<"sessions">> & { userId: Id<"users"> },
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("sessions", {
      title: "Test Session",
      isArchived: false,
      ...overrides,
    }),
  );
}

describe("assignments.lingeringScholarsForPush", () => {
  test("returns a scholar with a recent, unfinished session on the activity", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar", { name: "Kai" });
    const { unitId, activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);

    const assignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarId],
    });
    await seedSession(t, {
      userId: scholarId,
      assignmentId,
      activityId,
      unitId,
      lastMessageAt: Date.now() - 60_000, // 1 minute ago
    });

    const lingering = await asTeacher.query(api.assignments.lingeringScholarsForPush, {
      assignmentId,
      activityId,
    });
    expect(lingering).toHaveLength(1);
    expect(lingering[0].name).toBe("Kai");
  });

  test("excludes a session the scholar already completed", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar", { name: "Maya" });
    const { unitId, activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);

    const assignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarId],
    });
    await seedSession(t, {
      userId: scholarId,
      assignmentId,
      activityId,
      unitId,
      lastMessageAt: Date.now() - 60_000,
      activityCompletedAt: Date.now() - 30_000,
    });

    const lingering = await asTeacher.query(api.assignments.lingeringScholarsForPush, {
      assignmentId,
      activityId,
    });
    expect(lingering).toHaveLength(0);
  });

  test("excludes a session that's gone stale (untouched too long)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar", { name: "Priya" });
    const { unitId, activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);

    const assignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarId],
    });
    await seedSession(t, {
      userId: scholarId,
      assignmentId,
      activityId,
      unitId,
      lastMessageAt: Date.now() - 60 * 60_000, // an hour ago
    });

    const lingering = await asTeacher.query(api.assignments.lingeringScholarsForPush, {
      assignmentId,
      activityId,
    });
    expect(lingering).toHaveLength(0);
  });

  test("excludes archived, test-drive, and offline sessions", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholar1 = await seedUser(t, "scholar", { name: "Archived", username: "archived1" });
    const scholar2 = await seedUser(t, "scholar", { name: "TestDrive", username: "testdrive1" });
    const scholar3 = await seedUser(t, "scholar", { name: "Offline", username: "offline1" });
    const { unitId, activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);

    const assignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholar1, scholar2, scholar3],
    });
    const recentTouch = Date.now() - 60_000;
    await seedSession(t, {
      userId: scholar1,
      assignmentId,
      activityId,
      unitId,
      lastMessageAt: recentTouch,
      isArchived: true,
    });
    await seedSession(t, {
      userId: scholar2,
      assignmentId,
      activityId,
      unitId,
      lastMessageAt: recentTouch,
      isTestDrive: true,
    });
    await seedSession(t, {
      userId: scholar3,
      assignmentId,
      activityId,
      unitId,
      lastMessageAt: recentTouch,
      isOffline: true,
    });

    const lingering = await asTeacher.query(api.assignments.lingeringScholarsForPush, {
      assignmentId,
      activityId,
    });
    expect(lingering).toHaveLength(0);
  });

  test("excludes a session under a DIFFERENT assignment on the same activity", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar", { name: "Sam" });
    const { unitId, activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);

    const assignmentA = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarId],
    });
    const assignmentB = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarId],
    });
    await seedSession(t, {
      userId: scholarId,
      assignmentId: assignmentB,
      activityId,
      unitId,
      lastMessageAt: Date.now() - 60_000,
    });

    const lingering = await asTeacher.query(api.assignments.lingeringScholarsForPush, {
      assignmentId: assignmentA,
      activityId,
    });
    expect(lingering).toHaveLength(0);
  });

  test("blocks a teacher who doesn't own the assignment", async () => {
    const t = convexTest(schema, modules);
    const teacherA = await seedUser(t, "teacher", { username: "teacherA" });
    const teacherB = await seedUser(t, "teacher", { username: "teacherB" });
    const scholarId = await seedUser(t, "scholar");
    const { unitId, activityId } = await seedUnitWithActivity(t, teacherA);
    const asA = await withUser(t, teacherA);
    const asB = await withUser(t, teacherB);

    const assignmentId = await asA.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarId],
    });
    await seedSession(t, {
      userId: scholarId,
      assignmentId,
      activityId,
      unitId,
      lastMessageAt: Date.now() - 60_000,
    });

    // requireOwnedAssignment throws for a mismatched teacher (only a MISSING
    // assignment resolves to the empty-array fallback below).
    await expect(
      asB.query(api.assignments.lingeringScholarsForPush, {
        assignmentId,
        activityId,
      }),
    ).rejects.toThrow();
  });

  test("returns [] for a nonexistent assignment rather than throwing", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { unitId, activityId } = await seedUnitWithActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    // Create then archive... actually simplest: create an assignment id from
    // a DIFFERENT (deleted) doc isn't possible without insert/delete, so use
    // a real assignment owned by someone else instead — already covered
    // above. Here we just assert a fresh, valid-but-foreign id shape works
    // via the ownership guard (requireOwnedAssignment returns null → []).
    const assignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarId],
    });
    await t.run(async (ctx) => ctx.db.delete(assignmentId));

    const lingering = await asTeacher.query(api.assignments.lingeringScholarsForPush, {
      assignmentId,
      activityId,
    });
    expect(lingering).toEqual([]);
  });
});
