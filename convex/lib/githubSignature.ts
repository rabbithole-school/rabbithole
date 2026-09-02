// GitHub webhook signature verification (`X-Hub-Signature-256`) — the same
// scheme Meta uses for its webhooks (see `verifyMetaSignature` in
// parentMessageChannels.ts): HMAC-SHA256 of the RAW request body, keyed by
// the webhook secret, hex-encoded as `sha256=<hex>`. Verified in the HTTP
// action BEFORE trusting anything in the payload — this is the only thing
// standing between "GitHub sent this" and "anyone on the internet sent
// this" (the repo is public — review/rabbithole-introspection-plan.html §5).
//
// Uses Web Crypto (`crypto.subtle`) rather than `node:crypto` because
// convex/http.ts's default HTTP-action runtime has no node:crypto — only
// "use node" actions do (see convex/github.ts, which mints the GitHub App
// JWT with node:crypto). Functionally identical HMAC + constant-time
// compare either way.
//
// Pure module: unit-tested in convex/lib/__tests__/githubSignature.test.ts.

const SIGNATURE_PREFIX = "sha256=";

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  return Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Constant-time-ish string compare (lengths leak; contents don't). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function computeGithubSignature(
  secret: string,
  body: string,
): Promise<string> {
  return `${SIGNATURE_PREFIX}${await hmacSha256Hex(secret, body)}`;
}

/**
 * Verify GitHub's `X-Hub-Signature-256` header. Fails closed (never
 * throws): returns false if the secret isn't configured, the header is
 * missing, or it doesn't match.
 */
export async function verifyGithubSignature(args: {
  secret: string | undefined;
  signatureHeader: string | null;
  rawBody: string;
}): Promise<boolean> {
  const { secret, signatureHeader, rawBody } = args;
  if (!secret || !signatureHeader) return false;
  const expected = await computeGithubSignature(secret, rawBody);
  return timingSafeEqual(expected, signatureHeader);
}
