import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { sha256Hex } from "../lib/oauthCrypto";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" | "platform_admin",
  username: string,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: `Test ${username}`, username, role }),
  );
}

async function withUser(
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

const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"; // RFC 7636 vector

async function registerTestClient(
  t: ReturnType<typeof convexTest>,
  redirectUris = ["https://claude.ai/api/mcp/auth_callback"],
) {
  return await t.mutation(api.mcpOauth.registerClient, {
    clientName: "Claude",
    redirectUris,
  });
}

describe("mcpOauth.registerClient — open DCR with guardrails", () => {
  test("registers a client and getClient round-trips", async () => {
    const t = convexTest(schema, modules);
    const { clientId } = await registerTestClient(t);
    expect(clientId).toMatch(/^[0-9a-f]{32}$/);
    const client = await t.query(api.mcpOauth.getClient, { clientId });
    expect(client?.clientName).toBe("Claude");
    expect(client?.redirectUris).toEqual([
      "https://claude.ai/api/mcp/auth_callback",
    ]);
  });

  test("accepts loopback http for local clients", async () => {
    const t = convexTest(schema, modules);
    const { clientId } = await registerTestClient(t, [
      "http://localhost:33418/callback",
      "http://127.0.0.1:33418/callback",
    ]);
    expect(clientId).toBeTruthy();
  });

  test("rejects empty, oversized, and non-https/non-loopback URI lists", async () => {
    const t = convexTest(schema, modules);
    await expect(registerTestClient(t, [])).rejects.toThrow("1-10");
    await expect(
      registerTestClient(t, Array(11).fill("https://example.com/cb")),
    ).rejects.toThrow("1-10");
    for (const bad of [
      "http://evil.example.com/cb", // http on a non-loopback host
      "ftp://example.com/cb",
      "not a url",
      "https://example.com/cb#fragment",
    ]) {
      await expect(registerTestClient(t, [bad])).rejects.toThrow(
        "Unacceptable redirect_uri",
      );
    }
  });
});

describe("mcpOauth.approve — consent mints a user-bound one-shot code", () => {
  test("requires authentication", async () => {
    const t = convexTest(schema, modules);
    const { clientId } = await registerTestClient(t);
    await expect(
      t.mutation(api.mcpOauth.approve, {
        clientId,
        redirectUri: "https://claude.ai/api/mcp/auth_callback",
        codeChallenge: CHALLENGE,
        codeChallengeMethod: "S256",
      }),
    ).rejects.toThrow("Not authenticated");
  });

  test("validates client, redirect_uri membership, and S256", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "teach");
    const asTeacher = await withUser(t, teacher);
    const { clientId } = await registerTestClient(t);

    await expect(
      asTeacher.mutation(api.mcpOauth.approve, {
        clientId: "nope",
        redirectUri: "https://claude.ai/api/mcp/auth_callback",
        codeChallenge: CHALLENGE,
        codeChallengeMethod: "S256",
      }),
    ).rejects.toThrow("Unknown client");

    await expect(
      asTeacher.mutation(api.mcpOauth.approve, {
        clientId,
        redirectUri: "https://attacker.example.com/cb",
        codeChallenge: CHALLENGE,
        codeChallengeMethod: "S256",
      }),
    ).rejects.toThrow("not registered");

    await expect(
      asTeacher.mutation(api.mcpOauth.approve, {
        clientId,
        redirectUri: "https://claude.ai/api/mcp/auth_callback",
        codeChallenge: CHALLENGE,
        codeChallengeMethod: "plain",
      }),
    ).rejects.toThrow("S256");
  });

  test("the code is hashed at rest, bound to the approver, and one-shot", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "teach");
    const asTeacher = await withUser(t, teacher);
    const { clientId } = await registerTestClient(t);

    const { code } = await asTeacher.mutation(api.mcpOauth.approve, {
      clientId,
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
      codeChallenge: CHALLENGE,
      codeChallengeMethod: "S256",
    });
    expect(code).toMatch(/^[0-9a-f]{64}$/);

    // Raw code is never stored — only its hash.
    const rows = await t.run(async (ctx) =>
      ctx.db.query("mcpOauthCodes").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].codeHash).toBe(await sha256Hex(code));
    expect(rows[0].codeHash).not.toBe(code);
    expect(rows[0].userId).toBe(teacher);

    // First take wins…
    const grant = await t.run(async (ctx) =>
      ctx.runMutation(internal.mcpOauth.takeCode, {
        codeHash: await sha256Hex(code),
      }),
    );
    expect(grant?.userId).toBe(teacher);
    expect(grant?.clientId).toBe(clientId);
    expect(grant?.codeChallenge).toBe(CHALLENGE);

    // …second take gets nothing (anti-replay).
    const again = await t.run(async (ctx) =>
      ctx.runMutation(internal.mcpOauth.takeCode, {
        codeHash: await sha256Hex(code),
      }),
    );
    expect(again).toBeNull();
  });

  test("expired codes are rejected (and swept)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "teach");
    const hash = await sha256Hex("stale-code");
    await t.run(async (ctx) => {
      await ctx.db.insert("mcpOauthCodes", {
        codeHash: hash,
        clientId: "c",
        userId: teacher,
        redirectUri: "https://claude.ai/api/mcp/auth_callback",
        codeChallenge: CHALLENGE,
        expiresAt: Date.now() - 1000,
      });
    });
    const grant = await t.run(async (ctx) =>
      ctx.runMutation(internal.mcpOauth.takeCode, { codeHash: hash }),
    );
    expect(grant).toBeNull();
    const remaining = await t.run(async (ctx) =>
      ctx.db.query("mcpOauthCodes").collect(),
    );
    expect(remaining).toHaveLength(0);
  });
});

describe("mcpOauth — remembered consent (skip the click on reconnect)", () => {
  const approveArgs = (clientId: string, remember?: boolean) => ({
    clientId,
    redirectUri: "https://claude.ai/api/mcp/auth_callback",
    codeChallenge: CHALLENGE,
    codeChallengeMethod: "S256",
    ...(remember !== undefined ? { remember } : {}),
  });

  test("approve without remember records no consent; hasConsent is false", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "teach");
    const asTeacher = await withUser(t, teacher);
    const { clientId } = await registerTestClient(t);

    await asTeacher.mutation(api.mcpOauth.approve, approveArgs(clientId));
    expect(
      await asTeacher.query(api.mcpOauth.hasConsent, { clientId }),
    ).toBe(false);
    const rows = await t.run(async (ctx) =>
      ctx.db.query("mcpOauthConsents").collect(),
    );
    expect(rows).toHaveLength(0);
  });

  test("approve with remember records consent; hasConsent flips true, idempotent", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "teach");
    const asTeacher = await withUser(t, teacher);
    const { clientId } = await registerTestClient(t);

    await asTeacher.mutation(api.mcpOauth.approve, approveArgs(clientId, true));
    expect(
      await asTeacher.query(api.mcpOauth.hasConsent, { clientId }),
    ).toBe(true);
    // Re-approving the same client doesn't create a duplicate consent row.
    await asTeacher.mutation(api.mcpOauth.approve, approveArgs(clientId, true));
    const rows = await t.run(async (ctx) =>
      ctx.db.query("mcpOauthConsents").collect(),
    );
    expect(rows).toHaveLength(1);
  });

  test("consent is per-user", async () => {
    const t = convexTest(schema, modules);
    const a = await seedUser(t, "teacher", "teach-a");
    const b = await seedUser(t, "teacher", "teach-b");
    const asA = await withUser(t, a);
    const asB = await withUser(t, b);
    const { clientId } = await registerTestClient(t);

    await asA.mutation(api.mcpOauth.approve, approveArgs(clientId, true));
    expect(await asA.query(api.mcpOauth.hasConsent, { clientId })).toBe(true);
    expect(await asB.query(api.mcpOauth.hasConsent, { clientId })).toBe(false);
  });

  test("revoking a connection forgets its remembered consent", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "teach");
    const asTeacher = await withUser(t, teacher);
    const { clientId } = await registerTestClient(t);

    // Consent + an active session for the same client.
    await asTeacher.mutation(api.mcpOauth.approve, approveArgs(clientId, true));
    await asTeacher.mutation(api.mcpOauth.recordMySession, { clientId });
    expect(await asTeacher.query(api.mcpOauth.hasConsent, { clientId })).toBe(
      true,
    );

    const list = await asTeacher.query(api.mcpOauth.listMySessions, {});
    expect(list).toHaveLength(1);
    await asTeacher.mutation(api.mcpOauth.revokeMySession, { id: list[0]._id });

    // Revoke clears consent → next reconnect prompts again.
    expect(await asTeacher.query(api.mcpOauth.hasConsent, { clientId })).toBe(
      false,
    );
  });
});
