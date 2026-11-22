// `find_staff_account` / `staffCapabilities.aideFindStaffAccounts` — the aide's
// reader over staff accounts and their capability grants. Before it existed
// the bot could not tell a school admin whether a colleague had an account.
//
// Fixture people are drawn from the documented fictional dev cast — this repo
// is public.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { makeStaffAccountTools } from "../lib/staffAccountTools";
import {
  grantInstitutionMembership,
  grantStaffCapability,
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const _makeTestClient = () => convexTest(schema, modules);
type TestClient = ReturnType<typeof _makeTestClient>;

async function twoSchools(t: TestClient) {
  const moli = await seedTestInstitution(t, { name: "Mōliʻi School", slug: "moli" });
  const other = await seedTestInstitution(t, { name: "Kailua Academy", slug: "kailua" });
  const admin = await seedStaffWithMembership(t, {
    institutionId: moli,
    role: "school_admin",
    name: "Sloane Kahale",
    username: "sloane",
  });
  const mentor = await seedStaffWithMembership(t, {
    institutionId: moli,
    role: "staff",
    name: "Hoku Makani",
    username: "hoku_makani",
  });
  const scholar = await seedScholarInInstitution(t, { institutionId: moli });
  const groupId = await t.run((ctx) =>
    ctx.db.insert("scholarGroups", {
      institutionId: moli,
      name: "Seals",
      scholarIds: [scholar],
      teacherId: admin,
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("staffCapabilityGrants", {
      granteeUserId: mentor,
      institutionId: moli,
      capability: "scholars:mentor",
      scholarGroupId: groupId,
      grantedBy: admin,
      grantedAt: Date.now(),
    }),
  );
  await grantStaffCapability(t, mentor, moli, "curriculum:edit");
  // Same surname at another school — must never be visible from Mōliʻi.
  const otherHoku = await seedStaffWithMembership(t, {
    institutionId: other,
    role: "teacher",
    name: "Hoku Pali",
    username: "hoku_pali",
  });
  await grantStaffCapability(t, otherHoku, other, "school:operations");
  return { moli, other, admin, mentor, otherHoku };
}

function find(
  t: TestClient,
  callerUserId: Id<"users">,
  name: string,
  institutionScope?: string,
) {
  return t.run((ctx) =>
    ctx.runQuery(internal.staffCapabilities.aideFindStaffAccounts, {
      callerUserId,
      name,
      institutionScope,
    }),
  );
}

describe("aideFindStaffAccounts", () => {
  test("finds a colleague by username with role, Slack link, and grants", async () => {
    const t = convexTest(schema, modules);
    const { admin } = await twoSchools(t);
    const res = await find(t, admin, "HOKU");
    expect(res.schoolsSearched).toEqual(["Mōliʻi School"]);
    expect(res.more).toBe(false);
    expect(res.staff).toHaveLength(1);
    const [hoku] = res.staff;
    expect(hoku).toMatchObject({
      name: "Hoku Makani",
      username: "hoku_makani",
      linkedToSlack: false,
      schools: [{ school: "Mōliʻi School", roles: ["staff"] }],
    });
    expect(hoku.capabilityGrants).toEqual(
      expect.arrayContaining([
        { capability: "scholars:mentor", school: "Mōliʻi School", group: "Seals" },
        { capability: "curriculum:edit", school: "Mōliʻi School", group: null },
      ]),
    );
    expect(hoku.capabilityGrants).toHaveLength(2);
    // No contact details or ids leak through.
    expect(Object.keys(hoku).sort()).toEqual(
      ["capabilityGrants", "linkedToSlack", "name", "schools", "username"].sort(),
    );
  });

  test("hides revoked grants and returns an empty list for no match", async () => {
    const t = convexTest(schema, modules);
    const { admin, mentor } = await twoSchools(t);
    await t.run(async (ctx) => {
      for (const g of await ctx.db.query("staffCapabilityGrants").collect()) {
        if (g.granteeUserId === mentor && g.capability === "curriculum:edit") {
          await ctx.db.patch(g._id, { revokedAt: Date.now(), revokedBy: admin });
        }
      }
    });
    const [hoku] = (await find(t, admin, "makani")).staff;
    expect(hoku.capabilityGrants.map((g) => g.capability)).toEqual(["scholars:mentor"]);
    expect((await find(t, admin, "nobody-here")).staff).toEqual([]);
  });

  test("never crosses the tenant boundary", async () => {
    const t = convexTest(schema, modules);
    const { admin, otherHoku } = await twoSchools(t);
    expect((await find(t, admin, "pali")).staff).toEqual([]);
    // And from the other side: Kailua's teacher sees only Kailua's Hoku.
    const res = await find(t, otherHoku, "hoku");
    expect(res.staff.map((s) => s.username)).toEqual(["hoku_pali"]);
  });

  test("refuses a caller without scholar-admin or operations standing", async () => {
    const t = convexTest(schema, modules);
    const { mentor } = await twoSchools(t);
    await expect(find(t, mentor, "sloane")).rejects.toThrow(/scholar-admin/);
  });
});

describe("aideFindStaffAccounts — review fixes", () => {
  test("reports every role a person holds at one school", async () => {
    const t = convexTest(schema, modules);
    const { moli, admin } = await twoSchools(t);
    const lehua = await seedStaffWithMembership(t, {
      institutionId: moli,
      role: "school_admin",
      name: "Lehua Torres",
      username: "lehua",
    });
    await grantInstitutionMembership(t, lehua, moli, "teacher");
    const [found] = (await find(t, admin, "lehua")).staff;
    expect(found.schools).toHaveLength(1);
    expect([...found.schools[0].roles].sort()).toEqual(["school_admin", "teacher"]);
  });

  test("omits grants that would not take effect", async () => {
    const t = convexTest(schema, modules);
    const { moli, other, mentor } = await twoSchools(t);
    // A caller who manages scholars at BOTH schools.
    const avery = await seedStaffWithMembership(t, {
      institutionId: moli,
      role: "school_admin",
      name: "Avery Stone",
      username: "avery",
    });
    await grantInstitutionMembership(t, avery, other, "school_admin");
    // Hoku holds no membership at Kailua, so a Kailua grant is inert.
    await grantStaffCapability(t, mentor, other, "school:operations");
    // An institution-only capability scoped to a group is never honored.
    const groupId = await t.run(async (ctx) =>
      (await ctx.db.query("scholarGroups").collect())[0]._id,
    );
    await t.run((ctx) =>
      ctx.db.insert("staffCapabilityGrants", {
        granteeUserId: mentor,
        institutionId: moli,
        capability: "health:manage",
        scholarGroupId: groupId,
        grantedBy: avery,
        grantedAt: Date.now(),
      }),
    );
    const res = await find(t, avery, "makani", "all");
    expect(res.schoolsSearched.sort()).toEqual(["Kailua Academy", "Mōliʻi School"]);
    expect(res.staff[0].capabilityGrants.map((g) => g.capability).sort()).toEqual([
      "curriculum:edit",
      "scholars:mentor",
    ]);
  });

  test("a narrow grant at a second school does not open its staff", async () => {
    const t = convexTest(schema, modules);
    const { other, admin } = await twoSchools(t);
    await grantInstitutionMembership(t, admin, other, "staff");
    await grantStaffCapability(t, admin, other, "health:manage");
    const res = await find(t, admin, "hoku", "all");
    expect(res.schoolsSearched).toEqual(["Mōliʻi School"]);
    expect(res.staff.map((s) => s.username)).toEqual(["hoku_makani"]);
  });
});

describe("makeStaffAccountTools", () => {
  const ctxStub = {} as ActionCtx;
  test("is offered to scholar-admins and operations staff only", async () => {
    const emit = () => {};
    const id = "users:1" as Id<"users">;
    expect(await makeStaffAccountTools(ctxStub, emit, { role: "school_admin", callerUserId: id })).toHaveLength(1);
    expect(await makeStaffAccountTools(ctxStub, emit, { role: "staff", callerUserId: id })).toHaveLength(0);
    expect(
      await makeStaffAccountTools(ctxStub, emit, {
        role: "staff",
        callerUserId: id,
        hasSchoolOperationsAccess: true,
      }),
    ).toHaveLength(1);
    expect(await makeStaffAccountTools(ctxStub, emit, { role: "scholar", callerUserId: id })).toHaveLength(0);
  });
});
