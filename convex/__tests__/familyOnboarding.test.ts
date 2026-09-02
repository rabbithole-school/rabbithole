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

// Why this file: the prod enrolled-families seed must be idempotent, collapse siblings to one parent,
// and reuse (not duplicate / not re-role) an existing staff account that is
// also a guardian.

type Role = "scholar" | "teacher" | "platform_admin" | "staff" | "parent";
async function seedUser(t: ReturnType<typeof convexTest>, role: Role, username: string, email?: string) {
  return await t.run((ctx) =>
    ctx.db.insert("users", { name: `Test ${username}`, username, role, email }),
  );
}
async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    } as Omit<Doc<"authSessions">, "_id" | "_creationTime">),
  );
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

const TWO_SIBLINGS = [
  {
    studentName: "Kai Kahale",
    dob: "2018-12-24",
    grade: "2",
    parent1: { name: "Sloane Kahale", email: "sloane.kahale@example.com" },
    parent2: null,
  },
  {
    studentName: "Lani Kahale",
    dob: "2015-09-14",
    grade: "5",
    parent1: { name: "Sloane Kahale", email: "sloane.kahale@example.com" }, // same parent
    parent2: null,
  },
  {
    studentName: "Emi Park",
    dob: "2019-06-28",
    grade: "2",
    parent1: { name: "Hana Park", email: "hana.park@example.com" },
    parent2: { name: "Ren Park", email: "ren.park@example.com" },
  },
];


describe("parents.sendClaimInvite", () => {
  // A scholar-admin (teacher/admin/school_admin) emails a parent their "claim your
  // account" Welcome invite. Non-admins can't call it; a missing email or a
  // non-parent target is rejected.
  async function setupParent(t: ReturnType<typeof convexTest>, email?: string) {
    const parentId = await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "Hana Park",
        email,
        role: "parent",
        ...(email ? { emailVerificationTime: Date.now() } : {}),
      }),
    );
    return parentId;
  }

  test("sends to a parent with a valid email", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "admin");
    const parentId = await setupParent(t, "hana.park@example.com");
    const asAdmin = await withUser(t, admin);
    const res = await asAdmin.mutation(api.parents.sendClaimInvite, { parentId });
    expect(res.sent).toBe(true);
    expect(res.email).toBe("hana.park@example.com");
  });

  test("a non-admin (scholar) cannot send invites", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", "s");
    const parentId = await setupParent(t, "hana.park@example.com");
    const asScholar = await withUser(t, scholar);
    await expect(
      asScholar.mutation(api.parents.sendClaimInvite, { parentId }),
    ).rejects.toThrow();
  });

  test("rejects a non-parent target and a parent with no email", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "admin");
    const asAdmin = await withUser(t, admin);

    const scholarId = await seedUser(t, "scholar", "kai", "kai@home.com");
    await expect(
      asAdmin.mutation(api.parents.sendClaimInvite, { parentId: scholarId }),
    ).rejects.toThrow(/parent not found/i);

    const noEmailParent = await setupParent(t); // no email
    await expect(
      asAdmin.mutation(api.parents.sendClaimInvite, { parentId: noEmailParent }),
    ).rejects.toThrow(/no valid email/i);
  });
});
