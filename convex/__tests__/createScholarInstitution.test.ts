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

// users.createScholar must stamp the scholar to the CALLER's institution, not
// the global primary. Before the fix it routed through
// ensureDefaultMembershipForUser, whose no-institutionId fallback lands on the
// primary school — so a non-primary school admin (an outside partner school)
// would file their scholar into the primary institution. These pin the
// multi-tenant contract: user row AND membership both stamped the caller's
// school; a primary-school caller is unchanged.

type Role =
  | "scholar"
  | "teacher"
  | "platform_admin"
  | "school_admin";

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

describe("createScholar — institution stamping", () => {
  test("a NON-primary school admin stamps the scholar to THEIR school, not primary", async () => {
    const t = convexTest(schema, modules);
    const { moli, partner } = await t.run(async (ctx) => ({
      moli: await ctx.db.insert("institutions", {
        name: "Moli School",
        slug: "moli",
        kind: "school",
        isPrimary: true,
      }),
      partner: await ctx.db.insert("institutions", {
        name: "Partner Academy",
        slug: "partner",
        kind: "school",
      }),
    }));
    const leader = await seedUser(t, "school_admin", "leader", partner);
    const asLeader = await withUser(t, leader);

    const { userId } = await asLeader.mutation(api.users.createScholar, {
      name: "Kid B",
      username: "kidb",
    });

    const scholar = await t.run(async (ctx) => ctx.db.get(userId));
    expect(scholar?.role).toBe("scholar");
    // The user row is stamped the partner school — NOT the primary (moli).
    expect(scholar?.institutionId).toBe(partner);
    expect(scholar?.institutionId).not.toBe(moli);
    // …and the membership lands on the SAME school, consistently.
    const mem = await t.run(async (ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .first(),
    );
    expect(mem?.role).toBe("scholar");
    expect(mem?.institutionId).toBe(partner);
  });

  test("a primary-school caller (teacher) is unchanged — scholar files into the primary", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await t.run(async (ctx) => ({
      moli: await ctx.db.insert("institutions", {
        name: "Moli School",
        slug: "moli",
        kind: "school",
        isPrimary: true,
      }),
    }));
    const teacher = await seedUser(t, "teacher", "teach", moli);
    const asTeacher = await withUser(t, teacher);

    const { userId } = await asTeacher.mutation(api.users.createScholar, {
      name: "Kid A",
      username: "kida",
    });

    const scholar = await t.run(async (ctx) => ctx.db.get(userId));
    expect(scholar?.institutionId).toBe(moli);
    const mem = await t.run(async (ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .first(),
    );
    expect(mem?.institutionId).toBe(moli);
  });

  test("a platform admin acting under a lens files the scholar into the lensed school", async () => {
    const t = convexTest(schema, modules);
    const { moli, partner } = await t.run(async (ctx) => ({
      moli: await ctx.db.insert("institutions", {
        name: "Moli School",
        slug: "moli",
        kind: "school",
        isPrimary: true,
      }),
      partner: await ctx.db.insert("institutions", {
        name: "Partner Academy",
        slug: "partner",
        kind: "school",
      }),
    }));
    const avery = await seedUser(t, "platform_admin", "avery");
    const asAvery = await withUser(t, avery);

    const { userId } = await asAvery.mutation(api.users.createScholar, {
      name: "Kid P",
      username: "kidp",
      scope: "partner",
    });

    const scholar = await t.run(async (ctx) => ctx.db.get(userId));
    expect(scholar?.institutionId).toBe(partner);
    expect(scholar?.institutionId).not.toBe(moli);
    const mem = await t.run(async (ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .first(),
    );
    expect(mem?.institutionId).toBe(partner);
  });

  test("a platform admin with NO lens defaults to the primary (unchanged behavior)", async () => {
    const t = convexTest(schema, modules);
    const { moli } = await t.run(async (ctx) => ({
      moli: await ctx.db.insert("institutions", {
        name: "Moli School",
        slug: "moli",
        kind: "school",
        isPrimary: true,
      }),
    }));
    const avery = await seedUser(t, "platform_admin", "avery");
    const asAvery = await withUser(t, avery);

    const { userId } = await asAvery.mutation(api.users.createScholar, {
      name: "Kid D",
      username: "kidd",
    });

    const scholar = await t.run(async (ctx) => ctx.db.get(userId));
    expect(scholar?.institutionId).toBe(moli);
    const mem = await t.run(async (ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .first(),
    );
    expect(mem?.institutionId).toBe(moli);
  });

  test("rejects before inserting when the caller's institution cannot be resolved", async () => {
    const t = convexTest(schema, modules);
    const avery = await seedUser(t, "platform_admin", "avery");
    const asAvery = await withUser(t, avery);
    const usersBefore = await t.run((ctx) => ctx.db.query("users").collect());

    await expect(
      asAvery.mutation(api.users.createScholar, {
        name: "Unassigned Scholar",
        username: "unassigned",
      }),
    ).rejects.toThrow("No institution to assign this scholar to");

    const usersAfter = await t.run((ctx) => ctx.db.query("users").collect());
    expect(usersAfter).toHaveLength(usersBefore.length);
    expect(usersAfter.find((user) => user.username === "unassigned")).toBeUndefined();
  });
});
