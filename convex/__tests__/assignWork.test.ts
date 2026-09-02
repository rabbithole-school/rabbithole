import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { grantInstitutionMembership, seedTestInstitution } from "./institutionTestHelpers";
import { api } from "../_generated/api";
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
      lessonId: lessonA, title: "A1", kind: "online", order: 0, defaultMode: "classFocus",
    });
    const a2 = await ctx.db.insert("activities", {
      lessonId: lessonA, title: "A2", kind: "online", order: 1, defaultMode: "homework",
    });
    const b1 = await ctx.db.insert("activities", {
      lessonId: lessonB, title: "B1", kind: "online", order: 0,
    });
    return { unitId, lessonA, lessonB, a1, a2, b1 };
  });
}

describe("assignWork", () => {
  test("create defaults authored homework to the next open school day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(MONDAY_NOON_HST);
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const asT = await withUser(t, teacher);
    const { unitId, a2 } = await seedUnit(t, teacher);

    const id = await asT.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholar],
    });

    const assignment = await t.run((ctx) => ctx.db.get(id));
    expect(
      assignment!.activitySchedule!.find((entry) => entry.activityId === a2)
        ?.dueAt,
    ).toBe(schoolDayEndAt("2026-08-25", TIME_ZONE));
  });

  test("single homework assign defaults from its scheduled day", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const asT = await withUser(t, teacher);
    const { unitId, a2 } = await seedUnit(t, teacher);
    const fridayNoonHst = Date.parse("2026-08-21T22:00:00.000Z");

    const id = await asT.mutation(api.assignments.assignWork, {
      unitId,
      scholarIds: [scholar],
      startsAt: fridayNoonHst,
      target: { kind: "activity", activityId: a2, mode: "homework" },
    });

    const assignment = await t.run((ctx) => ctx.db.get(id));
    expect(assignment!.activitySchedule![0].dueAt).toBe(
      schoolDayEndAt("2026-08-24", TIME_ZONE),
    );
  });

  test("pushActivity defaults live homework to the next open school day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(MONDAY_NOON_HST);
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const asT = await withUser(t, teacher);
    const { unitId, a1 } = await seedUnit(t, teacher);
    const assignmentId = await t.run((ctx) =>
      ctx.db.insert("assignments", {
        teacherId: teacher,
        unitId,
        scholarIds: [scholar],
        startedAt: MONDAY_NOON_HST,
        activitySchedule: [],
      }),
    );

    await asT.mutation(api.assignments.pushActivity, {
      assignmentId,
      activityId: a1,
      mode: "homework",
    });

    const assignment = await t.run((ctx) => ctx.db.get(assignmentId));
    expect(assignment!.activitySchedule![0].dueAt).toBe(
      schoolDayEndAt("2026-08-25", TIME_ZONE),
    );
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
      ctx.db.insert("assignments", {
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
    expect(a!.activitySchedule).toHaveLength(1);
    const e = a!.activitySchedule![0];
    expect(e.activityId).toBe(a1);
    expect(e.startsAt).toBe(startsAt);
    expect(e.mode).toBe("classFocus");
    expect(e.endsAt).toBe(startsAt + 45 * 60_000);
    expect(e.setAt).toBeUndefined(); // planned, not live
  });

  test("whole unit, NO authored deltas: everything lands on the start date", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const asT = await withUser(t, teacher);
    const { unitId, a1, a2, b1 } = await seedUnit(t, teacher);

    const startsAt = Date.now() + DAY;
    const id = await asT.mutation(api.assignments.assignWork, {
      unitId,
      scholarIds: [scholar],
      startsAt,
      target: { kind: "unit" },
    });

    const a = await t.run(async (ctx) => ctx.db.get(id));
    const sched = a!.activitySchedule!;
    expect(sched).toHaveLength(3);
    const byId = new Map(sched.map((e) => [String(e.activityId), e]));
    // No deltas → all on the start date (teacher paces live).
    expect(byId.get(String(a1))!.startsAt).toBe(startsAt);
    expect(byId.get(String(a2))!.startsAt).toBe(startsAt);
    expect(byId.get(String(b1))!.startsAt).toBe(startsAt);
    // Each still uses its own defaultMode (A2 = homework → has dueAt).
    expect(byId.get(String(a1))!.mode).toBe("classFocus");
    expect(byId.get(String(a2))!.mode).toBe("homework");
    expect(byId.get(String(b1))!.mode).toBe("classFocus");
    // Un-paced: no activation jobs — teacher paces live with Start now,
    // so a whole unit doesn't flip every activity live at once.
    for (const e of sched) expect(e.scheduledFnId).toBeUndefined();
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
        defaultMode: "homework",
        description: undefined,
      }),
    );

    const id = await asT.mutation(api.assignments.assignWork, {
      unitId,
      scholarIds: [scholar],
      startsAt: Date.now() + DAY,
      target: { kind: "unit" },
    });

    const assignment = await t.run((ctx) => ctx.db.get(id));
    expect(
      assignment!.activitySchedule!.map((entry) => String(entry.activityId)),
    ).toEqual([String(a1), String(b1)]);
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
    });
    const a = await t.run(async (ctx) => ctx.db.get(id));
    const ids = a!.activitySchedule!.map((e) => String(e.activityId)).sort();
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
      target: { kind: "activity", activityId: b1, mode: "homework" },
    });
    expect(id2).toBe(id1); // same cohort × unit → reused
    const a = await t.run(async (ctx) => ctx.db.get(id1));
    expect(a!.activitySchedule).toHaveLength(2);

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
