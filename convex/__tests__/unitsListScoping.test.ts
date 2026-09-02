import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { unitListNeedsScholarEnumeration } from "../units";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

describe("units.list scholar enumeration", () => {
  test("does not enumerate scholars for an omitted-scope platform-admin list", () => {
    expect(
      unitListNeedsScholarEnumeration({
        adminAll: true,
        legacySingleTenant: false,
      }),
    ).toBe(false);
  });

  test("does not enumerate scholars for the legacy single-tenant path", () => {
    expect(
      unitListNeedsScholarEnumeration({
        adminAll: false,
        legacySingleTenant: true,
      }),
    ).toBe(false);
  });
});

/**
 * Acceptance criteria for scoping `units.list` to the institution lens.
 *
 * `units.listScholarAuthored` (the Quests board) already filters
 * scholar-authored units through `resolveInstitutionLens` +
 * `scholarIdsInLens`. `units.list` — which backs the Curriculum browser —
 * takes NO args and, for any curriculum role, returns every unit in the
 * deployment. That contradicts the contract documented on the
 * `authorScholarId` field in schema.ts ("Visible to the scholar + their
 * assigned teachers"), so staff at one institution currently see
 * independent-study units authored by scholars at another.
 *
 * The `describe.skip` block below is the FIX's acceptance criteria: it fails
 * on master today. Un-skip it as the first step of the implementation.
 */

async function seedInstitution(
  t: ReturnType<typeof convexTest>,
  opts: { name: string; slug: string; kind: "school" | "guest"; isPrimary?: boolean },
) {
  return await t.run(async (ctx) => ctx.db.insert("institutions", opts));
}

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher",
  opts: { name: string; institutionId?: Id<"institutions"> },
) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: opts.name,
      username: `${opts.name.toLowerCase().replace(/\W+/g, "")}${Math.random()}`,
      role,
      institutionId: opts.institutionId,
    });
    if (opts.institutionId) {
      await ctx.db.insert("memberships", {
        userId,
        role,
        institutionId: opts.institutionId,
      });
    }
    return userId;
  });
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

/** A scholar-authored (independent-study / Quest) unit. */
async function seedScholarUnit(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  title: string,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("units", {
      teacherId: scholarId,
      authorScholarId: scholarId,
      title,
      isActive: true,
    }),
  );
}

/** A normal teacher-authored catalog unit. */
async function seedCatalogUnit(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
  title: string,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("units", { teacherId, title, isActive: true }),
  );
}

/** Two institutions, a teacher in one, a scholar authoring a Quest in the other. */
async function seedCrossInstitutionWorld(t: ReturnType<typeof convexTest>) {
  const home = await seedInstitution(t, {
    name: "Primary School",
    slug: "primary",
    kind: "school",
    isPrimary: true,
  });
  const other = await seedInstitution(t, {
    name: "Guests",
    slug: "guests",
    kind: "guest",
  });
  const teacherId = await seedUser(t, "teacher", {
    name: "Home Teacher",
    institutionId: home,
  });
  const homeScholarId = await seedUser(t, "scholar", {
    name: "Home Scholar",
    institutionId: home,
  });
  const foreignScholarId = await seedUser(t, "scholar", {
    name: "Foreign Scholar",
    institutionId: other,
  });

  const catalogUnit = await seedCatalogUnit(t, teacherId, "Aquaponics QUEST");
  const homeQuest = await seedScholarUnit(t, homeScholarId, "Home Quest");
  const foreignQuest = await seedScholarUnit(t, foreignScholarId, "Foreign Quest");

  return { teacherId, homeScholarId, foreignScholarId, catalogUnit, homeQuest, foreignQuest };
}

// ── Behavior that is already correct today — regression guards ──────────
describe("units.list — scholar path (already correct, do not regress)", () => {
  test("a scholar sees their OWN independent-study unit", async () => {
    const t = convexTest(schema, modules);
    const { homeScholarId, homeQuest } = await seedCrossInstitutionWorld(t);
    const asScholar = await withUser(t, homeScholarId);

    const rows = await asScholar.query(api.units.list, {});
    expect(rows.map((r) => String(r._id))).toContain(String(homeQuest));
  });

  test("a scholar does NOT see another scholar's independent-study unit", async () => {
    const t = convexTest(schema, modules);
    const { homeScholarId, foreignQuest } = await seedCrossInstitutionWorld(t);
    const asScholar = await withUser(t, homeScholarId);

    const rows = await asScholar.query(api.units.list, {});
    expect(rows.map((r) => String(r._id))).not.toContain(String(foreignQuest));
  });

  test("a scholar still sees the teacher-authored catalog", async () => {
    const t = convexTest(schema, modules);
    const { homeScholarId, catalogUnit } = await seedCrossInstitutionWorld(t);
    const asScholar = await withUser(t, homeScholarId);

    const rows = await asScholar.query(api.units.list, {});
    expect(rows.map((r) => String(r._id))).toContain(String(catalogUnit));
  });
});

// ── The fix's acceptance criteria (were failing before the lens landed). ──
describe("units.list — institution scoping for curriculum roles (THE FIX)", () => {
  test("staff do NOT see a scholar-authored unit from another institution", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, foreignQuest } = await seedCrossInstitutionWorld(t);
    const asTeacher = await withUser(t, teacherId);

    const rows = await asTeacher.query(api.units.list, {});
    expect(rows.map((r) => String(r._id))).not.toContain(String(foreignQuest));
  });

  test("staff DO see a scholar-authored unit from their own institution", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, homeQuest } = await seedCrossInstitutionWorld(t);
    const asTeacher = await withUser(t, teacherId);

    const rows = await asTeacher.query(api.units.list, {});
    expect(rows.map((r) => String(r._id))).toContain(String(homeQuest));
  });

  test("the teacher-authored catalog is unaffected by the lens", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, catalogUnit } = await seedCrossInstitutionWorld(t);
    const asTeacher = await withUser(t, teacherId);

    const rows = await asTeacher.query(api.units.list, {});
    expect(rows.map((r) => String(r._id))).toContain(String(catalogUnit));
  });

  test("units.list agrees with units.listScholarAuthored on which Quests are visible", async () => {
    const t = convexTest(schema, modules);
    const { teacherId } = await seedCrossInstitutionWorld(t);
    const asTeacher = await withUser(t, teacherId);

    const listed = await asTeacher.query(api.units.list, {});
    const board = await asTeacher.query(api.units.listScholarAuthored, {
      scope: "",
      includeInactive: true,
    });

    const questIdsFromList = new Set(
      listed.filter((u) => !!u.authorScholarId).map((u) => String(u._id)),
    );
    const questIdsFromBoard = new Set(board.map((r) => String(r._id)));
    expect([...questIdsFromList].sort()).toEqual([...questIdsFromBoard].sort());
  });
});
