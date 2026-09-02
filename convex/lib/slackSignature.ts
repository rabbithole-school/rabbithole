// Slack request-signature verification (the `X-Slack-Signature` v0 scheme).
//
// Every Events API request is HMAC-SHA256 signed with the app's signing
// secret over `v0:<timestamp>:<raw body>`. We verify in the HTTP action
// BEFORE trusting anything in the payload — this is the only thing
// standing between "Slack sent this" and "anyone on the internet sent
// this". Default Convex runtime (Web Crypto only — no node:crypto).
//
// Pure module: unit-tested in convex/lib/__tests__/slackSignature.test.ts.

/** Reject requests older than 5 minutes (Slack's replay-window guidance). */
const REPLAY_WINDOW_SECONDS = 5 * 60;

function hexEncode(bytes: Uint8Array): string {
  return Array.from(bytes)
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

export async function computeSlackSignature(
  signingSecret: string,
  timestamp: string,
  rawBody: string,
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    enc.encode(`v0:${timestamp}:${rawBody}`),
  );
  return `v0=${hexEncode(new Uint8Array(sig))}`;
}

/**
 * Verify a Slack request. `nowMs` is injectable for tests.
 * Returns false (never throws) on any malformed input.
 */
export async function verifySlackSignature(args: {
  signingSecret: string;
  timestampHeader: string | null;
  signatureHeader: string | null;
  rawBody: string;
  nowMs?: number;
}): Promise<boolean> {
  const { signingSecret, timestampHeader, signatureHeader, rawBody } = args;
  if (!signingSecret || !timestampHeader || !signatureHeader) return false;

  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts)) return false;
  const nowSeconds = (args.nowMs ?? Date.now()) / 1000;
  if (Math.abs(nowSeconds - ts) > REPLAY_WINDOW_SECONDS) return false;

  const expected = await computeSlackSignature(
    signingSecret,
    timestampHeader,
    rawBody,
  );
  return timingSafeEqual(expected, signatureHeader);
}
