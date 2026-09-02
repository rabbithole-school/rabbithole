// Token helper for Convex actions that need to call Google APIs as a
// specific Rabbithole user. Centralises the "fetch acct row → refresh
// if expiring → persist new tokens" logic so every Google-calling
// action behaves the same.
//
// Lives outside the `"use node"` boundary so non-node modules can reuse
// the type. The function itself is callable from any action ctx; it
// uses `ctx.runQuery` / `ctx.runMutation` (no direct Node features).

import type { GenericActionCtx } from "convex/server";
import type { DataModel, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import {
  getGoogleScopeCapability,
  INSTITUTION_DOCS_BOT_SCOPES,
  INSTITUTION_WORKSPACE_BOT_SCOPES,
} from "./google";

export type GoogleActionCtx = GenericActionCtx<DataModel>;

export class GoogleReconsentRequiredError extends Error {
  constructor(readonly missingScopes: string[]) {
    super(
      `Google account requires re-consent; missing scopes: ${missingScopes.join(", ")}`,
    );
    this.name = "GoogleReconsentRequiredError";
  }
}

export async function getValidAccessToken(
  ctx: GoogleActionCtx,
  userId: Id<"users">,
  requiredScopes: readonly string[] = [],
): Promise<string> {
  const acct = await ctx.runQuery(
    internal.googleAccounts.getForUserInternal,
    { userId }
  );
  if (!acct) {
    throw new Error("No Google account linked. Connect Google in settings.");
  }
  const capability = getGoogleScopeCapability(acct.scopes, requiredScopes);
  if (!capability.hasRequiredScopes) {
    throw new GoogleReconsentRequiredError(
      capability.missingRequiredScopes,
    );
  }

  const { isExpiringSoon, refreshAccessToken, readOAuthConfig } = await import(
    "./google"
  );

  if (!isExpiringSoon(acct.expiresAt)) {
    return acct.accessToken;
  }
  if (!acct.refreshToken) {
    throw new Error(
      "Google access token expired and no refresh token on file. Reconnect Google."
    );
  }
  const { clientId, clientSecret } = readOAuthConfig();
  const refreshed = await refreshAccessToken({
    refreshToken: acct.refreshToken,
    clientId,
    clientSecret,
  });
  await ctx.runMutation(internal.googleAccounts.updateTokensInternal, {
    userId,
    accessToken: refreshed.access_token,
    expiresAt: Date.now() + refreshed.expires_in * 1000,
    refreshToken: refreshed.refresh_token,
  });
  return refreshed.access_token;
}

/**
 * Resolve a valid Google access token for an INSTITUTION-owned sync credential
 * (`institutionGoogleAccounts`), branching on `identityType`:
 *
 *   google_oauth    — refresh the stored OAuth token like the per-user link.
 *   service_account — mint (or reuse a cached) 2-legged JWT access token.
 *
 * This is the token half of the per-institution Drive-sync identity. It lives
 * outside `"use node"` — the SA signing uses Web Crypto, and OAuth refresh is
 * plain fetch — so any action ctx can call it.
 */
export async function getValidAccessTokenForCredential(
  ctx: GoogleActionCtx,
  credentialId: Id<"institutionGoogleAccounts">,
  requiredScopes: readonly string[] = [],
): Promise<string> {
  const cred = await ctx.runQuery(
    internal.driveSyncState.getCredentialInternal,
    { credentialId },
  );
  if (!cred) {
    throw new Error(
      "This institution's Drive-sync identity is missing. Re-link it in Drive sync admin.",
    );
  }
  const capability = getGoogleScopeCapability(cred.scopes, requiredScopes);
  if (!capability.hasRequiredScopes) {
    throw new GoogleReconsentRequiredError(
      capability.missingRequiredScopes,
    );
  }

  const { isExpiringSoon } = await import("./google");

  if (cred.identityType === "service_account") {
    // Reuse the cached SA token unless it's expiring soon.
    if (
      cred.saAccessToken &&
      cred.saAccessTokenExpiresAt &&
      !isExpiringSoon(cred.saAccessTokenExpiresAt)
    ) {
      return cred.saAccessToken;
    }
    if (!cred.saClientEmail || !cred.saPrivateKey) {
      throw new Error(
        "Service-account credential is incomplete (missing email or private key). Re-upload the key.",
      );
    }
    const { mintServiceAccountAccessToken } = await import("./serviceAccount");
    const minted = await mintServiceAccountAccessToken({
      key: {
        clientEmail: cred.saClientEmail,
        privateKey: cred.saPrivateKey,
        privateKeyId: cred.saPrivateKeyId ?? undefined,
        clientId: cred.saClientId ?? undefined,
        tokenUri: cred.saTokenUri ?? "https://oauth2.googleapis.com/token",
      },
      scopes: cred.scopes,
    });
    await ctx.runMutation(internal.driveSyncState.updateCredentialSaTokenInternal, {
      credentialId,
      saAccessToken: minted.accessToken,
      saAccessTokenExpiresAt: minted.expiresAtMs,
    });
    return minted.accessToken;
  }

  // identityType === "google_oauth"
  if (!cred.accessToken || cred.expiresAt == null) {
    throw new Error(
      "Google-account credential has no token on file. Re-link the account.",
    );
  }
  if (!isExpiringSoon(cred.expiresAt)) {
    return cred.accessToken;
  }
  if (!cred.refreshToken) {
    throw new Error(
      "Institution Google token expired and no refresh token on file. Re-link the account.",
    );
  }
  const { refreshAccessToken, readOAuthConfig } = await import("./google");
  const { clientId, clientSecret } = readOAuthConfig();
  const refreshed = await refreshAccessToken({
    refreshToken: cred.refreshToken,
    clientId,
    clientSecret,
  });
  await ctx.runMutation(internal.driveSyncState.updateCredentialOAuthTokenInternal, {
    credentialId,
    accessToken: refreshed.access_token,
    expiresAt: Date.now() + refreshed.expires_in * 1000,
    refreshToken: refreshed.refresh_token,
  });
  return refreshed.access_token;
}

/**
 * Resolve the dedicated Docs bot credential for one institution. The purpose
 * lookup prevents a Docs write from ever borrowing the scanner's read-only
 * Google identity.
 */
export async function getValidWorkspaceBotToken(
  ctx: GoogleActionCtx,
  institutionId: Id<"institutions">,
  requiredScopes: readonly string[] = INSTITUTION_WORKSPACE_BOT_SCOPES,
): Promise<string> {
  const credential = await ctx.runQuery(
    internal.driveSyncState.getWorkspaceBotCredentialByInstitutionInternal,
    { institutionId },
  );
  if (!credential) {
    throw new Error(
      "This institution has no Workspace bot account connected. Connect it in the Workspace admin settings.",
    );
  }
  return await getValidAccessTokenForCredential(
    ctx,
    credential._id,
    requiredScopes,
  );
}

/**
 * Compatibility wrapper for Docs-only operations. A legacy `docs_bot` can
 * continue to serve Docs while the general Workspace helper refuses it until
 * it has re-consented for Slides.
 */
export async function getValidDocsBotToken(
  ctx: GoogleActionCtx,
  institutionId: Id<"institutions">,
): Promise<string> {
  return await getValidWorkspaceBotToken(
    ctx,
    institutionId,
    INSTITUTION_DOCS_BOT_SCOPES,
  );
}
