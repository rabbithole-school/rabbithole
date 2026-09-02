import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { grantInstitutionMembership, seedTestInstitution } from "./institutionTestHelpers";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// Why this file: the old single `admin` split into platform_admin (global
// Rabbithole operator) + school_admin (institution leader). The split's whole
// point is a guardrail — a school_admin gets teacher/scholar-admin/curriculum
// power but NONE of the platform footguns (user/role admin, delete user,
// membership grants, cross-institution moves). These tests pin both halves so a
// gate regression can't silently hand a school admin platform power, or lock a
// platform admin out of one.

type Role =
  | "scholar"
  | "teacher"
  | "platform_admin"
  | "school_admin"
  | "curriculum_designer";

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: Role,
  username: string,
) {
  const institutionId = await seedTestInstitution(t);
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: `Test ${username}`, username, role }),
  );

  await t.run((ctx) => ctx.db.patch(userId, { institutionId }));
  if (role === "teacher" || role === "school_admin") await grantInstitutionMembership(t, userId, institutionId, role);
  return userId;
}

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
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

// ── platform_admin keeps all the platform powers ──────────────────────

describe("platform_admin — allowed: platform powers", () => {
  test("can change user roles", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "admin");
    const kai = await seedUser(t, "scholar", "kai");
    const asAdmin = await withUser(t, admin);
    await asAdmin.mutation(api.users.updateRole, { userId: kai, role: "teacher" });
    const updated = await t.run(async (ctx) => ctx.db.get(kai));
    expect(updated?.role).toBe("teacher");
  });

  test("can delete users", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "admin");
    const kai = await seedUser(t, "scholar", "kai");
    const asAdmin = await withUser(t, admin);
    await asAdmin.mutation(api.users.deleteUser, { userId: kai });
    const gone = await t.run(async (ctx) => ctx.db.get(kai));
    expect(gone).toBeNull();
  });

  test("can grant memberships", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "admin");
    const kai = await seedUser(t, "scholar", "kai");
    const asAdmin = await withUser(t, admin);
    const { membershipId } = await asAdmin.mutation(api.memberships.addMembership, {
      userId: kai,
      role: "parent",
    });
    expect(membershipId).toBeDefined();
  });
});


// ── school_admin has teacher / scholar-admin / curriculum power ────────

describe("school_admin — allowed: teacher + scholar-admin + curriculum", () => {
  test("can create a scholar (scholar-admin)", async () => {
    const t = convexTest(schema, modules);
    const hoku = await seedUser(t, "school_admin", "hoku");
    const asHoku = await withUser(t, hoku);
    const { userId } = await asHoku.mutation(api.users.createScholar, {
      name: "New Kid",
    });
    const created = await t.run(async (ctx) => ctx.db.get(userId));
    expect(created?.role).toBe("scholar");
  });

  test("can read sensitive scholar documents (teacher power, unlike operations staff)", async () => {
    const t = convexTest(schema, modules);
    const hoku = await seedUser(t, "school_admin", "hoku");
    const kai = await seedUser(t, "scholar", "kai");
    const asHoku = await withUser(t, hoku);
    // Should NOT throw (operations staff — base `staff` + `school:operations`,
    // the retired registrar role's successor — IS denied this elsewhere).
    const docs = await asHoku.query(api.scholarDocuments.listForScholar, {
      scholarId: kai,
    });
    expect(Array.isArray(docs)).toBe(true);
  });

  test("can create curriculum (a persona)", async () => {
    const t = convexTest(schema, modules);
    const hoku = await seedUser(t, "school_admin", "hoku");
    const asHoku = await withUser(t, hoku);
    const id = await asHoku.mutation(api.personas.create, {
      title: "X",
      emoji: "🤖",
    });
    expect(id).toBeDefined();
  });
});

// ── school_admin is denied EVERY platform footgun ─────────────────────

describe("school_admin — denied: platform powers", () => {
  test("CANNOT change user roles", async () => {
    const t = convexTest(schema, modules);
    const hoku = await seedUser(t, "school_admin", "hoku");
    const kai = await seedUser(t, "scholar", "kai");
    const asHoku = await withUser(t, hoku);
    await expect(
      asHoku.mutation(api.users.updateRole, { userId: kai, role: "teacher" }),
    ).rejects.toThrow("Forbidden");
  });

  test("CANNOT delete users", async () => {
    const t = convexTest(schema, modules);
    const hoku = await seedUser(t, "school_admin", "hoku");
    const kai = await seedUser(t, "scholar", "kai");
    const asHoku = await withUser(t, hoku);
    await expect(
      asHoku.mutation(api.users.deleteUser, { userId: kai }),
    ).rejects.toThrow("Forbidden");
  });

  test("CANNOT grant memberships (no granting platform_admin)", async () => {
    const t = convexTest(schema, modules);
    const hoku = await seedUser(t, "school_admin", "hoku");
    const kai = await seedUser(t, "scholar", "kai");
    const asHoku = await withUser(t, hoku);
    await expect(
      asHoku.mutation(api.memberships.addMembership, {
        userId: kai,
        role: "platform_admin",
      }),
    ).rejects.toThrow("Forbidden");
  });

  test("CANNOT move a scholar across institutions", async () => {
    const t = convexTest(schema, modules);
    const { guests } = await t.mutation(internal.institutions.ensureDefaults, {});
    const hoku = await seedUser(t, "school_admin", "hoku");
    const kai = await seedUser(t, "scholar", "kai");
    const asHoku = await withUser(t, hoku);
    await expect(
      asHoku.mutation(api.institutions.setScholarInstitution, {
        scholarId: kai,
        institutionId: guests,
      }),
    ).rejects.toThrow("Forbidden");
  });

  test("CANNOT create a new account (adminCreateUser)", async () => {
    const t = convexTest(schema, modules);
    const hoku = await seedUser(t, "school_admin", "hoku");
    const asHoku = await withUser(t, hoku);
    await expect(
      asHoku.mutation(api.users.adminCreateUser, {
        username: "newstaff",
        role: "teacher",
      }),
    ).rejects.toThrow("Forbidden");
  });
});
