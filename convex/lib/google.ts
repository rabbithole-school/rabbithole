// Google OAuth helpers shared by HTTP routes and "use node" actions.
//
// Tokens are stored in the `googleAccounts` table, scoped to a single
// Rabbithole user. Access tokens are short-lived (1h); we proactively
// refresh when within 5 min of expiry. Refresh tokens are long-lived but
// can be revoked by the user from their Google account settings — callers
// must surface a "reconnect" path when refresh fails.

export const GOOGLE_OAUTH_SCOPES = [
  "openid",
  "email",
  "profile",
  // Docs API: create + edit documents the user authorizes.
  "https://www.googleapis.com/auth/documents",
  // Slides API: create + edit presentations.
  "https://www.googleapis.com/auth/presentations",
  // Drive — files this app created or that the user explicitly opened via the
  // Picker. Covers metadata and sharing writes without granting full Drive.
  "https://www.googleapis.com/auth/drive.file",
  // Read-only access to the rest of the user's Drive. Required for
  // the Picker's "My Drive" / "Recents" views to enumerate their
  // existing presentations — without this scope the picker shows an
  // empty list (drive.file alone only surfaces files the app already
  // touched). Also used by `files.copy`'s source-side read.
  //
  // NOTE: drive.readonly is a "sensitive" scope per Google's policy,
  // but NOT a "restricted" one — no security review needed for
  // verification. If we ever need full `drive`, expect a verification
  // round-trip taking weeks.
  "https://www.googleapis.com/auth/drive.readonly",
] as const;

/**
 * The only scopes a token handed to browser JS (the Drive Picker) may carry.
 * `getDriveAccessToken` mints such a token by down-scoping a refresh, so the
 * browser never holds the personal link's Gmail, Calendar, Docs or Slides
 * access. Matches what the client's GIS fallback asks for.
 */
export const PICKER_DRIVE_SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.file",
] as const;

/** Whether every scope in `granted` is one of `allowed` (and `granted` is non-empty). */
export function scopesWithin(
  granted: readonly string[],
  allowed: readonly string[],
): boolean {
  const normalized = normalizeGoogleScopes(granted);
  const allow = new Set(normalizeGoogleScopes(allowed));
  return normalized.length > 0 && normalized.every((s) => allow.has(s));
}

export const GOOGLE_SLIDES_SCOPES = [
  "https://www.googleapis.com/auth/presentations",
] as const;

/**
 * Least-privilege scope set for an INSTITUTION-owned Drive-sync credential.
 * A scanner-inbox identity never makes Slides or writes files — it only
 * enumerates + reads the watched folder — so it drops `presentations` and
 * `drive.file` and requests `drive.readonly` alone. Independent of the richer
 * per-user personal link (which keeps the full set for the Slides picker /
 * deck creation). See review/drive-sync-institution-accounts-plan.html §5.
 */
export const INSTITUTION_DRIVE_SYNC_SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
] as const;

/**
 * Least-privilege scope set for the institution-owned Docs bot. `documents`
 * reads and edits any Google Doc shared with the bot through the Docs API;
 * `drive.file` creates and shares only Docs the bot itself created through the
 * Drive API. The primary flow creates and shares bot-owned Docs, while Docs API
 * edits may also target staff-shared Docs. This remains separate from the
 * scanner's read-only grant.
 */
export const INSTITUTION_DOCS_BOT_SCOPES = [
  // Regression: the callback calls OpenID userinfo to store the bot account's
  // stable subject and email; without these, Google returns userinfo 401.
  "openid",
  "email",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive.file",
] as const;

/**
 * The shared Workspace principal writes Docs and Slides. Keep the historical
 * Docs constant above as a compatibility export for callers/data that still
 * refer to the old `docs_bot` purpose.
 */
export const INSTITUTION_WORKSPACE_BOT_SCOPES = [
  ...INSTITUTION_DOCS_BOT_SCOPES,
  "https://www.googleapis.com/auth/presentations",
] as const;

/**
 * Identity scopes every personal link needs: the OAuth callback calls OpenID
 * userinfo to bind the token to a stable `sub` and email.
 */
export const GOOGLE_IDENTITY_SCOPES = ["openid", "email", "profile"] as const;

export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";
/**
 * The old admissions Gmail scope. No longer requested, and a grant that still
 * carries it needs a fresh consent: while a token holds gmail.metadata, Gmail
 * refuses format=full reads and `q` searches even when gmail.readonly is also
 * granted. gmail.readonly covers everything it allowed.
 */
export const GMAIL_METADATA_SCOPE = "https://www.googleapis.com/auth/gmail.metadata";

/**
 * Gmail scopes Admissions needs. readonly: the "last emailed" sync (headers
 * only for now) and, later, reading family mail to suggest status changes.
 * compose: saving drafts for staff to review and send. Nothing sends mail.
 */
export const ADMISSIONS_GMAIL_SCOPES = [GMAIL_READONLY_SCOPE, GMAIL_COMPOSE_SCOPE] as const;

/**
 * Every scope the Admissions workspace asks for, in one consent, so staff
 * approve access once: calendar events (tours, interviews) and Gmail.
 */
export const ADMISSIONS_GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  ...ADMISSIONS_GMAIL_SCOPES,
] as const;

/** Whether a grant still carries gmail.metadata (see GMAIL_METADATA_SCOPE). */
export function hasGmailMetadataScope(grantedScopes: readonly string[]): boolean {
  return normalizeGoogleScopes(grantedScopes).includes(GMAIL_METADATA_SCOPE);
}

/**
 * The `required` admissions scopes a new consent must grant. A grant still
 * carrying gmail.metadata reports every required Gmail scope as missing,
 * since those have to be granted again without it.
 */
export function missingAdmissionsScopes(
  grantedScopes: readonly string[],
  required: readonly string[] = ADMISSIONS_GOOGLE_SCOPES,
): string[] {
  const missing = missingGoogleScopes(grantedScopes, required);
  if (!hasGmailMetadataScope(grantedScopes)) return missing;
  const gmail = new Set<string>(ADMISSIONS_GMAIL_SCOPES);
  return normalizeGoogleScopes([...missing, ...required.filter((s) => gmail.has(s))]);
}

/** OAuth `purpose` values for the per-user link (`beginOAuth`). */
export const PERSONAL_GOOGLE_PURPOSES = ["default", "admissions"] as const;
export type PersonalGooglePurpose = (typeof PERSONAL_GOOGLE_PURPOSES)[number];

/** Union of scope sets, normalized and de-duplicated, order-preserving. */
export function mergeGoogleScopes(
  ...scopeSets: ReadonlyArray<readonly string[]>
): string[] {
  return normalizeGoogleScopes(scopeSets.flat());
}

/**
 * Scopes to request for a personal-link purpose. Admissions asks for identity
 * + admissions scopes merged with whatever the user already granted, so the
 * new token keeps Docs/Slides/Drive access for people who had it. The old
 * gmail.metadata scope is never carried forward.
 */
export function scopesForPersonalGooglePurpose(
  purpose: PersonalGooglePurpose,
  existingScopes: readonly string[] = [],
): string[] {
  if (purpose === "admissions") {
    return mergeGoogleScopes(
      GOOGLE_IDENTITY_SCOPES,
      normalizeGoogleScopes(existingScopes).filter((s) => s !== GMAIL_METADATA_SCOPE),
      ADMISSIONS_GOOGLE_SCOPES,
    );
  }
  return [...GOOGLE_OAUTH_SCOPES];
}

/**
 * Whether the consent URL should set `include_granted_scopes=true`
 * (incremental auth). It does, except for an admissions consent replacing a
 * grant that carries gmail.metadata: incremental auth would fold the old
 * scope back into the new token, so that consent asks for the full set
 * explicitly instead (scopesForPersonalGooglePurpose keeps the rest).
 */
export function includeGrantedScopesFor(
  purpose: PersonalGooglePurpose,
  existingScopes: readonly string[] = [],
): boolean {
  return !(purpose === "admissions" && hasGmailMetadataScope(existingScopes));
}

export const WORKSPACE_BOT_PURPOSES = ["workspace_bot", "docs_bot"] as const;
export type WorkspaceBotPurpose = (typeof WORKSPACE_BOT_PURPOSES)[number];

/** Normalize only documented OAuth scope representations; never substring-match. */
const GOOGLE_SCOPE_ALIASES: Record<string, string> = {
  email: "https://www.googleapis.com/auth/userinfo.email",
  profile: "https://www.googleapis.com/auth/userinfo.profile",
};

export function normalizeGoogleScopes(scopes: readonly string[]): string[] {
  return [
    ...new Set(
      scopes
        .flatMap((scope) => scope.trim().split(/\s+/).filter(Boolean))
        .map((scope) => GOOGLE_SCOPE_ALIASES[scope] ?? scope),
    ),
  ];
}

export function missingGoogleScopes(
  grantedScopes: readonly string[],
  requiredScopes: readonly string[],
): string[] {
  const granted = new Set(normalizeGoogleScopes(grantedScopes));
  return normalizeGoogleScopes(requiredScopes).filter((scope) => !granted.has(scope));
}

export function getGoogleScopeCapability(
  grantedScopes: readonly string[],
  requiredScopes: readonly string[],
) {
  const grantedScopesNormalized = normalizeGoogleScopes(grantedScopes);
  const missingRequiredScopes = missingGoogleScopes(
    grantedScopesNormalized,
    requiredScopes,
  );
  return {
    grantedScopes: grantedScopesNormalized,
    missingRequiredScopes,
    hasRequiredScopes: missingRequiredScopes.length === 0,
  };
}

const TOKEN_REFRESH_SLACK_MS = 5 * 60 * 1000; // refresh if expiring within 5 min

export interface GoogleTokenResponse {
  access_token: string;
  expires_in: number; // seconds
  refresh_token?: string;
  scope: string;
  token_type: string;
  id_token?: string;
}

export interface GoogleUserInfo {
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

export interface GoogleDriveUserInfo {
  email: string;
  name?: string;
}

/**
 * Build the Google consent-screen URL that the teacher's browser is
 * redirected to. `state` should be a signed value the callback can verify
 * (we use it to recover the userId + return URL).
 */
export function buildAuthUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: readonly string[];
  includeGrantedScopes?: boolean;
}): string {
  const params = new URLSearchParams({
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    response_type: "code",
    scope: (args.scopes ?? GOOGLE_OAUTH_SCOPES).join(" "),
    access_type: "offline",
    // `prompt=consent` forces Google to issue a refresh_token even on
    // re-auth. Without it, repeat connects skip the consent screen and
    // we get back an access_token only.
    prompt: "consent",
    include_granted_scopes: String(args.includeGrantedScopes ?? true),
    state: args.state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/** Exchange an authorization code for tokens. */
export async function exchangeCodeForTokens(args: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<GoogleTokenResponse> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: args.code,
      client_id: args.clientId,
      client_secret: args.clientSecret,
      redirect_uri: args.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Google token exchange failed (${res.status}): ${detail}`);
  }
  return (await res.json()) as GoogleTokenResponse;
}

/**
 * Refresh an expired access token. With `scopes`, asks Google for a token
 * limited to that subset of the grant (down-scoping on refresh); the caller
 * must still check the returned `scope`.
 */
export async function refreshAccessToken(args: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  scopes?: readonly string[];
}): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    refresh_token: args.refreshToken,
    client_id: args.clientId,
    client_secret: args.clientSecret,
    grant_type: "refresh_token",
  });
  if (args.scopes) body.set("scope", args.scopes.join(" "));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new GoogleTokenRefreshError(res.status, detail);
  }
  return (await res.json()) as GoogleTokenResponse;
}

/**
 * A failed refresh. `revoked` is true when Google says the grant itself is
 * dead (`invalid_grant`: revoked by the user, expired, or password reset), so
 * only a reconnect will help. Transient failures (5xx, rate limits) leave it
 * false and must not prompt a reconnect.
 */
export class GoogleTokenRefreshError extends Error {
  readonly status: number;
  readonly oauthError: string | undefined;
  constructor(status: number, detail: string) {
    super(`Google token refresh failed (${status}): ${detail}`);
    this.name = "GoogleTokenRefreshError";
    this.status = status;
    let oauthError: string | undefined;
    try {
      const parsed = JSON.parse(detail) as { error?: unknown };
      if (typeof parsed.error === "string") oauthError = parsed.error;
    } catch {
      // Non-JSON body; leave undefined.
    }
    this.oauthError = oauthError;
  }

  get revoked(): boolean {
    return this.oauthError === "invalid_grant";
  }
}

/** Fetch profile info (sub, email, name) for a freshly issued access token. */
export async function fetchUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Google userinfo failed (${res.status})`);
  }
  return (await res.json()) as GoogleUserInfo;
}

/**
 * Resolve the account behind a Drive-only scanner grant without adding OpenID
 * scopes. The Drive About resource is available under `drive.readonly`.
 */
export async function fetchDriveUserInfo(
  accessToken: string,
): Promise<GoogleDriveUserInfo> {
  const res = await fetch(
    "https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress)",
    { headers: { Authorization: "Bearer " + accessToken } },
  );
  if (!res.ok) {
    throw new Error(`Google Drive account lookup failed (${res.status})`);
  }
  const body = (await res.json()) as {
    user?: { displayName?: string; emailAddress?: string };
  };
  const email = body.user?.emailAddress?.trim();
  if (!email) {
    throw new Error("Google Drive account lookup returned no email");
  }
  return { email, name: body.user?.displayName?.trim() || undefined };
}

export function isExpiringSoon(expiresAt: number, nowMs = Date.now()): boolean {
  return expiresAt - nowMs <= TOKEN_REFRESH_SLACK_MS;
}

/**
 * Read the OAuth client config from environment. Throws a helpful error
 * if missing — this is the most common "oh, I forgot to set credentials"
 * failure mode.
 */
export function readOAuthConfig(): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
} {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "Google OAuth not configured. Set GOOGLE_OAUTH_CLIENT_ID, " +
        "GOOGLE_OAUTH_CLIENT_SECRET, and GOOGLE_OAUTH_REDIRECT_URI in the " +
        "Convex dashboard."
    );
  }
  return { clientId, clientSecret, redirectUri };
}

/** State token TTL: long enough for a slow user, short enough that a
 *  captured state isn't replayable forever. */
export const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Sign a small piece of state (userId + returnTo) with HMAC-SHA256 so the
 * OAuth callback can trust it. We don't need a real JWT library — this
 * runs server-side only, and the secret never leaves Convex. An `iat`
 * claim is added automatically; verifyState rejects anything older than
 * STATE_TTL_MS.
 */
export async function signState(
  payload: object,
  secret: string,
  nowMs: number = Date.now()
): Promise<string> {
  const json = JSON.stringify({ ...payload, iat: nowMs });
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(json));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return `${btoa(json)}.${b64}`;
}

export async function verifyState<T>(
  state: string,
  secret: string,
  nowMs: number = Date.now()
): Promise<T | null> {
  const [b64Json, b64Sig] = state.split(".");
  if (!b64Json || !b64Sig) return null;
  let json: string;
  try {
    json = atob(b64Json);
  } catch {
    return null;
  }
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  let sigBuffer: ArrayBuffer;
  try {
    const bytes = Uint8Array.from(atob(b64Sig), (c) => c.charCodeAt(0));
    // Copy into a fresh ArrayBuffer so the type is concretely `ArrayBuffer`
    // (not `ArrayBufferLike`), which is what `crypto.subtle.verify` wants.
    const fresh = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(fresh).set(bytes);
    sigBuffer = fresh;
  } catch {
    return null;
  }
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    sigBuffer,
    enc.encode(json)
  );
  if (!ok) return null;
  let parsed: T & { iat?: number };
  try {
    parsed = JSON.parse(json) as T & { iat?: number };
  } catch {
    return null;
  }
  // Reject states older than STATE_TTL_MS to prevent replay.
  if (typeof parsed.iat !== "number" || nowMs - parsed.iat > STATE_TTL_MS) {
    return null;
  }
  return parsed;
}

export function readStateSecret(): string {
  // Reuse JWT_PRIVATE_KEY if set (already used by @convex-dev/auth) so we
  // don't add another secret to manage. Fall back to a clearly-labeled
  // env var if the auth module ever stops setting that one.
  const secret =
    process.env.GOOGLE_OAUTH_STATE_SECRET ?? process.env.JWT_PRIVATE_KEY;
  if (!secret) {
    throw new Error(
      "No state-signing secret available. Set GOOGLE_OAUTH_STATE_SECRET " +
        "(any random 32+ char string) in the Convex dashboard."
    );
  }
  return secret;
}
