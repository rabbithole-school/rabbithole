/**
 * Connectivity probe backing the kid-facing "You're offline" gate.
 *
 * Two properties matter, and the endpoints below are chosen for both:
 *
 * 1. **It must not lie when Rabbithole itself is having a bad day.** Probing
 *    our own origin conflates "this iPad has no internet" (the kid should open
 *    Wi-Fi settings) with "our server is slow/down" (the kid can do nothing
 *    about it, and telling them to fix their Wi-Fi is actively wrong). In dev
 *    this was worse than theoretical: the origin resolves to the local Next dev
 *    server, so a cold compile or a wedged dev server showed the offline gate
 *    on a perfectly connected device.
 * 2. **It must not be fooled by a captive portal** — a school/hotel Wi-Fi login
 *    page that answers every plain-HTTP request with a 200. Two defenses: we
 *    speak **TLS** (a portal cannot forge a valid cert for these hosts, so an
 *    interception fails the fetch rather than faking success) and we verify the
 *    **response body**, not just that a response arrived.
 *
 * `captive.apple.com/hotspot-detect.html` is the endpoint iOS itself uses for
 * this, so it is about as available and as un-blocked as an endpoint gets, and
 * it returns a tiny known body. Our own prod origin is kept only as a secondary
 * signal for networks that block Apple's endpoint; it is the PROD origin
 * deliberately — never the dev/localhost override.
 */

/** Apple's hotspot-detection endpoint, over TLS. */
export const CAPTIVE_PROBE_URL = "https://captive.apple.com/hotspot-detect.html";

/** The exact marker Apple's endpoint returns when the network is unmolested. */
const CAPTIVE_PROBE_EXPECTED_BODY = "Success";

/**
 * Secondary endpoint. Hardcoded to PROD on purpose: the dev override
 * (`EXPO_PUBLIC_RABBITHOLE_WEB_URL`, typically `http://localhost:<port>`) must
 * never decide whether a device is "offline".
 */
export const FALLBACK_PROBE_URL = "https://rabbithole.school";

async function fetchWithDeadline(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { cache: "no-store", signal: controller.signal, ...init });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe whether real internet is reachable.
 *
 * Never throws — a timeout, DNS failure, TLS error, captive portal, or a dead
 * network all resolve to `false`. `cache: "no-store"` keeps a previously-cached
 * response from masquerading as live connectivity.
 */
export async function probeInternetReachable(timeoutMs = 5000): Promise<boolean> {
  // Split the budget so a hanging first probe still leaves room for the second.
  const perAttemptMs = Math.max(1, Math.floor(timeoutMs / 2));

  const captive = await fetchWithDeadline(CAPTIVE_PROBE_URL, { method: "GET" }, perAttemptMs);
  if (captive && captive.ok) {
    const body = await captive.text().catch(() => "");
    // A captive portal answers 200 with its own login HTML; only Apple's
    // endpoint returns this marker.
    return body.includes(CAPTIVE_PROBE_EXPECTED_BODY);
  }

  // Apple's endpoint is unreachable (blocked by a content filter, or genuinely
  // offline). Fall back to our own prod origin before declaring the kid offline.
  const fallback = await fetchWithDeadline(FALLBACK_PROBE_URL, { method: "HEAD" }, perAttemptMs);
  return fallback !== null && fallback.ok;
}
