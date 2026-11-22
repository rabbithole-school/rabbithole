import { convexTest } from "convex-test";
import { insertAssignmentWithSchedule } from "./scheduleFixtures";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { readSchedule } from "../lib/scheduleStore";
import { MISSING_FINISH_QUESTION } from "../lib/giveQuestions";
import { grantInstitutionMembership, seedTestInstitution } from "./institutionTestHelpers";
import { api } from "../_generated/api";
import { RELOAD_TO_GIVE } from "../assignments";
import type { Id } from "../_generated/dataModel";
import { schoolDayEndAt } from "../lib/schoolDays";

/**
 * assignWork is the one-step "Assign" path: find-or-create the cohort ×
 * unit assignment AND schedule something at a chosen time, so an
 * assignment is never born dateless/inert. These cover the three
 * targets (activity / lesson / unit), the cadence layout, and
 * find-or-create dedup.
 */

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const DAY = 24 * 3_600_000;
const TIME_ZONE = "Pacific/Honolulu";
const MONDAY_NOON_HST = Date.parse("2026-08-24T22:00:00.000Z");

afterEach(() => {
  vi.useRealTimers();
});

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role = "scholar",
  username = `u${Math.random()}`,
) {
  const institutionId = await seedTestInstitution(t);
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: username, username, role }),
  );

  await t.run((ctx) => ctx.db.patch(userId, { institutionId }));
  if (role === "teacher" || role === "school_admin") await grantInstitutionMembership(t, userId, institutionId, role);
  return userId;
}

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    }),
  );
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

/** A unit with two lessons; lesson A has 2 activities (one homework-default),
 *  lesson B has 1. Returns ids in teaching order. */
async function seedUnit(t: ReturnType<typeof convexTest>, teacherId: Id<"users">) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", { teacherId, title: "U", isActive: true });
    const lessonA = await ctx.db.insert("lessons", { unitId, title: "A", order: 0 });
    const lessonB = await ctx.db.insert("lessons", { unitId, title: "B", order: 1 });
    const a1 = await ctx.db.insert("activities", {
      lessonId: lessonA, title: "A1", kind: "online", order: 0,
    });
    const a2 = await ctx.db.insert("activities", {
      lessonId: lessonA, title: "A2", kind: "online", order: 1,
    });
    const b1 = await ctx.db.insert("activities", {
      lessonId: lessonB, title: "B1", kind: "online", order: 0,
    });
    return { unitId, lessonA, lessonB, a1, a2, b1 };
  });
}

describe("assignWork", () => {
  test("create plans nothing, even for an activity authored as homework", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(MONDAY_NOON_HST);
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const asT = await withUser(t, teacher);
    const { unitId } = await seedUnit(t, teacher);

    const id = await asT.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholar],
    });

    const assignment = await t.run((ctx) => ctx.db.get(id));
    expect(await t.run((ctx) => readSchedule(ctx, assignment!))).toEqual([]);
  });

  test("legacy undated homework is refused, never given an invented date", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const asT = await withUser(t, teacher);
    const { unitId, a2 } = await seedUnit(t, teacher);
    const fridayNoonHst = Date.parse("2026-08-21T22:00:00.000Z");

    await expect(
      asT.mutation(api.assignments.assignWork, {
        unitId,
        scholarIds: [scholar],
        startsAt: fridayNoonHst,
        target: { kind: "activity", activityId: a2, mode: "homework" },
      }),
    ).rejects.toThrow(MISSING_FINISH_QUESTION);
  });

  test("pushActivity refuses legacy homework with no due date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(MONDAY_NOON_HST);
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const asT = await withUser(t, teacher);
    const { unitId, a1 } = await seedUnit(t, teacher);
    const assignmentId = await t.run((ctx) =>
      insertAssignmentWithSchedule(ctx, {
        teacherId: teacher,
        unitId,
        scholarIds: [scholar],
        startedAt: MONDAY_NOON_HST,
        activitySchedule: [],
      }),
    );

    await expect(
      asT.mutation(api.assignments.pushActivity, {
        assignmentId,
        activityId: a1,
        mode: "homework",
      }),
    ).rejects.toThrow(MISSING_FINISH_QUESTION);
    const assignment = await t.run((ctx) => ctx.db.get(assignmentId));
    expect(await t.run((ctx) => readSchedule(ctx, assignment!))).toEqual([]);
  });

  test("legacy mixed rosters use the teacher's institution calendar", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-08-28T22:00:00.000Z"));
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const guestInstitutionId = await seedTestInstitution(t, {
      slug: "guest-homework-calendar",
    });
    const guest = await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "Guest Scholar",
        username: "guest-homework-scholar",
        role: "scholar",
        institutionId: guestInstitutionId,
      }),
    );
    const asT = await withUser(t, teacher);
    const { unitId } = await seedUnit(t, teacher);
    const assignmentId = await t.run((ctx) =>
      insertAssignmentWithSchedule(ctx, {
        teacherId: teacher,
        unitId,
        scholarIds: [scholar, guest],
        startedAt: MONDAY_NOON_HST,
        activitySchedule: [],
      }),
    );

    const options = await asT.query(
      api.assignments.homeworkDueDateOptions,
      { assignmentId, nowMs: MONDAY_NOON_HST },
    );

    expect(options?.nextOpen.dueAt).toBe(
      schoolDayEndAt("2026-08-25", TIME_ZONE),
    );
  });

  test("single activity: creates the assignment + one planned entry", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const asT = await withUser(t, teacher);
    const { unitId, a1 } = await seedUnit(t, teacher);

    const startsAt = Date.now() + 2 * DAY;
    const id = await asT.mutation(api.assignments.assignWork, {
      unitId,
      scholarIds: [scholar],
      startsAt,
      target: {
        kind: "activity",
        activityId: a1,
        mode: "classFocus",
        endsAt: startsAt + 45 * 60_000, // UI passes startsAt + duration
      },
    });

    const a = await t.run(async (ctx) => ctx.db.get(id));
    expect(a!.scholarIds).toEqual([scholar]);
    const schedule = await t.run((ctx) => readSchedule(ctx, a!));
    expect(schedule).toHaveLength(1);
    const e = schedule[0];
    expect(e.activityId).toBe(a1);
    expect(e.startsAt).toBe(startsAt);
    expect(e.mode).toBe("classFocus");
    expect(e.endsAt).toBe(startsAt + 45 * 60_000);
    expect(e.setAt).toBeUndefined(); // planned, not live
  });

  test("whole unit with no finish: asks for a reload and creates nothing", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const asT = await withUser(t, teacher);
    const { unitId } = await seedUnit(t, teacher);

    // An older client (deploy skew) giving a unit without "when should they
    // finish it?" gets a reload message, never an empty success.
    await expect(
      asT.mutation(api.assignments.assignWork, {
        unitId,
        scholarIds: [scholar],
        startsAt: Date.now() + DAY,
        target: { kind: "unit" },
      }),
    ).rejects.toThrow(RELOAD_TO_GIVE);

    const rows = await t.run(async (ctx) => ctx.db.query("assignments").collect());
    expect(rows).toEqual([]);
  });

  test("whole unit with a finish: everything lands on the start date with that window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(MONDAY_NOON_HST);
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const asT = await withUser(t, teacher);
    const { unitId, a1, a2, b1 } = await seedUnit(t, teacher);

    const startsAt = MONDAY_NOON_HST + DAY;
    const id = await asT.mutation(api.assignments.assignWork, {
      unitId,
      scholarIds: [scholar],
      startsAt,
      target: { kind: "unit" },
      finish: { kind: "by", dayKey: "2026-08-28" },
    });

    const a = await t.run(async (ctx) => ctx.db.get(id));
    const sched = await t.run((ctx) => readSchedule(ctx, a!));
    expect(sched).toHaveLength(3);
    const byId = new Map(sched.map((e) => [String(e.activityId), e]));
    // No deltas → all on the start date (teacher paces live).
    for (const activityId of [a1, a2, b1]) {
      const entry = byId.get(String(activityId))!;
      expect(entry.startsAt).toBe(startsAt);
      // One answer for the whole give; an activity's authored defaultMode
      // is not read.
      expect(entry.mode).toBe("homework");
      expect(entry.dueAt).toBe(schoolDayEndAt("2026-08-28", TIME_ZONE));
    }
    // The teacher said when it shows up: every entry gets an activation job
    // for that time (TRA-571 review #8), and none is live yet.
    for (const e of sched) {
      expect(e.scheduledFnId).toBeDefined();
      expect(e.setAt).toBeUndefined();
    }
  });

  test("whole unit skips an empty draft handout without blocking other activities", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const asT = await withUser(t, teacher);
    const { unitId, a1, a2, b1 } = await seedUnit(t, teacher);
    await t.run((ctx) =>
      ctx.db.patch(a2, {
        kind: "offline",
        description: undefined,
      }),
    );

    const id = await asT.mutation(api.assignments.assignWork, {
      unitId,
      scholarIds: [scholar],
      startsAt: Date.now() + DAY,
      target: { kind: "unit" },
      finish: { kind: "by", dayKey: "2099-01-02" },
    });

    const assignment = await t.run((ctx) => ctx.db.get(id));
    const schedule = await t.run((ctx) => readSchedule(ctx, assignment!));
    expect(schedule.map((entry) => String(entry.activityId))).toEqual([
      String(a1),
      String(b1),
    ]);
  });

  test("whole lesson: only that lesson's activities", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const asT = await withUser(t, teacher);
    const { unitId, lessonA, a1, a2 } = await seedUnit(t, teacher);

    const id = await asT.mutation(api.assignments.assignWork, {
      unitId,
      scholarIds: [scholar],
      startsAt: Date.now() + DAY,
      target: { kind: "lesson", lessonId: lessonA },
      finish: { kind: "inClass" },
    });
    const a = await t.run(async (ctx) => ctx.db.get(id));
    const schedule = await t.run((ctx) => readSchedule(ctx, a!));
    const ids = schedule.map((e) => String(e.activityId)).sort();
    expect(ids).toEqual([String(a1), String(a2)].sort());
  });

  test("find-or-create: same unit + same roster reuses one assignment", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const s1 = await seedUser(t, "scholar");
    const asT = await withUser(t, teacher);
    const { unitId, a1, b1 } = await seedUnit(t, teacher);

    const id1 = await asT.mutation(api.assignments.assignWork, {
      unitId, scholarIds: [s1], startsAt: Date.now() + DAY,
      target: { kind: "activity", activityId: a1, mode: "classFocus" },
    });
    const id2 = await asT.mutation(api.assignments.assignWork, {
      unitId, scholarIds: [s1], startsAt: Date.now() + 2 * DAY,
      target: { kind: "activity", activityId: b1, mode: "homework", dueAt: Date.now() + 3 * DAY },
    });
    expect(id2).toBe(id1); // same cohort × unit → reused
    const a = await t.run(async (ctx) => ctx.db.get(id1));
    expect(await t.run((ctx) => readSchedule(ctx, a!))).toHaveLength(2);

    // A different roster → a separate assignment.
    const s2 = await seedUser(t, "scholar");
    const id3 = await asT.mutation(api.assignments.assignWork, {
      unitId, scholarIds: [s1, s2], startsAt: Date.now() + DAY,
      target: { kind: "activity", activityId: a1, mode: "classFocus" },
    });
    expect(id3).not.toBe(id1);
  });

  test("a non-teacher cannot assign", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const { unitId, a1 } = await seedUnit(t, teacher);
    const asScholar = await withUser(t, scholar);
    await expect(
      asScholar.mutation(api.assignments.assignWork, {
        unitId, scholarIds: [scholar], startsAt: Date.now() + DAY,
        target: { kind: "activity", activityId: a1, mode: "classFocus" },
      }),
    ).rejects.toThrow();
  });
});
