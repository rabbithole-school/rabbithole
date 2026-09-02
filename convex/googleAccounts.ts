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

import { v } from "convex/values";
import { staffSelfQuery } from "./lib/customFunctions";
import {
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { normalizeEmail } from "./lib/email";
import { getGoogleScopeCapability, GOOGLE_OAUTH_SCOPES } from "./lib/google";

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
    const token = acct.refreshToken ?? acct.accessToken;
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
    if (existing) {
      // Preserve refresh token if the new exchange didn't return one
      // (Google sometimes omits it on re-auth without prompt=consent).
      await ctx.db.patch(existing._id, {
        googleSub: args.googleSub,
        email,
        googleDisplayName:
          googleDisplayName ?? existing.googleDisplayName,
        accessToken: args.accessToken,
        refreshToken: args.refreshToken ?? existing.refreshToken,
        expiresAt: args.expiresAt,
        scopes: args.scopes,
      });
      return existing._id;
    }
    return await ctx.db.insert("googleAccounts", {
      userId: args.userId,
      googleSub: args.googleSub,
      email,
      googleDisplayName,
      accessToken: args.accessToken,
      refreshToken: args.refreshToken,
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
      accessToken: args.accessToken,
      expiresAt: args.expiresAt,
      ...(args.refreshToken ? { refreshToken: args.refreshToken } : {}),
    });
  },
});
