import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// Why this file: magic-link is a passwordless login that is CAPABILITY-based,
// not role-based — ANY account that has a real email on file can use it
// (staff, parents, and scholars alike). The security-critical invariants are
// that it resolves ONLY to a PRE-EXISTING account (never self-creates), only
// to one with a real external email (never the synthetic `username@local`
// Password address), and never to an unknown email. These tests pin
// `isMagicLinkEligible` (the send-time + verify-time gate), `adminSetUserEmail`
// (operator trusted entry), and `setMyEmail` (self-service opt-in).

type Role = "scholar" | "teacher" | "platform_admin" | "curriculum_designer" | "staff";

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: Role,
  username: string,
  email?: string,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: `Test ${username}`, username, role, email }),
  );
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

const eligible = (t: ReturnType<typeof convexTest>, email: string) =>
  t.run(async (ctx) =>
    ctx.runQuery(internal.users.isMagicLinkEligible, { email }),
  );

describe("isMagicLinkEligible — any account with a real email", () => {
  test.each(["teacher", "platform_admin", "curriculum_designer", "staff"] as const)(
    "%s with an email is eligible",
    async (role) => {
      const t = convexTest(schema, modules);
      await seedUser(t, role, role, `${role}@school.org`);
      expect(await eligible(t, `${role}@school.org`)).toBe(true);
    },
  );

  test("a scholar WITH a real email IS eligible (additive opt-in)", async () => {
    const t = convexTest(schema, modules);
    await seedUser(t, "scholar", "kai", "kai@home.com");
    expect(await eligible(t, "kai@home.com")).toBe(true);
  });

  test("a scholar with NO email is NOT eligible (nothing to resolve)", async () => {
    const t = convexTest(schema, modules);
    await seedUser(t, "scholar", "lani");
    expect(await eligible(t, "lani@home.com")).toBe(false);
  });

  test("a synthetic username@local address is NOT eligible", async () => {
    const t = convexTest(schema, modules);
    // The Password provider uses `username@local`; it has no dot in the
    // domain, so isValidEmail rejects it and it can't be magic-linked into.
    await seedUser(t, "scholar", "noah", "noah@local");
    expect(await eligible(t, "noah@local")).toBe(false);
  });

  test("an unknown email is NOT eligible", async () => {
    const t = convexTest(schema, modules);
    await seedUser(t, "teacher", "t", "teacher@school.org");
    expect(await eligible(t, "stranger@elsewhere.com")).toBe(false);
  });

  test("lookup is case-insensitive", async () => {
    const t = convexTest(schema, modules);
    await seedUser(t, "teacher", "t", "teacher@school.org");
    expect(await eligible(t, "TEACHER@School.ORG")).toBe(true);
  });

  test("empty email is NOT eligible", async () => {
    const t = convexTest(schema, modules);
    expect(await eligible(t, "")).toBe(false);
  });
});

describe("adminSetUserEmail — trusted, pre-verified entry", () => {
  test("admin sets a normalized + verified email", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "admin");
    const teacher = await seedUser(t, "teacher", "t");
    const asAdmin = await withUser(t, admin);
    await asAdmin.mutation(api.users.adminSetUserEmail, {
      userId: teacher,
      email: "  Teacher@School.ORG ",
    });
    const updated = await t.run(async (ctx) => ctx.db.get(teacher));
    expect(updated?.email).toBe("teacher@school.org");
    expect(updated?.emailVerificationTime).toBeGreaterThan(0);
    // ...and that makes them magic-link eligible immediately.
    expect(await eligible(t, "teacher@school.org")).toBe(true);
  });

  test("rejects an invalid email", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "admin");
    const teacher = await seedUser(t, "teacher", "t");
    const asAdmin = await withUser(t, admin);
    await expect(
      asAdmin.mutation(api.users.adminSetUserEmail, {
        userId: teacher,
        email: "not-an-email",
      }),
    ).rejects.toThrow(/valid email/i);
  });

  test("rejects a duplicate email on a different account", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "admin");
    await seedUser(t, "teacher", "t1", "dup@school.org");
    const t2 = await seedUser(t, "teacher", "t2");
    const asAdmin = await withUser(t, admin);
    await expect(
      asAdmin.mutation(api.users.adminSetUserEmail, {
        userId: t2,
        email: "dup@school.org",
      }),
    ).rejects.toThrow(/already in use/i);
  });

  test("non-admin (teacher) is forbidden", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "t");
    const victim = await seedUser(t, "teacher", "v");
    const asTeacher = await withUser(t, teacher);
    await expect(
      asTeacher.mutation(api.users.adminSetUserEmail, {
        userId: victim,
        email: "x@school.org",
      }),
    ).rejects.toThrow(/admin/i);
  });

  test("admin can set a SCHOLAR's email (capability is role-agnostic)", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "admin");
    const scholar = await seedUser(t, "scholar", "kai");
    const asAdmin = await withUser(t, admin);
    await asAdmin.mutation(api.users.adminSetUserEmail, {
      userId: scholar,
      email: "kai@home.com",
    });
    expect(await eligible(t, "kai@home.com")).toBe(true);
  });
});

describe("setMyEmail — self-service opt-in (any role)", () => {
  test("a scholar sets their OWN email and becomes eligible (NOT pre-verified)", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", "kai");
    const asScholar = await withUser(t, scholar);
    await asScholar.mutation(api.users.setMyEmail, { email: "  Kai@Home.com " });
    const updated = await t.run(async (ctx) => ctx.db.get(scholar));
    expect(updated?.email).toBe("kai@home.com"); // normalized
    // Self-set is unproven: verification is left for the first magic-link use.
    expect(updated?.emailVerificationTime).toBeUndefined();
    // ...but the address is still magic-link eligible (gate keys off the email).
    expect(await eligible(t, "kai@home.com")).toBe(true);
  });

  test("changing a self-set email clears a stale verification stamp", async () => {
    const t = convexTest(schema, modules);
    // Seed an already-verified email, then have the user change it.
    const scholar = await seedUser(t, "scholar", "kai", "old@home.com");
    await t.run(async (ctx) =>
      ctx.db.patch(scholar, { emailVerificationTime: Date.now() }),
    );
    const asScholar = await withUser(t, scholar);
    await asScholar.mutation(api.users.setMyEmail, { email: "new@home.com" });
    const updated = await t.run(async (ctx) => ctx.db.get(scholar));
    expect(updated?.email).toBe("new@home.com");
    expect(updated?.emailVerificationTime).toBeUndefined();
  });

  test("rejects an invalid email", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", "kai");
    const asScholar = await withUser(t, scholar);
    await expect(
      asScholar.mutation(api.users.setMyEmail, { email: "nope" }),
    ).rejects.toThrow(/valid email/i);
  });

  test("rejects an email already used by another account (generic message)", async () => {
    const t = convexTest(schema, modules);
    await seedUser(t, "teacher", "t", "taken@school.org");
    const scholar = await seedUser(t, "scholar", "kai");
    const asScholar = await withUser(t, scholar);
    // Self-service gets a GENERIC clash message (no "already in use by another
    // account") so a scholar can't probe which emails are registered.
    await expect(
      asScholar.mutation(api.users.setMyEmail, { email: "taken@school.org" }),
    ).rejects.toThrow(/try a different one/i);
    await expect(
      asScholar.mutation(api.users.setMyEmail, { email: "taken@school.org" }),
    ).rejects.not.toThrow(/already in use by another account/i);
  });

  test("requires authentication", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.users.setMyEmail, { email: "x@school.org" }),
    ).rejects.toThrow();
  });
});

describe("clearMyEmail — self-service removal", () => {
  test("removes the email + verification stamp and ends eligibility", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", "kai", "kai@home.com");
    await t.run(async (ctx) =>
      ctx.db.patch(scholar, { emailVerificationTime: Date.now() }),
    );
    expect(await eligible(t, "kai@home.com")).toBe(true);

    const asScholar = await withUser(t, scholar);
    await asScholar.mutation(api.users.clearMyEmail, {});

    const updated = await t.run(async (ctx) => ctx.db.get(scholar));
    expect(updated?.email).toBeUndefined();
    expect(updated?.emailVerificationTime).toBeUndefined();
    expect(await eligible(t, "kai@home.com")).toBe(false);
  });

  test("is idempotent when no email is set", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", "kai");
    const asScholar = await withUser(t, scholar);
    await expect(
      asScholar.mutation(api.users.clearMyEmail, {}),
    ).resolves.toEqual({ ok: true });
  });

  test("requires authentication", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(api.users.clearMyEmail, {})).rejects.toThrow();
  });
});
