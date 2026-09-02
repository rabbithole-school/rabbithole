// Crypto helpers for the MCP OAuth flow (convex/mcpOauth.ts + the "mcp"
// credentials provider in convex/auth.ts).
//
// Runs in the DEFAULT Convex runtime (Web Crypto — same constraint as
// SimpleWebAuthn in passkeys.ts; do not add "use node"). Pure functions,
// so they also unit-test in plain Vitest with no convexTest fixture.

/** Lowercase hex sha256 — matches the convention in enrollment.ts. */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Random URL-safe token (hex), default 32 bytes / 64 chars. */
export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const B64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Unpadded base64url, implemented directly so it needs no btoa/Buffer. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    out += B64URL_ALPHABET[b0 >> 2];
    out += B64URL_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 !== undefined) {
      out += B64URL_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    }
    if (b2 !== undefined) {
      out += B64URL_ALPHABET[b2 & 0x3f];
    }
  }
  return out;
}

/**
 * PKCE S256 (RFC 7636): code_challenge = base64url(sha256(code_verifier)).
 * Used at exchange time to prove the token requester is the same client
 * that started the authorization request.
 */
export async function pkceChallengeFromVerifier(
  verifier: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64UrlEncode(new Uint8Array(digest));
}

/** RFC 7636 code_verifier shape: 43–128 chars of [A-Za-z0-9 - . _ ~]. */
export function isValidPkceVerifier(verifier: string): boolean {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(verifier);
}
