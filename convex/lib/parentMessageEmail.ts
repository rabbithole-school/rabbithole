// Renders + sends a teacher→parent message as an email via Resend (reusing
// the same HTTP API + AUTH_RESEND_KEY as the magic-link sender — see
// lib/magicLinkEmail.ts). Plain `fetch`, so it runs in the default Convex
// runtime (no "use node").
//
// FROM is the school ("{Teacher} via Rabbithole" <configured-address>) with
// REPLY-TO set to a per-thread inbound address when Resend receiving is
// configured, with the teacher's own inbox as a fallback.

import { parentMessageFromAddress } from "./deploymentConfig";
import { tokenizeMessageLinks } from "../../lib/messageLinks";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export type ParentEmailParts = {
  teacherName: string;
  threadSubjectBody: string;
  body: string;
  portalUrl: string; // deep link to this thread in the parent portal
  canReplyByEmail: boolean; // true when Reply-To is a monitored address
  attachmentNames?: string[];
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderBodyHtml(body: string): string {
  // Tokenize the raw body first; escaping it before this step would corrupt URL
  // query strings and make href values diverge from the visible URL.
  return tokenizeMessageLinks(body)
    .map((token) =>
      token.type === "url"
        ? `<a href="${escAttr(token.value)}" style="color:#1155cc;text-decoration:underline;">${esc(token.value)}</a>`
        : esc(token.value).replace(/\n/g, "<br />"),
    )
    .join("");
}

function subjectFromFirstMessage(body: string, teacherName: string): string {
  const normalized = body.replace(/\s+/g, " ").trim();
  if (!normalized) return `Message from ${teacherName}`;
  const characters = Array.from(normalized);
  if (characters.length <= 60) return normalized;
  return `${characters.slice(0, 60).join("").trimEnd()}…`;
}

export function renderParentMessage(p: ParentEmailParts): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = subjectFromFirstMessage(
    p.threadSubjectBody,
    p.teacherName,
  );

  const bodyHtml = renderBodyHtml(p.body);
  const attachmentHtml =
    p.attachmentNames && p.attachmentNames.length > 0
      ? `<p>Attached: ${p.attachmentNames.map(esc).join(", ")}</p>`
      : "";
  const replyPrompt = p.canReplyByEmail
    ? `Reply to this email to respond.<br />`
    : "";

  const html = `
  <div>
    ${bodyHtml}
    ${attachmentHtml}
  </div>
  <div style="color:#666;margin-top:24px;">
    ${replyPrompt}<a href="${escAttr(p.portalUrl)}" style="color:#666;"><em>View in Rabbithole</em></a>
  </div>`;

  const textLines = [
    p.body,
    ...(p.attachmentNames && p.attachmentNames.length > 0
      ? [`Attached: ${p.attachmentNames.join(", ")}`]
      : []),
    "",
    ...(p.canReplyByEmail ? ["Reply to this email to respond."] : []),
    `View in Rabbithole: ${p.portalUrl}`,
  ];

  return { subject, html, text: textLines.join("\n") };
}

/**
 * Send via Resend. Returns the provider message id, or null when no key is
 * configured (dev) — the caller marks the delivery "skipped" in that case so
 * nothing silently appears sent. Throws on a real API error.
 */
export async function sendParentEmail(opts: {
  to: string[];
  from: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  attachments?: {
    path: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
  }[];
  idempotencyKey?: string;
}): Promise<string | null> {
  const recipients = [...new Set(opts.to)];
  const apiKey = process.env.AUTH_RESEND_KEY;
  if (!apiKey) {
    console.warn(
      `[parent-message] AUTH_RESEND_KEY unset — not emailing ${recipients.join(", ")}. Subject: ${opts.subject}`,
    );
    return null;
  }
  const res = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(opts.idempotencyKey
        ? { "Idempotency-Key": opts.idempotencyKey }
        : {}),
    },
    body: JSON.stringify({
      from: opts.from,
      to: recipients,
      reply_to: opts.replyTo,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
      attachments: opts.attachments?.map((attachment) => ({
        path: attachment.path,
        filename: attachment.filename,
        content_type: attachment.contentType,
      })),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend send failed (${res.status}): ${body}`);
  }
  const json = (await res.json().catch(() => ({}))) as { id?: string };
  return json.id ?? "sent";
}

/** wa.me click-to-chat link for the school's WhatsApp number, if configured. */
export function schoolWhatsAppLink(prefill?: string): string | null {
  const num = (process.env.SCHOOL_WHATSAPP_NUMBER ?? "").replace(/[^\d]/g, "");
  if (!num) return null;
  const q = prefill ? `?text=${encodeURIComponent(prefill)}` : "";
  return `https://wa.me/${num}${q}`;
}

/** "{Teacher} via Rabbithole" <from-address>. */
export function fromHeader(teacherName: string): string {
  const addr = parentMessageFromAddress();
  const clean = teacherName.replace(/["\\<>]/g, "").trim() || "Your teacher";
  return `${clean} via Rabbithole <${addr}>`;
}

/** The per-thread Reply-To address routed through Resend receiving. */
export function replyAddressForThread(threadId: string): string | null {
  const domain = process.env.PARENT_INBOUND_DOMAIN?.trim();
  if (!domain) return null;
  return `reply+${threadId}@${domain}`;
}
