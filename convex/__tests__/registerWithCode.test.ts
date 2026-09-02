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

// registerWithCode is now DB-invite-only (the legacy env signup codes were
// removed). The gating rule is closed-by-default: every account requires a
// valid invite unconditionally — there is no public empty-deployment bootstrap.
// The first platform admin is created out-of-band via the admin-key-gated
// users.bootstrapFirstPlatformAdmin. These pin that rule; the full
// invite-redemption matrix lives in institutionInvites.test.ts.

const users = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => ctx.db.query("users").collect());

async function seedInstitutions(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => ({
    moli: await ctx.db.insert("institutions", {
      name: "Moli School",
      slug: "moli",
      kind: "school" as const,
      isPrimary: true,
    }),
  }));
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

describe("registerWithCode — invite-only, no public bootstrap", () => {
  test("EMPTY deployment + bogus code → rejected (no public bootstrap)", async () => {
    const t = convexTest(schema, modules);
    // An empty users table is NOT a bootstrap path: a prod restore transiently
    // empties it, and a public bootstrap there would mint an anonymous admin.
    await expect(
      t.mutation(api.users.registerWithCode, {
        username: "newbie",
        code: "anything",
      }),
    ).rejects.toThrow(/invalid invite code/i);
    expect(await users(t)).toHaveLength(0);
  });

  test("EMPTY deployment + empty code → rejected", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.users.registerWithCode, { username: "founder", code: "" }),
    ).rejects.toThrow(/invalid invite code/i);
    expect(await users(t)).toHaveLength(0);
  });

  test("POPULATED deployment + bogus code → rejected", async () => {
    const t = convexTest(schema, modules);
    // Any pre-existing user makes the deployment populated.
    await t.run(async (ctx) =>
      ctx.db.insert("users", { username: "someone", role: "scholar" }),
    );
    await expect(
      t.mutation(api.users.registerWithCode, { username: "newbie", code: "nope" }),
    ).rejects.toThrow(/invalid invite code/i);
    // Still just the one seeded user — no stranger created.
    expect(await users(t)).toHaveLength(1);
  });

  test("POPULATED deployment + empty code → rejected", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) =>
      ctx.db.insert("users", { username: "someone", role: "scholar" }),
    );
    await expect(
      t.mutation(api.users.registerWithCode, { username: "sneaky", code: "" }),
    ).rejects.toThrow(/invalid invite code/i);
  });

  test("a valid DB invite creates the right user + membership on a populated deployment", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await seedInstitutions(t);
    // A school_admin mints a scholar join invite for their school.
    const hoku = await t.run(async (ctx) =>
      ctx.db.insert("users", { username: "hoku", role: "school_admin" }),
    );
    await t.run(async (ctx) =>
      ctx.db.insert("memberships", {
        userId: hoku,
        role: "school_admin",
        institutionId: moli,
      }),
    );
    const { code } = await (await withUser(t, hoku)).mutation(
      api.institutionInvites.mintJoinInvite,
      { role: "scholar" },
    );
    const outcome = await t.mutation(api.users.registerWithCode, {
      username: "newkid",
      code,
    });
    expect(outcome).toMatchObject({ kind: "password", username: "newkid" });
    const kid = (await users(t)).find((u) => u.username === "newkid");
    expect(kid?.role).toBe("scholar");
    expect(kid?.institutionId).toBe(moli);
  });

  test("an expired then revoked invite is refused with a specific reason", async () => {
    const t = convexTest(schema, modules);
    const admin = await t.run(async (ctx) =>
      ctx.db.insert("users", { username: "avery", role: "platform_admin" }),
    );
    const asAdmin = await withUser(t, admin);
    const { inviteId, code } = await asAdmin.mutation(
      api.institutionInvites.mintCreateInstitutionInvite,
      {},
    );

    // Expired.
    await t.run(async (ctx) =>
      ctx.db.patch(inviteId, { expiresAt: Date.now() - 1000 }),
    );
    await expect(
      t.mutation(api.users.registerWithCode, {
        username: "a",
        code,
        institutionName: "A",
      }),
    ).rejects.toThrow(/expired/i);

    // Revoked (clear expiry first so we isolate the revoked reason).
    await t.run(async (ctx) =>
      ctx.db.patch(inviteId, { expiresAt: undefined, revokedAt: Date.now() }),
    );
    await expect(
      t.mutation(api.users.registerWithCode, {
        username: "a",
        code,
        institutionName: "A",
      }),
    ).rejects.toThrow(/revoked/i);
  });

  test("empty username is rejected when a valid invite is given", async () => {
    const t = convexTest(schema, modules);
    const admin = await t.run(async (ctx) =>
      ctx.db.insert("users", { username: "avery", role: "platform_admin" }),
    );
    const { code } = await (await withUser(t, admin)).mutation(
      api.institutionInvites.mintCreateInstitutionInvite,
      {},
    );
    await expect(
      t.mutation(api.users.registerWithCode, {
        username: "   ",
        code,
        institutionName: "A",
      }),
    ).rejects.toThrow(/username is required/i);
  });
});
