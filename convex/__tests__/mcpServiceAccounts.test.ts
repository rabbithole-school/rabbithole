import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { grantInstitutionMembership, seedTestInstitution } from "./institutionTestHelpers";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { sha256Hex } from "../lib/oauthCrypto";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// Why this file: an MCP service account is a hidden `users` row a school admin
// mints a bearer token for, so a shared surface (a Claude Tag channel) can act as
// ONE institution-scoped teacher/staff identity. These pin the security shape:
// the token is stored hashed and redeems to exactly that hidden user's one
// session, revocation is institution-bounded and immediate, a person can never
// be adopted as a service account, and the service user never shows up as a
// person.

type T = ReturnType<typeof convexTest>;

async function seedSchoolAdmin(t: T, username: string, institutionId?: Id<"institutions">) {
  const instId = institutionId ?? (await seedTestInstitution(t));
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { name: `Admin ${username}`, username, role: "school_admin", institutionId: instId }),
  );
  await grantInstitutionMembership(t, userId, instId, "school_admin");
  return { userId, institutionId: instId };
}

async function withUser(t: T, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1000,
    };
    return ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

async function tokenRows(t: T): Promise<Doc<"mcpServiceTokens">[]> {
  return t.run((ctx) => ctx.db.query("mcpServiceTokens").collect());
}

describe("mcpServiceAccounts", () => {
  test("issuing a teacher token creates a hidden service user + membership and stores only a hash", async () => {
    const t = convexTest(schema, modules);
    const { userId: admin, institutionId } = await seedSchoolAdmin(t, "leilani");
    const as = await withUser(t, admin);

    const issued = await as.mutation(api.mcpServiceAccounts.issueToken, { kind: "teacher" });
    expect(issued.token.startsWith("rhsa_teacher_")).toBe(true);
    expect(issued.tokenHint).toBe(issued.token.slice(-4));

    const rows = await tokenRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(await sha256Hex(issued.token));
    expect(rows[0].tokenHash).not.toContain(issued.token);
    expect(rows[0].institutionId).toBe(institutionId);

    const svc = await t.run((ctx) => ctx.db.get(rows[0].userId));
    expect(svc?.isSystem).toBe(true);
    expect(svc?.role).toBe("teacher");
    expect(svc?.institutionId).toBe(institutionId);
    expect(svc?.email).toBeUndefined();

    const memberships = await t.run((ctx) =>
      ctx.db.query("memberships").withIndex("by_user", (q) => q.eq("userId", rows[0].userId)).collect(),
    );
    expect(memberships.map((m) => [m.role, m.institutionId])).toEqual([["teacher", institutionId]]);
  });

  test("a staff service account gets the school:operations capability, otherwise base staff has no tools", async () => {
    const t = convexTest(schema, modules);
    const { userId: admin, institutionId } = await seedSchoolAdmin(t, "leilani");
    const as = await withUser(t, admin);
    await as.mutation(api.mcpServiceAccounts.issueToken, { kind: "staff" });
    const [row] = await tokenRows(t);

    const grants = await t.run((ctx) =>
      ctx.db
        .query("staffCapabilityGrants")
        .withIndex("by_grantee_capability", (q) =>
          q.eq("granteeUserId", row.userId).eq("capability", "school:operations"),
        )
        .collect(),
    );
    expect(grants.filter((g) => g.revokedAt === undefined).map((g) => g.institutionId)).toEqual([institutionId]);

    const asService = await withUser(t, row.userId);
    const me = await asService.query(api.mcp.whoami, {});
    expect(me.role).toBe("staff");
    expect(me.schoolOperations).toBe(true);
    expect(me.isServiceAccount).toBe(true);
  });

  test("redeemToken mints the token's one session, reuses it, and refuses wrong or revoked tokens", async () => {
    const t = convexTest(schema, modules);
    const { userId: admin } = await seedSchoolAdmin(t, "leilani");
    const as = await withUser(t, admin);
    const issued = await as.mutation(api.mcpServiceAccounts.issueToken, { kind: "teacher" });
    const [row] = await tokenRows(t);
    const tokenHash = await sha256Hex(issued.token);

    const first = await t.mutation(internal.mcpServiceAccounts.redeemToken, { tokenHash });
    expect(first?.userId).toBe(row.userId);
    const session = await t.run((ctx) => ctx.db.get(first!.sessionId));
    expect(session?.userId).toBe(row.userId);

    // A second exchange (another Next instance) reuses the same session row.
    const second = await t.mutation(internal.mcpServiceAccounts.redeemToken, { tokenHash });
    expect(second?.sessionId).toBe(first?.sessionId);
    const sessions = await t.run((ctx) =>
      ctx.db.query("authSessions").withIndex("userId", (q) => q.eq("userId", row.userId)).collect(),
    );
    expect(sessions).toHaveLength(1);
    expect((await t.run((ctx) => ctx.db.get(row._id)))?.lastUsedAt).toBeTypeOf("number");

    const wrong = await t.mutation(internal.mcpServiceAccounts.redeemToken, {
      tokenHash: await sha256Hex("rhsa_teacher_not-the-token"),
    });
    expect(wrong).toBeNull();

    await as.mutation(api.mcpServiceAccounts.revokeToken, { tokenId: row._id });
    expect(await t.mutation(internal.mcpServiceAccounts.redeemToken, { tokenHash })).toBeNull();
  });

  test("revoking deletes the token's session so the per-request probe 401s, and sweeps the user's sessions on the last token", async () => {
    const t = convexTest(schema, modules);
    const { userId: admin } = await seedSchoolAdmin(t, "leilani");
    const as = await withUser(t, admin);
    const issued = await as.mutation(api.mcpServiceAccounts.issueToken, { kind: "teacher" });
    const [row] = await tokenRows(t);
    const grant = await t.mutation(internal.mcpServiceAccounts.redeemToken, {
      tokenHash: await sha256Hex(issued.token),
    });

    // The exchanged session passes the route's probe before the revoke…
    const asSession = t.withIdentity({
      subject: `${row.userId}|${grant!.sessionId}`,
      issuer: "https://convex.dev",
    });
    expect((await asSession.query(api.mcp.whoami, { probeSession: true })).isServiceAccount).toBe(true);

    // A stray extra session for the same service user.
    const strayId = await t.run((ctx) =>
      ctx.db.insert("authSessions", { userId: row.userId, expirationTime: Date.now() + 3_600_000 }),
    );

    await as.mutation(api.mcpServiceAccounts.revokeToken, { tokenId: row._id });
    expect(await t.run((ctx) => ctx.db.get(grant!.sessionId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(strayId))).toBeNull();
    // …and fails it afterwards, even though the JWT itself is still valid.
    await expect(asSession.query(api.mcp.whoami, { probeSession: true })).rejects.toThrow(/Session revoked/);
  });

  test("a school admin cannot revoke another institution's token", async () => {
    const t = convexTest(schema, modules);
    const a = await seedSchoolAdmin(t, "admin-a");
    const otherSchool = await seedTestInstitution(t, { name: "Other School", slug: "other-school" });
    const b = await seedSchoolAdmin(t, "admin-b", otherSchool);
    expect(a.institutionId).not.toBe(b.institutionId);
    const asA = await withUser(t, a.userId);
    const asB = await withUser(t, b.userId);

    await asA.mutation(api.mcpServiceAccounts.issueToken, { kind: "teacher" });
    const [row] = await tokenRows(t);
    expect(row.institutionId).toBe(a.institutionId);

    await expect(asB.mutation(api.mcpServiceAccounts.revokeToken, { tokenId: row._id })).rejects.toThrow();
    expect((await t.run((ctx) => ctx.db.get(row._id)))?.revokedAt).toBeUndefined();

    const listB = await asB.query(api.mcpServiceAccounts.list, {});
    expect(listB.every((k) => k.activeTokens.length === 0)).toBe(true);
  });

  test("a token whose service user was moved to another institution no longer redeems", async () => {
    const t = convexTest(schema, modules);
    const { userId: admin } = await seedSchoolAdmin(t, "leilani");
    const otherSchool = await seedTestInstitution(t, { name: "Other School", slug: "other-school" });
    const as = await withUser(t, admin);
    const issued = await as.mutation(api.mcpServiceAccounts.issueToken, { kind: "teacher" });
    const [row] = await tokenRows(t);
    await t.run((ctx) => ctx.db.patch(row.userId, { institutionId: otherSchool }));
    expect(
      await t.mutation(internal.mcpServiceAccounts.redeemToken, { tokenHash: await sha256Hex(issued.token) }),
    ).toBeNull();
  });

  test("issuing refuses to adopt a person who happens to hold the service username", async () => {
    const t = convexTest(schema, modules);
    const { userId: admin, institutionId } = await seedSchoolAdmin(t, "leilani");
    const institution = await t.run((ctx) => ctx.db.get(institutionId));
    const humanId = await t.run((ctx) =>
      ctx.db.insert("users", { name: "A Person", username: `svc-${institution!.slug}-teacher`, role: "teacher" }),
    );
    const as = await withUser(t, admin);
    await expect(as.mutation(api.mcpServiceAccounts.issueToken, { kind: "teacher" })).rejects.toThrow(
      /belongs to a person/,
    );
    const human = await t.run((ctx) => ctx.db.get(humanId));
    expect(human?.isSystem).toBeUndefined();
    expect(await tokenRows(t)).toHaveLength(0);
  });

  test("the service user is hidden from the staff directory, Slack DM targets, parent recipients, and dev login", async () => {
    const t = convexTest(schema, modules);
    const { userId: admin, institutionId } = await seedSchoolAdmin(t, "leilani");
    const as = await withUser(t, admin);
    await as.mutation(api.mcpServiceAccounts.issueToken, { kind: "teacher" });
    const [row] = await tokenRows(t);

    const staff = await as.query(api.users.listInstitutionStaff, {});
    expect(staff.map((s) => s.id)).toContain(admin);
    expect(staff.map((s) => s.id)).not.toContain(row.userId);

    const dmTargets = await t.query(internal.users.listStaffForSlackDmInternal, {
      callerUserId: admin,
    });
    expect(dmTargets.map((u) => u.id)).not.toContain(row.userId);

    // A parent picking a teacher to message never sees the service account.
    const { scholarId, parentId } = await t.run(async (ctx) => {
      const scholarId = await ctx.db.insert("users", {
        name: "Kai",
        username: "kai_test",
        role: "scholar",
        institutionId,
      });
      const parentId = await ctx.db.insert("users", { name: "Pua", username: "pua_test", role: "parent" });
      await ctx.db.insert("guardianships", { parentUserId: parentId, scholarUserId: scholarId, createdBy: admin });
      return { scholarId, parentId };
    });
    const teacherId = await t.run((ctx) =>
      ctx.db.insert("users", { name: "Lehua", username: "lehua_test", role: "teacher", institutionId }),
    );
    await grantInstitutionMembership(t, teacherId, institutionId, "teacher");
    const asParent = await withUser(t, parentId);
    const recipients = await asParent.query(api.parentMessages.listParentRecipientTeachers, { scholarId });
    expect(recipients.map((r) => r._id)).toContain(teacherId);
    expect(recipients.map((r) => r._id)).not.toContain(row.userId);
  });

  test("issuing twice reuses one service user; both tokens stay redeemable and listed", async () => {
    const t = convexTest(schema, modules);
    const { userId: admin } = await seedSchoolAdmin(t, "leilani");
    const as = await withUser(t, admin);
    const first = await as.mutation(api.mcpServiceAccounts.issueToken, { kind: "teacher" });
    const second = await as.mutation(api.mcpServiceAccounts.issueToken, { kind: "teacher" });
    expect(first.token).not.toBe(second.token);

    const rows = await tokenRows(t);
    expect(new Set(rows.map((r) => r.userId)).size).toBe(1);
    const systemTeachers = await t.run(async (ctx) =>
      (await ctx.db.query("users").collect()).filter((u) => u.isSystem && u.role === "teacher"),
    );
    expect(systemTeachers).toHaveLength(1);

    const list = await as.query(api.mcpServiceAccounts.list, {});
    expect(list.find((k) => k.kind === "teacher")?.activeTokens).toHaveLength(2);
    expect(list.find((k) => k.kind === "staff")?.activeTokens).toHaveLength(0);
  });
});
