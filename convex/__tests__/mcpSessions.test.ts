import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { mcpSessionIdleMs } from "../mcpOauth";
import { pkceChallengeFromVerifier } from "../lib/oauthCrypto";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const newTest = () => convexTest(schema, modules);
type TestConvex = ReturnType<typeof newTest>;

const DAY_MS = 24 * 60 * 60 * 1000;
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

async function seedUser(
  t: TestConvex,
  username: string,
  role: "scholar" | "teacher" | "platform_admin" = "teacher",
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: `Test ${username}`, username, role }),
  );
}

/** The identity shape getAuthSessionId reads: subject = `${userId}|${sessionId}`. */
function asSession(
  t: TestConvex,
  userId: Id<"users">,
  sessionId: Id<"authSessions">,
) {
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

/** A plain browser-style session: an authSessions row with no MCP sidecar. */
async function withBrowserSession(
  t: TestConvex,
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
  return { sessionId, as: asSession(t, userId, sessionId) };
}

/** An MCP connection as the code exchange creates it (session + sidecar). */
async function withMcpSession(
  t: TestConvex,
  userId: Id<"users">,
  clientId = "client",
) {
  const sessionId = await t.mutation(internal.mcpOauth.openSession, {
    userId,
    clientId,
  });
  return { sessionId, as: asSession(t, userId, sessionId) };
}

async function setSessionEnd(
  t: TestConvex,
  sessionId: Id<"authSessions">,
  expirationTime: number,
) {
  await t.run(async (ctx) => ctx.db.patch(sessionId, { expirationTime }));
}

async function sessionEnd(
  t: TestConvex,
  sessionId: Id<"authSessions">,
) {
  return await t.run(async (ctx) => (await ctx.db.get(sessionId))?.expirationTime);
}

async function sidecars(t: TestConvex, userId: Id<"users">) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("mcpSessions")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect(),
  );
}

describe("mcpOauth.openSession — the code exchange's session + record", () => {
  test("mints a session for the user and records it with the client's name", async () => {
    const t = newTest();
    const userId = await seedUser(t, "teach-open");
    const { clientId } = await t.mutation(api.mcpOauth.registerClient, {
      clientName: "Claude Desktop",
      redirectUris: [REDIRECT_URI],
    });

    const before = Date.now();
    const { sessionId } = await withMcpSession(t, userId, clientId);

    const session = await t.run(async (ctx) => ctx.db.get(sessionId));
    expect(session?.userId).toBe(userId);
    expect(session!.expirationTime).toBeGreaterThanOrEqual(
      before + mcpSessionIdleMs(),
    );
    const rows = await sidecars(t, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe(sessionId);
    expect(rows[0].clientId).toBe(clientId);
    expect(rows[0].clientName).toBe("Claude Desktop");
  });

  test("a new connect prunes records whose session has ended", async () => {
    const t = newTest();
    const userId = await seedUser(t, "teach-prune");
    const { sessionId: dead } = await withMcpSession(t, userId, "dead");
    await setSessionEnd(t, dead, Date.now() - 1000);

    await withMcpSession(t, userId, "live");

    const rows = await sidecars(t, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].clientId).toBe("live");
  });
});

describe("mcpOauth.recordMySession — use keeps a connection alive", () => {
  test("pushes a nearly-ended MCP session out to the idle limit and bumps lastSeenAt", async () => {
    const t = newTest();
    const userId = await seedUser(t, "teach-renew");
    const { sessionId, as } = await withMcpSession(t, userId);
    // The old failure: an active connection one minute from its fixed end.
    await setSessionEnd(t, sessionId, Date.now() + 60_000);
    const [before] = await sidecars(t, userId);

    const renewedAt = Date.now();
    await as.mutation(api.mcpOauth.recordMySession, {});

    expect(await sessionEnd(t, sessionId)).toBeGreaterThanOrEqual(
      renewedAt + mcpSessionIdleMs(),
    );
    const [after] = await sidecars(t, userId);
    expect(after.lastSeenAt).toBeGreaterThanOrEqual(before.lastSeenAt);
  });

  test("never shortens a session", async () => {
    const t = newTest();
    const userId = await seedUser(t, "teach-noshrink");
    const { sessionId, as } = await withMcpSession(t, userId);
    const far = Date.now() + 2 * mcpSessionIdleMs();
    await setSessionEnd(t, sessionId, far);

    await as.mutation(api.mcpOauth.recordMySession, {});

    expect(await sessionEnd(t, sessionId)).toBe(far);
  });

  test("leaves a browser session alone and creates no record for it", async () => {
    const t = newTest();
    const userId = await seedUser(t, "teach-browser");
    const { clientId } = await t.mutation(api.mcpOauth.registerClient, {
      clientName: "Claude",
      redirectUris: [REDIRECT_URI],
    });
    const { sessionId, as } = await withBrowserSession(t, userId, DAY_MS);
    const end = await sessionEnd(t, sessionId);

    // The old path: naming a real client used to write the record.
    await as.mutation(api.mcpOauth.recordMySession, { clientId });

    expect(await sessionEnd(t, sessionId)).toBe(end);
    expect(await sidecars(t, userId)).toHaveLength(0);
  });

  test("renews a read-only account's connection too", async () => {
    const t = newTest();
    const userId = await seedUser(t, "readonly-renew");
    await t.run(async (ctx) => ctx.db.patch(userId, { readOnly: true }));
    const { sessionId, as } = await withMcpSession(t, userId);
    await setSessionEnd(t, sessionId, Date.now() + 60_000);

    const renewedAt = Date.now();
    await as.mutation(api.mcpOauth.recordMySession, {});

    expect(await sessionEnd(t, sessionId)).toBeGreaterThanOrEqual(
      renewedAt + mcpSessionIdleMs(),
    );
  });

  test("does not revive a session that has already ended", async () => {
    const t = newTest();
    const userId = await seedUser(t, "teach-ended");
    const { sessionId, as } = await withMcpSession(t, userId);
    const ended = Date.now() - 1000;
    await setSessionEnd(t, sessionId, ended);

    await as.mutation(api.mcpOauth.recordMySession, {});

    expect(await sessionEnd(t, sessionId)).toBe(ended);
  });
});

describe("mcpOauth — listing and revoking connections", () => {
  test("listMySessions returns live sessions only", async () => {
    const t = newTest();
    const userId = await seedUser(t, "teach-list");
    const { as } = await withMcpSession(t, userId, "live");
    const { sessionId: dead } = await withMcpSession(t, userId, "dead");
    await setSessionEnd(t, dead, Date.now() - 1000);

    const list = await as.query(api.mcpOauth.listMySessions, {});
    expect(list).toHaveLength(1);
    expect(list[0].expiresAt).toBeGreaterThan(Date.now());
  });

  test("revokeMySession kills the auth session + refresh tokens + record", async () => {
    const t = newTest();
    const userId = await seedUser(t, "teach-rev");
    const { sessionId, as } = await withMcpSession(t, userId);
    // Seed a refresh token bound to the session (framework would create one).
    await t.run(async (ctx) =>
      ctx.db.insert("authRefreshTokens", {
        sessionId,
        expirationTime: Date.now() + 1000 * 60 * 60,
      }),
    );

    const list = await as.query(api.mcpOauth.listMySessions, {});
    expect(list).toHaveLength(1);
    await as.mutation(api.mcpOauth.revokeMySession, { id: list[0]._id });

    expect(await t.run(async (ctx) => ctx.db.get(sessionId))).toBeNull();
    const refresh = await t.run(async (ctx) =>
      ctx.db
        .query("authRefreshTokens")
        .withIndex("sessionId", (q) => q.eq("sessionId", sessionId))
        .collect(),
    );
    expect(refresh).toHaveLength(0);
    expect(await sidecars(t, userId)).toHaveLength(0);
  });

  test("revokeMySession refuses another user's connection", async () => {
    const t = newTest();
    const ownerId = await seedUser(t, "owner-rev");
    const otherId = await seedUser(t, "other-rev");
    const { as: ownerAs } = await withMcpSession(t, ownerId);
    const list = await ownerAs.query(api.mcpOauth.listMySessions, {});

    const { as: otherAs } = await withBrowserSession(t, otherId);
    await expect(
      otherAs.mutation(api.mcpOauth.revokeMySession, { id: list[0]._id }),
    ).rejects.toThrow(/forbidden/i);
  });
});

// ── End to end through Convex Auth: exchange → refresh → renew ───────────
//
// The token endpoint makes exactly these calls. This runs the real "mcp"
// provider and the library's refresh logic, so it proves Convex Auth mints
// tokens on the session openSession created, and that refreshing then
// renewing carries a connection past the moment it used to expire.

async function rsaPrivateKeyPem(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  let binary = "";
  for (const byte of der) binary += String.fromCharCode(byte);
  const body = btoa(binary).match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN ${"PRIVATE"} KEY-----\n${body}\n-----END ${"PRIVATE"} KEY-----\n`;
}

describe("MCP connection through auth:signIn", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  test("a connection that keeps refreshing outlives its original end date", async () => {
    vi.stubEnv("JWT_PRIVATE_KEY", await rsaPrivateKeyPem());
    vi.stubEnv("CONVEX_SITE_URL", "https://example.test");
    const t = newTest();
    const userId = await seedUser(t, "teach-e2e");
    const { clientId } = await t.mutation(api.mcpOauth.registerClient, {
      clientName: "Claude",
      redirectUris: [REDIRECT_URI],
    });
    const verifier = "test-verifier-0123456789-abcdefghijklmnopqrstuvwxyz";
    const { sessionId: browserSession } = await withBrowserSession(t, userId);
    const { code } = await asSession(t, userId, browserSession).mutation(
      api.mcpOauth.approve,
      {
        clientId,
        redirectUri: REDIRECT_URI,
        codeChallenge: await pkceChallengeFromVerifier(verifier),
        codeChallengeMethod: "S256",
      },
    );

    // Code exchange: the tokens belong to the session openSession recorded.
    const exchanged = await t.action(api.auth.signIn, {
      provider: "mcp",
      params: { code, codeVerifier: verifier, clientId, redirectUri: REDIRECT_URI },
    });
    expect(exchanged.tokens).toBeTruthy();
    const sessionId = exchanged.tokens!.refreshToken.split("|")[1] as Id<"authSessions">;
    // What the token route sends right after the exchange; it must not
    // add a second record.
    await asSession(t, userId, sessionId).mutation(api.mcpOauth.recordMySession, {
      clientId,
    });
    const rows = await sidecars(t, userId);
    expect(rows.map((r) => r.sessionId)).toEqual([sessionId]);

    // A month of use later, one minute before the session's end date.
    await setSessionEnd(t, sessionId, Date.now() + 60_000);
    const refreshed = await t.action(api.auth.signIn, {
      refreshToken: exchanged.tokens!.refreshToken,
    });
    expect(refreshed.tokens).toBeTruthy();
    const renewedAt = Date.now();
    await asSession(t, userId, sessionId).mutation(api.mcpOauth.recordMySession, {});
    expect(await sessionEnd(t, sessionId)).toBeGreaterThanOrEqual(
      renewedAt + mcpSessionIdleMs(),
    );

    // An hour on, well past the old end date, the next refresh still works.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60 * 60_000);
    const again = await t.action(api.auth.signIn, {
      refreshToken: refreshed.tokens!.refreshToken,
    });
    expect(again.tokens).toBeTruthy();
  });

  test("a bad PKCE verifier mints no session and no record", async () => {
    vi.stubEnv("JWT_PRIVATE_KEY", await rsaPrivateKeyPem());
    vi.stubEnv("CONVEX_SITE_URL", "https://example.test");
    const t = newTest();
    const userId = await seedUser(t, "teach-badpkce");
    const { clientId } = await t.mutation(api.mcpOauth.registerClient, {
      clientName: "Claude",
      redirectUris: [REDIRECT_URI],
    });
    const { sessionId: browserSession } = await withBrowserSession(t, userId);
    const { code } = await asSession(t, userId, browserSession).mutation(
      api.mcpOauth.approve,
      {
        clientId,
        redirectUri: REDIRECT_URI,
        codeChallenge: await pkceChallengeFromVerifier(
          "right-verifier-0123456789-abcdefghijklmnopqrstuvwxyz",
        ),
        codeChallengeMethod: "S256",
      },
    );

    const result = await t.action(api.auth.signIn, {
      provider: "mcp",
      params: {
        code,
        codeVerifier: "wrong-verifier-0123456789-abcdefghijklmnopqrstuvwxyz",
        clientId,
        redirectUri: REDIRECT_URI,
      },
    });
    expect(result.tokens).toBeNull();
    expect(await sidecars(t, userId)).toHaveLength(0);
    const sessions = await t.run(async (ctx) =>
      ctx.db
        .query("authSessions")
        .withIndex("userId", (q) => q.eq("userId", userId))
        .collect(),
    );
    expect(sessions.map((s) => s._id)).toEqual([browserSession]);
  });
});
