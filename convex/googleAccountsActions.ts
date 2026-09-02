"use node";

// Actions that need fetch / Node features for the Google OAuth flow.
// Kept separate from `googleAccounts.ts` so the query/mutation file can
// stay in the V8 runtime.

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireStaffAction } from "./lib/auth";
import { getValidAccessToken } from "./lib/googleTokens";
import { getGoogleScopeCapability, INSTITUTION_DRIVE_SYNC_SCOPES } from "./lib/google";

/**
 * Returns a Google OAuth consent-screen URL the client should navigate
 * to. Validates that the caller is staff and signs the caller's userId into
 * the `state` param so the callback can bind the resulting tokens to the
 * right account without relying on cross-domain session cookies.
 *
 * Staff-wide, not curriculum-only: this links the caller's OWN Google
 * account, and Google decides what that account can see. Gating it on
 * curriculum access just locked operations staff out of their own Drive.
 */
export const beginOAuth = action({
  args: { returnTo: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ url: string }> => {
    const userId = await requireStaffAction(ctx);

    const {
      buildAuthUrl,
      readOAuthConfig,
      readStateSecret,
      signState,
    } = await import("./lib/google");
    const { clientId, redirectUri } = readOAuthConfig();
    const stateSecret = readStateSecret();

    const returnTo =
      args.returnTo && args.returnTo.startsWith("/") && !args.returnTo.startsWith("//")
        ? args.returnTo
        : "/teacher";

    const state = await signState(
      { userId, returnTo, nonce: crypto.randomUUID() },
      stateSecret
    );
    const url = buildAuthUrl({ clientId, redirectUri, state });
    return { url };
  },
});

/**
 * Disconnect the user's Google account. Deletes the row in one mutation
 * (load-bearing for Rabbithole-side security) and best-effort revokes
 * the token at Google so the app stops appearing under "Apps with
 * access to your account".
 *
 * Revocation can fail silently — the row is already gone by then, and
 * the user can also revoke from their Google account settings.
 */
export const disconnect = action({
  args: {},
  handler: async (ctx): Promise<{ ok: true }> => {
    const userId = await requireStaffAction(ctx);
    const { token } = await ctx.runMutation(
      internal.googleAccounts.disconnectInternal,
      { userId }
    );
    if (token) {
      try {
        await fetch(
          `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
          }
        );
      } catch {
        // Silent — best-effort.
      }
    }
    return { ok: true };
  },
});

/**
 * Mint a Drive access token for the SIGNED-IN user server-side so the
 * Google Picker can open without the browser GIS OAuth popup.
 *
 * Why: `initTokenClient().requestAccessToken()` opens a cross-origin OAuth
 * popup and polls `popup.closed` / postMessage to hand the token back. Under
 * modern popup-isolation / third-party-storage rules that handshake can be
 * severed, so the popup hangs and NEITHER `callback` nor `error_callback`
 * fires — the picker never opens, with only a spinner and a benign
 * "Cross-Origin-Opener-Policy would block the window.closed call" console
 * warning. Minting the token on the server (we already hold the user's Drive
 * refresh token) and feeding it to the picker via `setOAuthToken` sidesteps
 * that popup entirely.
 *
 * Identity: resolves the REAL session owner (`requireStaffAction`
 * → `getAuthUserId`), matching the OAuth write path, so a platform-admin's own
 * token is minted even while a view-as overlay is active.
 *
 * Fallback-safe: returns `null` (never throws) whenever a server token isn't
 * available — not signed in, not staff, no linked Google
 * account, the link lacks Drive read scope, or the refresh failed — so the
 * client transparently falls back to the in-browser GIS flow. The returned
 * token is the user's OWN token and carries no more privilege than the one
 * GIS would have minted in the browser.
 */
export const getDriveAccessToken = action({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ token: string; email: string } | null> => {
    let userId;
    try {
      userId = await requireStaffAction(ctx);
    } catch {
      return null;
    }
    const acct = await ctx.runQuery(
      internal.googleAccounts.getForUserInternal,
      { userId },
    );
    if (!acct) return null;
    // The Picker's DocsView browses the user's Drive, which needs read access.
    // A `drive.file`-only grant can only see files the app itself created, so
    // it would show an empty picker — let GIS re-consent for the broader scope
    // in that case instead of handing back a token that can't list anything.
    if (
      !getGoogleScopeCapability(
        acct.scopes,
        INSTITUTION_DRIVE_SYNC_SCOPES,
      ).hasRequiredScopes
    ) {
      return null;
    }
    try {
      const token = await getValidAccessToken(ctx, userId);
      return { token, email: acct.email };
    } catch {
      return null;
    }
  },
});
