// The per-teacher token in a staff email's Reply-To (parentMessageStaffEmail.ts).
//
// A family thread's plain reply address, `reply+<threadId>@…`, is no secret:
// every guardian on the thread holds it. So a reply that claims to be FROM a
// teacher must also come back to the address only that teacher was sent:
// `reply+<threadId>.<token>@…`, where the token is an HMAC of (thread, user).
// A forged From header alone can't post as staff.
//
// Keyed off RESEND_WEBHOOK_SECRET, which every deployment that receives email
// already has (the inbound route answers 503 without it), with a fixed label
// so the derived key is used for nothing else. No secret → no token → the
// staff copy carries no Reply-To and says nothing about replying. Rotating
// that secret invalidates every staff reply address already sent: replies to
// older copies then fail closed (the teacher can still answer in the app).
//
// Lowercase hex because mail systems may fold the local part's case, and 20
// characters (80 bits) so `reply+<32-char id>.<token>` fits the 64-character
// local-part limit.

const LABEL = "rabbithole/staff-reply-token/v1";
const TOKEN_HEX_LENGTH = 20;

async function hmacHex(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(message),
  );
  return [...new Uint8Array(mac)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** The token for this teacher on this thread, or null when unconfigured. */
export async function staffReplyToken(
  threadId: string,
  userId: string,
): Promise<string | null> {
  const secret = process.env.RESEND_WEBHOOK_SECRET?.trim();
  if (!secret) return null;
  const key = await hmacHex(secret, LABEL);
  return (await hmacHex(key, `${threadId}:${userId}`)).slice(0, TOKEN_HEX_LENGTH);
}

/** Does `token` belong to this teacher on this thread? Constant-time. */
export async function staffReplyTokenMatches(
  threadId: string,
  userId: string,
  token: string | undefined,
): Promise<boolean> {
  if (!token) return false;
  const expected = await staffReplyToken(threadId, userId);
  if (!expected) return false;
  const given = token.toLowerCase();
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  }
  return diff === 0;
}
