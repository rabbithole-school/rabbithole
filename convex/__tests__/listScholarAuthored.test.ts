import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" = "scholar",
  overrides: { name?: string; username?: string } = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: overrides.name ?? `Test ${role}`,
      username: overrides.username ?? `test${role}${Math.random()}`,
      role,
    }),
  );
}

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
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

/** A scholar-authored unit whose structural essentials are ALL present, so
 *  `computeUnitMaturity` puts it past Draft (bigIdea + EQs + EUs + a
 *  core/connections/practice lesson each with a generated prompt). */
async function seedCompleteUnit(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  opts: { isActive: boolean; title: string },
) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId: scholarId,
      authorScholarId: scholarId,
      title: opts.title,
      isActive: opts.isActive,
      bigIdea: "Systems are made of interacting parts.",
      essentialQuestions: [{ key: "eq1", text: "What holds a system together?" }],
      enduringUnderstandings: [{ key: "eu1", text: "Parts interact." }],
    });
    for (const strand of ["core", "connections", "practice"] as const) {
      await ctx.db.insert("lessons", {
        unitId,
        title: `${strand} lesson`,
        strand,
        systemPrompt: "You are a tutor.",
        order: 0,
      });
    }
    return unitId;
  });
}

/** A skeleton unit — only a title, no EQs/EUs/lessons — so it stays Draft. */
async function seedDraftUnit(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  opts: { isActive: boolean; title: string },
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("units", {
      teacherId: scholarId,
      authorScholarId: scholarId,
      title: opts.title,
      isActive: opts.isActive,
    }),
  );
}

describe("units.listScholarAuthored — board hygiene", () => {
  test("defaults to ACTIVE units only", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar", { name: "Oliver Stone" });
    const asTeacher = await withUser(t, teacherId);

    const active = await seedCompleteUnit(t, scholarId, {
      isActive: true,
      title: "Active Quest",
    });
    await seedDraftUnit(t, scholarId, { isActive: false, title: "Retired Quest" });

    const rows = await asTeacher.query(api.units.listScholarAuthored, {});
    expect(rows.map((r) => String(r._id))).toEqual([String(active)]);
    expect(rows.every((r) => r.isActive)).toBe(true);
  });

  test("includeInactive: true also lists deactivated units", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar", { name: "Oliver Stone" });
    const asTeacher = await withUser(t, teacherId);

    const active = await seedCompleteUnit(t, scholarId, {
      isActive: true,
      title: "Active Quest",
    });
    const inactive = await seedDraftUnit(t, scholarId, {
      isActive: false,
      title: "Retired Quest",
    });

    const rows = await asTeacher.query(api.units.listScholarAuthored, {
      includeInactive: true,
    });
    const byId = new Map(rows.map((r) => [String(r._id), r]));
    expect(byId.size).toBe(2);
    expect(byId.get(String(active))?.isActive).toBe(true);
    expect(byId.get(String(inactive))?.isActive).toBe(false);
  });

  test("isDraft reflects structural completeness, not isActive", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar", { name: "Oliver Stone" });
    const asTeacher = await withUser(t, teacherId);

    const complete = await seedCompleteUnit(t, scholarId, {
      isActive: true,
      title: "Built Quest",
    });
    const draft = await seedDraftUnit(t, scholarId, {
      isActive: true,
      title: "Skeleton Quest",
    });

    const rows = await asTeacher.query(api.units.listScholarAuthored, {});
    const byId = new Map(rows.map((r) => [String(r._id), r]));
    expect(byId.get(String(complete))?.isDraft).toBe(false);
    expect(byId.get(String(draft))?.isDraft).toBe(true);
  });

  test("a non-teacher cannot read the board", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const asScholar = await withUser(t, scholarId);
    await expect(
      asScholar.query(api.units.listScholarAuthored, {}),
    ).rejects.toThrow(/teacher or admin/i);
  });
});
