import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1000,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("wholeChild observations", () => {
  test("listForScholarPeriod includes explicit migrated rows and creation-time-derived rows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00.000Z"));
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const teacherId = await seedStaffWithMembership(t, {
      institutionId,
      name: "Teacher",
      username: "teacher",
    });
    const scholarId = await seedScholarInInstitution(t, {
      institutionId,
      name: "Scholar",
      username: "scholar",
    });
    const startsAt = new Date("2026-08-10T00:00:00.000Z").getTime();
    const endsAt = new Date("2026-08-20T23:59:59.999Z").getTime();
    const { periodId, otherPeriodId } = await t.run(async (ctx) => ({
      periodId: await ctx.db.insert("reportingPeriods", {
        label: "Target",
        startsAt,
        endsAt,
        status: "writing",
        institutionId,
      }),
      otherPeriodId: await ctx.db.insert("reportingPeriods", {
        label: "Other",
        startsAt,
        endsAt,
        status: "writing",
        institutionId,
      }),
    }));

    const explicitId = await t.run((ctx) =>
      ctx.db.insert("observations", {
        teacherId,
        scholarId,
        note: "Migrated explicit term note.",
        type: "note",
        category: "execFunction",
        periodId,
      }),
    );

    vi.setSystemTime(new Date("2026-08-15T12:00:00.000Z"));
    const derivedId = await t.run((ctx) =>
      ctx.db.insert("observations", {
        teacherId,
        scholarId,
        note: "New note derived from creation time.",
        type: "note",
        category: "passions",
      }),
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("observations", {
        teacherId,
        scholarId,
        note: "Explicitly filed in a different period.",
        type: "note",
        category: "collaboration",
        periodId: otherPeriodId,
      });
      await ctx.db.insert("observations", {
        teacherId,
        scholarId,
        note: "Ordinary observation without a Whole Child tag.",
        type: "praise",
      });
    });

    vi.setSystemTime(new Date("2026-08-25T12:00:00.000Z"));
    await t.run((ctx) =>
      ctx.db.insert("observations", {
        teacherId,
        scholarId,
        note: "Outside the target period.",
        type: "note",
        category: "socialEmotional",
      }),
    );

    const staff = await withUser(t, teacherId);
    const rows = await staff.query(api.wholeChild.listForScholarPeriod, {
      scholarId,
      periodId,
    });
    expect(rows.map((row) => row._id)).toEqual([derivedId, explicitId]);
    expect(rows.every((row) => row.authorName === "Teacher")).toBe(true);
  });

  test("explicit period filing keeps a writing-phase note visible after the period window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T12:00:00.000Z"));
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const teacherId = await seedStaffWithMembership(t, {
      institutionId,
      name: "Teacher",
      username: "teacher",
    });
    const scholarId = await seedScholarInInstitution(t, {
      institutionId,
      name: "Scholar",
      username: "scholar",
    });
    const periodId = await t.run((ctx) =>
      ctx.db.insert("reportingPeriods", {
        label: "Writing",
        startsAt: new Date("2026-08-01T00:00:00.000Z").getTime(),
        endsAt: new Date("2026-08-20T00:00:00.000Z").getTime(),
        status: "writing",
        institutionId,
      }),
    );
    const staff = await withUser(t, teacherId);

    const row = await staff.mutation(api.wholeChild.add, {
      scholarId,
      periodId,
      category: "execFunction",
      note: "Still needs pacing scaffolding.",
    });
    expect(row?.periodId).toBe(periodId);

    const rows = await staff.query(api.wholeChild.listForScholarPeriod, {
      scholarId,
      periodId,
    });
    expect(rows.map((observation) => observation._id)).toContain(row!._id);
  });

  test("add and remove keep the wholeChild API while writing observations", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const teacherId = await seedStaffWithMembership(t, {
      institutionId,
      name: "Teacher",
      username: "teacher",
    });
    const scholarId = await seedScholarInInstitution(t, {
      institutionId,
      name: "Scholar",
      username: "scholar",
    });
    const periodId = await t.run((ctx) =>
      ctx.db.insert("reportingPeriods", {
        label: "Current",
        startsAt: Date.now() - 1000,
        endsAt: Date.now() + 1000,
        status: "writing",
        institutionId,
      }),
    );
    const staff = await withUser(t, teacherId);

    const row = await staff.mutation(api.wholeChild.add, {
      scholarId,
      periodId,
      category: "socialEmotional",
      note: "  Named the feeling and reset independently.  ",
    });
    expect(row).toMatchObject({
      teacherId,
      scholarId,
      category: "socialEmotional",
      note: "Named the feeling and reset independently.",
      type: "note",
      periodId,
    });

    await staff.mutation(api.wholeChild.remove, { inputId: row!._id });
    expect(await t.run((ctx) => ctx.db.get(row!._id))).toBeNull();
  });
});
