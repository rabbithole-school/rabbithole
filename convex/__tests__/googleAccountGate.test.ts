import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { ROLES, STAFF_ROLES, type Role } from "../lib/roles";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: Role,
  username: string,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: `Test ${username}`, username, role }),
  );
}

async function asUser(
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

/**
 * The Google account link is gated in five places (the OAuth actions, the two
 * Slack Drive tools, the inline Slack resolver, the profile row, and this
 * status query). They drifted apart twice: a registrar (now retired; its
 * successor is a base `staff` user) was authorised to ingest Drive files for
 * the scanner inbox but couldn't mint a token, and later could see a
 * "Connect" row backed by a query that threw at them.
 *
 * So assert the READ gate directly against the role list the WRITE path uses,
 * rather than restating a role set a future edit could change in one place.
 */
describe("googleAccounts.status role gate", () => {
  test.each(STAFF_ROLES)("%s can read their own link status", async (role) => {
    const t = convexTest(schema, modules);
    const user = await seedUser(t, role, `staff-${role}`);
    const as = await asUser(t, user);
    await expect(as.query(api.googleAccounts.status, {})).resolves.toMatchObject(
      { connected: false },
    );
  });

  test("a staff member (registrar's successor role) sees a real link, not an error", async () => {
    const t = convexTest(schema, modules);
    const user = await seedUser(t, ROLES.STAFF, "sloane");
    await t.run(async (ctx) =>
      ctx.db.insert("googleAccounts", {
        userId: user,
        googleSub: "sub-sloane",
        email: "sloane@moli.school",
        accessToken: "at",
        refreshToken: "rt",
        expiresAt: Date.now() + 3_600_000,
        scopes: ["https://www.googleapis.com/auth/drive.readonly"],
        connectedAt: Date.now(),
      }),
    );
    const as = await asUser(t, user);
    expect(await as.query(api.googleAccounts.status, {})).toMatchObject({
      connected: true,
      email: "sloane@moli.school",
    });
  });

  test.each([ROLES.SCHOLAR, ROLES.PARENT, ROLES.LIFELONG_LEARNER])(
    "%s is refused",
    async (role) => {
      const t = convexTest(schema, modules);
      const user = await seedUser(t, role, `nonstaff-${role}`);
      const as = await asUser(t, user);
      await expect(as.query(api.googleAccounts.status, {})).rejects.toThrow(
        /Forbidden/,
      );
    },
  );

  test("signed-out callers are refused", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(api.googleAccounts.status, {})).rejects.toThrow(
      /Not authenticated/,
    );
  });
});
