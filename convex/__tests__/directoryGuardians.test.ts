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

// Why this file: two Wave-2 backend invariants.
//   1. The staff/families directory (`parents.listAllParents`) must list a
//      guardian by RELATION (the `guardianships` table), not by `users.role`.
//      A staff member (admin/teacher) who is also a parent must appear — the
//      bug was seeding the guardian set from `by_role === parent` only. Rows
//      also carry `image` (guardian + child) for the directory avatars.
//   2. `users.internalDeleteUserCascade` full-cascades a user, including their
//      auth accounts and institution memberships (the membership cleanup lives
//      in `deleteUserCore`, so the admin-dashboard path benefits too).

type Role =
  | "scholar"
  | "teacher"
  | "platform_admin"
  | "curriculum_designer"
  | "parent";

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: Role,
  username: string,
  extra?: Partial<Doc<"users">>,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: `Test ${username}`,
      username,
      role,
      ...extra,
    }),
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

async function linkGuardian(
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

// ── listAllParents seeds its guardian set by RELATION, not role ────────

describe("parents.listAllParents — guardianship, not role", () => {
  test("a staff (admin) guardian appears with their linked child", async () => {
    const t = convexTest(schema, modules);
    const caller = await seedUser(t, "platform_admin", "caller");
    // A staff member whose PRIMARY role is admin — NOT `parent` — but who is a
    // linked guardian. The pre-fix code (by_role === parent) dropped this row.
    const staffGuardian = await seedUser(t, "platform_admin", "staffparent", {
      image: "https://example.com/staff.png",
    });
    const kai = await seedUser(t, "scholar", "kai", {
      image: "https://example.com/kai.png",
    });
    await linkGuardian(t, staffGuardian, kai, caller);

    const asCaller = await withUser(t, caller);
    const rows = await asCaller.query(api.parents.listAllParents, {});
    const row = rows.find((r) => r._id === staffGuardian);
    expect(row).toBeDefined();
    // Guardian avatar present.
    expect(row).toHaveProperty("image", "https://example.com/staff.png");
    // Linked child present, with its avatar.
    const kaiRow = row!.children.find((c) => c._id === kai);
    expect(kaiRow).toBeDefined();
    expect(kaiRow).toHaveProperty("image", "https://example.com/kai.png");
  });

  test("a role-parent with zero links still appears (unscoped admin caller)", async () => {
    const t = convexTest(schema, modules);
    const caller = await seedUser(t, "platform_admin", "caller");
    const lonelyParent = await seedUser(t, "parent", "lonely");

    const asCaller = await withUser(t, caller);
    const rows = await asCaller.query(api.parents.listAllParents, {});
    const row = rows.find((r) => r._id === lonelyParent);
    expect(row).toBeDefined();
    expect(row!.children).toEqual([]);
  });

  test("guardian + child rows carry image:null when unset", async () => {
    const t = convexTest(schema, modules);
    const caller = await seedUser(t, "platform_admin", "caller");
    const parent = await seedUser(t, "parent", "pat");
    const kai = await seedUser(t, "scholar", "kai");
    await linkGuardian(t, parent, kai, caller);

    const asCaller = await withUser(t, caller);
    const rows = await asCaller.query(api.parents.listAllParents, {});
    const row = rows.find((r) => r._id === parent);
    expect(row).toHaveProperty("image", null);
    expect(row!.children.find((c) => c._id === kai)).toHaveProperty(
      "image",
      null,
    );
  });

  test("a plain (non-guardian) staff member is NOT listed", async () => {
    const t = convexTest(schema, modules);
    const caller = await seedUser(t, "platform_admin", "caller");
    const teacher = await seedUser(t, "teacher", "teach");

    const asCaller = await withUser(t, caller);
    const rows = await asCaller.query(api.parents.listAllParents, {});
    expect(rows.find((r) => r._id === teacher)).toBeUndefined();
  });
});

// ── internalDeleteUserCascade — full cascade incl. accounts + memberships ──

describe("users.internalDeleteUserCascade", () => {
  test("deletes the user, their authAccounts, memberships, and guardianships", async () => {
    const t = convexTest(schema, modules);
    const operator = await seedUser(t, "platform_admin", "operator");
    const stray = await seedUser(t, "scholar", "stray");
    const guardian = await seedUser(t, "parent", "strayparent");

    const { accountId, membershipId, guardianshipId } = await t.run(
      async (ctx) => {
        const accountId = await ctx.db.insert("authAccounts", {
          userId: stray,
          provider: "password",
          providerAccountId: "stray@local",
        });
        const membershipId = await ctx.db.insert("memberships", {
          userId: stray,
          role: "scholar",
        });
        const guardianshipId = await ctx.db.insert("guardianships", {
          parentUserId: guardian,
          scholarUserId: stray,
          createdBy: operator,
        });
        return { accountId, membershipId, guardianshipId };
      },
    );

    await t.mutation(internal.users.internalDeleteUserCascade, {
      userId: stray,
      callerUserId: operator,
    });

    const [user, account, membership, guardianship] = await t.run(
      async (ctx) => [
        await ctx.db.get(stray),
        await ctx.db.get(accountId),
        await ctx.db.get(membershipId),
        await ctx.db.get(guardianshipId),
      ],
    );
    expect(user).toBeNull();
    expect(account).toBeNull();
    expect(membership).toBeNull();
    expect(guardianship).toBeNull();
  });

  test("refuses self-deletion (caller === target)", async () => {
    const t = convexTest(schema, modules);
    const operator = await seedUser(t, "platform_admin", "operator");
    await expect(
      t.mutation(internal.users.internalDeleteUserCascade, {
        userId: operator,
        callerUserId: operator,
      }),
    ).rejects.toThrow(/cannot delete yourself/i);
  });
});
