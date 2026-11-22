import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { normalizeGranules } from "../lib/granules";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type Role = "scholar" | "teacher" | "platform_admin";

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: Role = "scholar",
  overrides: { name?: string; username?: string } = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: overrides.name ?? `Test ${role}`,
      username: overrides.username ?? `test${role}`,
      role,
    }),
  );
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

// A unit that meets all 7 completeness checks → past Draft.
async function seedBuiltUnit(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Aquaponics",
      isActive: true,
      bigIdea: "Systems balance",
      essentialQuestions: normalizeGranules(["Why balance?"], "eq"),
      enduringUnderstandings: normalizeGranules(["Systems self-regulate"], "eu"),
    });
    for (const strand of ["core", "connections", "practice"] as const) {
      await ctx.db.insert("lessons", {
        unitId,
        title: `${strand} lesson`,
        strand,
        systemPrompt: "p",
        order: 0,
      });
    }
    return unitId;
  });
}

describe("unitReviews.record — gating", () => {
  test("a scholar cannot record a review (not edit access)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", { username: "t1" });
    const scholar = await seedUser(t, "scholar", { username: "s1" });
    const unitId = await seedBuiltUnit(t, teacher);
    const asScholar = await withUser(t, scholar);
    await expect(
      asScholar.mutation(api.unitReviews.record, { unitId, openGapCount: 0 }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("rejects a negative gap count", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", { username: "t2" });
    const unitId = await seedBuiltUnit(t, teacher);
    const asTeacher = await withUser(t, teacher);
    await expect(
      asTeacher.mutation(api.unitReviews.record, { unitId, openGapCount: -1 }),
    ).rejects.toThrow(/openGapCount/);
  });
});

describe("unitReviews.recordInternal — the bot tool's writer", () => {
  test("records a freeform coverage summary and advances the rail", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", { username: "ti" });
    const unitId = await seedBuiltUnit(t, teacher);

    await t.run(async (ctx) =>
      ctx.runMutation(internal.unitReviews.recordInternal, {
        unitId,
        reviewedBy: teacher,
        openGapCount: 0,
        summary: {
          coverage: [
            { item: "Why balance?", kind: "essentialQuestion", verdict: "covered", activityTitles: ["A"] },
          ],
          note: "all EQs covered",
        },
      }),
    );

    const asTeacher = await withUser(t, teacher);
    const statuses = await asTeacher.query(api.unitMaturity.getNodeStatuses, { unitId });
    expect(statuses.readiness.unit.steps[1].state).toBe("done");
    const review = await asTeacher.query(api.unitReviews.latestForUnit, { unitId });
    expect(review?.openGapCount).toBe(0);
    expect((review?.summary as { note?: string })?.note).toBe("all EQs covered");
  });

  test("rejects a negative gap count", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", { username: "tj" });
    const unitId = await seedBuiltUnit(t, teacher);
    await expect(
      t.run(async (ctx) =>
        ctx.runMutation(internal.unitReviews.recordInternal, {
          unitId,
          reviewedBy: teacher,
          openGapCount: -2,
        }),
      ),
    ).rejects.toThrow(/openGapCount/);
  });
});

describe("unitMaturity.getNodeStatuses — unit Readiness rolls up real data", () => {
  test("built-but-unreviewed unit is Built, frontier=heuristic review", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", { username: "t3" });
    const unitId = await seedBuiltUnit(t, teacher);
    const asTeacher = await withUser(t, teacher);

    const { readiness } = await asTeacher.query(api.unitMaturity.getNodeStatuses, { unitId });
    expect(readiness.unit.steps[0].state).toBe("done"); // all 7 essentials
    expect(readiness.unit.frontierStepId).toBe("heuristicReview");
  });

  test("recording a clean review clears the heuristic review", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", { username: "t4" });
    const unitId = await seedBuiltUnit(t, teacher);
    const asTeacher = await withUser(t, teacher);

    await asTeacher.mutation(api.unitReviews.record, { unitId, openGapCount: 0 });
    const { readiness } = await asTeacher.query(api.unitMaturity.getNodeStatuses, { unitId });
    expect(readiness.unit.steps[1].state).toBe("done");
    // No online activities yet, so the rehearsal step is n/a and the unit is Ready.
    expect(readiness.unit.steps[2].state).toBe("na");
    expect(readiness.unit.ready).toBe(true);
  });

  test("a passing rehearsal on the unit's only online activity clears the rehearsal", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", { username: "t5" });
    const unitId = await seedBuiltUnit(t, teacher);

    // One online activity with a passing rehearsal scorecard.
    await t.run(async (ctx) => {
      const lesson = await ctx.db
        .query("lessons")
        .withIndex("by_unit", (q) => q.eq("unitId", unitId))
        .first();
      const activityId = await ctx.db.insert("activities", {
        lessonId: lesson!._id,
        title: "Build a model",
        kind: "online",
        systemPrompt: "p",
        order: 0,
      });
      await ctx.db.insert("curriculumVariants", {
        activityId,
        generation: 0,
        origin: "baseline",
        aggregateScores: { fitness: 4.2 },
        status: "candidate",
      });
    });

    const asTeacher = await withUser(t, teacher);
    await asTeacher.mutation(api.unitReviews.record, { unitId, openGapCount: 0 });
    const { readiness } = await asTeacher.query(api.unitMaturity.getNodeStatuses, { unitId });
    expect(readiness.unit.steps[2].state).toBe("done");
    expect(readiness.unit.steps[2].detail).toBe("1/1 activities");
    expect(readiness.unit.ready).toBe(true);
  });
});

// Carl's rule: when a class finishes a unit, archive the run and keep the unit
// for the next teacher. Archiving must not cost the unit the record of having
// been taught.
describe("a unit whose runs are all archived keeps its record", () => {
  test("Sessions still counts the archived run's work, and Readiness is unchanged", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", { username: "t6" });
    const scholar = await seedUser(t, "scholar", { username: "s6" });
    const unitId = await seedBuiltUnit(t, teacher);
    const { activityId, assignmentId } = await t.run(async (ctx) => {
      const lesson = await ctx.db
        .query("lessons")
        .withIndex("by_unit", (q) => q.eq("unitId", unitId))
        .first();
      const activityId = await ctx.db.insert("activities", {
        lessonId: lesson!._id,
        title: "Build a model",
        kind: "online",
        systemPrompt: "p",
        order: 0,
      });
      const assignmentId = await ctx.db.insert("assignments", {
        teacherId: teacher,
        unitId,
        scholarIds: [scholar],
        startedAt: Date.now() - 7 * 86_400_000,
      });
      await ctx.db.insert("sessions", {
        userId: scholar,
        unitId,
        lessonId: lesson!._id,
        activityId,
        assignmentId,
        title: "Build a model",
        isArchived: false,
        activityCompletedAt: Date.now() - 6 * 86_400_000,
      });
      return { activityId, assignmentId };
    });
    const asTeacher = await withUser(t, teacher);
    await asTeacher.mutation(api.unitReviews.record, { unitId, openGapCount: 0 });

    const before = {
      statuses: await asTeacher.query(api.unitMaturity.getNodeStatuses, { unitId }),
      sessions: await asTeacher.query(api.activitySessions.getForUnit, { unitId }),
    };
    expect(before.sessions.unit.completeCount).toBe(1);

    await t.run(async (ctx) => ctx.db.patch(assignmentId, { archivedAt: Date.now() }));

    const after = {
      statuses: await asTeacher.query(api.unitMaturity.getNodeStatuses, { unitId }),
      sessions: await asTeacher.query(api.activitySessions.getForUnit, { unitId }),
    };
    expect(after.sessions.unit.completeCount).toBe(1);
    expect(after.sessions.unit).toEqual(before.sessions.unit);
    expect(after.statuses.readiness.unit).toEqual(before.statuses.readiness.unit);
    expect(after.statuses.activitiesAssigned[String(activityId)]).toBe(true);
  });
});
