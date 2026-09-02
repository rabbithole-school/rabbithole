/**
 * OAuth 2.1 state for the remote MCP connector — the Convex half of the
 * flow served by the Next.js endpoints (app/api/oauth/*, /oauth/authorize).
 *
 * Flow:
 *   1. Claude POSTs /api/oauth/register → `registerClient` (RFC 7591 open
 *      dynamic registration — unauthenticated by spec; public client, PKCE,
 *      no secret).
 *   2. The user lands on /oauth/authorize, signs in with their normal
 *      Rabbithole credentials, and consents → `approve` mints a one-shot
 *      authorization code bound to THEIR userId + the client's PKCE
 *      challenge. Only the sha256 of the code is stored.
 *   3. Claude exchanges the code at /api/oauth/token → the "mcp"
 *      ConvexCredentials provider (auth.ts) consumes it via `takeCode`,
 *      verifies PKCE, and mints a REAL Convex Auth session — so the MCP
 *      access token IS a normal Convex JWT and every existing role /
 *      guardianship gate applies unchanged. Refresh goes through the
 *      standard `auth:signIn { refreshToken }` machinery.
 *
 * This replaced the bearer `tokens` table (deleted 2026-06).
 */
import { v } from "convex/values";
import { mutation, query, internalMutation } from "./_generated/server";
import { authedMutation, authedQuery } from "./lib/customFunctions";
import { randomToken, sha256Hex } from "./lib/oauthCrypto";
import { getAuthSessionId } from "@convex-dev/auth/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

/** Auth codes are one-shot and short-lived: 10 minutes (RFC 6749 §4.1.2). */
const AUTH_CODE_TTL_MS = 10 * 60 * 1000;

/**
 * Validate a redirect URI for client registration. HTTPS for real
 * clients; plain HTTP only for loopback (local MCP clients / dev).
 * No fragments (RFC 6749 §3.1.2).
 */
export function isAcceptableRedirectUri(uri: string): boolean {
  if (uri.length > 2000) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") {
    return (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]"
    );
  }
  return false;
}

/**
 * RFC 7591 dynamic client registration. Unauthenticated by spec — anyone
 * may register a client, because a client grants NOTHING by itself: data
 * access requires a real user to sign in and consent on /oauth/authorize,
 * and the code/token are PKCE-bound to that registration. Input caps keep
 * the table from being a junk-drawer for abuse.
 */
export const registerClient = mutation({
  args: {
    clientName: v.optional(v.string()),
    redirectUris: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.redirectUris.length < 1 || args.redirectUris.length > 10) {
      throw new Error("redirect_uris must contain 1-10 entries");
    }
    for (const uri of args.redirectUris) {
      if (!isAcceptableRedirectUri(uri)) {
        throw new Error(`Unacceptable redirect_uri: ${uri}`);
      }
    }
    const clientName = args.clientName?.trim().slice(0, 200) || undefined;
    const clientId = randomToken(16);
    await ctx.db.insert("mcpOauthClients", {
      clientId,
      clientName,
      redirectUris: args.redirectUris,
    });
    return { clientId };
  },
});

/**
 * Public lookup for the consent page: shows the client's name and lets
 * the page validate the redirect_uri BEFORE rendering consent (an invalid
 * redirect_uri must error in-page, never redirect — RFC 6749 §4.1.2.1).
 */
export const getClient = query({
  args: { clientId: v.string() },
  handler: async (ctx, args) => {
    const client = await ctx.db
      .query("mcpOauthClients")
      .withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
      .unique();
    if (!client) return null;
    return {
      clientName: client.clientName ?? null,
      redirectUris: client.redirectUris,
    };
  },
});

/**
 * The consent step: the signed-in user approves the connection and we
 * mint an authorization code bound to THEIR userId. Any authed user may
 * call this — the code only ever grants access to the caller's own
 * identity, so there's nothing to escalate.
 */
export const approve = authedMutation({
  args: {
    clientId: v.string(),
    redirectUri: v.string(),
    codeChallenge: v.string(),
    codeChallengeMethod: v.string(),
    scope: v.optional(v.string()),
    // When true, remember this consent so future authorize requests for the
    // same client auto-approve (skips the consent click). Set by the "Remember
    // this connection" checkbox; absent on a silent auto-approve.
    remember: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const client = await ctx.db
      .query("mcpOauthClients")
      .withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
      .unique();
    if (!client) throw new Error("Unknown client");
    if (!client.redirectUris.includes(args.redirectUri)) {
      throw new Error("redirect_uri not registered for this client");
    }
    if (args.codeChallengeMethod !== "S256") {
      throw new Error("Only the S256 code_challenge_method is supported");
    }
    // base64url(sha256) is exactly 43 chars; accept a small range for safety.
    if (!/^[A-Za-z0-9\-_]{43,128}$/.test(args.codeChallenge)) {
      throw new Error("Malformed code_challenge");
    }

    const code = randomToken(32);
    await ctx.db.insert("mcpOauthCodes", {
      codeHash: await sha256Hex(code),
      clientId: args.clientId,
      userId: ctx.user._id,
      redirectUri: args.redirectUri,
      codeChallenge: args.codeChallenge,
      scope: args.scope,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    });

    if (args.remember) {
      const now = Date.now();
      const existing = await ctx.db
        .query("mcpOauthConsents")
        .withIndex("by_user_client", (q) =>
          q.eq("userId", ctx.user._id).eq("clientId", args.clientId),
        )
        .unique();
      if (existing) {
        await ctx.db.patch(existing._id, { lastUsedAt: now });
      } else {
        await ctx.db.insert("mcpOauthConsents", {
          userId: ctx.user._id,
          clientId: args.clientId,
          createdAt: now,
          lastUsedAt: now,
        });
      }
    }
    return { code };
  },
});

/**
 * Whether the caller has already granted remembered consent to this client.
 * The consent page uses this to auto-approve (skip the click) on reconnect.
 */
export const hasConsent = authedQuery({
  args: { clientId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("mcpOauthConsents")
      .withIndex("by_user_client", (q) =>
        q.eq("userId", ctx.user._id).eq("clientId", args.clientId),
      )
      .unique();
    return row !== null;
  },
});

/**
 * One-shot consume of an authorization code, keyed by hash. Deletes the
 * row on ANY lookup hit — a failed exchange attempt burns the code (safer
 * than leaving it live for a second try). Expiry is checked here so the
 * caller (the "mcp" provider in auth.ts) gets null for stale codes.
 * Opportunistically sweeps other expired codes to keep the table tidy.
 */
export const takeCode = internalMutation({
  args: { codeHash: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("mcpOauthCodes")
      .withIndex("by_codeHash", (q) => q.eq("codeHash", args.codeHash))
      .unique();
    if (row) await ctx.db.delete(row._id);

    // Sweep a handful of expired codes (10-min TTL keeps this tiny).
    const now = Date.now();
    const all = await ctx.db.query("mcpOauthCodes").take(50);
    for (const stale of all) {
      if (stale.expiresAt < now) await ctx.db.delete(stale._id);
    }

    if (!row || row.expiresAt < now) return null;
    return {
      clientId: row.clientId,
      userId: row.userId,
      redirectUri: row.redirectUri,
      codeChallenge: row.codeChallenge,
      scope: row.scope ?? null,
    };
  },
});

// ── Active-connection management (Account Details → "Connect Claude") ────
//
// An MCP token is a stock Convex Auth session, indistinguishable from a
// browser session, so we keep a sidecar (`mcpSessions`) the connecting
// session writes about ITSELF at token-exchange. That gives the user a
// list to see + revoke without us having to reverse-engineer which
// authSessions rows are MCP ones.

/** Delete dead sidecar rows for a user (authSessions parent gone/expired). */
async function pruneDeadSessions(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<void> {
  const now = Date.now();
  const rows = await ctx.db
    .query("mcpSessions")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const row of rows) {
    const session = await ctx.db.get(row.sessionId);
    if (!session || session.expirationTime < now) {
      await ctx.db.delete(row._id);
    }
  }
}

/**
 * The just-authenticated MCP session records itself. Called from the OAuth
 * token endpoint after a successful exchange, authenticated as the new
 * session — so `getAuthSessionId` returns ITS OWN sessionId (a caller can
 * never register a session it doesn't hold). `clientId` is passed on the
 * initial code exchange; on refresh it's omitted and we just bump
 * `lastSeenAt`. Idempotent per session.
 */
export const recordMySession = authedMutation({
  args: { clientId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const sessionId = await getAuthSessionId(ctx);
    if (!sessionId) return; // not session-backed (shouldn't happen via token)
    const typedSessionId = sessionId as Id<"authSessions">;
    const now = Date.now();

    const existing = await ctx.db
      .query("mcpSessions")
      .withIndex("by_session", (q) => q.eq("sessionId", typedSessionId))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { lastSeenAt: now });
      return;
    }

    let clientName: string | undefined;
    if (args.clientId) {
      const client = await ctx.db
        .query("mcpOauthClients")
        .withIndex("by_clientId", (q) => q.eq("clientId", args.clientId!))
        .unique();
      clientName = client?.clientName ?? undefined;
    }
    await ctx.db.insert("mcpSessions", {
      sessionId: typedSessionId,
      userId: ctx.user._id,
      clientId: args.clientId ?? "unknown",
      clientName,
      createdAt: now,
      lastSeenAt: now,
    });
    // Opportunistic GC so the list stays clean without a dedicated cron.
    await pruneDeadSessions(ctx, ctx.user._id);
  },
});

/** The caller's active MCP connections (live sessions only). */
export const listMySessions = authedQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const rows = await ctx.db
      .query("mcpSessions")
      .withIndex("by_user", (q) => q.eq("userId", ctx.user._id))
      .collect();
    const live = [];
    for (const row of rows) {
      const session = await ctx.db.get(row.sessionId);
      if (!session || session.expirationTime < now) continue;
      live.push({
        _id: row._id,
        clientName: row.clientName ?? null,
        createdAt: row.createdAt,
        lastSeenAt: row.lastSeenAt,
        expiresAt: session.expirationTime,
      });
    }
    live.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    return live;
  },
});

/**
 * Revoke one of the caller's MCP connections: delete the underlying auth
 * session (which kills the access + refresh tokens) and the sidecar row.
 * Mirrors the framework's `deleteSession` (session row + its refresh
 * tokens). Owner-checked — you can only revoke your own.
 */
export const revokeMySession = authedMutation({
  args: { id: v.id("mcpSessions") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row || row.userId !== ctx.user._id) {
      throw new Error("Forbidden");
    }
    const refreshTokens = await ctx.db
      .query("authRefreshTokens")
      .withIndex("sessionId", (q) => q.eq("sessionId", row.sessionId))
      .collect();
    for (const rt of refreshTokens) await ctx.db.delete(rt._id);
    await ctx.db.delete(row.sessionId);
    await ctx.db.delete(row._id);

    // Forget remembered consent too — a revoke should stop silent re-granting,
    // so the next reconnect of this client prompts the consent screen again.
    const consent = await ctx.db
      .query("mcpOauthConsents")
      .withIndex("by_user_client", (q) =>
        q.eq("userId", ctx.user._id).eq("clientId", row.clientId),
      )
      .unique();
    if (consent) await ctx.db.delete(consent._id);
  },
});
