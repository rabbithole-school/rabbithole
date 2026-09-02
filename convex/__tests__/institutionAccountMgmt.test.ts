import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// Institution-scoped account management (follow-up to the platform/school admin
// split): a school_admin may add staff (teacher/staff/curriculum_designer)
// AND issue their enrollment links; operations staff (the retired `registrar`
// role's successor — base `staff` + the `school:operations` capability grant)
// may add scholars/parents + issue PARENT links, but NOT staff. Granting
// another school_admin/platform_admin stays platform-only. These pin the
// grant matrix.

type Role =
  | "scholar"
  | "teacher"
  | "platform_admin"
  | "school_admin"
  | "staff"
  | "curriculum_designer"
  | "parent";

async function seedInstitutions(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => ({
    moli: await ctx.db.insert("institutions", {
      name: "Moli School",
      slug: "moli",
      kind: "school",
      isPrimary: true,
    }),
  }));
}

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: Role,
  username: string,
  institutionId?: Id<"institutions">,
) {
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: `Test ${username}`,
      username,
      role,
      ...(institutionId && role === "scholar" ? { institutionId } : {}),
    }),
  );
  if (institutionId && role !== "scholar") {
    await t.run(async (ctx) =>
      ctx.db.insert("memberships", { userId, role, institutionId }),
    );
  }
  return userId;
}

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
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

/**
 * Grant a staff capability (test helper, local to this file — the retired
 * `registrar` role's successor for scholar-admin access is a base `staff`
 * user plus a `school:operations` grant at the institution).
 */
async function grantOpsCapability(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  institutionId: Id<"institutions">,
) {
  await t.run(async (ctx) =>
    ctx.db.insert("staffCapabilityGrants", {
      granteeUserId: userId,
      institutionId,
      capability: "school:operations",
      grantedBy: userId,
      grantedAt: Date.now(),
    }),
  );
}

/** Seed the retired-registrar successor: base staff + school:operations. */
async function seedOperationsStaff(
  t: ReturnType<typeof convexTest>,
  username: string,
  institutionId: Id<"institutions">,
) {
  const userId = await seedUser(t, "staff", username, institutionId);
  await grantOpsCapability(t, userId, institutionId);
  return userId;
}

// ── createInstitutionStaff ─────────────────────────────────────────────

describe("createInstitutionStaff — school_admin only, institution-stamped", () => {
  test("school_admin creates a teacher stamped to their institution", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    const asHoku = await withUser(t, hoku);
    const { userId } = await asHoku.mutation(api.users.createInstitutionStaff, {
      name: "New Teacher",
      role: "teacher",
    });
    const created = await t.run(async (ctx) => ctx.db.get(userId));
    expect(created?.role).toBe("teacher");
    const mem = await t.run(async (ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .first(),
    );
    expect(mem?.institutionId).toBe(moli);
  });

  test("operations staff CANNOT create staff", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const reg = await seedOperationsStaff(t, "reg", moli);
    const asReg = await withUser(t, reg);
    await expect(
      asReg.mutation(api.users.createInstitutionStaff, {
        name: "Nope",
        role: "teacher",
      }),
    ).rejects.toThrow("Forbidden");
  });

  test("the role arg cannot be school_admin or platform_admin (validator)", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    const asHoku = await withUser(t, hoku);
    await expect(
      asHoku.mutation(api.users.createInstitutionStaff, {
        name: "No Escalation",
        // @ts-expect-error — school_admin is not an allowed grantable role
        role: "school_admin",
      }),
    ).rejects.toThrow();
  });
});

// ── enrollment links — the grant matrix ────────────────────────────────

describe("enrollment links honor the grant matrix", () => {
  test("operations staff CAN issue a parent enroll link", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const reg = await seedOperationsStaff(t, "reg", moli);
    const parent = await seedUser(t, "parent", "p1");
    const asReg = await withUser(t, reg);
    const res = await asReg.mutation(api.enrollment.issueParentEnrollLink, {
      parentId: parent,
    });
    expect(res.path).toContain("/enroll?token=");
  });

  test("operations staff CANNOT issue a staff enroll link", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const reg = await seedOperationsStaff(t, "reg", moli);
    const teacher = await seedUser(t, "teacher", "teach", moli);
    const asReg = await withUser(t, reg);
    await expect(
      asReg.mutation(api.enrollment.issueStaffEnrollLink, { userId: teacher }),
    ).rejects.toThrow("Forbidden");
  });

  test("school_admin CAN issue a staff enroll link", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    const teacher = await seedUser(t, "teacher", "teach", moli);
    const asHoku = await withUser(t, hoku);
    const res = await asHoku.mutation(api.enrollment.issueStaffEnrollLink, {
      userId: teacher,
    });
    expect(res.path).toContain("/enroll?token=");
  });

  test("issueStaffEnrollLink REFUSES a platform_admin target (no escalation)", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    const platform = await seedUser(t, "platform_admin", "avery");
    const asHoku = await withUser(t, hoku);
    await expect(
      asHoku.mutation(api.enrollment.issueStaffEnrollLink, { userId: platform }),
    ).rejects.toThrow("Staff account not found");
  });

  test("issueStaffEnrollLink REFUSES a staff target in ANOTHER institution", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const nuni = await t.run(async (ctx) =>
      ctx.db.insert("institutions", { name: "Nuni", slug: "nuni", kind: "school" }),
    );
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    const teacherB = await seedUser(t, "teacher", "teachB", nuni);
    const asHoku = await withUser(t, hoku);
    await expect(
      asHoku.mutation(api.enrollment.issueStaffEnrollLink, { userId: teacherB }),
    ).rejects.toThrow("Staff account not found");
  });

  test("a platform_admin CAN issue a staff link across institutions", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const avery = await seedUser(t, "platform_admin", "avery");
    const teacher = await seedUser(t, "teacher", "teach", moli);
    const asAvery = await withUser(t, avery);
    const res = await asAvery.mutation(api.enrollment.issueStaffEnrollLink, {
      userId: teacher,
    });
    expect(res.path).toContain("/enroll?token=");
  });
});

describe("createInstitutionStaff — email uniqueness", () => {
  test("rejects a duplicate email (would break magic-link auth)", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    const asHoku = await withUser(t, hoku);
    await asHoku.mutation(api.users.createInstitutionStaff, {
      name: "First",
      email: "dup@school.edu",
      role: "teacher",
    });
    await expect(
      asHoku.mutation(api.users.createInstitutionStaff, {
        name: "Second",
        email: "dup@school.edu",
        role: "staff",
      }),
    ).rejects.toThrow("already in use");
  });
});

// ── listInstitutionStaff — read is open to any scholar-admin ───────────
// The staff roster is READABLE by any scholar-admin (teacher / operations
// staff / school_admin / platform_admin), mirroring the sibling Scholars/
// Guardians directory reads. Scholars are refused; MANAGING staff stays
// school-admin-only (see the create/remove/enroll-link suites above).

describe("listInstitutionStaff — scholar-admin read gate", () => {
  test("operations staff CAN read the staff roster for their institution", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const reg = await seedOperationsStaff(t, "reg", moli);
    await seedUser(t, "teacher", "teach", moli);
    await seedUser(t, "school_admin", "hoku", moli);
    const asReg = await withUser(t, reg);
    const staff = await asReg.query(api.users.listInstitutionStaff, {});
    expect(staff.map((s) => s.username).sort()).toEqual(["hoku", "reg", "teach"]);
  });

  test("teacher CAN read the staff roster", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const teacher = await seedUser(t, "teacher", "teach", moli);
    const asTeacher = await withUser(t, teacher);
    const staff = await asTeacher.query(api.users.listInstitutionStaff, {});
    expect(staff.map((s) => s.username)).toContain("teach");
  });

  test("scholar CANNOT read the staff roster", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const kid = await seedUser(t, "scholar", "kid", moli);
    const asKid = await withUser(t, kid);
    await expect(
      asKid.query(api.users.listInstitutionStaff, {}),
    ).rejects.toThrow("Forbidden");
  });

  test("operations staff can view but CANNOT remove staff (read-only)", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const reg = await seedOperationsStaff(t, "reg", moli);
    const teacher = await seedUser(t, "teacher", "teach", moli);
    const asReg = await withUser(t, reg);
    // Can see the teacher in the roster…
    const staff = await asReg.query(api.users.listInstitutionStaff, {});
    expect(staff.map((s) => s.username)).toContain("teach");
    // …but cannot remove them.
    await expect(
      asReg.mutation(api.users.removeStaffFromInstitution, { userId: teacher }),
    ).rejects.toThrow("Forbidden");
  });
});
