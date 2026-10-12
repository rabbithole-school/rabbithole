"use node";

// Actions that need fetch / Node features for the Google OAuth flow.
// Kept separate from `googleAccounts.ts` so the query/mutation file can
// stay in the V8 runtime.

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireStaffAction } from "./lib/auth";
import { mintDownscopedAccessToken } from "./lib/googleTokens";
import {
  getGoogleScopeCapability,
  includeGrantedScopesFor,
  INSTITUTION_DRIVE_SYNC_SCOPES,
  normalizeGoogleScopes,
  PICKER_DRIVE_SCOPES,
  type PersonalGooglePurpose,
  scopesForPersonalGooglePurpose,
} from "./lib/google";

/**
 * Returns a Google OAuth consent-screen URL the client should navigate
 * to. Validates that the caller is staff and signs the caller's userId into
 * the `state` param so the callback can bind the resulting tokens to the
 * right account without relying on cross-domain session cookies. The state's
 * nonce is stored (googleOAuthNonces) and consumed by the callback, so a
 * state cannot be replayed. For `admissions`, the callback also requires
 * the Google account's email to be the Rabbithole user's own.
 *
 * Staff-wide, not curriculum-only: this links the caller's OWN Google
 * account, and Google decides what that account can see. Gating it on
 * curriculum access just locked operations staff out of their own Drive.
 *
 * `purpose: "admissions"` asks for calendar.readonly, gmail.readonly and
 * gmail.compose (ADMISSIONS_GOOGLE_SCOPES) on top of the scopes the user
 * already granted. It uses incremental auth (`include_granted_scopes=true`)
 * unless the old grant carries gmail.metadata, which incremental auth would
 * keep; then it asks for the full set without it (includeGrantedScopesFor).
 * `prompt=consent` is always set, so Google shows the new scopes and returns
 * a refresh token for them. Omitted = the default Docs/Slides/Drive set.
 */
export const beginOAuth = action({
  args: {
    returnTo: v.optional(v.string()),
    purpose: v.optional(
      v.union(v.literal("default"), v.literal("admissions")),
    ),
  },
  handler: async (ctx, args): Promise<{ url: string }> => {
    const userId = await requireStaffAction(ctx);
    const purpose: PersonalGooglePurpose = args.purpose ?? "default";

    const {
      buildAuthUrl,
      readOAuthConfig,
      readStateSecret,
      signState,
      STATE_TTL_MS,
    } = await import("./lib/google");
    const { clientId, redirectUri } = readOAuthConfig();
    const stateSecret = readStateSecret();

    const returnTo =
      args.returnTo && args.returnTo.startsWith("/") && !args.returnTo.startsWith("//")
        ? args.returnTo
        : "/teacher";

    let scopes: string[] | undefined;
    let includeGrantedScopes = true;
    if (purpose === "admissions") {
      const existing = await ctx.runQuery(
        internal.googleAccounts.getForUserInternal,
        { userId },
      );
      scopes = scopesForPersonalGooglePurpose(purpose, existing?.scopes ?? []);
      includeGrantedScopes = includeGrantedScopesFor(purpose, existing?.scopes ?? []);
    }

    // The nonce is stored and consumed by the callback: a state works once,
    // only for this user and purpose, and only within STATE_TTL_MS.
    const nonce = crypto.randomUUID();
    await ctx.runMutation(internal.googleAccounts.createOAuthNonceInternal, {
      nonce,
      userId,
      purpose,
      expiresAt: Date.now() + STATE_TTL_MS,
    });
    const state = await signState(
      { userId, returnTo, nonce, purpose },
      stateSecret
    );
    const url = buildAuthUrl({
      clientId,
      redirectUri,
      state,
      scopes,
      includeGrantedScopes,
    });
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
 * Mint a Drive-only access token for the SIGNED-IN user server-side so the
 * Google Picker can open without the browser GIS OAuth popup.
 *
 * Why: `initTokenClient().requestAccessToken()` opens a cross-origin OAuth
 * popup and polls `popup.closed` / postMessage to hand the token back. Under
 * modern popup-isolation / third-party-storage rules that handshake can be
 * severed, so the popup hangs and NEITHER `callback` nor `error_callback`
 * fires. Minting the token on the server and feeding it to the picker via
 * `setOAuthToken` sidesteps that popup entirely.
 *
 * Least privilege: the token returned to browser JS is NEVER the stored
 * token. The personal link can carry gmail.readonly and gmail.compose
 * (Admissions), Calendar, Docs and Slides; the browser gets a fresh token
 * down-scoped on refresh to PICKER_DRIVE_SCOPES (drive.readonly +
 * drive.file) and nothing else. It is not persisted. If Google will not
 * down-scope, or answers with any other scope, this returns null.
 *
 * Identity: resolves the REAL session owner (`requireStaffAction`
 * → `getAuthUserId`), matching the OAuth write path, so a platform-admin's own
 * token is minted even while a view-as overlay is active.
 *
 * Fallback-safe: returns `null` (never throws) whenever a down-scoped token
 * isn't available (not signed in, not staff, no linked Google account, the
 * link lacks Drive read scope, no refresh token, or the refresh failed), so
 * the client falls back to the in-browser GIS flow.
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
    // it would show an empty picker; let GIS re-consent for the broader scope
    // in that case instead of handing back a token that can't list anything.
    if (
      !getGoogleScopeCapability(
        acct.scopes,
        INSTITUTION_DRIVE_SYNC_SCOPES,
      ).hasRequiredScopes
    ) {
      return null;
    }
    // Ask only for the Drive scopes the link actually holds (drive.file may
    // be absent on an old grant; Google refuses a scope that was never granted).
    const granted = new Set(normalizeGoogleScopes(acct.scopes));
    const scopes = PICKER_DRIVE_SCOPES.filter((s) => granted.has(s));
    try {
      const token = await mintDownscopedAccessToken(ctx, userId, scopes);
      return token ? { token, email: acct.email } : null;
    } catch {
      return null;
    }
  },
});
