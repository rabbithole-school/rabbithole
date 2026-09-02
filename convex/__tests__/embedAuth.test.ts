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

// Standard fixtures (copied verbatim per .claude/rules/rabbithole-testing.md).
async function seedUser(
  t: ReturnType<typeof convexTest>,
  role = "scholar",
  overrides: { name?: string; username?: string } = {},
): Promise<Id<"users">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: overrides.name ?? `Test ${role}`,
      username: overrides.username ?? `test-${role}`,
      role,
    }),
  );
}

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

const consume = (t: ReturnType<typeof convexTest>, token: string) =>
  t.run(async (ctx) => ctx.runMutation(internal.embedAuth.consumeEmbedToken, { token }));

const allTokenRows = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => ctx.db.query("embedSessionTokens").collect());

describe("embedAuth one-shot embed-session handoff", () => {
  test("issued token consumes to the CALLER's own identity, exactly once", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", { username: "embed-scholar" });
    const asScholar = await withUser(t, scholar);

    const { token } = await asScholar.mutation(api.embedAuth.issueEmbedToken, {});
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThanOrEqual(32);

    // First consume returns the caller's userId — never a target passed in.
    const first = await consume(t, token);
    expect(first?.userId).toBe(scholar);

    // Single-use: the second consume of the same token is rejected.
    const second = await consume(t, token);
    expect(second).toBeNull();
  });

  test("the raw token never lands in the DB — only its sha256 hash", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", { username: "embed-hash" });
    const asScholar = await withUser(t, scholar);

    const { token } = await asScholar.mutation(api.embedAuth.issueEmbedToken, {});

    const rows = await allTokenRows(t);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    // Stored value is the hash, not the raw token.
    expect(row.tokenHash).toBe(await sha256Hex(token));
    expect(row.tokenHash).not.toBe(token);
    // No column anywhere holds the raw token.
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.userId).toBe(scholar);
    expect(row.usedAt).toBeUndefined();
  });

  test("expired token is rejected", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", { username: "embed-expired" });
    const asScholar = await withUser(t, scholar);

    const { token } = await asScholar.mutation(api.embedAuth.issueEmbedToken, {});
    // Force the single row to have already expired.
    await t.run(async (ctx) => {
      const row = await ctx.db.query("embedSessionTokens").first();
      if (row) await ctx.db.patch(row._id, { expiresAt: Date.now() - 1_000 });
    });

    expect(await consume(t, token)).toBeNull();
  });

  test("an unknown / forged token is rejected", async () => {
    const t = convexTest(schema, modules);
    expect(await consume(t, "not-a-real-token")).toBeNull();
    expect(await consume(t, "")).toBeNull();
  });

  test("issuing requires an authenticated caller", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(api.embedAuth.issueEmbedToken, {})).rejects.toThrow();
  });

  test("caller-scoped: a teacher (rehearsing) mints a token for THEMSELVES", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", { username: "embed-teacher" });
    const scholar = await seedUser(t, "scholar", { username: "embed-other" });
    const asTeacher = await withUser(t, teacher);

    const { token } = await asTeacher.mutation(api.embedAuth.issueEmbedToken, {});
    const consumed = await consume(t, token);
    // The token resolves to the teacher, never the scholar — issuance is
    // caller-scoped and role-agnostic (test-drive works).
    expect(consumed?.userId).toBe(teacher);
    expect(consumed?.userId).not.toBe(scholar);
  });

  test("each caller's token is bound to that caller only", async () => {
    const t = convexTest(schema, modules);
    const a = await seedUser(t, "scholar", { username: "embed-a" });
    const b = await seedUser(t, "scholar", { username: "embed-b" });

    const { token: tokenA } = await (await withUser(t, a)).mutation(
      api.embedAuth.issueEmbedToken,
      {},
    );
    const { token: tokenB } = await (await withUser(t, b)).mutation(
      api.embedAuth.issueEmbedToken,
      {},
    );

    expect((await consume(t, tokenA))?.userId).toBe(a);
    expect((await consume(t, tokenB))?.userId).toBe(b);
  });

  test("sweep removes used and expired rows, keeps live ones", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", { username: "embed-sweep" });
    const asScholar = await withUser(t, scholar);

    // Live (unused, unexpired) — kept.
    await asScholar.mutation(api.embedAuth.issueEmbedToken, {});
    // Used — swept.
    const { token: usedToken } = await asScholar.mutation(api.embedAuth.issueEmbedToken, {});
    await consume(t, usedToken);
    // Expired — swept.
    const { token: expiredToken } = await asScholar.mutation(api.embedAuth.issueEmbedToken, {});
    await t.run(async (ctx) => {
      const hash = await sha256Hex(expiredToken);
      const row = await ctx.db
        .query("embedSessionTokens")
        .withIndex("by_tokenHash", (q) => q.eq("tokenHash", hash))
        .unique();
      if (row) await ctx.db.patch(row._id, { expiresAt: Date.now() - 1_000 });
    });

    const before = await allTokenRows(t);
    expect(before).toHaveLength(3);

    const result = await t.run(async (ctx) =>
      ctx.runMutation(internal.embedAuth.sweepStaleEmbedTokens, {}),
    );
    expect(result.removed).toBe(2);

    const after = await allTokenRows(t);
    expect(after).toHaveLength(1);
    expect(after[0].usedAt).toBeUndefined();
  });
});
