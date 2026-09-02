// Google Cloud service-account (2-legged OAuth) helper.
//
// Identity type B for the institution-owned Drive-sync credential: instead of
// a person's OAuth link, the school points the inbox at a GCP service account.
// The folder is SHARED to the SA's client_email (no domain-wide delegation),
// and we mint short-lived access tokens by signing a JWT with the SA's private
// key and exchanging it at Google's token endpoint (the `jwt-bearer` grant).
//
// Deliberately runtime-agnostic (Web Crypto only, no `"use node"`) so it runs
// in the Convex default runtime AND is unit-testable under vitest's
// edge-runtime. See review/drive-sync-institution-accounts-plan.html §5.

export interface ServiceAccountKey {
  clientEmail: string;
  privateKey: string; // PEM, PKCS#8
  privateKeyId?: string;
  clientId?: string;
  tokenUri: string;
  projectId?: string;
}

const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
// Token lifetime we request in the assertion. Google caps SA tokens at 1h.
const ASSERTION_TTL_SECONDS = 3600;

/**
 * Parse + validate a downloaded service-account key JSON (the file GCP hands
 * you for a SA key). Throws a human-actionable error when a required field is
 * missing so the admin surface can show why the paste was rejected.
 */
export function parseServiceAccountKey(raw: string): ServiceAccountKey {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(
      "That isn't valid JSON. Paste the whole service-account key file, " +
        "including the surrounding { }.",
    );
  }
  const type = json.type;
  if (type && type !== "service_account") {
    throw new Error(
      `Expected a "service_account" key, but this JSON has type "${String(type)}".`,
    );
  }
  const clientEmail = str(json.client_email);
  const privateKey = str(json.private_key);
  if (!clientEmail) {
    throw new Error("Service-account key is missing `client_email`.");
  }
  if (!privateKey || !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey)) {
    throw new Error(
      "Service-account key is missing a PEM `private_key`. Download a fresh " +
        "JSON key for the service account (not just its key id) and paste that.",
    );
  }
  return {
    clientEmail,
    privateKey,
    privateKeyId: str(json.private_key_id) || undefined,
    clientId: str(json.client_id) || undefined,
    tokenUri: str(json.token_uri) || DEFAULT_TOKEN_URI,
    projectId: str(json.project_id) || undefined,
  };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// ── base64url helpers (no Node Buffer) ──────────────────────────────────────

function base64UrlFromBytes(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlFromString(s: string): string {
  return base64UrlFromBytes(new TextEncoder().encode(s));
}

/** Decode a base64 (standard, possibly newline-wrapped) string to bytes. */
function bytesFromBase64(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, "");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Strip PEM armor and decode the PKCS#8 DER body of a private key. */
function pkcs8DerFromPem(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "")
    .replace(/-----END [A-Z ]*PRIVATE KEY-----/, "")
    .trim();
  if (!body) throw new Error("Empty PEM private key.");
  return bytesFromBase64(body);
}

async function importSigningKey(pem: string): Promise<CryptoKey> {
  const der = pkcs8DerFromPem(pem);
  // Copy into a standalone ArrayBuffer so the type is concretely ArrayBuffer.
  const buf = new ArrayBuffer(der.byteLength);
  new Uint8Array(buf).set(der);
  return crypto.subtle.importKey(
    "pkcs8",
    buf,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/**
 * Build a signed RS256 JWT assertion for the SA, scoped to `scopes`. Exposed
 * (not just used internally) so it can be unit-tested against a locally
 * generated RSA key without a live Google round-trip.
 */
export async function signServiceAccountJwt(args: {
  key: ServiceAccountKey;
  scopes: readonly string[];
  nowSec?: number;
  audience?: string;
}): Promise<string> {
  const now = args.nowSec ?? Math.floor(Date.now() / 1000);
  const aud = args.audience ?? args.key.tokenUri ?? DEFAULT_TOKEN_URI;
  const header: Record<string, string> = { alg: "RS256", typ: "JWT" };
  if (args.key.privateKeyId) header.kid = args.key.privateKeyId;
  const claims = {
    iss: args.key.clientEmail,
    scope: args.scopes.join(" "),
    aud,
    iat: now,
    exp: now + ASSERTION_TTL_SECONDS,
  };
  const signingInput =
    `${base64UrlFromString(JSON.stringify(header))}.` +
    `${base64UrlFromString(JSON.stringify(claims))}`;
  const cryptoKey = await importSigningKey(args.key.privateKey);
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlFromBytes(new Uint8Array(sig))}`;
}

export interface MintedToken {
  accessToken: string;
  expiresAtMs: number;
}

/**
 * Mint a short-lived Google access token for the service account by signing a
 * JWT and exchanging it at the token endpoint. `fetchImpl` is injectable for
 * tests. Throws with the token endpoint's error body on failure.
 */
export async function mintServiceAccountAccessToken(args: {
  key: ServiceAccountKey;
  scopes: readonly string[];
  nowSec?: number;
  fetchImpl?: typeof fetch;
}): Promise<MintedToken> {
  const assertion = await signServiceAccountJwt({
    key: args.key,
    scopes: args.scopes,
    nowSec: args.nowSec,
  });
  const doFetch = args.fetchImpl ?? fetch;
  const res = await doFetch(args.key.tokenUri || DEFAULT_TOKEN_URI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(
      `Service-account token exchange failed (${res.status}): ${detail}`,
    );
  }
  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
    throw new Error("Service-account token exchange returned no access_token.");
  }
  const nowMs = (args.nowSec ?? Math.floor(Date.now() / 1000)) * 1000;
  return {
    accessToken: json.access_token,
    expiresAtMs: nowMs + (json.expires_in ?? ASSERTION_TTL_SECONDS) * 1000,
  };
}
