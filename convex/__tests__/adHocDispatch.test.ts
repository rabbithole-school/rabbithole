import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { grantInstitutionMembership, seedTestInstitution } from "./institutionTestHelpers";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// ── Fixtures copied verbatim from testDrive.test.ts ──────────────────────
async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" | "platform_admin" = "scholar",
) {
  const institutionId = await seedTestInstitution(t);
  const userId = await t.run(async (ctx) => {
    return await ctx.db.insert("users", {
      name: role === "scholar" ? "Test Scholar" : `Test ${role}`,
      username: role === "scholar" ? "testscholar" : `test${role}`,
      role,
    });
  });

  await t.run((ctx) => ctx.db.patch(userId, { institutionId }));
  if (role === "teacher") {
    await grantInstitutionMembership(t, userId, institutionId, role);
  }
  return userId;
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

// ── Local helpers ────────────────────────────────────────────────────────
/** Seed an extra scholar with a distinct username (the shared seedUser
 *  fixture hard-codes "testscholar", which collides for a second scholar). */
async function seedNamedScholar(
  t: ReturnType<typeof convexTest>,
  username: string,
) {
  const institutionId = await seedTestInstitution(t);
  const userId = await t.run(async (ctx) => {
    return await ctx.db.insert("users", {
      name: username,
      username,
      role: "scholar",
    });
  });

  await t.run((ctx) => ctx.db.patch(userId, { institutionId }));
  return userId;
}

/** A lesson-less activity NOT referenced by any assignment schedule —
 *  the shape an attacker would try to smuggle past scope validation. */
async function seedOrphanActivity(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("activities", {
      title: "Orphan Activity",
      kind: "online",
      systemPrompt: "Not scheduled anywhere.",
      order: 0,
    });
  });
}

describe("Ad-hoc dispatch — scholar starts", () => {
  test("practice dispatch schedules durable items for its target", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const asTeacher = await withUser(t, teacherId);

    const { activityId } = await asTeacher.mutation(api.assignments.dispatchActivity, {
      scholarId,
      title: "Multiplication practice",
      activityKind: "problem_set",
      targetSkillKeys: ["mult_facts_7_8_9"],
    });

    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].name).toContain("practiceGen:ensureProblemSetItems");
    expect(scheduled[0].args[0]).toEqual({ activityId });
  });

  test("teacher dispatches (default live) → scholar sessions.create returns an id", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const asTeacher = await withUser(t, teacherId);

    const { assignmentId, activityId } = await asTeacher.mutation(
      api.assignments.dispatchActivity,
      { scholarId, title: "Explore tessellations" },
    );

    // The dispatched assignment is unit-less with a populated schedule.
    const assignment = await t.run(async (ctx) => ctx.db.get(assignmentId));
    expect(assignment!.kind).toBe("adHocDispatch");
    expect(assignment!.unitId).toBeUndefined();
    expect((assignment!.activitySchedule ?? []).length).toBe(1);

    const asScholar = await withUser(t, scholarId);
    const result = await asScholar.mutation(api.sessions.create, {
      activityId,
      assignmentId,
    });
    expect(result.id).toBeTruthy();

    const session = await t.run(async (ctx) => ctx.db.get(result.id));
    expect(session).toBeTruthy();
    expect(session!.userId).toBe(scholarId);
    expect(session!.activityId).toBe(activityId);
    expect(session!.assignmentId).toBe(assignmentId);
    // No unit to anchor to — the dispatch session stays unit-less.
    expect(session!.unitId).toBeUndefined();
  });

  test("lesson-less activity NOT referenced by the assignment's schedule → rejected", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const asTeacher = await withUser(t, teacherId);

    const { assignmentId } = await asTeacher.mutation(
      api.assignments.dispatchActivity,
      { scholarId, title: "Explore tessellations" },
    );
    // A lesson-less activity that the assignment's schedule does NOT reference.
    const orphanActivityId = await seedOrphanActivity(t);

    const asScholar = await withUser(t, scholarId);
    await expect(
      asScholar.mutation(api.sessions.create, {
        activityId: orphanActivityId,
        assignmentId,
      }),
    ).rejects.toThrow("Assignment does not match activity");
  });

  test("scholar not on the roster → still rejected", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const outsiderId = await seedNamedScholar(t, "outsider");
    const asTeacher = await withUser(t, teacherId);

    const { assignmentId, activityId } = await asTeacher.mutation(
      api.assignments.dispatchActivity,
      { scholarId, title: "Explore tessellations" },
    );

    const asOutsider = await withUser(t, outsiderId);
    await expect(
      asOutsider.mutation(api.sessions.create, { activityId, assignmentId }),
    ).rejects.toThrow("Assignment does not include scholar");
  });
});

describe("Ad-hoc dispatch — teacher/aide reads don't crash", () => {
  test("coreAideListAssignments + coreAideSchedule include the dispatch without throwing", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const asTeacher = await withUser(t, teacherId);

    const { assignmentId } = await asTeacher.mutation(
      api.assignments.dispatchActivity,
      { scholarId, title: "Explore tessellations" },
    );

    const listed = await t.run(async (ctx) =>
      ctx.runQuery(internal.assignments.aideListAssignments, {
        callerUserId: teacherId,
      }),
    );
    expect(listed).toHaveLength(1);
    expect(String(listed[0].assignmentId)).toBe(String(assignmentId));
    expect(listed[0].unitId).toBeNull();
    expect(listed[0].unitTitle).toBe("Explore tessellations");

    const sched = await t.run(async (ctx) =>
      ctx.runQuery(internal.assignments.aideScheduleForTeacher, {
        callerUserId: teacherId,
      }),
    );
    expect(sched).toHaveLength(1);
    expect(String(sched[0].assignmentId)).toBe(String(assignmentId));
    expect(sched[0].unitTitle).toBe("Explore tessellations");
    expect(sched[0].state).toBe("live");
  });

  test("listForTeacher + scheduleForTeacher don't throw with a dispatch row present", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const asTeacher = await withUser(t, teacherId);

    const { assignmentId } = await asTeacher.mutation(
      api.assignments.dispatchActivity,
      { scholarId, title: "Explore tessellations" },
    );

    const list = await asTeacher.query(api.assignments.listForTeacher, {});
    expect(list).toHaveLength(1);
    expect(String(list[0]._id)).toBe(String(assignmentId));
    expect(list[0].unitId).toBeNull();
    expect(list[0].unitTitle).toBe("Explore tessellations");

    const agenda = await asTeacher.query(
      api.assignments.scheduleForTeacher,
      {},
    );
    expect(agenda).toHaveLength(1);
    expect(String(agenda[0].assignmentId)).toBe(String(assignmentId));
    expect(agenda[0].unitId).toBeNull();
    expect(agenda[0].unitTitle).toBe("Explore tessellations");
  });

  test("archived dispatch → recentlyArchivedForTeacher doesn't throw", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const asTeacher = await withUser(t, teacherId);

    const { assignmentId } = await asTeacher.mutation(
      api.assignments.dispatchActivity,
      { scholarId, title: "Explore tessellations" },
    );
    await asTeacher.mutation(api.assignments.archive, { assignmentId });

    const archived = await asTeacher.query(
      api.assignments.recentlyArchivedForTeacher,
      {},
    );
    expect(archived).toHaveLength(1);
    expect(String(archived[0]._id)).toBe(String(assignmentId));
    expect(archived[0].unitId).toBeNull();
    expect(archived[0].unitTitle).toBe("Explore tessellations");
  });
});
