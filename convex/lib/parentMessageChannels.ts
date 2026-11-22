// The off-portal CHANNEL ADAPTER seam — one `deliverOffPortal()` over two
// phone channels, both plain `fetch` (no "use node") and both env-gated: a
// deployment WITHOUT a channel's credentials returns null and the delivery is
// marked "skipped" (never silently "sent").
//
// WhatsApp — the Meta WhatsApp Cloud API directly (no BSP). Needs a Meta app
// with the WhatsApp product, a registered sender on a verified business, and a
// permanent (system-user) access token:
//   WHATSAPP_PHONE_NUMBER_ID   the sender number's id (WhatsApp → API Setup)
//   WHATSAPP_ACCESS_TOKEN      permanent system-user token
//   WHATSAPP_APP_SECRET        App → Settings → Basic (verifies inbound webhooks)
//   WHATSAPP_VERIFY_TOKEN      arbitrary string; matches the webhook GET handshake
//   WHATSAPP_TEMPLATE_NAME / _LANG  approved template for out-of-24h-window sends
//
// SMS — Twilio's Messages API from the school's verified toll-free number
// (A2P 10DLC is shelved). Outbound authenticates with an API key, never the
// account auth token:
//   TWILIO_ACCOUNT_SID     AC… — the account the key and number belong to
//   TWILIO_API_KEY_SID     SK… — Console → Account → API keys (Standard key)
//   TWILIO_API_KEY_SECRET  that key's secret (shown once at creation)
//   TWILIO_FROM_NUMBER     the verified toll-free number, E.164 (+18xx…)
//   TWILIO_AUTH_TOKEN      the account auth token; ONLY verifies inbound
//                          webhook signatures (Twilio signs with it, not a key)
//
// Until those are set, the code path is exercised by tests; nothing leaves the
// building.

import { messagePlainText } from "../../lib/messageLinks";
import { bedtimeWindowText } from "../../shared/bedtime";

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
 * Send one off-portal message. Returns the provider's message id (`wamid…` for
 * WhatsApp, `SM…` for SMS), or null when that channel isn't configured (→
 * caller marks the delivery "skipped"). Throws on a real provider error (→
 * caller marks "failed"). Outside WhatsApp's 24-hour window a free-form text is
 * rejected by Meta, so the caller passes `useTemplate` to send the approved
 * template instead (its single `{{1}}` body parameter carries the rendered
 * message). SMS has no such window; `useTemplate` is ignored there.
 */
export async function deliverOffPortal(opts: {
  channel: OffPortalChannel;
  to: string; // the parent's phone number (any format; normalized to digits)
  body: string;
  useTemplate?: boolean;
}): Promise<string | null> {
  if (opts.channel === "sms") return sendTwilioSms(opts.to, opts.body);
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

// ── SMS via Twilio ───────────────────────────────────────────────────────

const TWILIO_API = "https://api.twilio.com/2010-04-01";

/**
 * Twilio's hard cap on a Messages API `Body`: 1,600 characters (it splits the
 * text into segments itself). A longer body is rejected outright (error
 * 21617), so the SMS path cuts to this before sending rather than failing the
 * whole delivery. The ~300-character target for aide replies is prompt
 * guidance (`formattingGuidance("sms")`), not this limit.
 */
export const SMS_MAX_CHARS = 1600;

function twilioCreds() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const keySid = process.env.TWILIO_API_KEY_SID;
  const keySecret = process.env.TWILIO_API_KEY_SECRET;
  const from = process.env.TWILIO_FROM_NUMBER;
  return accountSid && keySid && keySecret && from
    ? { accountSid, keySid, keySecret, from }
    : null;
}

/** Normalize a stored phone identity to E.164 for Twilio. Ten bare digits are
 *  read as a US/Canada number (the school's toll-free number only reaches
 *  NANP numbers anyway); anything else keeps its digits behind a `+`. */
export function toE164(phone: string): string {
  const digits = phone.replace(/[^\d]/g, "");
  return digits.length === 10 ? `+1${digits}` : `+${digits}`;
}

async function sendTwilioSms(to: string, body: string): Promise<string | null> {
  const creds = twilioCreds();
  if (!creds) {
    // No number in the log: SMS logs carry no phone numbers or bodies.
    console.warn("[parent-message] sms not configured — not sending.");
    return null;
  }
  const form = new URLSearchParams({
    To: toE164(to),
    From: creds.from,
    Body: truncateSms(body, SMS_MAX_CHARS),
  });
  const res = await fetch(
    `${TWILIO_API}/Accounts/${encodeURIComponent(creds.accountSid)}/Messages.json`,
    {
      method: "POST",
      headers: {
        // API-key auth: Basic <KeySid:KeySecret>, scoped to the AccountSid in
        // the path. The account auth token never leaves the inbound verifier.
        Authorization: `Basic ${btoa(`${creds.keySid}:${creds.keySecret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Twilio Messages API send failed (${res.status}): ${text}`);
  }
  const json = (await res.json().catch(() => ({}))) as { sid?: string };
  return json.sid ?? "sent";
}

/**
 * Hard-cut text to at most `max` characters for an outgoing SMS, ending on a
 * word boundary with an ellipsis. Text already within the limit is returned
 * unchanged. A single word longer than the whole budget (a long URL) is cut
 * mid-word rather than dropped. Counts UTF-16 code units, as Twilio does, and
 * never splits a surrogate pair (an emoji) in half.
 */
export function truncateSms(text: string, max: number): string {
  if (text.length <= max) return text;
  const ELLIPSIS = "…";
  if (max <= ELLIPSIS.length) return ELLIPSIS.slice(0, Math.max(0, max));
  let cut = max - ELLIPSIS.length;
  // Don't strand the high half of a surrogate pair at the cut.
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  const head = text.slice(0, cut);
  // Ends on a word boundary when the next char starts a new word; else back up
  // to the last whitespace inside the budget.
  const atBoundary = /\s/.test(text.charAt(cut));
  const lastSpace = head.search(/\s\S*$/);
  // Back up only if that leaves real text; leading whitespace before one
  // oversized word falls through to the mid-word cut instead of a bare "…".
  const backedUp = lastSpace > 0 ? head.slice(0, lastSpace) : "";
  const kept = atBoundary || !/\S/.test(backedUp) ? head : backedUp;
  return kept.replace(/\s+$/, "") + ELLIPSIS;
}

/**
 * The body an aide reply arrives as on a parent's phone: plain text (a stray
 * `[label](url)` becomes "label (url)"), cut to one SMS budget. The SMS reply
 * path (parentSms) and the staff preview (/family-chat) both use it, so the
 * preview shows the text a parent would actually receive.
 */
export function smsBodyFor(reply: string): string {
  return truncateSms(messagePlainText(reply), SMS_MAX_CHARS);
}

/**
 * Verify Twilio's `X-Twilio-Signature` header on an inbound webhook: the
 * base64 HMAC-SHA1, keyed by `TWILIO_AUTH_TOKEN`, of the FULL request URL
 * (scheme, host, path and query exactly as Twilio requested it) followed by
 * every POST parameter, sorted by name, appended as name+value with no
 * delimiters (a repeated name contributes each distinct value once, in
 * sorted order). Checked against Twilio's own published test vector in the unit
 * tests. Returns false when the auth token isn't configured or the header is
 * missing (fails closed). Compared in constant time.
 */
export async function verifyTwilioSignature(
  url: string,
  params: Record<string, string | string[]>,
  signatureHeader: string | null,
): Promise<boolean> {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token || !signatureHeader) return false;
  let data = url;
  for (const name of Object.keys(params).sort()) {
    const value = params[name];
    // Twilio's reference library (twilio-node toFormUrlEncodedParam) drops
    // duplicate values of a repeated param before sorting them.
    const values = Array.isArray(value) ? [...new Set(value)].sort() : [value];
    for (const v of values) data += name + v;
  }
  const expected = await hmacSha1Base64(token, data);
  return constantTimeEqual(signatureHeader, expected);
}

async function hmacSha1Base64(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)),
  );
  let bin = "";
  for (const b of mac) bin += String.fromCharCode(b);
  return btoa(bin);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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
    messagePlainText(opts.body),
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

/**
 * The canonical stored form of a phone identity: digits only, with the
 * country code (ten bare digits read as US/Canada, as `toE164` does). A number
 * that already carries its country code normalizes exactly as the older
 * digits-only rule did, so existing rows still match. Inbound `From` and the
 * staff consent path both go through this, so they can't disagree.
 */
export function canonicalPhoneIdentity(phone: string): string {
  return toE164(phone).slice(1);
}

/**
 * What a whole inbound SMS body asks for, before the model sees it. Twilio
 * and the toll-free network act only on SINGLE-WORD keywords ("STOP please"
 * is not an opt-out to them), so this matches the whole trimmed body too.
 *
 * - stop: Twilio's opt-out list plus HALT (the toll-free verification list).
 *   On a toll-free number the carrier sends its own fixed "NETWORK MSG"
 *   confirmation and still forwards the text, so code records it and stays
 *   silent.
 * - start: START / UNSTOP lift the carrier block on toll-free. Consent here
 *   is staff-recorded, so this re-opts nothing; it just never reaches the
 *   aide. (YES is a long-code keyword only, and a real answer to the aide.)
 * - help: HELP / INFO / SUPPORT.
 */
export type SmsKeyword = "stop" | "start" | "help";

export function smsKeyword(body: string): SmsKeyword | null {
  // "STOP." and "Stop!" are opt-outs; still a single word only.
  const word = body
    .trim()
    .replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, "")
    .toLowerCase();
  if (/^(stop|stopall|unsubscribe|cancel|end|quit|revoke|optout|halt)$/.test(word)) {
    return "stop";
  }
  if (/^(start|unstop)$/.test(word)) return "start";
  if (/^(help|info|support)$/.test(word)) return "help";
  return null;
}

/**
 * The program's HELP reply. Under 320 characters, so the same text can be
 * pasted into a Messaging Service's Advanced Opt-Out HELP response. No link
 * shortener (carriers filter them).
 */
export function smsHelpText(
  schoolName: string,
  portalUrl: string | null,
): string {
  const more = portalUrl
    ? `More at ${portalUrl} or ask the school office.`
    : "For more, ask the school office.";
  return `${schoolName} family texts from Rabbithole: text a question about your child's learning, or ask to freeze or unfreeze their BunnyPad. On school nights we text if it needs charging. ${more} Msg & data rates may apply. Reply STOP to opt out.`;
}

/**
 * The first text a guardian gets, sent once when staff record their consent
 * (parentSms.recordSmsConsent → sendSmsIntro). It names the guardian's own
 * kids: one kid fills both examples; with two or more, each example names a
 * different kid, so a parent of several sees that any of them works. Kid
 * names arrive in a fixed order (the caller sorts them). It promises only what
 * the program does today, and carries the rates, HELP and STOP lines carriers
 * expect in a first message.
 *
 * The bedtime line is true for every recipient: SMS is first-party only
 * (parentSms eligibility), and so is bedtime (convex/lib/bedtime.ts). It
 * tells a parent what the school does about evenings with a fact, the window
 * the BunnyPad enforces, rather than with talk about screens.
 */
export function smsIntroText(schoolName: string, kidNames: string[]): string {
  const askAbout = kidNames[0] ?? "your child";
  const freezeKid = kidNames[1] ?? askAbout;
  return `${schoolName}: you can now text this number to reach Rabbithole. Ask what ${askAbout} is learning or what homework is due, or text "freeze ${freezeKid}'s BunnyPad" to pause it for the evening. BunnyPads sleep from ${bedtimeWindowText()} every night, and on school nights we'll text if one needs charging. Msg & data rates may apply. Reply HELP for help, STOP to opt out.`;
}

function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A TwiML webhook answer: empty, or one immediate reply. */
export function twimlResponseBody(reply?: string | null): string {
  const message = reply ? `<Message>${xmlEscape(reply)}</Message>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${message}</Response>`;
}

/**
 * What a parent gets when their texted question couldn't be answered. It is
 * also saved as the aide's reply in the thread, so a later text can't pick
 * the failed request back up. It doesn't claim nothing happened: a freeze can
 * land before the turn fails, so it points to the freeze status.
 */
export const SMS_TURN_FAILED_TEXT =
  "Sorry, I couldn't finish answering your last text. If it was about a BunnyPad freeze, ask me for the freeze status before trying again.";

/** Inbound `From` must be one E.164 number: no `whatsapp:` prefix, no junk. */
export function isE164Sender(from: string): boolean {
  return /^\+[1-9]\d{10,14}$/.test(from);
}

/**
 * May TEACHER messages go out on this phone-channel row? Opted in, not
 * stopped, and not an aide-only consent (`scope: "aide"`, what staff record
 * for SMS): that consent covered texting the aide, and a parent's reply to a
 * teacher's text would reach the aide, never the teacher. Every reader that
 * delivers teacher messages goes through this one predicate.
 */
export function rowCarriesTeacherMessages(row: {
  optInAt?: number;
  stopState?: boolean;
  scope?: "aide";
}): boolean {
  return !!row.optInAt && row.stopState !== true && row.scope !== "aide";
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
