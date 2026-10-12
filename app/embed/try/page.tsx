/**
 * Guest mode — the unauthenticated "try it" exchange, embedded by iframe from
 * the school marketing site so a prospective parent can watch the tutor refuse
 * to answer them.
 *
 * A SERVER component on purpose: it asks this Convex deployment whether guest
 * mode is on (GET /guest-tutor/config) before rendering anything, and 404s
 * when it is not. That keeps ONE flag — `GUEST_TUTOR_ENABLED` in the Convex
 * environment — governing both the page and the stream, so the surface can
 * never be reachable while the endpoint behind it is dark (or the reverse),
 * and turning it on takes no web redeploy.
 *
 * Who may frame this is enforced by `frame-ancestors` in next.config.js
 * (coarse — CSP grammar can't express every deployment preview host). The stream's
 * exact origin allowlist separately controls which callers may invoke the
 * endpoint; it cannot identify the site framing this page. See
 * convex/lib/guestTutor.ts.
 *
 * No auth, no Convex client, no scholar data. The transcript lives in this
 * tab's React state and nowhere else.
 */
import { notFound } from "next/navigation";
import { convexSiteUrl } from "@/lib/convexUrls";
import { GuestTutorEmbed, type GuestConfig } from "./GuestTutorEmbed";

// The flag is read per request, so flipping it in the Convex dashboard takes
// effect on the next load rather than the next deploy.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Try Rabbithole",
  // A demo surface has nothing to gain from search traffic, and a parent
  // landing here cold — without the page around it that explains what they are
  // looking at — is a worse first impression than not finding it.
  robots: { index: false, follow: false },
};

export default async function GuestTutorPage() {
  let config: GuestConfig | null = null;
  try {
    const response = await fetch(`${convexSiteUrl()}/guest-tutor/config`, {
      cache: "no-store",
    });
    // A dark deployment 404s this route rather than answering `enabled:false`,
    // so a non-ok response IS the "off" answer, not an error to distinguish.
    if (response.ok) config = (await response.json()) as GuestConfig;
  } catch {
    // A deployment that can't answer is treated exactly like one that says no.
    config = null;
  }
  if (!config?.enabled) notFound();

  return <GuestTutorEmbed config={config} />;
}
