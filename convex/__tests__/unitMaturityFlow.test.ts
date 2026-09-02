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
    const m = await asTeacher.query(api.unitMaturity.getForUnit, { unitId });
    expect(m.stages[1].done).toBe(true);
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

describe("unitMaturity.getForUnit — rolls up real data", () => {
  test("built-but-unreviewed unit sits at Draft, frontier=reviewed", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", { username: "t3" });
    const unitId = await seedBuiltUnit(t, teacher);
    const asTeacher = await withUser(t, teacher);

    const m = await asTeacher.query(api.unitMaturity.getForUnit, { unitId });
    expect(m.stages[0].done).toBe(true); // Draft built
    expect(m.frontierStageId).toBe("reviewed");
    expect(m.completeness.completed).toBe(7);
  });

  test("recording a clean review advances to Reviewed", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", { username: "t4" });
    const unitId = await seedBuiltUnit(t, teacher);
    const asTeacher = await withUser(t, teacher);

    await asTeacher.mutation(api.unitReviews.record, { unitId, openGapCount: 0 });
    const m = await asTeacher.query(api.unitMaturity.getForUnit, { unitId });
    expect(m.stages[1].done).toBe(true);
    expect(m.currentStageId).toBe("reviewed");
    expect(m.frontierStageId).toBe("rehearsed");
  });

  test("a passing rehearsal on the unit's only online activity earns Rehearsed", async () => {
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
    const m = await asTeacher.query(api.unitMaturity.getForUnit, { unitId });
    expect(m.stages[2].done).toBe(true);
    expect(m.currentStageId).toBe("rehearsed");
    expect(m.stages[2].detail).toBe("1/1 activities");
  });
});
