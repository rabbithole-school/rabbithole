// Renders and sends a form-reminder email to a guardian using the same Resend
// API as parent messaging. Reminder includes:
//   - all outstanding form names and descriptions
//   - one link to the relevant parent-records surface
//   - a brief footer

import { parentMessageFromAddress } from "./deploymentConfig";
import { PRIMARY_INSTITUTION_PROMPT_PROFILE } from "./primaryInstitutionPromptProfile";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function renderFormReminder(opts: {
  childName: string | null;
  guardianName: string | null;
  forms: {
    id: string;
    label: string;
    description: string;
    needsReplacement: boolean;
  }[];
  formUrl: string;
}): { subject: string; html: string; text: string } {
  const { childName, guardianName, forms, formUrl } = opts;
  const greeting = guardianName
    ? `Hi ${esc(guardianName.split(" ")[0])},`
    : "Hello,";
  const aboutChild = childName ? ` for ${esc(childName)}` : "";

  const subject =
    forms.length === 1
      ? childName
        ? `Action needed: ${forms[0].label} for ${childName}`
        : `Action needed: ${forms[0].label}`
      : childName
        ? `Action needed: forms for ${childName}`
        : "Action needed: school forms";
  const formList = forms
    .map(
      (form) =>
        `<li style="margin:0 0 10px;"><strong>${esc(form.label)}</strong>${form.needsReplacement ? " <span style=\"color:#b45309;\">(replacement requested)</span>" : ""}<br /><span style="color:#6b7280;">${esc(form.description)}</span></li>`,
    )
    .join("");
  const textFormList = forms.flatMap((form) => [
    `- ${form.label}${form.needsReplacement ? " (replacement requested)" : ""}: ${form.description}`,
  ]);

  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#222656;">
    <div style="font-size:13px;color:#9ca3af;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;margin-bottom:6px;">Rabbithole${childName ? ` · ${esc(childName ?? "")}` : ""}</div>
    <p style="font-size:16px;font-weight:600;color:#222656;margin:0 0 16px;">${greeting}</p>
    <p style="font-size:15px;line-height:1.6;color:#364153;margin:0 0 12px;">
      We still need the following${aboutChild}.
    </p>
    <ul style="font-size:14px;line-height:1.6;color:#364153;margin:0 0 20px;padding-left:20px;">${formList}</ul>
    <a href="${formUrl}" style="display:inline-block;background:#7c3aed;color:white;font-size:15px;font-weight:600;text-decoration:none;padding:12px 24px;border-radius:8px;">
      Review outstanding forms \u2192
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

  const textLines = [
    greeting,
    "",
    `We still need the following${aboutChild ? aboutChild : ""}:`,
    "",
    ...textFormList,
    "",
    `Complete the form: ${formUrl}`,
  ];

  return { subject, html, text: textLines.join("\n") };
}

export function formReminderUrl(opts: {
  siteUrl: string;
  scholarId: string;
  forms: { formPath: string }[];
}): string {
  const { siteUrl, scholarId, forms } = opts;
  if (forms.length === 1) {
    const separator = forms[0].formPath.includes("?") ? "&" : "?";
    return `${siteUrl}${forms[0].formPath}${separator}scholarId=${scholarId}`;
  }
  return `${siteUrl}/parent/records?child=${scholarId}`;
}

/**
 * Send a form-reminder email via Resend. Returns the provider message id, or
 * null when no API key is configured.
 * Throws on a real Resend API error.
 */
export async function sendFormReminderEmail(opts: {
  to: string;
  childName: string | null;
  guardianName: string | null;
  forms: {
    id: string;
    label: string;
    description: string;
    needsReplacement: boolean;
  }[];
  formUrl: string;
}): Promise<string | null> {
  const apiKey = process.env.AUTH_RESEND_KEY;
  if (!apiKey) {
    console.warn(
      `[form-reminder] AUTH_RESEND_KEY unset — not emailing ${opts.to}. Forms: ${opts.forms.map((form) => form.id).join(", ")}`,
    );
    return null;
  }

  const { subject, html, text } = renderFormReminder({
    childName: opts.childName,
    guardianName: opts.guardianName,
    forms: opts.forms,
    formUrl: opts.formUrl,
  });

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
