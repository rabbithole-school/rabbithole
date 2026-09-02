// The off-portal CHANNEL ADAPTER seam — one `deliver()` over WhatsApp via the
// Meta WhatsApp Cloud API (we send + receive directly with Meta; no BSP). Plain
// `fetch` (no "use node"); env-gated, so a deployment WITHOUT credentials
// returns null and the delivery is marked "skipped" (never silently "sent").
// WhatsApp is the only off-portal channel (SMS would need a separate provider).
//
// Real sends need a Meta app with the WhatsApp product, a registered sender
// number on a verified business, and a permanent (system-user) access token:
//   WHATSAPP_PHONE_NUMBER_ID   the sender number's id (WhatsApp → API Setup)
//   WHATSAPP_ACCESS_TOKEN      permanent system-user token
//   WHATSAPP_APP_SECRET        App → Settings → Basic (verifies inbound webhooks)
//   WHATSAPP_VERIFY_TOKEN      arbitrary string; matches the webhook GET handshake
//   WHATSAPP_TEMPLATE_NAME / _LANG  approved template for out-of-24h-window sends
// Until those are set, the code path is exercised by tests; nothing leaves the
// building.

export type OffPortalChannel = "whatsapp" | "sms";

/**
 * Flatten arbitrary text into a valid WhatsApp template *variable* value: no
 * newlines/tabs and no run of >4 spaces (Cloud API rejects those with error
 * 132000). Collapses all whitespace runs to a single space.
 */
export function flattenTemplateParam(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// Meta Graph API version for the Cloud API endpoints.
const GRAPH = "https://graph.facebook.com/v21.0";

function cloudCreds() {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  return phoneNumberId && token ? { phoneNumberId, token } : null;
}

/**
 * Send one off-portal message via the WhatsApp Cloud API. Returns the message
 * id (`wamid…`), or null when WhatsApp isn't configured (→ caller marks the
 * delivery "skipped"). Throws on a real Cloud API error (→ caller marks
 * "failed"). Outside WhatsApp's 24-hour window a free-form text is rejected by
 * Meta, so the caller passes `useTemplate` to send the approved template
 * instead (its single `{{1}}` body parameter carries the rendered message).
 */
export async function deliverOffPortal(opts: {
  channel: OffPortalChannel;
  to: string; // the parent's phone number (any format; normalized to digits)
  body: string;
  useTemplate?: boolean;
}): Promise<string | null> {
  // Cloud API is WhatsApp-only; an SMS delivery has no sender here (skip).
  if (opts.channel !== "whatsapp") {
    console.warn(
      `[parent-message] ${opts.channel} has no sender (WhatsApp Cloud API only) — not sending to ${opts.to}.`,
    );
    return null;
  }
  const creds = cloudCreds();
  if (!creds) {
    console.warn(
      `[parent-message] whatsapp not configured — not sending to ${opts.to}.`,
    );
    return null;
  }
  const to = opts.to.replace(/[^\d]/g, ""); // Cloud API wants the bare number
  let payload: Record<string, unknown>;
  if (opts.useTemplate) {
    const name = process.env.WHATSAPP_TEMPLATE_NAME;
    if (!name) {
      console.warn(
        `[parent-message] whatsapp template not configured — not sending to ${opts.to}.`,
      );
      return null;
    }
    // A template's variable value can't contain newlines/tabs or runs of >4
    // spaces (Cloud API error 132000) — but the rendered message is always
    // multi-line. Flatten it to a single line so the {{1}} parameter is valid;
    // any structural line breaks belong in the approved template body itself.
    const param = flattenTemplateParam(opts.body);
    payload = {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name,
        language: { code: process.env.WHATSAPP_TEMPLATE_LANG ?? "en_US" },
        components: [
          { type: "body", parameters: [{ type: "text", text: param }] },
        ],
      },
    };
  } else {
    payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: true, body: opts.body },
    };
  }
  const res = await fetch(`${GRAPH}/${creds.phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${creds.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`WhatsApp Cloud API send failed (${res.status}): ${text}`);
  }
  const json = (await res.json().catch(() => ({}))) as {
    messages?: { id?: string }[];
  };
  return json.messages?.[0]?.id ?? "sent";
}

const WINDOW_MS = 24 * 60 * 60 * 1000;
/** Is the WhatsApp 24-hour customer-service window open (free-form allowed)? */
export function whatsAppWindowOpen(lastInboundAt: number | null | undefined): boolean {
  return !!lastInboundAt && Date.now() - lastInboundAt < WINDOW_MS;
}

/**
 * Verify Meta's `X-Hub-Signature-256` header — `sha256=<hex>` of the HMAC-SHA256
 * of the RAW request body keyed by the app secret. Proves an inbound webhook
 * really came from Meta. Returns false if the app secret isn't configured or the
 * header is missing (fails closed). Compared in constant time.
 */
export async function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | null,
): Promise<boolean> {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret || !signatureHeader) return false;
  const expected = `sha256=${await hmacSha256Hex(secret, rawBody)}`;
  if (signatureHeader.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= signatureHeader.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

async function hmacSha256Hex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * A short text rendering for SMS/WhatsApp (no HTML). Every message over a
 * phone channel arrives from the SAME number, so the FIRST LINE identifies the
 * teacher.
 */
export function renderOffPortalText(opts: {
  authorType: "teacher";
  authorName: string;
  childName: string | null;
  body: string;
  portalUrl: string;
  attachmentLinks?: { fileName: string; url: string }[];
}): string {
  const who = `👩‍🏫 ${opts.authorName}${opts.childName ? ` · ${opts.childName}'s teacher` : " · teacher"}`;
  const attachmentLines = (opts.attachmentLinks ?? []).flatMap(
    (attachment) => [attachment.fileName, attachment.url],
  );
  return [
    who,
    "",
    opts.body,
    ...(attachmentLines.length > 0
      ? ["", "Attachments:", ...attachmentLines]
      : []),
    "",
    `Open the portal: ${opts.portalUrl}`,
  ].join("\n");
}

/**
 * The one-time orientation message sent back over WhatsApp the moment a parent
 * opts in, so they know it worked and where teacher messages will arrive.
 */
export function welcomeMessage(childNames: string[], portalUrl: string): string {
  const kids =
    childNames.length === 0
      ? "your child"
      : childNames.length === 1
        ? childNames[0]
        : childNames.slice(0, -1).join(", ") + " and " + childNames.slice(-1);
  return [
    `✅ You're connected to Rabbithole on WhatsApp.`,
    "",
    `Here's how it works:`,
    `👩‍🏫 Messages from ${kids}'s teacher come through here.`,
    "",
    `Reply STOP to opt out. Open the portal: ${portalUrl}`,
  ].join("\n");
}

/** Detect a STOP/unsubscribe keyword (carrier-standard, case-insensitive). */
export function isStopKeyword(body: string): boolean {
  return /^\s*(stop|stopall|unsubscribe|cancel|end|quit)\s*$/i.test(body);
}

// ── Opt-in tokens (HMAC-signed, expiring) ───────────────────────────────
// The wa.me opt-in link carries a token that binds the SENDER's number to a
// parent. The token must be UNFORGEABLE — a third party who learns a victim's
// id must not be able to text `optin:<victim-id>` and hijack delivery of that
// child's data to their phone. So we sign (parentId, expiry) with the
// deployment's PARENT_INBOUND_SECRET; inbound verifies the signature + expiry
// before linking. No secret ⇒ no link + no accepted token (fail closed).

const OPTIN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

/** wa.me click-to-chat opt-in link with a signed token, or null if WhatsApp
 *  (number) or the signing secret isn't configured. */
export async function whatsAppOptInLink(
  parentUserId: string,
): Promise<string | null> {
  const num = (process.env.SCHOOL_WHATSAPP_NUMBER ?? "").replace(/[^\d]/g, "");
  const secret = process.env.PARENT_INBOUND_SECRET;
  if (!num || !secret) return null;
  const exp = Date.now() + OPTIN_TTL_MS;
  const sig = await hmacHex(secret, `${parentUserId}.${exp}`);
  const text = `optin:${parentUserId}.${exp}.${sig}`;
  return `https://wa.me/${num}?text=${encodeURIComponent(text)}`;
}

/** Verify + parse an opt-in token; returns the parent id only if the signature
 *  is valid and unexpired (else null — a forged/expired token is rejected). */
export async function parseOptInToken(body: string): Promise<string | null> {
  const secret = process.env.PARENT_INBOUND_SECRET;
  if (!secret) return null;
  const m = /optin:\s*([a-z0-9]+)\.(\d+)\.([a-f0-9]+)/i.exec(body);
  if (!m) return null;
  const [, id, expStr, sig] = m;
  if (Date.now() > Number(expStr)) return null; // expired
  const expected = await hmacHex(secret, `${id}.${expStr}`);
  if (sig.toLowerCase() !== expected) return null; // bad signature
  return id;
}
