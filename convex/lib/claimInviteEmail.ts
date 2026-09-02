/**
 * Sends the parent "claim your account" WELCOME email via Resend.
 *
 * This is the deliberate onboarding invite (see
 * review/parent-account-claim-plan.html). It is intentionally NOT a magic
 * link — the email carries only an INERT link to the `/claim` landing page,
 * which is where the parent requests a fresh, short-lived (15-min) magic
 * sign-in link via the existing audited flow. So a Welcome email that sits in
 * an inbox for days is harmless: it's a link to a page, never a standing login
 * credential. The actual login link is always minted fresh and used within its
 * TTL. See `app/claim/page.tsx` + `convex/auth.ts` (magic-link provider).
 *
 * Mirrors `convex/lib/magicLinkEmail.ts`: hits the Resend REST API with `fetch`
 * (no npm dep, default Convex runtime). Required env (per deployment):
 *   AUTH_RESEND_KEY   Resend API key
 *   AUTH_EMAIL_FROM   Full From identity on a Resend-verified domain
 *
 */
import { siteUrl } from "./channels";
import { authEmailFrom } from "./deploymentConfig";
import { PRIMARY_INSTITUTION_PROMPT_PROFILE } from "./primaryInstitutionPromptProfile";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/** The inert landing-page URL the Welcome email links to (NOT a magic link). */
export function claimUrl(email: string): string {
  return `${siteUrl()}/claim?email=${encodeURIComponent(email)}`;
}

function renderHtml(url: string, firstName?: string): string {
  const hi = firstName ? `Hi ${firstName},` : "Hi,";
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #222656;">
      <h1 style="font-size: 20px; margin: 0 0 16px;">Welcome to Rabbithole</h1>
      <p style="font-size: 15px; line-height: 1.5; color: #364153;">
        ${hi}
      </p>
      <p style="font-size: 15px; line-height: 1.5; color: #364153;">
        ${PRIMARY_INSTITUTION_PROMPT_PROFILE.shortName} set up a Rabbithole parent account for you. Claiming it takes
        a minute and is where you'll take care of your child's school forms —
        starting with the <strong>health &amp; emergency information</strong> the
        school needs on file before the first day.
      </p>
      <p style="margin: 24px 0;">
        <a href="${url}" style="display: inline-block; background: #AD60BF; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: 600; font-size: 15px;">
          Claim my account
        </a>
      </p>
      <p style="font-size: 15px; line-height: 1.5; color: #364153;">
        We'll email you a secure sign-in link — there's no password to create.
        Right now it's where you'll complete the health &amp; emergency form and
        your child's other records. Over time, this same account is where you'll
        follow your child's learning and provide other school forms as they come
        up. You'll only ever see your own child's information, never another
        family's.
      </p>
      <p style="font-size: 12px; color: #9ca3af; word-break: break-all;">
        Or paste this link into your browser:<br />${url}
      </p>
    </div>
  `;
}

/**
 * Send the Welcome / claim-invite email. Returns normally without sending when
 * the mail provider is not configured.
 */
export async function sendClaimInviteEmail({
  to,
  firstName,
}: {
  to: string;
  firstName?: string;
}): Promise<null | void> {
  const url = claimUrl(to);
  const apiKey = process.env.AUTH_RESEND_KEY;

  if (!apiKey) {
    // Dev fallback: no Resend key. Surface the claim URL in logs so the flow
    // is still exercisable. NEVER reaches here on a deployment with the key set.
    console.warn(
      `[claim-invite] AUTH_RESEND_KEY unset — not sending email. Claim URL for ${to}: ${url}`,
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
      subject: "Welcome to Rabbithole — claim your account & complete your child's forms",
      html: renderHtml(url, firstName),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend send failed (${res.status}): ${body}`);
  }
}
