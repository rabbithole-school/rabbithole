// Google Drive push-notification forwarder.
//
// Google only delivers push notifications to a VERIFIED domain, and we can't
// verify the Convex `.convex.site` domain (Convex owns it). We CAN verify
// the configured application domain, so Google is configured to ping THIS route
// (`/api/drive/webhook`), and we forward the ping to the
// Convex `/drive-webhook` HTTP action server-side.
//
// The ping carries no body — only X-Goog-* headers — so we just relay those.
// We always answer 200 fast: a non-2xx makes Google retry and eventually drop
// the channel. The real work (folder re-sync) happens async in Convex.

import { NextRequest } from "next/server";
import { convexSiteUrl } from "@/lib/convexUrls";

const CONVEX_SITE_URL = process.env.NEXT_PUBLIC_CONVEX_URL
  ? convexSiteUrl()
  : undefined;

export async function POST(request: NextRequest) {
  if (!CONVEX_SITE_URL) {
    console.error("[drive/webhook] NEXT_PUBLIC_CONVEX_URL not set");
    // Still 200 so Google doesn't hammer us; nothing we can do here.
    return new Response(null, { status: 200 });
  }

  const headers: Record<string, string> = {};
  for (const key of [
    "x-goog-channel-id",
    "x-goog-channel-token",
    "x-goog-resource-id",
    "x-goog-resource-state",
    "x-goog-resource-uri",
    "x-goog-message-number",
  ]) {
    const v = request.headers.get(key);
    if (v) headers[key] = v;
  }

  try {
    await fetch(`${CONVEX_SITE_URL}/drive-webhook`, { method: "POST", headers });
  } catch (err) {
    // Don't fail the webhook — the cron safety-net will catch a missed sync.
    console.error("[drive/webhook] forward failed:", err);
  }
  return new Response(null, { status: 200 });
}
