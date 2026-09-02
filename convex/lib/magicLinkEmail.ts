/**
 * Sends the magic-link sign-in email via Resend's REST API.
 *
 * We hit the Resend HTTP API with `fetch` rather than pulling in the
 * `resend` npm package — one fewer dependency, and it runs in the default
 * Convex runtime (no `"use node"`). Called only from the magic-link Email
 * provider's `sendVerificationRequest` in `convex/auth.ts`.
 *
 * Required Convex env vars (set per-deployment in the dashboard):
 *   AUTH_RESEND_KEY   Resend API key (re-used by the future digest sender)
 *   AUTH_EMAIL_FROM   Full From identity, e.g. "Rabbithole <no-reply@messages.rabbithole.school>"
 *
 * The From address must live on a domain verified in Resend.
 *
 * If `AUTH_RESEND_KEY` is unset (e.g. a fresh dev deployment), we log the
 * sign-in URL to the Convex logs instead of throwing, so magic-link login
 * is still testable in dev without a Resend account.
 */

import { authEmailFrom } from "./deploymentConfig";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

function renderHtml(url: string): string {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #222656;">
      <h1 style="font-size: 20px; margin: 0 0 16px;">Sign in to Rabbithole</h1>
      <p style="font-size: 15px; line-height: 1.5; color: #364153;">
        Click the button below to sign in. This link expires in 15 minutes
        and can only be used once.
      </p>
      <p style="margin: 24px 0;">
        <a href="${url}" style="display: inline-block; background: #AD60BF; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: 600; font-size: 15px;">
          Sign in to Rabbithole
        </a>
      </p>
      <p style="font-size: 13px; line-height: 1.5; color: #6b7280;">
        If you didn't request this, you can safely ignore this email.
      </p>
      <p style="font-size: 12px; color: #9ca3af; word-break: break-all;">
        Or paste this link into your browser:<br />${url}
      </p>
    </div>
  `;
}

export async function sendMagicLinkEmail({
  to,
  url,
}: {
  to: string;
  url: string;
}): Promise<void> {
  const apiKey = process.env.AUTH_RESEND_KEY;

  if (!apiKey) {
    // Dev fallback: no Resend key configured. Surface the link in logs so
    // the flow is still exercisable. NEVER reaches here on a deployment
    // with the key set (prod must set it).
    console.warn(
      `[magic-link] AUTH_RESEND_KEY unset — not sending email. Sign-in URL for ${to}: ${url}`,
    );
    return;
  }
  const from = authEmailFrom();

  const res = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to,
      subject: "Your Rabbithole sign-in link",
      html: renderHtml(url),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend send failed (${res.status}): ${body}`);
  }
}
