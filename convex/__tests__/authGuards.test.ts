import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import type { Id } from "../_generated/dataModel";
import {
  resolveMagicLinkUser,
  blockPasswordIfPasskeyEnrolled,
  assertNotSystemAccount,
  assertScholarAdoptionAuthorized,
  grantPasswordBind,
  admitMagicLinkRequest,
  MAGIC_LINK_REQUESTS_PER_HOUR,
} from "../lib/authGuards";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type Role = "scholar" | "teacher" | "platform_admin" | "curriculum_designer" | "parent";

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: Role,
  overrides: { username?: string; email?: string; emailVerificationTime?: number } = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: `Test ${role}`,
      username: overrides.username ?? `test-${role}-${Math.random().toString(36).slice(2, 7)}`,
      role,
      email: overrides.email,
      emailVerificationTime: overrides.emailVerificationTime,
    }),
  );
}

async function seedPasskey(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  credentialId = `cred-${Math.random().toString(36).slice(2, 8)}`,
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

// ── blockPasswordIfPasskeyEnrolled — the self-migrating passwordless gate ──
describe("blockPasswordIfPasskeyEnrolled", () => {
  const run = (t: ReturnType<typeof convexTest>, userId: Id<"users">) =>
    t.run(async (ctx) => blockPasswordIfPasskeyEnrolled(ctx, userId));

  test("staff with NO passkey may still password-login (no throw)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    await expect(run(t, teacher)).resolves.toBeNull();
  });

  test("staff WITH a passkey is blocked from password login", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    await seedPasskey(t, teacher);
    await expect(run(t, teacher)).rejects.toThrow(/passkey/i);
  });

  test("a PARENT with a passkey is blocked too (keyed on isPasskeyRole)", async () => {
    const t = convexTest(schema, modules);
    const parent = await seedUser(t, "parent");
    await seedPasskey(t, parent);
    await expect(run(t, parent)).rejects.toThrow(/passkey/i);
  });

  test("a SCHOLAR with a passkey is NOT blocked (password always works)", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar");
    await seedPasskey(t, scholar);
    await expect(run(t, scholar)).resolves.toBeNull();
  });

  test("a missing user is a no-op", async () => {
    const t = convexTest(schema, modules);
    const ghost = await seedUser(t, "teacher");
    await t.run(async (ctx) => ctx.db.delete(ghost));
    await expect(run(t, ghost)).resolves.toBeNull();
  });
});

// ── resolveMagicLinkUser — capability-based: any account WITH a real email ──
// Magic-link is no longer role-gated (#149): it resolves ANY pre-existing
// account that has a real external email, scholars included — but never one
// without an email, never the synthetic `username@local` address, and never
// creates an account.
describe("resolveMagicLinkUser", () => {
  const run = (
    t: ReturnType<typeof convexTest>,
    args: Parameters<typeof resolveMagicLinkUser>[1],
  ) => t.run(async (ctx) => resolveMagicLinkUser(ctx, args));

  test("resolves an existingUserId for an account with an email", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", { email: "t@x.com" });
    const id = await run(t, { existingUserId: teacher, profile: {} });
    expect(id).toBe(teacher);
  });

  test("resolves by email (case-insensitive) when no existingUserId", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", { email: "teacher@x.com" });
    const id = await run(t, {
      existingUserId: null,
      profile: { email: "Teacher@X.com" },
    });
    expect(id).toBe(teacher);
  });

  test("stamps emailVerificationTime on the VERIFY leg", async () => {
    const t = convexTest(schema, modules);
    const parent = await seedUser(t, "parent", { email: "p@x.com" });
    await run(t, {
      existingUserId: parent,
      profile: { emailVerified: true },
    });
    const row = await t.run(async (ctx) => ctx.db.get(parent));
    expect(row?.emailVerificationTime).toBeGreaterThan(0);
  });

  // Prevent address knowledge alone from marking a victim's email as verified.
  test("a bare magic-link REQUEST does not stamp emailVerificationTime", async () => {
    const t = convexTest(schema, modules);
    const email = "request-target@example.com";
    const teacher = await seedUser(t, "teacher", { email });
    const id = await run(t, {
      existingUserId: teacher,
      profile: { email },
    });
    expect(id).toBe(teacher);
    const row = await t.run(async (ctx) => ctx.db.get(teacher));
    expect(row?.emailVerificationTime).toBeUndefined();
  });

  test("a magic-link REQUEST leaves an existing emailVerificationTime untouched", async () => {
    const t = convexTest(schema, modules);
    const stamped = 12345;
    const email = "already-verified@moli.school";
    const teacher = await seedUser(t, "teacher", {
      email,
      emailVerificationTime: stamped,
    });
    await run(t, {
      existingUserId: teacher,
      profile: { email },
    });
    const row = await t.run(async (ctx) => ctx.db.get(teacher));
    expect(row?.emailVerificationTime).toBe(stamped);
  });

  test("does not overwrite an existing emailVerificationTime", async () => {
    const t = convexTest(schema, modules);
    const stamped = 12345;
    const teacher = await seedUser(t, "teacher", {
      email: "t@x.com",
      emailVerificationTime: stamped,
    });
    await run(t, {
      existingUserId: teacher,
      profile: { emailVerified: true },
    });
    const row = await t.run(async (ctx) => ctx.db.get(teacher));
    expect(row?.emailVerificationTime).toBe(stamped);
  });

  test("RESOLVES a scholar that has an email (capability-based, additive)", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", { email: "kid@x.com" });
    const id = await run(t, { existingUserId: scholar, profile: {} });
    expect(id).toBe(scholar);
  });

  test("REFUSES an account with NO email on file", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    await expect(
      run(t, { existingUserId: teacher, profile: {} }),
    ).rejects.toThrow(/not authorized/i);
  });

  test("REFUSES a synthetic username@local email (no dot in domain)", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", { email: "kai@local" });
    await expect(
      run(t, { existingUserId: scholar, profile: {} }),
    ).rejects.toThrow(/not authorized/i);
  });

  test("REFUSES an unknown email (never creates an account)", async () => {
    const t = convexTest(schema, modules);
    await expect(
      run(t, { existingUserId: null, profile: { email: "nobody@x.com" } }),
    ).rejects.toThrow(/not authorized/i);
    const count = await t.run(async (ctx) =>
      (await ctx.db.query("users").collect()).length,
    );
    expect(count).toBe(0);
  });
});

// ── admitMagicLinkRequest — the request-leg gate (security review S13) ──
describe("admitMagicLinkRequest", () => {
  const admit = (t: ReturnType<typeof convexTest>, email: string, now?: number) =>
    t.run(async (ctx) => admitMagicLinkRequest(ctx, email, now));
  const buckets = (t: ReturnType<typeof convexTest>) =>
    t.run(async (ctx) => (await ctx.db.query("authRateLimits").collect()).length);

  test("admits an account with a real email (case-insensitive)", async () => {
    const t = convexTest(schema, modules);
    await seedUser(t, "teacher", { email: "test.teacher@example.test" });
    expect(await admit(t, "Test.Teacher@Example.test")).toBe(true);
  });

  test("refuses unknown, synthetic and invalid addresses and writes nothing", async () => {
    const t = convexTest(schema, modules);
    await seedUser(t, "scholar", { email: "test-kid@local" });
    expect(await admit(t, "nobody@example.test")).toBe(false);
    expect(await admit(t, "test-kid@local")).toBe(false);
    expect(await admit(t, "not an email")).toBe(false);
    expect(await buckets(t)).toBe(0);
  });

  test("a duplicate account for one email admits without throwing", async () => {
    const t = convexTest(schema, modules);
    await seedUser(t, "parent", { email: "test.twin@example.test" });
    await t.run(async (ctx) =>
      ctx.db.insert("users", {
        name: "Test Twin",
        username: "test-twin-2",
        role: "parent",
        email: "test.twin@example.test",
      }),
    );
    expect(await admit(t, "test.twin@example.test")).toBe(true);
  });

  test("refuses a service account", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) =>
      ctx.db.insert("users", {
        name: "Test Guide",
        username: "test-guide",
        role: "teacher",
        isSystem: true,
        email: "test-guide@example.test",
      }),
    );
    expect(await admit(t, "test-guide@example.test")).toBe(false);
  });

  test(`allows ${MAGIC_LINK_REQUESTS_PER_HOUR} an hour per address, then refills`, async () => {
    const t = convexTest(schema, modules);
    await seedUser(t, "parent", { email: "test.parent@example.test" });
    await seedUser(t, "teacher", { email: "test.other@example.test" });
    const now = 1_800_000_000_000;
    for (let i = 0; i < MAGIC_LINK_REQUESTS_PER_HOUR; i++) {
      expect(await admit(t, "test.parent@example.test", now)).toBe(true);
    }
    expect(await admit(t, "test.parent@example.test", now)).toBe(false);
    // Another address has its own bucket.
    expect(await admit(t, "test.other@example.test", now)).toBe(true);
    // One token back after a fifth of an hour.
    const later = now + (60 * 60 * 1000) / MAGIC_LINK_REQUESTS_PER_HOUR;
    expect(await admit(t, "test.parent@example.test", later)).toBe(true);
    expect(await admit(t, "test.parent@example.test", later)).toBe(false);
  });
});

describe("assertNotSystemAccount", () => {
  test("throws for a service account (isSystem)", () => {
    expect(() => assertNotSystemAccount({ isSystem: true })).toThrow(
      /can't be signed in/i,
    );
  });

  test("no-ops for normal / absent users", () => {
    expect(() => assertNotSystemAccount({ isSystem: false })).not.toThrow();
    expect(() => assertNotSystemAccount({})).not.toThrow();
    expect(() => assertNotSystemAccount(null)).not.toThrow();
  });

  test("magic-link refuses a system account even with a valid email", async () => {
    const t = convexTest(schema, modules);
    const sys = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        name: "Rabbithole",
        username: "rabbithole-guide",
        role: "teacher",
        isSystem: true,
        email: "guide@example.com",
        emailVerificationTime: Date.now(),
      }),
    );
    void sys;
    await expect(
      t.run(async (ctx) =>
        resolveMagicLinkUser(ctx, {
          existingUserId: null,
          profile: { email: "guide@example.com" },
        }),
      ),
    ).rejects.toThrow(/can't be signed in/i);
  });
});

// ── The username coupon (TODO #scholar-self-claim) ────────────────────────
//
// A scholar username is public — it's on the roster and printed on emergency
// one-pagers — so the password sign-up path must never bind a credential to a
// scholar row on the strength of knowing one. Authorization is proven out of
// band (a one-time enroll token, or the scholar's own session), which stamps a
// short-lived `passwordBindAllowedUntil` grant that this guard consumes.
describe("assertScholarAdoptionAuthorized", () => {
  test("refuses to adopt a scholar row with no grant", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar", { username: "kai_kahale" });
    await expect(
      t.run(async (ctx) => {
        const user = await ctx.db.get(scholarId);
        return assertScholarAdoptionAuthorized(ctx, user!);
      }),
    ).rejects.toThrow(/ask your teacher/i);
  });

  test("allows the bind while a grant is live, and consumes it", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar", { username: "lani_kahale" });
    await t.run(async (ctx) => grantPasswordBind(ctx, scholarId));

    await t.run(async (ctx) => {
      const user = await ctx.db.get(scholarId);
      return assertScholarAdoptionAuthorized(ctx, user!);
    });

    // Single-use: a second sign-up racing the same window finds it cleared.
    const after = await t.run(async (ctx) => ctx.db.get(scholarId));
    expect(after?.passwordBindAllowedUntil).toBeUndefined();
    await expect(
      t.run(async (ctx) => {
        const user = await ctx.db.get(scholarId);
        return assertScholarAdoptionAuthorized(ctx, user!);
      }),
    ).rejects.toThrow(/ask your teacher/i);
  });

  test("refuses an EXPIRED grant", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar", { username: "koa_de_mello" });
    await t.run(async (ctx) =>
      ctx.db.patch(scholarId, { passwordBindAllowedUntil: Date.now() - 1 }),
    );
    await expect(
      t.run(async (ctx) => {
        const user = await ctx.db.get(scholarId);
        return assertScholarAdoptionAuthorized(ctx, user!);
      }),
    ).rejects.toThrow(/ask your teacher/i);
  });

  // Deliberately scoped to scholars: a staffer with neither passkey nor
  // password still self-migrates via one password login (see
  // .claude/rules/rabbithole-passkeys.md). Closing that is a separate call, so
  // assert the CURRENT boundary rather than letting it drift silently.
  test("does not gate non-scholar roles", async () => {
    const t = convexTest(schema, modules);
    for (const role of ["teacher", "parent", "platform_admin"] as const) {
      const userId = await seedUser(t, role);
      await t.run(async (ctx) => {
        const user = await ctx.db.get(userId);
        return assertScholarAdoptionAuthorized(ctx, user!);
      });
    }
  });
});
