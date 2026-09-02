import { convexTest } from "convex-test";
import type { TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { ONBOARDING_UNIT_SLUG } from "../onboardingData";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type TC = TestConvex<typeof schema>;

async function seedUser(
  t: TC,
  role: "scholar" | "teacher" = "scholar",
  overrides: { name?: string; username?: string } = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: overrides.name ?? `Test ${role}`,
      username:
        overrides.username ?? `test-${role}-${Math.random().toString(36).slice(2, 8)}`,
      role,
    }),
  );
}

async function withUser(t: TC, userId: Id<"users">) {
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

/** Seed the welcome unit + enroll a scholar; return the onboarding bundle. */
async function seedAndEnroll(t: TC, scholarId: Id<"users">) {
  await t.run(async (ctx) =>
    ctx.runMutation(internal.onboarding.seedOnboarding, {}),
  );
  await t.run(async (ctx) =>
    ctx.runMutation(internal.onboarding.enrollScholar, { scholarId }),
  );
  return await t.run(async (ctx) => {
    const unit = await ctx.db
      .query("units")
      .withIndex("by_slug", (q) => q.eq("slug", ONBOARDING_UNIT_SLUG))
      .first();
    if (!unit) throw new Error("Expected onboarding unit");
    const lesson = await ctx.db
      .query("lessons")
      .withIndex("by_unit", (q) => q.eq("unitId", unit._id))
      .first();
    const activities = (
      await ctx.db
        .query("activities")
        .withIndex("by_lesson", (q) => q.eq("lessonId", lesson!._id))
        .collect()
    ).sort((a, b) => a.order - b.order);
    const assignment = (
      await ctx.db
        .query("assignments")
        .withIndex("by_unit", (q) => q.eq("unitId", unit._id))
        .collect()
    ).find((a) => a.scholarIds.some((id) => id === scholarId));
    return { unit, activities, assignment: assignment! };
  });
}

describe("scholarPlate — onboarding pin", () => {
  test("an enrolled scholar gets a first-beat pin, not a buried row", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const { activities } = await seedAndEnroll(t, scholarId);
    const asScholar = await withUser(t, scholarId);

    const result = await asScholar.query(api.scholarPlate.activeForMe, {});
    expect(result.onboarding).not.toBeNull();
    expect(result.onboarding!.nextBeatTitle).toBe(activities[0].title);
    expect(result.onboarding!.completedCount).toBe(0);
    expect(result.onboarding!.totalCount).toBe(3);
    // Onboarding is surfaced ONLY by the pin — never as a plate row.
    expect(
      result.rows.some((r) => r.title === activities[0].title),
    ).toBe(false);
  });

  test("onboarding never creates a class-focus lock (excluded from currentClassFocusForMe)", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    await seedAndEnroll(t, scholarId);
    const asScholar = await withUser(t, scholarId);

    const focus = await asScholar.query(
      api.assignments.currentClassFocusForMe,
      {},
    );
    expect(focus).toHaveLength(0);
  });

  test("the pin points at the NEXT incomplete beat and stays first mid-way", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const { unit, activities, assignment } = await seedAndEnroll(t, scholarId);
    const asScholar = await withUser(t, scholarId);

    // Complete beats 1 & 2 (assignment-scoped completions).
    await t.run(async (ctx) => {
      for (const a of activities.slice(0, 2)) {
        await ctx.db.insert("activityCompletions", {
          scholarId,
          activityId: a._id,
          unitId: unit._id,
          assignmentId: assignment._id,
          completedAt: Date.now(),
        });
      }
    });

    const result = await asScholar.query(api.scholarPlate.activeForMe, {});
    expect(result.onboarding).not.toBeNull();
    expect(result.onboarding!.nextBeatTitle).toBe(activities[2].title);
    expect(result.onboarding!.completedCount).toBe(2);
    expect(result.onboarding!.totalCount).toBe(3);
  });

  test("the pin disappears once the welcome unit is 3/3 complete", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const { unit, activities, assignment } = await seedAndEnroll(t, scholarId);
    const asScholar = await withUser(t, scholarId);

    await t.run(async (ctx) => {
      for (const a of activities) {
        await ctx.db.insert("activityCompletions", {
          scholarId,
          activityId: a._id,
          unitId: unit._id,
          assignmentId: assignment._id,
          completedAt: Date.now(),
        });
      }
    });

    const result = await asScholar.query(api.scholarPlate.activeForMe, {});
    expect(result.onboarding).toBeNull();
    // And no lingering onboarding rows either.
    expect(
      result.rows.some((r) => activities.some((a) => a.title === r.title)),
    ).toBe(false);
  });

  test("non-onboarding work still shows in the sections while onboarding is pinned", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    await seedAndEnroll(t, scholarId);
    const asScholar = await withUser(t, scholarId);

    // A separate, ordinary class-focus session in a different unit.
    const now = Date.now();
    await t.run(async (ctx) => {
      const teacher = await ctx.db.insert("users", {
        name: "T",
        username: `t-${Math.random().toString(36).slice(2, 8)}`,
        role: "teacher",
      });
      const unit = await ctx.db.insert("units", {
        teacherId: teacher,
        title: "Fraction Sense",
        isActive: true,
      });
      const lesson = await ctx.db.insert("lessons", {
        unitId: unit,
        title: "L1",
        order: 0,
      });
      const activity = await ctx.db.insert("activities", {
        lessonId: lesson,
        title: "Halves and wholes",
        order: 0,
        kind: "online",
      });
      const assignment = await ctx.db.insert("assignments", {
        teacherId: teacher,
        unitId: unit,
        scholarIds: [scholarId],
        startedAt: now - 3_600_000,
        activitySchedule: [
          { activityId: activity, mode: "classFocus", setAt: now - 3_600_000 },
        ],
      });
      await ctx.db.insert("sessions", {
        userId: scholarId,
        unitId: unit,
        activityId: activity,
        assignmentId: assignment,
        title: "Halves and wholes",
        isArchived: false,
        lastMessageAt: now - 60_000,
      });
    });

    const result = await asScholar.query(api.scholarPlate.activeForMe, {});
    expect(result.onboarding).not.toBeNull();
    expect(result.rows.some((r) => r.title === "Halves and wholes")).toBe(true);
  });
});
