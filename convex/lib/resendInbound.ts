const REPLAY_WINDOW_SECONDS = 5 * 60;
const RECEIVING_ENDPOINT = "https://api.resend.com/emails/receiving";

function base64Decode(value: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function base64Encode(value: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function signingKey(secret: string): Uint8Array | null {
  if (!secret.startsWith("whsec_")) return null;
  return base64Decode(secret.slice("whsec_".length));
}

export async function computeResendWebhookSignature(args: {
  webhookSecret: string;
  id: string;
  timestamp: string;
  payload: string;
}): Promise<string | null> {
  const keyBytes = signingKey(args.webhookSecret);
  if (!keyBytes) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(keyBytes).buffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${args.id}.${args.timestamp}.${args.payload}`),
  );
  return base64Encode(signature);
}

/** Verify Resend's Svix-signed webhook and reject stale/replayed requests. */
export async function verifyResendWebhook(args: {
  webhookSecret: string | undefined;
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  payload: string;
  nowMs?: number;
}): Promise<boolean> {
  if (
    !args.webhookSecret ||
    !args.id ||
    !args.timestamp ||
    !args.signature
  ) {
    return false;
  }
  const timestamp = Number(args.timestamp);
  if (!Number.isFinite(timestamp)) return false;
  const nowSeconds = (args.nowMs ?? Date.now()) / 1000;
  if (Math.abs(nowSeconds - timestamp) > REPLAY_WINDOW_SECONDS) return false;

  const expected = await computeResendWebhookSignature({
    webhookSecret: args.webhookSecret,
    id: args.id,
    timestamp: args.timestamp,
    payload: args.payload,
  });
  if (!expected) return false;

  return args.signature
    .split(/\s+/)
    .some((candidate) => {
      const [version, value] = candidate.split(",", 2);
      return version === "v1" && !!value && timingSafeEqual(expected, value);
    });
}

export type ReceivedEmail = {
  id: string;
  to: string[];
  cc: string[];
  bcc: string[];
  receivedFor: string[];
  from: string;
  text: string | null;
  html: string | null;
};

type ReceivedEmailResponse = Omit<ReceivedEmail, "receivedFor"> & {
  received_for?: unknown;
};

/** Resend webhooks contain metadata only; retrieve the actual message body. */
export async function retrieveReceivedEmail(
  emailId: string,
): Promise<ReceivedEmail> {
  const apiKey = process.env.RESEND_RECEIVING_API_KEY;
  if (!apiKey) throw new Error("RESEND_RECEIVING_API_KEY is not configured");

  const response = await fetch(
    `${RECEIVING_ENDPOINT}/${encodeURIComponent(emailId)}`,
    {
      headers: { Authorization: ["Bearer", apiKey].join(" ") },
    },
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Resend received-email fetch failed (${response.status}): ${detail}`,
    );
  }
  const email = (await response.json()) as Partial<ReceivedEmailResponse>;
  if (
    typeof email.id !== "string" ||
    typeof email.from !== "string" ||
    !Array.isArray(email.to)
  ) {
    throw new Error("Resend received-email response was malformed");
  }
  return {
    id: email.id,
    from: email.from,
    to: email.to.filter((address): address is string => typeof address === "string"),
    cc: Array.isArray(email.cc)
      ? email.cc.filter((address): address is string => typeof address === "string")
      : [],
    bcc: Array.isArray(email.bcc)
      ? email.bcc.filter((address): address is string => typeof address === "string")
      : [],
    receivedFor: Array.isArray(email.received_for)
      ? email.received_for.filter(
          (address): address is string => typeof address === "string",
        )
      : [],
    text: typeof email.text === "string" ? email.text : null,
    html: typeof email.html === "string" ? email.html : null,
  };
}

/** Find the routed thread mailbox even when Reply All moves it to Cc. */
export function findThreadReplyAddress(
  email: Pick<ReceivedEmail, "receivedFor" | "to" | "cc" | "bcc">,
): string | null {
  return (
    [...email.receivedFor, ...email.to, ...email.cc, ...email.bcc].find(
      (address) => /reply\+[a-z0-9]+@/i.test(address),
    ) ?? null
  );
}

export function extractEmailAddress(value: string): string | null {
  const angleAddress = /<([^<>\s]+@[^<>\s]+)>/.exec(value)?.[1];
  const address = angleAddress ?? /[^\s<>,]+@[^\s<>,]+/.exec(value)?.[0];
  return address?.trim().toLowerCase() ?? null;
}

function canonicalMailbox(address: string): string {
  const normalized = address.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at < 1) return normalized;
  let local = normalized.slice(0, at);
  let domain = normalized.slice(at + 1);
  if (domain === "gmail.com" || domain === "googlemail.com") {
    local = local.split("+", 1)[0].replaceAll(".", "");
    domain = "gmail.com";
  }
  return `${local}@${domain}`;
}

/** Gmail replies from the base mailbox even when delivery used a plus alias. */
export function emailMailboxesMatch(a: string, b: string): boolean {
  return canonicalMailbox(a) === canonicalMailbox(b);
}

/**
 * Match a provider-neutral plus-tag address to its base sender mailbox.
 * Callers must reject ambiguous matches when multiple participants share a base.
 */
export function emailTaggedMailboxesMatch(a: string, b: string): boolean {
  const [aLocal, aDomain, ...aRest] = a.trim().toLowerCase().split("@");
  const [bLocal, bDomain, ...bRest] = b.trim().toLowerCase().split("@");
  if (
    !aLocal ||
    !aDomain ||
    aRest.length > 0 ||
    !bLocal ||
    !bDomain ||
    bRest.length > 0 ||
    aDomain !== bDomain ||
    (!aLocal.includes("+") && !bLocal.includes("+"))
  ) {
    return false;
  }
  return aLocal.split("+", 1)[0] === bLocal.split("+", 1)[0];
}

/** Keep the newly typed reply and remove common quoted-message tails. */
export function extractNewReply(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  const separators = [
    /\nOn [\s\S]{1,500}?\bwrote:\s*(?:\n|$)/i,
    /\n-{2,}\s*Original Message\s*-{2,}\s*\n/i,
    /\nFrom:\s.+\nSent:\s.+\n/i,
  ];
  let end = normalized.length;
  for (const separator of separators) {
    const index = normalized.search(separator);
    if (index >= 0) end = Math.min(end, index);
  }
  return normalized
    .slice(0, end)
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n")
    .trim();
}

export function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .trim();
}
