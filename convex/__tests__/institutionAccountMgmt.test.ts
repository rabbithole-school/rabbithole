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
    // A second, non-primary school. Membership management is only
    // interesting across a boundary — "give this existing account standing
    // at the OTHER school" is the case that had no UI.
    kona: await ctx.db.insert("institutions", {
      name: "Kona Tutoring",
      slug: "kona",
      kind: "school",
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

async function linkParentToScholar(
  t: ReturnType<typeof convexTest>,
  parentUserId: Id<"users">,
  scholarUserId: Id<"users">,
  createdBy: Id<"users">,
) {
  await t.run(async (ctx) =>
    ctx.db.insert("guardianships", {
      parentUserId,
      scholarUserId,
      createdBy,
    }),
  );
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
    const scholar = await seedUser(t, "scholar", "s1", moli);
    await linkParentToScholar(t, parent, scholar, reg);
    const asReg = await withUser(t, reg);
    const res = await asReg.mutation(api.enrollment.issueParentEnrollLink, {
      parentId: parent,
    });
    expect(res.path).toContain("/enroll?token=");
  });

  test("operations staff CANNOT issue a parent link across institutions", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const nuni = await t.run(async (ctx) =>
      ctx.db.insert("institutions", { name: "Nuni", slug: "nuni", kind: "school" }),
    );
    const reg = await seedOperationsStaff(t, "reg", nuni);
    const parent = await seedUser(t, "parent", "p1");
    const scholar = await seedUser(t, "scholar", "s1", moli);
    await linkParentToScholar(t, parent, scholar, reg);
    const asReg = await withUser(t, reg);

    await expect(
      asReg.mutation(api.enrollment.issueParentEnrollLink, {
        parentId: parent,
      }),
    ).rejects.toThrow("Parent not found");
    const tokens = await t.run(async (ctx) =>
      ctx.db.query("enrollmentTokens").collect(),
    );
    expect(tokens).toHaveLength(0);
  });

  test("platform admins CAN issue parent links across institutions", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const platformAdmin = await seedUser(t, "platform_admin", "platform");
    const parent = await seedUser(t, "parent", "p1");
    const scholar = await seedUser(t, "scholar", "s1", moli);
    await linkParentToScholar(t, parent, scholar, platformAdmin);
    const asPlatformAdmin = await withUser(t, platformAdmin);

    const res = await asPlatformAdmin.mutation(
      api.enrollment.issueParentEnrollLink,
      { parentId: parent },
    );
    expect(res.path).toContain("/enroll?token=");
  });

  test("claim invite: operations staff CAN email a same-institution parent", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const reg = await seedOperationsStaff(t, "reg", moli);
    const parent = await seedUser(t, "parent", "p1");
    await t.run(async (ctx) =>
      ctx.db.patch(parent, { email: "p1@example.com" }),
    );
    const scholar = await seedUser(t, "scholar", "s1", moli);
    await linkParentToScholar(t, parent, scholar, reg);
    const asReg = await withUser(t, reg);
    const res = await asReg.mutation(api.parents.sendClaimInvite, {
      parentId: parent,
    });
    expect(res).toEqual({ sent: true, email: "p1@example.com" });
  });

  test("claim invite: operations staff CANNOT email a parent across institutions", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const nuni = await t.run(async (ctx) =>
      ctx.db.insert("institutions", { name: "Nuni", slug: "nuni", kind: "school" }),
    );
    const reg = await seedOperationsStaff(t, "reg", nuni);
    const parent = await seedUser(t, "parent", "p1");
    await t.run(async (ctx) =>
      ctx.db.patch(parent, { email: "p1@example.com" }),
    );
    const scholar = await seedUser(t, "scholar", "s1", moli);
    await linkParentToScholar(t, parent, scholar, reg);
    const asReg = await withUser(t, reg);

    await expect(
      asReg.mutation(api.parents.sendClaimInvite, { parentId: parent }),
    ).rejects.toThrow("Parent not found");
    expect(
      await t.run((ctx) =>
        ctx.db.system.query("_scheduled_functions").collect(),
      ),
    ).toHaveLength(0);
  });

  test("claim invite: platform admins CAN email parents across institutions", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const platformAdmin = await seedUser(t, "platform_admin", "platform");
    const parent = await seedUser(t, "parent", "p1");
    await t.run(async (ctx) =>
      ctx.db.patch(parent, { email: "p1@example.com" }),
    );
    const scholar = await seedUser(t, "scholar", "s1", moli);
    await linkParentToScholar(t, parent, scholar, platformAdmin);
    const asPlatformAdmin = await withUser(t, platformAdmin);
    const res = await asPlatformAdmin.mutation(api.parents.sendClaimInvite, {
      parentId: parent,
    });
    expect(res.sent).toBe(true);
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

  // The directory carries its OWN staff-role set (teacher / staff /
  // curriculum_designer / school_admin) — deliberately NOT `STAFF_ROLES`,
  // which also includes `platform_admin`. The read is now indexed per staff
  // role (`by_institution_role`) instead of collecting a school's whole
  // membership table and filtering, so this pins the set the roles are read
  // from: scholars stay out (they are the bulk of the rows), and an
  // institution-scoped platform admin stays out (they are the operator, not
  // school staff).
  test("excludes scholars and an institution-scoped platform admin", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const teacher = await seedUser(t, "teacher", "teach", moli);
    await seedUser(t, "school_admin", "hoku", moli);
    await seedUser(t, "platform_admin", "operator", moli);
    // Scholars hold membership rows too — the bulk of them, in a real school.
    const kid = await seedUser(t, "scholar", "kid", moli);
    await t.run(async (ctx) =>
      ctx.db.insert("memberships", {
        userId: kid,
        role: "scholar",
        institutionId: moli,
      }),
    );
    const asTeacher = await withUser(t, teacher);
    const staff = await asTeacher.query(api.users.listInstitutionStaff, {});
    expect(staff.map((s) => s.username).sort()).toEqual(["hoku", "teach"]);
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

// ── Attaching a staff membership to an EXISTING account (TRA-349) ──────
//
// Before this, `/admin/accounts` could create a new staff member or set a
// LEARNER's institution, but nothing could give an existing account
// institution-scoped STAFF standing — the only paths were the Convex
// dashboard and `convex import`. The backend mutation already existed; these
// pin the semantics the surface has to honor, and the trap it must not fall
// into.

describe("addMembership — staff standing for an existing account", () => {
  test("grants standing at a second school and the directory reflects it", async () => {
    const t = convexTest(schema, modules);
    const { moli, kona } = await seedInstitutions(t);
    const admin = await seedUser(t, "platform_admin", "operator");
    const teacher = await seedUser(t, "teacher", "teach", moli);

    // Not in Kona's directory yet.
    const konaAdmin = await seedUser(t, "school_admin", "kai", kona);
    const asKonaAdmin = await withUser(t, konaAdmin);
    expect(
      (await asKonaAdmin.query(api.users.listInstitutionStaff, { scope: "kona" }))
        .map((s) => s.username),
    ).not.toContain("teach");

    const asAdmin = await withUser(t, admin);
    await asAdmin.mutation(api.memberships.addMembership, {
      userId: teacher,
      role: "teacher",
      institutionId: kona,
    });

    expect(
      (await asKonaAdmin.query(api.users.listInstitutionStaff, { scope: "kona" }))
        .map((s) => s.username)
        .sort(),
    ).toEqual(["kai", "teach"]);
    // The original standing is untouched — this adds a context, never moves one.
    const asMoliTeacher = await withUser(t, teacher);
    expect(
      (await asMoliTeacher.query(api.users.listInstitutionStaff, { scope: "moli" }))
        .map((s) => s.username),
    ).toContain("teach");
  });

  test("adding the same (user, role, school) twice leaves ONE row", async () => {
    const t = convexTest(schema, modules);
    const { moli, kona } = await seedInstitutions(t);
    const admin = await seedUser(t, "platform_admin", "operator");
    const staffer = await seedUser(t, "staff", "ops", moli);
    const asAdmin = await withUser(t, admin);

    const first = await asAdmin.mutation(api.memberships.addMembership, {
      userId: staffer,
      role: "staff",
      institutionId: kona,
    });
    const second = await asAdmin.mutation(api.memberships.addMembership, {
      userId: staffer,
      role: "staff",
      institutionId: kona,
    });
    // `ensureMembership` dedupes on the triple, so the surface needs no
    // guard of its own — it returns the row that already exists.
    expect(second.membershipId).toEqual(first.membershipId);
    const rows = await asAdmin.query(api.memberships.listForUser, {
      userId: staffer,
    });
    expect(rows.filter((r) => r.institutionId === kona)).toHaveLength(1);
  });

  test("an institution-scoped role without a school is refused, readably", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const admin = await seedUser(t, "platform_admin", "operator");
    const designer = await seedUser(t, "curriculum_designer", "des");
    const asAdmin = await withUser(t, admin);

    await expect(
      asAdmin.mutation(api.memberships.addMembership, {
        userId: designer,
        role: "school_admin",
      }),
    ).rejects.toThrow('Role "school_admin" requires an institution');
    // The surface renders the thrown message inline, so it has to name the
    // problem rather than fail generically.
    await expect(
      asAdmin.mutation(api.memberships.addMembership, {
        userId: designer,
        role: "teacher",
        institutionId: moli,
      }),
    ).resolves.toBeDefined();
  });

  test("a SCOPED platform_admin row grants authority but no directory standing", async () => {
    // The trap: `platform_admin` looks like the "max permissions" choice, but
    // `listInstitutionStaff` deliberately excludes it, so the person would
    // have full authority while being invisible to — and un-DMable from — the
    // school. `school_admin` is the row that means "everything, at ONE
    // school". This is why the admin UI does not offer platform_admin.
    const t = convexTest(schema, modules);
    const { moli, kona } = await seedInstitutions(t);
    const admin = await seedUser(t, "platform_admin", "operator");
    const konaAdmin = await seedUser(t, "school_admin", "kai", kona);
    const asAdmin = await withUser(t, admin);
    const asKonaAdmin = await withUser(t, konaAdmin);

    await asAdmin.mutation(api.memberships.addMembership, {
      userId: admin,
      role: "platform_admin",
      institutionId: kona,
    });
    expect(
      (await asKonaAdmin.query(api.users.listInstitutionStaff, { scope: "kona" }))
        .map((s) => s.username),
    ).not.toContain("operator");

    await asAdmin.mutation(api.memberships.addMembership, {
      userId: admin,
      role: "school_admin",
      institutionId: kona,
    });
    expect(
      (await asKonaAdmin.query(api.users.listInstitutionStaff, { scope: "kona" }))
        .map((s) => s.username),
    ).toContain("operator");
    expect(moli).toBeDefined();
  });

  test("removeMembership revokes standing without touching the account", async () => {
    const t = convexTest(schema, modules);
    const { moli, kona } = await seedInstitutions(t);
    const admin = await seedUser(t, "platform_admin", "operator");
    const teacher = await seedUser(t, "teacher", "teach", moli);
    const asAdmin = await withUser(t, admin);

    const { membershipId } = await asAdmin.mutation(
      api.memberships.addMembership,
      { userId: teacher, role: "teacher", institutionId: kona },
    );
    await asAdmin.mutation(api.memberships.removeMembership, { membershipId });

    const rows = await asAdmin.query(api.memberships.listForUser, {
      userId: teacher,
    });
    expect(rows.map((r) => r.institutionId)).toEqual([moli]);
    // The user itself survives — revoking standing is not a deletion.
    const users = await asAdmin.query(api.users.listAllUsers, {});
    expect(users.map((u) => u.username)).toContain("teach");
  });

  test("only a platform admin may grant standing", async () => {
    const t = convexTest(schema, modules);
    const { moli, kona } = await seedInstitutions(t);
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    const teacher = await seedUser(t, "teacher", "teach", moli);
    const asHoku = await withUser(t, hoku);
    // A school_admin adds staff through `createInstitutionStaff` (which
    // stamps THEIR school); cross-school grants stay platform-only.
    await expect(
      asHoku.mutation(api.memberships.addMembership, {
        userId: teacher,
        role: "teacher",
        institutionId: kona,
      }),
    ).rejects.toThrow("Forbidden");
  });
});

describe("listAllUsers — the standing the admin row renders", () => {
  test("hydrates staff rows and excludes scholar / parent / platform_admin", async () => {
    const t = convexTest(schema, modules);
    const { moli, kona } = await seedInstitutions(t);
    const admin = await seedUser(t, "platform_admin", "operator");
    const teacher = await seedUser(t, "teacher", "teach", moli);
    const asAdmin = await withUser(t, admin);

    await asAdmin.mutation(api.memberships.addMembership, {
      userId: teacher,
      role: "staff",
      institutionId: kona,
    });
    // Two rows that must NOT be mistaken for school standing: the operator's
    // own scoped platform_admin row, and a learner context.
    await asAdmin.mutation(api.memberships.addMembership, {
      userId: admin,
      role: "platform_admin",
      institutionId: moli,
    });
    await asAdmin.mutation(api.memberships.addMembership, {
      userId: teacher,
      role: "scholar",
      institutionId: moli,
    });

    const users = await asAdmin.query(api.users.listAllUsers, {});
    const row = users.find((u) => u.username === "teach")!;
    expect(
      row.staffMemberships.map((m) => `${m.role}@${m.institutionName}`).sort(),
    ).toEqual(["staff@Kona Tutoring", "teacher@Moli School"]);
    // The learner context lives in its own column, not this one.
    expect(row.learnerInstitutionId).toEqual(moli);

    const operatorRow = users.find((u) => u.username === "operator")!;
    expect(operatorRow.staffMemberships).toEqual([]);
  });

  test("a staff-role account with no membership reports EMPTY standing", async () => {
    // The state behind TRA-349: `platform_admin` short-circuits every
    // capability resolver, so the operator had full authority while holding
    // standing at no school — and nothing surfaced it until a school-scoped
    // directory silently dropped them. An empty list is what the row renders
    // as "No school standing".
    const t = convexTest(schema, modules);
    const { kona } = await seedInstitutions(t);
    const admin = await seedUser(t, "platform_admin", "operator");
    // Standing at a NON-primary school only — authority everywhere, standing
    // nowhere that matters.
    await seedUser(t, "teacher", "stranded", kona);
    const asAdmin = await withUser(t, admin);

    const users = await asAdmin.query(api.users.listAllUsers, {});
    expect(users.find((u) => u.username === "operator")!.staffMemberships).toEqual(
      [],
    );
    expect(
      users
        .find((u) => u.username === "stranded")!
        .staffMemberships.map((m) => m.institutionName),
    ).toEqual(["Kona Tutoring"]);
  });

  test("a paused school is flagged on the chip, not hidden", async () => {
    const t = convexTest(schema, modules);
    const { moli, kona } = await seedInstitutions(t);
    const admin = await seedUser(t, "platform_admin", "operator");
    await seedUser(t, "teacher", "teach", kona);
    await t.run(async (ctx) => ctx.db.patch(kona, { disabledAt: Date.now() }));
    const asAdmin = await withUser(t, admin);

    const users = await asAdmin.query(api.users.listAllUsers, {});
    const row = users.find((u) => u.username === "teach")!;
    expect(row.staffMemberships).toHaveLength(1);
    expect(row.staffMemberships[0].institutionDisabled).toBe(true);
    expect(moli).toBeDefined();
  });

  // Standing is the MEMBERSHIP, never `users.role` —
  // `hasActiveStaffMembershipAtInstitution` says so explicitly. So the row
  // data has to carry a staff membership held by an account whose coarse
  // role is something else, or the surface would hide real access it cannot
  // then revoke. Caught in review; the cell now draws these rows for every
  // role and only withholds the ADD control.
  test("surfaces a staff membership held by a parent- or scholar-role account", async () => {
    const t = convexTest(schema, modules);
    const { moli, kona } = await seedInstitutions(t);
    const admin = await seedUser(t, "platform_admin", "operator");
    const parent = await seedUser(t, "parent", "guardian");
    const kid = await seedUser(t, "scholar", "kid", moli);
    const asAdmin = await withUser(t, admin);

    await asAdmin.mutation(api.memberships.addMembership, {
      userId: parent,
      role: "teacher",
      institutionId: kona,
    });
    await asAdmin.mutation(api.memberships.addMembership, {
      userId: kid,
      role: "staff",
      institutionId: kona,
    });

    const users = await asAdmin.query(api.users.listAllUsers, {});
    expect(
      users.find((u) => u.username === "guardian")!.staffMemberships.map(
        (m) => `${m.role}@${m.institutionName}`,
      ),
    ).toEqual(["teacher@Kona Tutoring"]);
    expect(
      users.find((u) => u.username === "kid")!.staffMemberships.map(
        (m) => `${m.role}@${m.institutionName}`,
      ),
    ).toEqual(["staff@Kona Tutoring"]);
  });

  // An UNSCOPED curriculum_designer row is deployment-wide standing
  // (`isGloballyPrivilegedMembership`) and standing at NO school. It has to
  // arrive with a null institution so the cell can label it "all schools"
  // and still fire the "No school standing" warning — otherwise the one row
  // that confers nothing locally would silence the one signal this feature
  // exists to raise.
  test("an unscoped curriculum_designer row carries a null institution", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const admin = await seedUser(t, "platform_admin", "operator");
    const designer = await seedUser(t, "curriculum_designer", "des");
    const asAdmin = await withUser(t, admin);

    await asAdmin.mutation(api.memberships.addMembership, {
      userId: designer,
      role: "curriculum_designer",
    });

    const rows = (await asAdmin.query(api.users.listAllUsers, {})).find(
      (u) => u.username === "des",
    )!.staffMemberships;
    expect(rows).toHaveLength(1);
    expect(rows[0].institutionId).toBeNull();
    expect(rows[0].institutionName).toBeNull();
    // …and it is genuinely standing at no school: nobody at Moli sees them.
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    const asHoku = await withUser(t, hoku);
    expect(
      (await asHoku.query(api.users.listInstitutionStaff, { scope: "moli" }))
        .map((u) => u.username),
    ).not.toContain("des");
  });

  test("a non-admin cannot read the directory at all", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    const asHoku = await withUser(t, hoku);
    await expect(asHoku.query(api.users.listAllUsers, {})).rejects.toThrow(
      "Forbidden",
    );
  });
});
