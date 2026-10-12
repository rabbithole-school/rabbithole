/**
 * Connectivity probe backing the kid-facing "You're offline" gate AND the
 * ASAM hybrid's offline exit (`useAsamController` — an offline locked iPad
 * steps out of Single App Mode so Settings → Wi-Fi is reachable).
 *
 * Three properties matter, and the transport + endpoints below are chosen for
 * all of them:
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
 * 3. **It must not be fooled by the iOS URL cache.** This is the one that bit
 *    the fleet (2026-09-09, see the PR that landed this note): `captive.apple.com` ships
 *    `Cache-Control: max-age=31536000` — Apple's own detector bypasses the
 *    cache so Apple never needed a stricter header — and once a device has
 *    completed ONE real probe, NSURLCache answers every later one with the
 *    cached "Success" body in ~2 ms, `cache_hit=true`, with Wi-Fi off. The
 *    original implementation passed `cache: "no-store"` to `fetch`, which
 *    React Native's own fetch polyfill would turn into a fresh `?_=<timestamp>`
 *    on each URL. But Expo (since SDK 56, i.e. for this app's whole life)
 *    installs `expo/fetch` as the global `fetch`; it forwards method/headers/
 *    body/credentials/redirect to iOS and silently drops `cache` — so the same
 *    URL was requested every time and the cache served it. The offline exit
 *    therefore never worked on a device: every managed iPad stayed locked in
 *    ASAM when it went offline, which is precisely the moment the hybrid
 *    exists to handle. Proven on device: idevicesyslog showed the probe tasks
 *    finishing `{transaction_duration_ms=2, response_status=200,
 *    cache_hit=true}` beside the Convex WebSocket closing with "Network is
 *    down".
 *
 *    The probe therefore goes through React Native's `XMLHttpRequest` (still
 *    globally installed under Expo; `expo/fetch` only replaces `fetch`) and
 *    sends an `If-None-Match` header. RN's iOS networking layer sets
 *    `NSURLRequestReloadIgnoringLocalCacheData` on any request carrying that
 *    header (`RCTNetworking.mm`, "NSRequest default cache policy violate on
 *    `If-None-Match`"), which is the one documented lever RN exposes for
 *    bypassing NSURLCache. A per-request `?_=<nonce>` query is kept as a
 *    second, transport-independent defense.
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

/**
 * The request header that makes React Native's iOS transport ignore the local
 * URL cache (see property 3 above). The value is irrelevant to the cache
 * bypass; a nonce keeps it from ever matching a real ETag and yielding a 304.
 */
export const CACHE_BYPASS_HEADER = "If-None-Match";

type ProbeResponse = { status: number; body: string };

let nonceCounter = 0;

function nonce(): string {
  nonceCounter = (nonceCounter + 1) % 1_000_000;
  return `${Date.now().toString(36)}-${nonceCounter.toString(36)}`;
}

/** Append a unique query parameter so no two probes share a cache key. */
export function cacheBustedUrl(url: string, tag: string = nonce()): string {
  return `${url}${url.includes("?") ? "&" : "?"}_=${tag}`;
}

/**
 * One cache-bypassing request. Resolves `null` on ANY failure — timeout,
 * DNS, TLS, dead network, or a missing XHR implementation — never throws.
 */
async function requestWithDeadline(
  url: string,
  method: "GET" | "HEAD",
  timeoutMs: number,
): Promise<ProbeResponse | null> {
  const XhrCtor = (globalThis as { XMLHttpRequest?: typeof XMLHttpRequest })
    .XMLHttpRequest;
  if (!XhrCtor) return null;

  return new Promise<ProbeResponse | null>((resolve) => {
    let settled = false;
    // Declared before `finish` can run: a synchronous throw in XHR setup below
    // reaches `finish` before the timer exists, and a TDZ ReferenceError there
    // would reject this promise and wedge useOfflineRecovery's in-flight guard.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: ProbeResponse | null) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(value);
    };

    let xhr: XMLHttpRequest;
    try {
      xhr = new XhrCtor();
      xhr.open(method, cacheBustedUrl(url), true);
      // The header is what flips RN's iOS cache policy; the nonce value is a
      // guard against a coincidental ETag match.
      xhr.setRequestHeader(CACHE_BYPASS_HEADER, `"probe-${nonce()}"`);
      // These do nothing for the LOCAL NSURLCache lookup (that is governed by
      // cachePolicy above); they are for intermediaries — a school proxy that
      // would otherwise answer from its own cache.
      xhr.setRequestHeader("Cache-Control", "no-cache");
      xhr.setRequestHeader("Pragma", "no-cache");
      xhr.timeout = timeoutMs;
    } catch {
      finish(null);
      return;
    }

    timer = setTimeout(() => {
      try {
        xhr.abort();
      } catch {
        // abort() on an already-settled request is harmless; nothing to do.
      }
      finish(null);
    }, timeoutMs);

    xhr.onload = () =>
      finish({
        status: xhr.status,
        body: typeof xhr.responseText === "string" ? xhr.responseText : "",
      });
    xhr.onerror = () => finish(null);
    xhr.ontimeout = () => finish(null);
    xhr.onabort = () => finish(null);

    try {
      xhr.send();
    } catch {
      finish(null);
    }
  });
}

function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * Probe whether real internet is reachable.
 *
 * Never throws — a timeout, DNS failure, TLS error, captive portal, a dead
 * network, or a cached response all resolve to `false`.
 */
export async function probeInternetReachable(timeoutMs = 5000): Promise<boolean> {
  // Split the budget so a hanging first probe still leaves room for the second.
  const perAttemptMs = Math.max(1, Math.floor(timeoutMs / 2));

  try {
    const captive = await requestWithDeadline(CAPTIVE_PROBE_URL, "GET", perAttemptMs);
    if (captive && isOk(captive.status)) {
      // A captive portal answers 200 with its own login HTML; only Apple's
      // endpoint returns this marker.
      return captive.body.includes(CAPTIVE_PROBE_EXPECTED_BODY);
    }

    // Apple's endpoint is unreachable (blocked by a content filter, or genuinely
    // offline). Fall back to our own prod origin before declaring the kid offline.
    const fallback = await requestWithDeadline(FALLBACK_PROBE_URL, "HEAD", perAttemptMs);
    return fallback !== null && isOk(fallback.status);
  } catch {
    // The never-throws contract is load-bearing: useOfflineRecovery's in-flight
    // guard only clears after this resolves, so a rejection here would silence
    // offline detection for the rest of the mount.
    return false;
  }
}
