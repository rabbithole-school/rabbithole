import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * The narrative-report backend that the curriculum-bot report tools + the
 * composer rely on: units are DERIVED from the scholar's in-window sessions
 * (never hand-picked), sections + ratings are teacher-authored, and the bot's
 * read/write internals round-trip. Exercised through the internal functions so
 * we test the logic without the auth gate (the public wrappers are thin).
 */

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const DAY = 24 * 3_600_000;

async function seedWorld(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const teacherId = await ctx.db.insert("users", {
      name: "T", username: "t", role: "teacher",
    });
    const scholarId = await ctx.db.insert("users", {
      name: "S", username: "s", role: "scholar",
    });
    const now = Date.now();
    // A current period that includes now, and a past period that doesn't.
    const periodId = await ctx.db.insert("reportingPeriods", {
      label: "Now", startsAt: now - 10 * DAY, endsAt: now + 10 * DAY, status: "writing",
    });
    const pastPeriodId = await ctx.db.insert("reportingPeriods", {
      label: "Past", startsAt: now - 100 * DAY, endsAt: now - 90 * DAY, status: "closed",
    });
    const sci1 = await ctx.db.insert("units", { teacherId, title: "Volcanoes", subject: "Science", isActive: true });
    const sci2 = await ctx.db.insert("units", { teacherId, title: "Reefs", subject: "Science", isActive: true });
    const math = await ctx.db.insert("units", { teacherId, title: "Fractions", subject: "Mathematics", isActive: true });
    // Sessions (inserted now → in the current window). Two distinct Science
    // units + a duplicate + a Math unit + a unitless session.
    for (const unitId of [sci1, sci2, sci1, math]) {
      await ctx.db.insert("sessions", { userId: scholarId, unitId, title: "sess", isArchived: false });
    }
    await ctx.db.insert("sessions", { userId: scholarId, title: "no-unit", isArchived: false });
    return { teacherId, scholarId, periodId, pastPeriodId, sci1, sci2, math };
  });
}

describe("courseNarratives — units derived from sessions", () => {
  test("openInternal derives the scholar's in-window Science units (deduped, subject-scoped)", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const narrativeId = await t.mutation(internal.courseNarratives.openInternal, {
      scholarId: w.scholarId, teacherId: w.teacherId, periodId: w.periodId, subject: "Science",
    });
    const n = await t.run(async (ctx) => ctx.db.get(narrativeId));
    const ids = (n!.unitIds as Id<"units">[]).map(String).sort();
    // Both Science units (deduped), NOT the Math unit, NOT the unitless session.
    expect(ids).toEqual([String(w.sci1), String(w.sci2)].sort());
  });

  test("a period whose window is entirely in the past derives no units", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const narrativeId = await t.mutation(internal.courseNarratives.openInternal, {
      scholarId: w.scholarId, teacherId: w.teacherId, periodId: w.pastPeriodId, subject: "Science",
    });
    const n = await t.run(async (ctx) => ctx.db.get(narrativeId));
    expect(n!.unitIds).toEqual([]);
  });

  test("openInternal is idempotent per (scholar, period, subject)", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const a = await t.mutation(internal.courseNarratives.openInternal, {
      scholarId: w.scholarId, teacherId: w.teacherId, periodId: w.periodId, subject: "Science",
    });
    const b = await t.mutation(internal.courseNarratives.openInternal, {
      scholarId: w.scholarId, teacherId: w.teacherId, periodId: w.periodId, subject: "Science",
    });
    expect(String(a)).toBe(String(b));
  });

  test("subject dedup is case-insensitive (no duplicate narrative for Science vs science)", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const a = await t.mutation(internal.courseNarratives.openInternal, {
      scholarId: w.scholarId, teacherId: w.teacherId, periodId: w.periodId, subject: "Science",
    });
    const b = await t.mutation(internal.courseNarratives.openInternal, {
      scholarId: w.scholarId, teacherId: w.teacherId, periodId: w.periodId, subject: "science",
    });
    expect(String(a)).toBe(String(b));
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("courseNarratives")
        .withIndex("by_scholar_period", (q) =>
          q.eq("scholarId", w.scholarId).eq("periodId", w.periodId),
        )
        .collect(),
    );
    expect(rows).toHaveLength(1);
  });
});

describe("courseNarratives — bot read/write internals", () => {
  test("write section + set ratings round-trip through getForBot", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const narrativeId = await t.mutation(internal.courseNarratives.openInternal, {
      scholarId: w.scholarId, teacherId: w.teacherId, periodId: w.periodId, subject: "Science",
    });
    await t.mutation(internal.courseNarratives.setSectionInternal, {
      narrativeId, key: "dim_connections", body: "Linked nitrogen cycle to ahupuaʻa.",
    });
    await t.mutation(internal.courseNarratives.setRatingInternal, {
      narrativeId, dimension: "connections", value: 7,
    });
    await t.mutation(internal.courseNarratives.setRatingInternal, {
      narrativeId, dimension: "overall", value: 5,
    });
    const reports = await t.query(internal.courseNarratives.getForBot, {
      scholarId: w.scholarId, periodId: w.periodId, subject: "Science",
    });
    expect(reports).toHaveLength(1);
    const r = reports[0];
    expect(r.sections.find((s) => s.key === "dim_connections")?.body).toMatch(/nitrogen cycle/);
    expect(r.pcmRatings?.connections).toBe(7);
    expect(r.courseRating).toBe(5);
  });

  test("setRatingInternal rejects out-of-range + unknown dimensions", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const narrativeId = await t.mutation(internal.courseNarratives.openInternal, {
      scholarId: w.scholarId, teacherId: w.teacherId, periodId: w.periodId, subject: "Science",
    });
    await expect(
      t.mutation(internal.courseNarratives.setRatingInternal, { narrativeId, dimension: "core", value: 8 }),
    ).rejects.toThrow(/1.?7/);
    await expect(
      t.mutation(internal.courseNarratives.setRatingInternal, { narrativeId, dimension: "bogus", value: 3 }),
    ).rejects.toThrow(/dimension/i);
  });
});
