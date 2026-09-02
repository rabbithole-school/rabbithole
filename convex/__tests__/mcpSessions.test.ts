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

async function seedUser(
  t: ReturnType<typeof convexTest>,
  username: string,
  role: "scholar" | "teacher" | "platform_admin" = "teacher",
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: `Test ${username}`, username, role }),
  );
}

/** Insert an authSessions row + return an identity bound to it (the shape
 *  getAuthSessionId reads: subject = `${userId}|${sessionId}`). */
async function withSession(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  ttlMs = 1000 * 60 * 60,
) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + ttlMs,
    };
    return await ctx.db.insert("authSessions", session);
  });
  const as = t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
  return { sessionId, as };
}

describe("mcpOauth — MCP session management", () => {
  test("recordMySession records the caller's own session + resolves client name", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "teach-rec");
    const { clientId } = await t.mutation(api.mcpOauth.registerClient, {
      clientName: "Claude Desktop",
      redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
    });
    const { sessionId, as } = await withSession(t, userId);

    await as.mutation(api.mcpOauth.recordMySession, { clientId });

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("mcpSessions")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect(),
    );
    expect(rows.length).toBe(1);
    expect(rows[0].sessionId).toBe(sessionId);
    expect(rows[0].clientId).toBe(clientId);
    expect(rows[0].clientName).toBe("Claude Desktop");
  });

  test("recordMySession is idempotent per session (bumps lastSeenAt, no dup)", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "teach-idem");
    const { as } = await withSession(t, userId);

    await as.mutation(api.mcpOauth.recordMySession, { clientId: "c1" });
    const first = await t.run(async (ctx) =>
      ctx.db
        .query("mcpSessions")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .unique(),
    );
    // Refresh exchange: no clientId, just a lastSeen bump.
    await as.mutation(api.mcpOauth.recordMySession, {});
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("mcpSessions")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect(),
    );
    expect(rows.length).toBe(1);
    expect(rows[0].lastSeenAt).toBeGreaterThanOrEqual(first!.lastSeenAt);
  });

  test("listMySessions returns live sessions only", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "teach-list");
    const { as: liveAs } = await withSession(t, userId);
    await liveAs.mutation(api.mcpOauth.recordMySession, { clientId: "live" });

    // A sidecar row whose auth session is already expired must be hidden.
    const { as: deadAs } = await withSession(t, userId, -1000);
    await deadAs.mutation(api.mcpOauth.recordMySession, { clientId: "dead" });

    const list = await liveAs.query(api.mcpOauth.listMySessions, {});
    expect(list.length).toBe(1);
    expect(list[0].expiresAt).toBeGreaterThan(Date.now());
  });

  test("a new connect prunes dead sidecar rows", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "teach-prune");
    // Dead session row first.
    const { as: deadAs } = await withSession(t, userId, -1000);
    await deadAs.mutation(api.mcpOauth.recordMySession, { clientId: "dead" });
    // A fresh connect should GC the dead one.
    const { as: liveAs } = await withSession(t, userId);
    await liveAs.mutation(api.mcpOauth.recordMySession, { clientId: "live" });

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("mcpSessions")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect(),
    );
    expect(rows.length).toBe(1);
    expect(rows[0].clientId).toBe("live");
  });

  test("revokeMySession kills the auth session + refresh tokens + sidecar", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "teach-rev");
    const { sessionId, as } = await withSession(t, userId);
    await as.mutation(api.mcpOauth.recordMySession, { clientId: "c" });
    // Seed a refresh token bound to the session (framework would create one).
    await t.run(async (ctx) =>
      ctx.db.insert("authRefreshTokens", {
        sessionId,
        expirationTime: Date.now() + 1000 * 60 * 60,
      }),
    );

    const list = await as.query(api.mcpOauth.listMySessions, {});
    expect(list.length).toBe(1);
    await as.mutation(api.mcpOauth.revokeMySession, { id: list[0]._id });

    // Auth session, refresh token, and sidecar are all gone.
    expect(await t.run(async (ctx) => ctx.db.get(sessionId))).toBeNull();
    const refresh = await t.run(async (ctx) =>
      ctx.db
        .query("authRefreshTokens")
        .withIndex("sessionId", (q) => q.eq("sessionId", sessionId))
        .collect(),
    );
    expect(refresh.length).toBe(0);
    const sidecar = await t.run(async (ctx) =>
      ctx.db
        .query("mcpSessions")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect(),
    );
    expect(sidecar.length).toBe(0);
  });

  test("revokeMySession refuses another user's connection", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await seedUser(t, "owner-rev");
    const otherId = await seedUser(t, "other-rev");
    const { as: ownerAs } = await withSession(t, ownerId);
    await ownerAs.mutation(api.mcpOauth.recordMySession, { clientId: "c" });
    const list = await ownerAs.query(api.mcpOauth.listMySessions, {});

    const { as: otherAs } = await withSession(t, otherId);
    await expect(
      otherAs.mutation(api.mcpOauth.revokeMySession, { id: list[0]._id }),
    ).rejects.toThrow(/forbidden/i);
  });
});
