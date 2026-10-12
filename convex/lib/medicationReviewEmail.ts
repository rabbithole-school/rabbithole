// Sends the staff review note to guardians when a Medication Authorization
// is marked "Needs replacement" and the reviewer leaves the "Email this note
// to guardians from Rabbithole" checkbox checked. Same Resend API, sender,
// and house style as the bulk form-reminder email (lib/formReminderEmail.ts)
// — this is the free-text-note twin, not a forms list.

import { parentMessageFromAddress } from "./deploymentConfig";
import { PRIMARY_INSTITUTION_PROMPT_PROFILE } from "./primaryInstitutionPromptProfile";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function noteToHtmlParagraphs(note: string): string {
  return note
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map(
      (block) =>
        `<p style="font-size:14px;line-height:1.6;color:#364153;margin:0 0 12px;">${esc(block).replace(/\n/g, "<br />")}</p>`,
    )
    .join("");
}

export function renderMedicationReviewEmail(opts: {
  childName: string | null;
  note: string;
  formUrl: string;
}): { subject: string; html: string; text: string } {
  const { childName, note, formUrl } = opts;
  const subject = childName
    ? `Action needed: medication authorization for ${childName}`
    : "Action needed: medication authorization";

  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#222656;">
    <div style="font-size:13px;color:#9ca3af;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;margin-bottom:6px;">Rabbithole${childName ? ` · ${esc(childName)}` : ""}</div>
    ${noteToHtmlParagraphs(note)}
    <a href="${formUrl}" style="display:inline-block;background:#7c3aed;color:white;font-size:15px;font-weight:600;text-decoration:none;padding:12px 24px;border-radius:8px;">
      Go to your parent portal \u2192
    </a>
    <p style="font-size:13px;color:#9ca3af;margin-top:12px;">
      Or copy this link: <a href="${formUrl}" style="color:#7c3aed;">${formUrl}</a>
    </p>
    <hr style="border:none;border-top:1px solid #ece8f3;margin:24px 0 12px;" />
    <p style="font-size:12px;color:#9ca3af;line-height:1.6;margin:0;">
      You are receiving this because you are listed as a guardian at ${PRIMARY_INSTITUTION_PROMPT_PROFILE.shortName}.
      Sign in to your Rabbithole parent portal any time to manage your family records.
    </p>
  </div>`;

  // The note is the whole body — the staff template already opens with its
  // own greeting, and a reviewer who rewrote it chose their own opening.
  const text = [note, "", `Parent portal: ${formUrl}`].join("\n");

  return { subject, html, text };
}

/**
 * Send a medication-review note email via Resend. Returns the provider
 * message id, or null when no API key is configured. Throws on a real Resend
 * API error.
 */
export async function sendMedicationReviewEmail(opts: {
  to: string;
  childName: string | null;
  note: string;
  formUrl: string;
}): Promise<string | null> {
  const apiKey = process.env.AUTH_RESEND_KEY;
  if (!apiKey) {
    console.warn(
      `[medication-review] AUTH_RESEND_KEY unset — not emailing ${opts.to}.`,
    );
    return null;
  }

  const { subject, html, text } = renderMedicationReviewEmail(opts);
  const from = parentMessageFromAddress();

  const authHeader = ["Bearer", apiKey].join(" ");
  const res = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${PRIMARY_INSTITUTION_PROMPT_PROFILE.shortName} via Rabbithole <${from}>`,
      to: opts.to,
      subject,
      html,
      text,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend send failed (${res.status}): ${body}`);
  }
  const json = (await res.json().catch(() => ({}))) as { id?: string };
  return json.id ?? "sent";
}
