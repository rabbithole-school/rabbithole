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
 *      verifies PKCE, and `openSession` mints a REAL Convex Auth session
 *      plus its `mcpSessions` row — so the MCP access token IS a normal
 *      Convex JWT and every existing role / guardianship gate applies
 *      unchanged. Refresh goes through the standard
 *      `auth:signIn { refreshToken }` machinery, then `recordMySession`
 *      pushes the session's end date out (mcpSessionIdleMs).
 *
 * This replaced the bearer `tokens` table (deleted 2026-06).
 */
import { v } from "convex/values";
import { mutation, query, internalMutation } from "./_generated/server";
import { authedMutation, authedQuery } from "./lib/customFunctions";
import { randomToken, sha256Hex } from "./lib/oauthCrypto";
import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

/** Auth codes are one-shot and short-lived: 10 minutes (RFC 6749 §4.1.2). */
const AUTH_CODE_TTL_MS = 10 * 60 * 1000;

/**
 * How long an MCP connection survives without refreshing. Every refresh
 * pushes the session's end date to now + this, so a connection in use never
 * hits Convex Auth's fixed 30-day session lifetime, which used to log every
 * connector out 30 days after it connected, however active it was. Read from
 * the same setting Convex Auth uses for refresh-token inactivity (default 30
 * days), so both limits agree: a connection unused that long ends and has to
 * be reconnected.
 */
export function mcpSessionIdleMs(): number {
  const configured = Number(process.env.AUTH_SESSION_INACTIVE_DURATION_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : 30 * 24 * 60 * 60 * 1000;
}

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
 * The consent screen's version. Bump it when an older screen misdescribed
 * what a connection can do: `hasConsent` ignores remembered consents from
 * older screens, so the person sees the corrected screen once instead of
 * auto-approving on the old one.
 *
 * 1 — TRA-635. Before it, a client could make the screen say "read-only" by
 *     naming /api/mcp/read in the RFC 8707 `resource` parameter, though the
 *     token it approved also worked on the full connector.
 */
export const CONSENT_SCREEN_VERSION = 1;

/** Cap on outstanding auth codes a revoke deletes in one transaction. */
const MAX_CODES_BURNED_ON_REVOKE = 256;

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
        await ctx.db.patch(existing._id, {
          lastUsedAt: now,
          consentVersion: CONSENT_SCREEN_VERSION,
        });
      } else {
        await ctx.db.insert("mcpOauthConsents", {
          userId: ctx.user._id,
          clientId: args.clientId,
          createdAt: now,
          lastUsedAt: now,
          consentVersion: CONSENT_SCREEN_VERSION,
        });
      }
    }
    return { code };
  },
});

/**
 * Whether the caller has already granted remembered consent to this client
 * on the current consent screen (CONSENT_SCREEN_VERSION). The consent page
 * uses this to auto-approve (skip the click) on reconnect.
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
    return (
      row !== null && (row.consentVersion ?? 0) >= CONSENT_SCREEN_VERSION
    );
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
// browser session, so we keep a sidecar (`mcpSessions`) written at
// code-exchange time. That gives the user a list to see + revoke, and it is
// what marks a session as an MCP connection whose end date may slide.

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
 * Mint the session for a code exchange, together with its `mcpSessions` row,
 * in one transaction. Called only by the "mcp" provider in auth.ts after the
 * code and PKCE check out; the provider hands the session id to Convex Auth,
 * which mints the tokens on it (same pattern as `devicePair`). Internal on
 * purpose: the sidecar row is what lets `recordMySession` slide a session's
 * end date, and this is the only code that writes one.
 */
export const openSession = internalMutation({
  args: { userId: v.id("users"), clientId: v.string() },
  handler: async (ctx, args): Promise<Id<"authSessions">> => {
    const now = Date.now();
    const sessionId = await ctx.db.insert("authSessions", {
      userId: args.userId,
      expirationTime: now + mcpSessionIdleMs(),
    });
    const client = await ctx.db
      .query("mcpOauthClients")
      .withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
      .unique();
    await ctx.db.insert("mcpSessions", {
      sessionId,
      userId: args.userId,
      clientId: args.clientId,
      clientName: client?.clientName ?? undefined,
      createdAt: now,
      lastSeenAt: now,
    });
    // Opportunistic GC so the list stays clean without a dedicated cron.
    await pruneDeadSessions(ctx, args.userId);
    return sessionId;
  },
});

/**
 * Record that an MCP connection is in use, which keeps it alive. The OAuth
 * token endpoint calls this after every successful code exchange and refresh,
 * authenticated as that session, so `getAuthSessionId` is the caller's OWN
 * session. Bumps `lastSeenAt` and pushes the session's end date to
 * now + mcpSessionIdleMs().
 *
 * It acts only on a session that already has an `mcpSessions` row, never
 * creates one, never shortens an end date, and never revives a session that
 * has ended. Before 2026-11 this mutation wrote the row itself, so any
 * signed-in session could give itself one; the rows on prod were checked
 * when that changed and are all genuine connections. Renewing grants no
 * access of its own: every later call still goes through the normal gates.
 *
 * A plain `mutation` rather than `authedMutation`, whose write gate refuses
 * read-only accounts: keeping a session alive isn't a write on the user's
 * behalf, and a read-only account's connection should last like any other.
 * `clientId` is accepted and ignored — the token route still sends it on the
 * code exchange, which only an older backend used.
 */
export const recordMySession = mutation({
  args: { clientId: v.optional(v.string()) },
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    const sessionId = await getAuthSessionId(ctx);
    if (!userId || !sessionId) return;
    const sidecar = await ctx.db
      .query("mcpSessions")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .unique();
    if (!sidecar || sidecar.userId !== userId) return;

    const session = await ctx.db.get(sessionId);
    const now = Date.now();
    if (!session || session.userId !== userId) return;
    if (session.expirationTime <= now) return;

    const renewedUntil = now + mcpSessionIdleMs();
    if (renewedUntil > session.expirationTime) {
      await ctx.db.patch(sessionId, { expirationTime: renewedUntil });
    }
    await ctx.db.patch(sidecar._id, { lastSeenAt: now });
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

    // Burn any outstanding, unconsumed authorization codes for this
    // user+client too. Without this, a code minted (e.g. from a second
    // consent tab, or a client that requested one but hasn't exchanged it
    // yet) just before the revoke survives it — it's a *different* row from
    // the mcpSessions one being revoked here — and can still be exchanged
    // for a brand-new session up to its 10-minute TTL later, silently
    // re-granting the access the user just revoked. `by_user` bounds this
    // to the caller's own (small, short-lived) codes.
    const outstandingCodes = await ctx.db
      .query("mcpOauthCodes")
      .withIndex("by_user_client", (q) =>
        q.eq("userId", ctx.user._id).eq("clientId", row.clientId),
      )
      // Bounded so a pile of minted codes can't push the revoke itself past
      // transaction limits; codes live 10 minutes, so this is far above any
      // real backlog for one client.
      .take(MAX_CODES_BURNED_ON_REVOKE);
    for (const codeRow of outstandingCodes) {
      await ctx.db.delete(codeRow._id);
    }
  },
});
