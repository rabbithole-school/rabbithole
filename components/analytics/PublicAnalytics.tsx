"use client";

import { Analytics as VercelAnalytics, type BeforeSendEvent } from "@vercel/analytics/next";
import Script from "next/script";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { PRIMARY_INSTITUTION_BRAND } from "@/lib/primaryInstitutionBrand";
import { analyticsMeasurementId, isPublicAnalyticsPath } from "./publicAnalyticsConfig";

/**
 * Google Analytics and Vercel Web Analytics for the pages a stranger sees:
 * the signed-out homepage, the free worksheet maker, the invite page and the
 * Davidson pitch.
 *
 * Children use the signed-in app, so the boundary is WHERE THIS IS MOUNTED,
 * and components/analytics/publicAnalytics.test.ts holds the list of files
 * allowed to mount it. Both scripts outlive a client-side navigation, so
 * neither is trusted to stop on its own:
 *
 * - GA counts the first page of a load itself: the stream's enhanced
 *   measurement sends a page-load view even with `send_page_view: false`
 *   (seen on production, 2026-11-21). This component sends the views for
 *   client-side navigations, only while it is mounted. On unmount it sets `window['ga-disable-<id>']`,
 *   Google's documented opt-out flag. The GA web stream also has "page changes
 *   based on browser history events" turned off.
 * - Vercel's events pass through `beforeSend`, which drops any event sent
 *   while no public page has this mounted or whose path is not public.
 *
 * Renders nothing when the deployment configures neither (Foundation's
 * default). GA also stays off in dev and on Vercel previews.
 */

let mountedCount = 0;
let gaConfigured = false;
/** True until the page GA counted on load has been skipped here. */
let gaLoadViewPending = false;

type GtagWindow = { dataLayer?: unknown[]; gtag?: (...args: unknown[]) => void };

/** Google's gtag snippet, run once. Queued calls replay when gtag.js loads. */
function configureGa(id: string) {
  const w = window as unknown as GtagWindow;
  w.dataLayer = w.dataLayer || [];
  w.gtag =
    w.gtag ||
    function gtag() {
      // gtag.js reads the arguments object itself, not an array.
      // eslint-disable-next-line prefer-rest-params
      w.dataLayer!.push(arguments);
    };
  if (gaConfigured) return;
  gaConfigured = true;
  gaLoadViewPending = true;
  w.gtag("js", new Date());
  w.gtag("config", id, {
    send_page_view: false,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });
}

function keepPublicOnly(event: BeforeSendEvent): BeforeSendEvent | null {
  if (mountedCount === 0) return null;
  try {
    return isPublicAnalyticsPath(new URL(event.url).pathname) ? event : null;
  } catch {
    return null;
  }
}

export function PublicAnalytics() {
  const gaId = analyticsMeasurementId(PRIMARY_INSTITUTION_BRAND.analyticsMeasurementId, {
    nodeEnv: process.env.NODE_ENV,
    vercelEnv: process.env.NEXT_PUBLIC_VERCEL_ENV,
  });
  const vercel = PRIMARY_INSTITUTION_BRAND.vercelWebAnalytics;
  const pathname = usePathname();

  useEffect(() => {
    mountedCount += 1;
    const w = window as unknown as Record<string, unknown>;
    if (gaId) {
      w[`ga-disable-${gaId}`] = false;
      configureGa(gaId);
    }
    return () => {
      mountedCount -= 1;
      if (gaId && mountedCount === 0) w[`ga-disable-${gaId}`] = true;
    };
  }, [gaId]);

  useEffect(() => {
    if (!gaId || !pathname || !isPublicAnalyticsPath(pathname)) return;
    if (gaLoadViewPending) {
      gaLoadViewPending = false;
      return;
    }
    // Runs after the mount effect above has set gtag up; it queues into
    // dataLayer, so this works before gtag.js has loaded.
    (window as unknown as GtagWindow).gtag?.("event", "page_view", {
      send_to: gaId,
      page_location: window.location.href,
      page_title: document.title,
    });
  }, [gaId, pathname]);

  return (
    <>
      {gaId ? (
        <Script src={`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(gaId)}`} strategy="afterInteractive" />
      ) : null}
      {vercel ? <VercelAnalytics beforeSend={keepPublicOnly} /> : null}
    </>
  );
}
