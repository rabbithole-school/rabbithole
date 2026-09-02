import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// ── Standard fixtures (copied verbatim per rabbithole-testing.md) ───────
async function seedUser(
  t: ReturnType<typeof convexTest>,
  role = "scholar",
  overrides: { name?: string; username?: string } = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: overrides.name ?? `Test ${role}`,
      username: overrides.username ?? `test${role}${Math.floor(role.length)}`,
      role: role as "scholar" | "teacher" | "platform_admin" | "curriculum_designer",
    }),
  );
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

async function seedPasskey(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  credentialId = "cred-1",
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("passkeys", {
      userId,
      credentialId,
      publicKey: "pk",
      counter: 0,
      createdAt: Date.now(),
    }),
  );
}

// ── Enrollment tokens ───────────────────────────────────────────────────
describe("enrollment tokens", () => {
  test("admin can issue a token for a staff user", async () => {
    const t = convexTest(schema, modules);
    const adminId = await seedUser(t, "platform_admin", { username: "admin1" });
    const teacherId = await seedUser(t, "teacher", { username: "teach1" });
    const asAdmin = await withUser(t, adminId);

    const res = await asAdmin.mutation(api.enrollment.issueToken, {
      userId: teacherId,
    });
    expect(res.token).toBeTruthy();
    expect(res.path).toContain("/enroll?token=");

    // The raw token validates to the target user.
    const valid = await t.run(async (ctx) =>
      ctx.runQuery(internal.enrollment.validateToken, { token: res.token }),
    );
    expect(valid?.userId).toBe(teacherId);
  });

  test("issuing a token for a scholar is rejected", async () => {
    const t = convexTest(schema, modules);
    const adminId = await seedUser(t, "platform_admin", { username: "admin2" });
    const scholarId = await seedUser(t, "scholar", { username: "scho1" });
    const asAdmin = await withUser(t, adminId);

    await expect(
      asAdmin.mutation(api.enrollment.issueToken, { userId: scholarId }),
    ).rejects.toThrow(/staff/i);
  });

  test("non-admin cannot issue tokens", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", { username: "teach2" });
    const otherId = await seedUser(t, "teacher", { username: "teach3" });
    const asTeacher = await withUser(t, teacherId);

    await expect(
      asTeacher.mutation(api.enrollment.issueToken, { userId: otherId }),
    ).rejects.toThrow(/admin/i);
  });

  test("a token is single-use", async () => {
    const t = convexTest(schema, modules);
    const adminId = await seedUser(t, "platform_admin", { username: "admin3" });
    const teacherId = await seedUser(t, "teacher", { username: "teach4" });
    const asAdmin = await withUser(t, adminId);

    const { token } = await asAdmin.mutation(api.enrollment.issueToken, {
      userId: teacherId,
    });
    await t.run(async (ctx) =>
      ctx.runMutation(internal.enrollment.consumeToken, { token }),
    );
    const valid = await t.run(async (ctx) =>
      ctx.runQuery(internal.enrollment.validateToken, { token }),
    );
    expect(valid).toBeNull();
  });

  test("expired tokens do not validate", async () => {
    const t = convexTest(schema, modules);
    const adminId = await seedUser(t, "platform_admin", { username: "admin4" });
    const teacherId = await seedUser(t, "teacher", { username: "teach5" });
    const asAdmin = await withUser(t, adminId);

    const { token } = await asAdmin.mutation(api.enrollment.issueToken, {
      userId: teacherId,
    });
    // Force-expire the token row.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("enrollmentTokens")
        .withIndex("by_user", (q) => q.eq("userId", teacherId))
        .unique();
      if (row) await ctx.db.patch(row._id, { expiresAt: Date.now() - 1000 });
    });
    const valid = await t.run(async (ctx) =>
      ctx.runQuery(internal.enrollment.validateToken, { token }),
    );
    expect(valid).toBeNull();
  });

  test("sweepStaleTokens removes used + expired, keeps live tokens", async () => {
    const t = convexTest(schema, modules);
    const adminId = await seedUser(t, "platform_admin", { username: "admin-sweep" });
    const liveUserId = await seedUser(t, "teacher", { username: "teach-live" });
    const usedUserId = await seedUser(t, "teacher", { username: "teach-used" });
    const expiredUserId = await seedUser(t, "teacher", { username: "teach-exp" });
    const asAdmin = await withUser(t, adminId);

    // Live, unused token — must survive.
    const { token: liveToken } = await asAdmin.mutation(
      api.enrollment.issueToken,
      { userId: liveUserId },
    );
    // Used token — must be swept.
    const { token: usedToken } = await asAdmin.mutation(
      api.enrollment.issueToken,
      { userId: usedUserId },
    );
    await t.run(async (ctx) =>
      ctx.runMutation(internal.enrollment.consumeToken, { token: usedToken }),
    );
    // Expired, unused token — must be swept.
    await asAdmin.mutation(api.enrollment.issueToken, { userId: expiredUserId });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("enrollmentTokens")
        .withIndex("by_user", (q) => q.eq("userId", expiredUserId))
        .unique();
      if (row) await ctx.db.patch(row._id, { expiresAt: Date.now() - 1000 });
    });

    const res = await t.run(async (ctx) =>
      ctx.runMutation(internal.enrollment.sweepStaleTokens, {}),
    );
    expect(res.removed).toBe(2);

    // The live token still validates; nothing else remains.
    const valid = await t.run(async (ctx) =>
      ctx.runQuery(internal.enrollment.validateToken, { token: liveToken }),
    );
    expect(valid?.userId).toBe(liveUserId);
    const remaining = await t.run(async (ctx) =>
      ctx.db.query("enrollmentTokens").collect(),
    );
    expect(remaining.length).toBe(1);
  });

  test("adminResetPasskeys removes credentials and issues a token", async () => {
    const t = convexTest(schema, modules);
    const adminId = await seedUser(t, "platform_admin", { username: "admin5" });
    const teacherId = await seedUser(t, "teacher", { username: "teach6" });
    await seedPasskey(t, teacherId, "cred-reset-1");
    await seedPasskey(t, teacherId, "cred-reset-2");
    const asAdmin = await withUser(t, adminId);

    const res = await asAdmin.mutation(api.enrollment.adminResetPasskeys, {
      userId: teacherId,
    });
    expect(res.removed).toBe(2);
    expect(res.token).toBeTruthy();

    const remaining = await t.run(async (ctx) =>
      ctx.db
        .query("passkeys")
        .withIndex("by_user", (q) => q.eq("userId", teacherId))
        .collect(),
    );
    expect(remaining.length).toBe(0);
  });
});

// ── Challenge handling ──────────────────────────────────────────────────
describe("webauthn challenges", () => {
  test("takeChallenge is one-shot and type-checked", async () => {
    const t = convexTest(schema, modules);
    const challengeId = await t.run(async (ctx) =>
      ctx.runMutation(internal.passkeys.createChallenge, {
        challenge: "abc",
        type: "authentication",
      }),
    );

    // Wrong type consumes but returns null.
    const wrongType = await t.run(async (ctx) =>
      ctx.runMutation(internal.passkeys.takeChallenge, {
        challengeId,
        type: "registration",
      }),
    );
    expect(wrongType).toBeNull();

    // Already consumed → null.
    const second = await t.run(async (ctx) =>
      ctx.runMutation(internal.passkeys.takeChallenge, {
        challengeId,
        type: "authentication",
      }),
    );
    expect(second).toBeNull();
  });

  test("takeChallenge returns the challenge once for the right type", async () => {
    const t = convexTest(schema, modules);
    const challengeId = await t.run(async (ctx) =>
      ctx.runMutation(internal.passkeys.createChallenge, {
        challenge: "xyz",
        type: "authentication",
      }),
    );
    const taken = await t.run(async (ctx) =>
      ctx.runMutation(internal.passkeys.takeChallenge, {
        challengeId,
        type: "authentication",
      }),
    );
    expect(taken?.challenge).toBe("xyz");
  });

  test("sweepExpiredChallenges deletes only expired rows", async () => {
    const t = convexTest(schema, modules);
    // A fresh challenge (default 5-min TTL) and a force-expired one.
    const liveId = await t.run(async (ctx) =>
      ctx.runMutation(internal.passkeys.createChallenge, {
        challenge: "live",
        type: "authentication",
      }),
    );
    const expiredId = await t.run(async (ctx) =>
      ctx.runMutation(internal.passkeys.createChallenge, {
        challenge: "stale",
        type: "registration",
      }),
    );
    await t.run(async (ctx) =>
      ctx.db.patch(expiredId, { expiresAt: Date.now() - 1000 }),
    );

    const res = await t.run(async (ctx) =>
      ctx.runMutation(internal.passkeys.sweepExpiredChallenges, {}),
    );
    expect(res.removed).toBe(1);
    expect(await t.run(async (ctx) => ctx.db.get(expiredId))).toBeNull();
    expect(await t.run(async (ctx) => ctx.db.get(liveId))).not.toBeNull();
  });
});

// ── Credentials ─────────────────────────────────────────────────────────
describe("passkey credentials", () => {
  test("insertCredential is idempotent by credentialId", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "teacher", { username: "teach7" });
    const first = await t.run(async (ctx) =>
      ctx.runMutation(internal.passkeys.insertCredential, {
        userId,
        credentialId: "dup",
        publicKey: "pk",
        counter: 0,
      }),
    );
    const second = await t.run(async (ctx) =>
      ctx.runMutation(internal.passkeys.insertCredential, {
        userId,
        credentialId: "dup",
        publicKey: "pk",
        counter: 5,
      }),
    );
    expect(second).toBe(first);
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("passkeys")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect(),
    );
    expect(rows.length).toBe(1);
  });

  test("deleteMine only deletes the caller's own passkey", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await seedUser(t, "teacher", { username: "owner1" });
    const otherId = await seedUser(t, "teacher", { username: "other1" });
    const passkeyId = await seedPasskey(t, ownerId, "cred-owned");

    const asOther = await withUser(t, otherId);
    await expect(
      asOther.mutation(api.passkeys.deleteMine, { passkeyId }),
    ).rejects.toThrow(/forbidden/i);

    const asOwner = await withUser(t, ownerId);
    await asOwner.mutation(api.passkeys.deleteMine, { passkeyId });
    const gone = await t.run(async (ctx) => ctx.db.get(passkeyId));
    expect(gone).toBeNull();
  });

  test("myStatus reflects credential count", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "teacher", { username: "teach8" });
    const asUser = await withUser(t, userId);

    let status = await asUser.query(api.passkeys.myStatus, {});
    expect(status.hasPasskey).toBe(false);
    expect(status.count).toBe(0);

    await seedPasskey(t, userId, "cred-status");
    status = await asUser.query(api.passkeys.myStatus, {});
    expect(status.hasPasskey).toBe(true);
    expect(status.count).toBe(1);
  });

  test("mustEnroll is true for staff with no passkey, false otherwise", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", { username: "teach10" });
    const scholarId = await seedUser(t, "scholar", { username: "scho10" });

    const asTeacher = await withUser(t, teacherId);
    const asScholar = await withUser(t, scholarId);

    // Staff with no passkey → must enroll.
    let teacherStatus = await asTeacher.query(api.passkeys.myStatus, {});
    expect(teacherStatus.isStaff).toBe(true);
    expect(teacherStatus.mustEnroll).toBe(true);

    // Scholar with no passkey → not forced.
    const scholarStatus = await asScholar.query(api.passkeys.myStatus, {});
    expect(scholarStatus.isStaff).toBe(false);
    expect(scholarStatus.mustEnroll).toBe(false);

    // Once the teacher has a passkey → no longer forced.
    await seedPasskey(t, teacherId, "cred-mustenroll");
    teacherStatus = await asTeacher.query(api.passkeys.myStatus, {});
    expect(teacherStatus.mustEnroll).toBe(false);
  });

  test("hasMultiDevice tracks synced (multiDevice) credentials", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "teacher", { username: "teach11" });
    const asUser = await withUser(t, userId);

    // A single-device (hardware-key style) credential.
    await t.run(async (ctx) =>
      ctx.db.insert("passkeys", {
        userId,
        credentialId: "cred-singledevice",
        publicKey: "pk",
        counter: 0,
        deviceType: "singleDevice",
        createdAt: Date.now(),
      }),
    );
    let status = await asUser.query(api.passkeys.myStatus, {});
    expect(status.hasMultiDevice).toBe(false);

    // Add a synced (multiDevice) credential.
    await t.run(async (ctx) =>
      ctx.db.insert("passkeys", {
        userId,
        credentialId: "cred-multidevice",
        publicKey: "pk",
        counter: 0,
        deviceType: "multiDevice",
        createdAt: Date.now(),
      }),
    );
    status = await asUser.query(api.passkeys.myStatus, {});
    expect(status.hasMultiDevice).toBe(true);
  });

  test("getByCredentialId finds the right row", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "teacher", { username: "teach9" });
    await seedPasskey(t, userId, "lookup-me");
    const found = await t.run(async (ctx) =>
      ctx.runQuery(internal.passkeys.getByCredentialId, {
        credentialId: "lookup-me",
      }),
    );
    expect(found?.userId).toBe(userId);
  });
});

describe("devEnsureEnrollmentBypass (dev-login sentinel)", () => {
  const bypass = async (t: ReturnType<typeof convexTest>, userId: Id<"users">) =>
    t.run(async (ctx) =>
      ctx.runMutation(internal.passkeys.devEnsureEnrollmentBypass, { userId }),
    );
  const passkeys = async (t: ReturnType<typeof convexTest>, userId: Id<"users">) =>
    t.run(async (ctx) => {
      const all = await ctx.db.query("passkeys").collect();
      return all.filter((p) => p.userId === userId);
    });

  test("inserts a sentinel for staff with no passkey; idempotent", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    await bypass(t, teacher);
    await bypass(t, teacher); // idempotent
    const rows = await passkeys(t, teacher);
    expect(rows).toHaveLength(1);
    // Regression guard: the credentialId MUST be valid base64url, else
    // generateRegistrationOptions' excludeCredentials throws and breaks REAL
    // passkey enrollment for this user. A colon (the original bug) is invalid.
    expect(rows[0].credentialId).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("no-op for a non-staff scholar", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar");
    await bypass(t, scholar);
    expect(await passkeys(t, scholar)).toHaveLength(0);
  });

  test("does not add a sentinel when a real passkey already exists", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin");
    await seedPasskey(t, admin, "real-cred");
    await bypass(t, admin);
    const rows = await passkeys(t, admin);
    expect(rows).toHaveLength(1);
    expect(rows[0].credentialId).toBe("real-cred");
  });
});
