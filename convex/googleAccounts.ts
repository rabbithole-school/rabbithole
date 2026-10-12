// Public + internal API for the per-user Google account link.
//
// - `status`: curriculum-only query that tells the UI whether the current
//   user has a linked Google account (without exposing the tokens). Resolves
//   the REAL session owner (not the impersonated target) so it matches the
//   write path (beginOAuth/callback bind by getAuthUserId) — a platform-admin's
//   own link stays visible while a view-as overlay is active.
// - `disconnect`: teacher-initiated unlink. Best-effort revoke at Google.
// - `upsertInternal` / `getForUserInternal` / `updateTokensInternal`:
//   used by the OAuth callback (in `http.ts`) and the export actions.
// - `admissionsConnectStatus`: whether the signed-in user's link can serve
//   the Admissions workspace (calendar.readonly + gmail.readonly +
//   gmail.compose).
//
// Tokens are encrypted at rest. Writers seal through `sealGoogleToken`;
// readers open through `openGoogleAccountTokens` (lib/googleTokenCrypto.ts).

import { v } from "convex/values";
import { staffSelfQuery } from "./lib/customFunctions";
import {
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { normalizeEmail } from "./lib/email";
import {
  ADMISSIONS_GOOGLE_SCOPES,
  getGoogleScopeCapability,
  GOOGLE_OAUTH_SCOPES,
  missingAdmissionsScopes,
} from "./lib/google";
import {
  isProdDeployment,
  openGoogleAccountTokens,
  sealGoogleToken,
} from "./lib/googleTokenCrypto";
import { isPlatformAdminRole } from "./lib/roles";

export const status = staffSelfQuery({
  args: {},
  handler: async (ctx) => {
    const acct = await ctx.db
      .query("googleAccounts")
      .withIndex("by_user", (q) => q.eq("userId", ctx.user._id))
      .unique();
    if (!acct) return { connected: false as const };
    const capability = getGoogleScopeCapability(acct.scopes, GOOGLE_OAUTH_SCOPES);
    return {
      connected: true as const,
      email: acct.email,
      scopes: acct.scopes,
      connectedAt: acct.connectedAt,
      hasRefreshToken: !!acct.refreshToken,
      ...capability,
      requiresReconsent: !capability.hasRequiredScopes,
    };
  },
});

/**
 * Admissions needs calendar.readonly + gmail.readonly + gmail.compose on the
 * caller's OWN link, and no leftover gmail.metadata (which would block full
 * reads); `missingScopes` lists what a new consent must grant. `needsReconnect` means the link exists but its grant is dead (a
 * refresh came back `invalid_grant`, the stored token is unreadable, or there
 * is no refresh token to keep the access token alive), so asking for more
 * scopes is not enough: the user must run the consent flow again.
 *
 * `bypass` lets a platform admin into the workspace without a Google link,
 * on a dev deployment only (local, or hosted with ADMISSIONS_DEV_MODE=1), so a
 * prototype is not blocked on OAuth. On
 * production it is always false and the gate applies to everyone.
 */
export const admissionsConnectStatus = staffSelfQuery({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    connected: boolean;
    missingScopes: string[];
    needsReconnect: boolean;
    bypass: boolean;
  }> => {
    const bypass = !isProdDeployment() && isPlatformAdminRole(ctx.user.role);
    const acct = await ctx.db
      .query("googleAccounts")
      .withIndex("by_user", (q) => q.eq("userId", ctx.user._id))
      .unique();
    if (!acct) {
      return {
        connected: false,
        missingScopes: [...ADMISSIONS_GOOGLE_SCOPES],
        needsReconnect: false,
        bypass,
      };
    }
    // No refresh token means the link dies within the hour and Admissions
    // can't sync in the background, so treat it as needing a reconnect.
    // (Checking `expiresAt` here would read the clock in a cached query.)
    return {
      connected: true,
      missingScopes: missingAdmissionsScopes(acct.scopes),
      needsReconnect:
        acct.reconnectRequiredAt !== undefined || !acct.refreshToken,
      bypass,
    };
  },
});

/**
 * Delete the row + return the access/refresh token so the caller can
 * fire-and-forget the revoke at Google. Mutations can't make HTTP calls,
 * hence the two-step shape: this mutation hands the token back to
 * `googleAccountsActions.disconnect` which does the revoke.
 *
 * Internal — the action `googleAccountsActions.disconnect` is the
 * client-facing entry point and re-checks the caller's role.
 */
export const disconnectInternal = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const acct = await ctx.db
      .query("googleAccounts")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (!acct) return { token: null as string | null };
    let token: string | null = null;
    try {
      const opened = await openGoogleAccountTokens(acct);
      token = opened.refreshToken ?? opened.accessToken;
    } catch {
      // Unreadable token (missing/rotated key): still unlink locally; the
      // user can revoke from their Google account settings.
    }
    await ctx.db.delete(acct._id);
    return { token };
  },
});

// ── Internal helpers used by http.ts callback + export actions ──────────

export const getForUserInternal = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("googleAccounts")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
  },
});

export const upsertInternal = internalMutation({
  args: {
    userId: v.id("users"),
    googleSub: v.string(),
    email: v.string(),
    googleDisplayName: v.optional(v.string()),
    accessToken: v.string(),
    refreshToken: v.optional(v.string()),
    expiresAt: v.number(),
    scopes: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const email = normalizeEmail(args.email);
    const googleDisplayName = args.googleDisplayName?.trim() || undefined;
    // Refuse to bind the same Google account to two different Rabbithole
    // users. Either user-error (signed in as the wrong account) or a
    // collision after an admin promoted someone — surface it instead of
    // silently re-pointing a row.
    const subOwner = await ctx.db
      .query("googleAccounts")
      .withIndex("by_googleSub", (q) => q.eq("googleSub", args.googleSub))
      .unique();
    if (subOwner && subOwner.userId !== args.userId) {
      throw new Error(
        "This Google account is already linked to a different Rabbithole user."
      );
    }
    const existing = await ctx.db
      .query("googleAccounts")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    const accessToken = await sealGoogleToken(args.accessToken);
    const refreshToken =
      args.refreshToken === undefined
        ? undefined
        : await sealGoogleToken(args.refreshToken);
    if (existing) {
      // Preserve refresh token if the new exchange didn't return one
      // (Google sometimes omits it on re-auth without prompt=consent).
      // A preserved legacy plaintext refresh token is upgraded in place.
      const keptRefreshToken =
        refreshToken ??
        (existing.refreshToken === undefined
          ? undefined
          : await sealGoogleToken(existing.refreshToken));
      await ctx.db.patch(existing._id, {
        googleSub: args.googleSub,
        email,
        googleDisplayName:
          googleDisplayName ?? existing.googleDisplayName,
        accessToken,
        refreshToken: keptRefreshToken,
        expiresAt: args.expiresAt,
        scopes: args.scopes,
        // A fresh consent revives the grant.
        reconnectRequiredAt: undefined,
        reconnectReason: undefined,
      });
      return existing._id;
    }
    return await ctx.db.insert("googleAccounts", {
      userId: args.userId,
      googleSub: args.googleSub,
      email,
      googleDisplayName,
      accessToken,
      refreshToken,
      expiresAt: args.expiresAt,
      scopes: args.scopes,
      connectedAt: Date.now(),
    });
  },
});

export const updateDisplayNameInternal = internalMutation({
  args: {
    userId: v.id("users"),
    googleSub: v.string(),
    googleDisplayName: v.string(),
  },
  handler: async (ctx, args) => {
    const account = await ctx.db
      .query("googleAccounts")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (!account || account.googleSub !== args.googleSub) return false;
    const googleDisplayName = args.googleDisplayName.trim();
    if (!googleDisplayName) return false;
    await ctx.db.patch(account._id, { googleDisplayName });
    return true;
  },
});

/**
 * Store a refreshed access token. A refresh does NOT clear a reconnect flag:
 * every flag today (`refresh_revoked`, including Gmail refusing the grant,
 * and `token_unreadable`) means the grant itself must be renewed, and a
 * refresh that happens to succeed (another API still accepts the token)
 * would otherwise clear it and let the Gmail sync fail and re-flag on the
 * next run. Only a fresh consent (`upsertInternal`) clears it.
 */
export const updateTokensInternal = internalMutation({
  args: {
    userId: v.id("users"),
    accessToken: v.string(),
    expiresAt: v.number(),
    refreshToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const acct = await ctx.db
      .query("googleAccounts")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (!acct) throw new Error("No Google account linked");
    await ctx.db.patch(acct._id, {
      accessToken: await sealGoogleToken(args.accessToken),
      expiresAt: args.expiresAt,
      ...(args.refreshToken
        ? { refreshToken: await sealGoogleToken(args.refreshToken) }
        : acct.refreshToken !== undefined
          ? // Upgrade a legacy plaintext refresh token on the way past.
            { refreshToken: await sealGoogleToken(acct.refreshToken) }
          : {}),
    });
  },
});

/**
 * Record that this user's stored grant is dead so the UI asks for a
 * reconnect. Called by `getValidAccessToken` when Google rejects the refresh
 * token (`invalid_grant`) or the stored token can't be decrypted.
 */
export const markReconnectRequiredInternal = internalMutation({
  args: {
    userId: v.id("users"),
    reason: v.union(v.literal("refresh_revoked"), v.literal("token_unreadable")),
  },
  handler: async (ctx, args) => {
    const acct = await ctx.db
      .query("googleAccounts")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (!acct) return;
    await ctx.db.patch(acct._id, {
      reconnectRequiredAt: Date.now(),
      reconnectReason: args.reason,
    });
  },
});

// ── Single-use OAuth state nonces (personal link) ───────────────────────

/** Expired nonce rows swept per new OAuth start. */
const NONCE_SWEEP = 50;

/**
 * Record the nonce signed into a personal OAuth `state` (beginOAuth). The
 * callback must consume it, so the state works once and only for this user.
 * Sweeps a few expired rows on the way past.
 */
export const createOAuthNonceInternal = internalMutation({
  args: {
    nonce: v.string(),
    userId: v.id("users"),
    purpose: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const stale = await ctx.db
      .query("googleOAuthNonces")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(NONCE_SWEEP);
    for (const row of stale) await ctx.db.delete(row._id);
    await ctx.db.insert("googleOAuthNonces", args);
  },
});

/**
 * Consume a personal OAuth nonce. Valid only if it exists, has not expired,
 * and was minted for this user and purpose. The row is deleted on any match
 * by nonce, so a second use (or a tampered attempt) finds nothing. Returns
 * the Rabbithole user's email for the callback's account check.
 */
export const consumeOAuthNonceInternal = internalMutation({
  args: { nonce: v.string(), userId: v.id("users"), purpose: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: true; userEmail: string | null } | { ok: false }> => {
    const row = await ctx.db
      .query("googleOAuthNonces")
      .withIndex("by_nonce", (q) => q.eq("nonce", args.nonce))
      .first();
    if (!row) return { ok: false };
    await ctx.db.delete(row._id);
    if (
      row.userId !== args.userId ||
      row.purpose !== args.purpose ||
      row.expiresAt <= Date.now()
    ) {
      return { ok: false };
    }
    const user = await ctx.db.get(args.userId);
    return { ok: true, userEmail: user?.email ? normalizeEmail(user.email) : null };
  },
});
