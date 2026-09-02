import { authEmailFrom } from "./deploymentConfig";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export const HEALTH_RECORD_CONFIRMATION_SUBJECT = "Rabbithole form submitted";

export function renderHealthRecordConfirmationHtml(): string {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #222656;">
      <h1 style="font-size: 20px; margin: 0 0 16px;">Form submitted</h1>
      <p style="font-size: 15px; line-height: 1.6; color: #364153;">
        We received your submitted Rabbithole form.
      </p>
      <p style="font-size: 15px; line-height: 1.6; color: #364153;">
        You can review or update it at any time through your parent portal.
      </p>
      <p style="font-size: 13px; line-height: 1.5; color: #6b7280; margin-top: 24px;">
        If you have questions or need help, please contact the school office.
      </p>
    </div>
  `;
}

export async function sendHealthRecordConfirmationEmail({
  to,
}: {
  to: string;
}): Promise<boolean> {
  const apiKey = process.env.AUTH_RESEND_KEY;
  if (!apiKey) {
    console.warn(
      `[health-confirmation] AUTH_RESEND_KEY unset; not sending to ${to}`,
    );
    return false;
  }
  const from = authEmailFrom();

  const response = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to,
      subject: HEALTH_RECORD_CONFIRMATION_SUBJECT,
      html: renderHealthRecordConfirmationHtml(),
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Resend send failed (${response.status}): ${body}`);
  }
  return true;
}
