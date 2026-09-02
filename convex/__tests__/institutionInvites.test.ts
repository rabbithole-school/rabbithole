import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import {
  assertNotPendingEnrollment,
  assertScholarAdoptionAuthorized,
  resolveMagicLinkUser,
} from "../lib/authGuards";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// The institution invite-code system is a TRUST BOUNDARY: a platform admin
// mints a link that lets an outside partner create their OWN institution and
// become its school_admin (never platform admin, no global grant); a school
// admin mints join links for THEIR OWN institution only. Redemption runs inside
// users.registerWithCode, which is DB-invite-only (the legacy env signup codes
// were removed) and closed-by-default. These tests pin the whole boundary.

type Role =
  | "scholar"
  | "teacher"
  | "platform_admin"
  | "school_admin"
  | "curriculum_designer"
  | "parent";

async function seedInstitutions(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => ({
    moli: await ctx.db.insert("institutions", {
      name: "Moli School",
      slug: "moli",
      kind: "school" as const,
      isPrimary: true,
    }),
    kona: await ctx.db.insert("institutions", {
      name: "Kona Tutoring",
      slug: "kona",
      kind: "school" as const,
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

const users = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => ctx.db.query("users").collect());
const institutions = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => ctx.db.query("institutions").collect());
const memberships = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => ctx.db.query("memberships").collect());

// ── Minting: authorization boundary ─────────────────────────────────────

describe("minting invites — authorization", () => {
  test("platform_admin mints a create_institution invite; others cannot", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const admin = await seedUser(t, "platform_admin", "avery");
    const schoolAdmin = await seedUser(t, "school_admin", "hoku", moli);

    const res = await (await withUser(t, admin)).mutation(
      api.institutionInvites.mintCreateInstitutionInvite,
      { label: "James Wong — Prism Academy" },
    );
    expect(res.code).toBeTruthy();
    expect(res.path).toContain("/join?code=");
    expect(res.url).toContain("/join?code=");

    // A school_admin is NOT a platform admin → cannot mint create invites.
    await expect(
      (await withUser(t, schoolAdmin)).mutation(
        api.institutionInvites.mintCreateInstitutionInvite,
        {},
      ),
    ).rejects.toThrow(/forbidden/i);
  });

  test("school_admin mints a join invite stamped to THEIR OWN institution", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    const res = await (await withUser(t, hoku)).mutation(
      api.institutionInvites.mintJoinInvite,
      { role: "teacher" },
    );
    const row = await t.run(async (ctx) => ctx.db.get(res.inviteId));
    expect(row?.kind).toBe("join_institution");
    expect(row?.institutionId).toBe(moli);
    expect(row?.role).toBe("teacher");
  });

  test("school_admin CANNOT mint a join invite for another institution (target is their own)", async () => {
    const t = convexTest(schema, modules);
    const { moli, kona } = await seedInstitutions(t);
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    // Even asking with ?scope=kona, the resolver only honors an institution the
    // caller is a member of → falls back to their home (moli).
    const res = await (await withUser(t, hoku)).mutation(
      api.institutionInvites.mintJoinInvite,
      { role: "scholar", scope: "kona" },
    );
    const row = await t.run(async (ctx) => ctx.db.get(res.inviteId));
    expect(row?.institutionId).toBe(moli);
    expect(row?.institutionId).not.toBe(kona);
  });

  test("school_admin CANNOT mint a school_admin join (validator rejects the role)", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    await expect(
      (await withUser(t, hoku)).mutation(api.institutionInvites.mintJoinInvite, {
        // @ts-expect-error — school_admin is not an allowed self-mint role
        role: "school_admin",
      }),
    ).rejects.toThrow();
  });

  test("only a platform_admin may mint a school_admin join (for any institution)", async () => {
    const t = convexTest(schema, modules);
    const { kona } = await seedInstitutions(t);
    const admin = await seedUser(t, "platform_admin", "avery");
    const res = await (await withUser(t, admin)).mutation(
      api.institutionInvites.mintJoinInviteForInstitution,
      { institutionId: kona, role: "school_admin" },
    );
    const row = await t.run(async (ctx) => ctx.db.get(res.inviteId));
    expect(row?.role).toBe("school_admin");
    expect(row?.institutionId).toBe(kona);
  });

  test("a plain teacher cannot mint any invite", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const teacher = await seedUser(t, "teacher", "tim", moli);
    await expect(
      (await withUser(t, teacher)).mutation(api.institutionInvites.mintJoinInvite, {
        role: "scholar",
      }),
    ).rejects.toThrow(/forbidden/i);
  });
});

// ── Redemption: create_institution ──────────────────────────────────────

describe("redeeming a create_institution invite", () => {
  test("creates the institution + a school_admin membership atomically, grants no platform role", async () => {
    const t = convexTest(schema, modules);
    await seedInstitutions(t);
    const admin = await seedUser(t, "platform_admin", "avery");
    const asAdmin = await withUser(t, admin);
    const { inviteId, code } = await asAdmin.mutation(
      api.institutionInvites.mintCreateInstitutionInvite,
      { label: "Prism" },
    );

    const outcome = await t.mutation(api.users.registerWithCode, {
      username: "chris",
      code,
      name: "James Wong",
      email: "chris@school.edu",
      institutionName: "Prism Academy",
      timeZone: "America/New_York",
    });
    expect(outcome).toMatchObject({ kind: "enroll", username: "chris" });

    // New institution exists, NOT primary, with the chosen name + timezone.
    const allInst = await institutions(t);
    const prism = allInst.find((i) => i.name === "Prism Academy");
    expect(prism).toBeTruthy();
    expect(prism?.isPrimary).toBe(false);
    expect(prism?.timeZone).toBe("America/New_York");
    expect(prism?.kind).toBe("school");

    // The new user is a school_admin — and holds NO platform_admin role/membership.
    const chris = (await users(t)).find((u) => u.username === "chris");
    expect(chris?.role).toBe("school_admin");
    const mems = (await memberships(t)).filter((m) => m.userId === chris?._id);
    expect(mems).toHaveLength(1);
    expect(mems[0].role).toBe("school_admin");
    expect(mems[0].institutionId).toBe(prism?._id);
    expect(mems[0].inviteId).toBeTruthy(); // stamped with provenance
    const anyGlobal = (await memberships(t)).some(
      (m) => m.userId === chris?._id && m.role === "platform_admin",
    );
    expect(anyGlobal).toBe(false);

    // The invite records what this create-school redemption produced.
    const inv = await t.run(async (ctx) => ctx.db.get(inviteId));
    expect(inv).toMatchObject({
      usedCount: 1,
      createdInstitutionId: prism?._id,
      redeemedBy: chris?._id,
      redeemedAt: expect.any(Number),
    });

    // The admin list hydrates the created school back onto the invite row.
    const listed = (await asAdmin.query(api.institutionInvites.listInvites, {})).find(
      (row) => row._id === inviteId,
    );
    expect(listed).toMatchObject({
      institutionId: null,
      createdInstitutionId: prism?._id,
      institutionName: "Prism Academy",
      redeemedBy: chris?._id,
      redeemedAt: expect.any(Number),
    });
  });

  test("a unique slug is derived when the name collides", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) =>
      ctx.db.insert("institutions", {
        name: "Prism Academy",
        slug: "prism-academy",
        kind: "school",
      }),
    );
    const admin = await seedUser(t, "platform_admin", "avery");
    const { code } = await (await withUser(t, admin)).mutation(
      api.institutionInvites.mintCreateInstitutionInvite,
      {},
    );
    await t.mutation(api.users.registerWithCode, {
      username: "chris",
      code,
      email: "chris@school.edu",
      institutionName: "Prism Academy",
    });
    const slugs = (await institutions(t)).map((i) => i.slug);
    expect(slugs).toContain("prism-academy");
    expect(slugs).toContain("prism-academy-2");
  });

  test("create_institution requires an institution name", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "avery");
    const { code } = await (await withUser(t, admin)).mutation(
      api.institutionInvites.mintCreateInstitutionInvite,
      {},
    );
    await expect(
      t.mutation(api.users.registerWithCode, { username: "chris", code }),
    ).rejects.toThrow(/institution name is required/i);
  });

  test("create_institution requires a valid email (server-side)", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "avery");
    const { code } = await (await withUser(t, admin)).mutation(
      api.institutionInvites.mintCreateInstitutionInvite,
      {},
    );
    // Missing email → rejected. The school leader is passkey-primary, so their
    // email is the only magic-link recovery path; an API caller must not skip it.
    await expect(
      t.mutation(api.users.registerWithCode, {
        username: "chris",
        code,
        institutionName: "Prism Academy",
      }),
    ).rejects.toThrow(/email is required/i);
    // A malformed email → also rejected (structural validation).
    await expect(
      t.mutation(api.users.registerWithCode, {
        username: "chris",
        code,
        email: "not-an-email",
        institutionName: "Prism Academy",
      }),
    ).rejects.toThrow(/invalid email/i);
    // No account was created by either failed attempt.
    expect((await users(t)).some((u) => u.username === "chris")).toBe(false);

    // A valid email succeeds.
    const outcome = await t.mutation(api.users.registerWithCode, {
      username: "chris",
      code,
      email: "chris@school.edu",
      institutionName: "Prism Academy",
    });
    expect(outcome).toMatchObject({ kind: "enroll", username: "chris" });
    const chris = (await users(t)).find((u) => u.username === "chris");
    expect(chris?.email).toBe("chris@school.edu");
  });
});

// ── Redemption: join_institution ────────────────────────────────────────

describe("redeeming a join_institution invite", () => {
  test("a scholar join lands the user at the right institution + role, with password outcome", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    const asHoku = await withUser(t, hoku);
    const { inviteId, code } = await asHoku.mutation(
      api.institutionInvites.mintJoinInvite,
      { role: "scholar" },
    );

    const outcome = await t.mutation(api.users.registerWithCode, {
      username: "newkid",
      code,
    });
    expect(outcome).toMatchObject({ kind: "password", username: "newkid" });

    const kid = (await users(t)).find((u) => u.username === "newkid");
    if (!kid) throw new Error("Expected invite-created scholar");
    const kidId = kid._id as Id<"users">;
    expect(kid?.role).toBe("scholar");
    expect(kid?.institutionId).toBe(moli); // scholars carry institutionId
    expect(kid.passwordBindAllowedUntil).toBeGreaterThan(Date.now());
    await t.run(async (ctx) => {
      const inviteCreatedScholar = await ctx.db.get(kidId);
      if (!inviteCreatedScholar) throw new Error("Expected invite-created scholar");
      await assertScholarAdoptionAuthorized(ctx, inviteCreatedScholar);
    });
    expect(
      (await t.run(async (ctx) => ctx.db.get(kidId)))
        ?.passwordBindAllowedUntil,
    ).toBeUndefined();
    const mem = (await memberships(t)).find((m) => m.userId === kid?._id);
    expect(mem?.role).toBe("scholar");
    expect(mem?.institutionId).toBe(moli);
    expect(mem?.inviteId).toBeTruthy();

    // Reusable join invites retain membership provenance without the singular
    // create-school outcome fields.
    const invite = await t.run(async (ctx) => ctx.db.get(inviteId));
    expect(invite?.createdInstitutionId).toBeUndefined();
    expect(invite?.redeemedBy).toBeUndefined();
    expect(invite?.redeemedAt).toBeUndefined();
    const listed = await asHoku.query(
      api.institutionInvites.listJoinInvites,
      {},
    );
    expect(listed[0]).toMatchObject({
      institutionId: moli,
      createdInstitutionId: null,
      institutionName: "Moli School",
      redeemedBy: null,
      redeemedAt: null,
    });
  });

  test("a teacher join creates a passwordless staff account (enroll outcome)", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    const { code } = await (await withUser(t, hoku)).mutation(
      api.institutionInvites.mintJoinInvite,
      { role: "teacher" },
    );
    const outcome = await t.mutation(api.users.registerWithCode, {
      username: "newteacher",
      code,
      email: "new@school.edu",
    });
    expect(outcome).toMatchObject({ kind: "enroll" });
    if (outcome && outcome.kind === "enroll") {
      expect(outcome.path).toContain("/enroll?token=");
    }
    const tch = (await users(t)).find((u) => u.username === "newteacher");
    expect(tch?.role).toBe("teacher");
    const mem = (await memberships(t)).find((m) => m.userId === tch?._id);
    expect(mem?.institutionId).toBe(moli);
  });

  test("a duplicate username is rejected", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    await seedUser(t, "scholar", "taken", moli);
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    const { code } = await (await withUser(t, hoku)).mutation(
      api.institutionInvites.mintJoinInvite,
      { role: "scholar" },
    );
    await expect(
      t.mutation(api.users.registerWithCode, { username: "taken", code }),
    ).rejects.toThrow(/already taken/i);
  });
});

// ── Redemption: expired / revoked / exhausted are rejected ──────────────

describe("invalid invites are rejected at redemption", () => {
  async function mintCreate(t: ReturnType<typeof convexTest>) {
    const admin = await seedUser(t, "platform_admin", "avery");
    return await (await withUser(t, admin)).mutation(
      api.institutionInvites.mintCreateInstitutionInvite,
      {},
    );
  }

  test("expired code is rejected", async () => {
    const t = convexTest(schema, modules);
    const { inviteId, code } = await mintCreate(t);
    await t.run(async (ctx) =>
      ctx.db.patch(inviteId, { expiresAt: Date.now() - 1000 }),
    );
    await expect(
      t.mutation(api.users.registerWithCode, {
        username: "x",
        code,
        institutionName: "X",
      }),
    ).rejects.toThrow(/expired/i);
  });

  test("revoked code is rejected", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "avery");
    const asAdmin = await withUser(t, admin);
    const { inviteId, code } = await asAdmin.mutation(
      api.institutionInvites.mintCreateInstitutionInvite,
      {},
    );
    await asAdmin.mutation(api.institutionInvites.revokeInvite, { inviteId });
    await expect(
      t.mutation(api.users.registerWithCode, {
        username: "x",
        code,
        institutionName: "X",
      }),
    ).rejects.toThrow(/revoked/i);
  });

  test("exhausted (maxUses reached) code is rejected", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "avery");
    const { code } = await (await withUser(t, admin)).mutation(
      api.institutionInvites.mintCreateInstitutionInvite,
      { maxUses: 1 },
    );
    // First redemption succeeds.
    await t.mutation(api.users.registerWithCode, {
      username: "first",
      code,
      email: "first@school.edu",
      institutionName: "First School",
    });
    // Second is rejected — maxUses reached.
    await expect(
      t.mutation(api.users.registerWithCode, {
        username: "second",
        code,
        institutionName: "Second School",
      }),
    ).rejects.toThrow(/used up/i);
  });

  test("inviteInfo returns null for a revoked code, a shape for a live one", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    const asHoku = await withUser(t, hoku);
    const { inviteId, code } = await asHoku.mutation(
      api.institutionInvites.mintJoinInvite,
      { role: "scholar" },
    );
    const live = await t.query(api.institutionInvites.inviteInfo, { code });
    expect(live).toMatchObject({
      kind: "join_institution",
      role: "scholar",
      institutionName: "Moli School",
      ceremony: "password",
    });
    await asHoku.mutation(api.institutionInvites.revokeJoinInvite, { inviteId });
    expect(
      await t.query(api.institutionInvites.inviteInfo, { code }),
    ).toBeNull();
    expect(
      await t.query(api.institutionInvites.inviteInfo, { code: "bogus" }),
    ).toBeNull();
  });
});

// ── School-admin revoke scoping ─────────────────────────────────────────

describe("revokeJoinInvite — school_admin scope", () => {
  test("a school_admin CANNOT revoke a join invite for another institution", async () => {
    const t = convexTest(schema, modules);
    const { moli, kona } = await seedInstitutions(t);
    const admin = await seedUser(t, "platform_admin", "avery");
    // Platform admin mints a join invite for kona.
    const { inviteId } = await (await withUser(t, admin)).mutation(
      api.institutionInvites.mintJoinInviteForInstitution,
      { institutionId: kona, role: "teacher" },
    );
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    await expect(
      (await withUser(t, hoku)).mutation(api.institutionInvites.revokeJoinInvite, {
        inviteId,
      }),
    ).rejects.toThrow(/not found/i);
    // Still live.
    const row = await t.run(async (ctx) => ctx.db.get(inviteId));
    expect(row?.revokedAt).toBeUndefined();
  });

  test("a school_admin CAN revoke a join invite for their own institution", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    const asHoku = await withUser(t, hoku);
    const { inviteId } = await asHoku.mutation(
      api.institutionInvites.mintJoinInvite,
      { role: "teacher" },
    );
    await asHoku.mutation(api.institutionInvites.revokeJoinInvite, { inviteId });
    const row = await t.run(async (ctx) => ctx.db.get(inviteId));
    expect(row?.revokedAt).toBeTruthy();
  });
});

// ── Delete: terminal-only cleanup + school scope ─────────────────────────

describe("deleting invites", () => {
  test("a redeemable invite is refused and remains available", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "avery");
    const asAdmin = await withUser(t, admin);
    const { inviteId } = await asAdmin.mutation(
      api.institutionInvites.mintCreateInstitutionInvite,
      {},
    );

    await expect(
      asAdmin.mutation(api.institutionInvites.deleteInvite, { inviteId }),
    ).rejects.toThrow(/live invites must be revoked/i);
    expect(await t.run(async (ctx) => ctx.db.get(inviteId))).not.toBeNull();
  });

  test("an exhausted invite deletes without touching users, memberships, or institutions", async () => {
    const t = convexTest(schema, modules);
    await seedInstitutions(t);
    const admin = await seedUser(t, "platform_admin", "avery");
    const asAdmin = await withUser(t, admin);
    const { inviteId, code } = await asAdmin.mutation(
      api.institutionInvites.mintCreateInstitutionInvite,
      { maxUses: 1 },
    );
    await t.mutation(api.users.registerWithCode, {
      username: "hoku_partner",
      code,
      name: "Hoku Partner",
      email: "hoku@example.com",
      institutionName: "Waimea Learning Lab",
    });

    const before = {
      users: await users(t),
      memberships: await memberships(t),
      institutions: await institutions(t),
    };
    const createdUser = before.users.find((user) => user.username === "hoku_partner");
    const createdInstitution = before.institutions.find(
      (institution) => institution.name === "Waimea Learning Lab",
    );
    const createdMembership = before.memberships.find(
      (membership) => membership.userId === createdUser?._id,
    );
    expect(createdMembership?.inviteId).toBe(inviteId);

    await asAdmin.mutation(api.institutionInvites.deleteInvite, { inviteId });

    expect(await t.run(async (ctx) => ctx.db.get(inviteId))).toBeNull();
    expect(await users(t)).toHaveLength(before.users.length);
    expect(await memberships(t)).toHaveLength(before.memberships.length);
    expect(await institutions(t)).toHaveLength(before.institutions.length);
    expect(
      await t.run(async (ctx) =>
        createdUser ? ctx.db.get(createdUser._id) : null,
      ),
    ).not.toBeNull();
    expect(
      await t.run(async (ctx) =>
        createdMembership ? ctx.db.get(createdMembership._id) : null,
      ),
    ).toMatchObject({ inviteId });
    expect(
      await t.run(async (ctx) =>
        createdInstitution ? ctx.db.get(createdInstitution._id) : null,
      ),
    ).not.toBeNull();
  });

  test("expired and revoked invites delete, and deleting again is idempotent", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "avery");
    const asAdmin = await withUser(t, admin);
    const expired = await asAdmin.mutation(
      api.institutionInvites.mintCreateInstitutionInvite,
      {},
    );
    const revoked = await asAdmin.mutation(
      api.institutionInvites.mintCreateInstitutionInvite,
      {},
    );
    await t.run(async (ctx) =>
      ctx.db.patch(expired.inviteId, { expiresAt: Date.now() - 1000 }),
    );
    await asAdmin.mutation(api.institutionInvites.revokeInvite, {
      inviteId: revoked.inviteId,
    });

    await asAdmin.mutation(api.institutionInvites.deleteInvite, {
      inviteId: expired.inviteId,
    });
    await asAdmin.mutation(api.institutionInvites.deleteInvite, {
      inviteId: revoked.inviteId,
    });
    await asAdmin.mutation(api.institutionInvites.deleteInvite, {
      inviteId: revoked.inviteId,
    });

    expect(await t.run(async (ctx) => ctx.db.get(expired.inviteId))).toBeNull();
    expect(await t.run(async (ctx) => ctx.db.get(revoked.inviteId))).toBeNull();
  });

  test("a school admin cannot delete another institution's invite", async () => {
    const t = convexTest(schema, modules);
    const { moli, kona } = await seedInstitutions(t);
    const admin = await seedUser(t, "platform_admin", "avery");
    const asAdmin = await withUser(t, admin);
    const { inviteId } = await asAdmin.mutation(
      api.institutionInvites.mintJoinInviteForInstitution,
      { institutionId: kona, role: "teacher" },
    );
    await asAdmin.mutation(api.institutionInvites.revokeInvite, { inviteId });
    const hoku = await seedUser(t, "school_admin", "hoku", moli);

    await expect(
      (await withUser(t, hoku)).mutation(
        api.institutionInvites.deleteJoinInvite,
        { inviteId },
      ),
    ).rejects.toThrow(/not found/i);
    expect(await t.run(async (ctx) => ctx.db.get(inviteId))).not.toBeNull();
  });

  test("a school admin can delete their own revoked join invite", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    const asHoku = await withUser(t, hoku);
    const { inviteId } = await asHoku.mutation(
      api.institutionInvites.mintJoinInvite,
      { role: "teacher" },
    );
    await asHoku.mutation(api.institutionInvites.revokeJoinInvite, { inviteId });

    await asHoku.mutation(api.institutionInvites.deleteJoinInvite, { inviteId });

    expect(await t.run(async (ctx) => ctx.db.get(inviteId))).toBeNull();
  });
});

// ── Unconditional invite-only signup (no public bootstrap) ──────────────

describe("registerWithCode — always requires a valid invite", () => {
  test("EMPTY deployment + bogus code → rejected (NO public bootstrap)", async () => {
    const t = convexTest(schema, modules);
    // An empty users table is NOT a bootstrap path anymore — a prod restore
    // transiently empties it, and a public bootstrap there would mint an
    // anonymous admin. registerWithCode must reject regardless of population.
    await expect(
      t.mutation(api.users.registerWithCode, { username: "kai", code: "whatever" }),
    ).rejects.toThrow(/invalid invite code/i);
    expect(await users(t)).toHaveLength(0);
  });

  test("EMPTY deployment + empty code → rejected", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.users.registerWithCode, { username: "kai", code: "" }),
    ).rejects.toThrow(/invalid invite code/i);
    expect(await users(t)).toHaveLength(0);
  });

  test("POPULATED deployment + bogus code → rejected", async () => {
    const t = convexTest(schema, modules);
    await seedUser(t, "scholar", "someone");
    await expect(
      t.mutation(api.users.registerWithCode, { username: "x", code: "bogus" }),
    ).rejects.toThrow(/invalid invite code/i);
  });

  test("bogus code STILL rejected after the only invite is exhausted", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "avery");
    const { code } = await (await withUser(t, admin)).mutation(
      api.institutionInvites.mintCreateInstitutionInvite,
      { maxUses: 1 },
    );
    await t.mutation(api.users.registerWithCode, {
      username: "first",
      code,
      email: "first@school.edu",
      institutionName: "First School",
    });
    await expect(
      t.mutation(api.users.registerWithCode, { username: "sneaky", code: "bogus" }),
    ).rejects.toThrow(/invalid invite code/i);
  });
});

// ── bootstrapFirstPlatformAdmin — the admin-key-gated bootstrap ──────────
// Public signup can never mint an admin (see above). The first platform admin
// is created out-of-band via this internalMutation (npx convex run, which
// requires deployment admin credentials). Its invariant — refuse if ANY
// platform admin already exists — is what survives a restore window (a restore
// repopulates admins), so an empty users table is never a bootstrap trigger.

describe("bootstrapFirstPlatformAdmin", () => {
  test("creates the first platform admin + membership on an admin-less deployment", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await t.mutation(
      internal.users.bootstrapFirstPlatformAdmin,
      { username: "andy", name: "Andy" },
    );
    const admin = await t.run(async (ctx) => ctx.db.get(userId as Id<"users">));
    expect(admin?.role).toBe("platform_admin");
    const mem = await t.run(async (ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .first(),
    );
    expect(mem?.role).toBe("platform_admin");
  });

  test("REFUSES when a platform admin already exists (role column)", async () => {
    const t = convexTest(schema, modules);
    await seedUser(t, "platform_admin", "avery");
    await expect(
      t.mutation(internal.users.bootstrapFirstPlatformAdmin, { username: "andy" }),
    ).rejects.toThrow(/already exists/i);
  });

  test("REFUSES when only a platform_admin MEMBERSHIP exists (restore-window shape)", async () => {
    const t = convexTest(schema, modules);
    // A user whose denormalized role isn't platform_admin but who holds a
    // platform_admin membership — the shape a restore can leave behind.
    const u = await seedUser(t, "scholar", "ghost");
    await t.run(async (ctx) =>
      ctx.db.insert("memberships", { userId: u, role: "platform_admin" }),
    );
    await expect(
      t.mutation(internal.users.bootstrapFirstPlatformAdmin, { username: "andy" }),
    ).rejects.toThrow(/already exists/i);
  });

  test("promotes an existing same-username row instead of duplicating it", async () => {
    const t = convexTest(schema, modules);
    // A seeded placeholder row with the target username but a lesser role.
    await seedUser(t, "scholar", "andy");
    const { userId } = await t.mutation(
      internal.users.bootstrapFirstPlatformAdmin,
      { username: "andy" },
    );
    expect((await users(t)).filter((u) => u.username === "andy")).toHaveLength(1);
    const admin = await t.run(async (ctx) => ctx.db.get(userId as Id<"users">));
    expect(admin?.role).toBe("platform_admin");
  });
});

// ── Finding A: an invite-created staff account is unclaimable until enrolled ──
// registerWithCode marks invite-created staff accounts `pendingEnrollment` so
// the auth callback refuses to bootstrap a password onto the credential-less
// account. Only passkey enrollment clears the flag; a platform admin
// can re-issue a lapsed enroll token as the recovery path.

describe("pending-enrollment guard (orphaned-account-takeover fix)", () => {
  test("assertNotPendingEnrollment throws for a pending account, no-op otherwise", () => {
    expect(() => assertNotPendingEnrollment({ pendingEnrollment: true })).toThrow(
      /finishing setup/i,
    );
    expect(() => assertNotPendingEnrollment({ pendingEnrollment: false })).not.toThrow();
    expect(() => assertNotPendingEnrollment({})).not.toThrow();
    expect(() => assertNotPendingEnrollment(null)).not.toThrow();
  });

  test("a create_institution school_admin is created pendingEnrollment; a scholar join is NOT", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const admin = await seedUser(t, "platform_admin", "avery");
    const { code: createCode } = await (await withUser(t, admin)).mutation(
      api.institutionInvites.mintCreateInstitutionInvite,
      {},
    );
    await t.mutation(api.users.registerWithCode, {
      username: "chris",
      code: createCode,
      email: "chris@school.edu",
      institutionName: "Prism Academy",
    });
    const chris = (await users(t)).find((u) => u.username === "chris");
    expect(chris?.pendingEnrollment).toBe(true);

    // A scholar join keeps username+password, so it is NOT pending.
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    const { code: joinCode } = await (await withUser(t, hoku)).mutation(
      api.institutionInvites.mintJoinInvite,
      { role: "scholar" },
    );
    await t.mutation(api.users.registerWithCode, {
      username: "newkid",
      code: joinCode,
    });
    const kid = (await users(t)).find((u) => u.username === "newkid");
    expect(kid?.pendingEnrollment).toBeFalsy();
  });

  test("a teacher join is created pendingEnrollment", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    const hoku = await seedUser(t, "school_admin", "hoku", moli);
    const { code } = await (await withUser(t, hoku)).mutation(
      api.institutionInvites.mintJoinInvite,
      { role: "teacher" },
    );
    await t.mutation(api.users.registerWithCode, { username: "newteacher", code });
    const tch = (await users(t)).find((u) => u.username === "newteacher");
    expect(tch?.pendingEnrollment).toBe(true);
  });

  test("enrolling a passkey clears pendingEnrollment", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "avery");
    const { code } = await (await withUser(t, admin)).mutation(
      api.institutionInvites.mintCreateInstitutionInvite,
      {},
    );
    await t.mutation(api.users.registerWithCode, {
      username: "chris",
      code,
      email: "chris@school.edu",
      institutionName: "Prism Academy",
    });
    const chris = (await users(t)).find((u) => u.username === "chris")!;
    expect(chris.pendingEnrollment).toBe(true);

    // Simulate the passkey-enrollment write (the canonical clear point).
    await t.run(async (ctx) =>
      ctx.runMutation(internal.passkeys.insertCredential, {
        userId: chris._id,
        credentialId: "cred-abc",
        publicKey: "pk",
        counter: 0,
      }),
    );
    const afterPasskey = await t.run(
      async (ctx) => (await ctx.db.get(chris._id as Id<"users">))?.pendingEnrollment,
    );
    expect(afterPasskey).toBe(false);
  });

  test("an unauthenticated magic-link REQUEST does NOT clear pendingEnrollment; password path still refuses", async () => {
    // THE ATTACK (re-review Finding-A regression): in @convex-dev/auth the
    // custom createOrUpdateUser callback (resolveMagicLinkUser) fires at magic-
    // link REQUEST time, before any email is sent — so an unauthenticated
    // attacker calling signIn("magic-link", { email: <victim> }) reaches it
    // WITHOUT receiving the link. It must NOT clear the pending flag, or the
    // attacker could then claim the username via password sign-up.
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "avery");
    const { code } = await (await withUser(t, admin)).mutation(
      api.institutionInvites.mintCreateInstitutionInvite,
      {},
    );
    await t.mutation(api.users.registerWithCode, {
      username: "chris",
      code,
      email: "chris@school.edu",
      institutionName: "Prism Academy",
    });
    const chris = (await users(t)).find((u) => u.username === "chris")!;
    expect(chris.pendingEnrollment).toBe(true);

    // Simulate the request-time callback the attacker triggers. It still
    // resolves the account (magic-link sign-in works for a pending account)…
    const resolvedId = await t.run(async (ctx) =>
      resolveMagicLinkUser(ctx, {
        existingUserId: chris._id,
        profile: { email: "chris@school.edu" },
      }),
    );
    expect(resolvedId).toBe(chris._id);
    // …but the pending flag MUST remain set.
    const stillPending = await t.run(
      async (ctx) => (await ctx.db.get(chris._id as Id<"users">))?.pendingEnrollment,
    );
    expect(stillPending).toBe(true);

    // And the password-bootstrap guard therefore still refuses the takeover.
    const reloaded = await t.run(async (ctx) => ctx.db.get(chris._id as Id<"users">));
    expect(() => assertNotPendingEnrollment(reloaded)).toThrow(/finishing setup/i);
  });

  test("recovery: a platform admin can re-issue an enroll token for a pending account", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "avery");
    const asAdmin = await withUser(t, admin);
    const { code } = await asAdmin.mutation(
      api.institutionInvites.mintCreateInstitutionInvite,
      {},
    );
    await t.mutation(api.users.registerWithCode, {
      username: "chris",
      code,
      email: "chris@school.edu",
      institutionName: "Prism Academy",
    });
    const chris = (await users(t)).find((u) => u.username === "chris")!;
    // The invite's own enroll token may have lapsed; the platform admin mints a
    // fresh one via the existing enrollment.issueToken recovery path.
    const res = await asAdmin.mutation(api.enrollment.issueToken, {
      userId: chris._id,
    });
    expect(res.path).toContain("/enroll?token=");
  });
});
