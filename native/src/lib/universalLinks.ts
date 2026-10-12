import {
  navigationHrefMatches,
  sitemapHasPathname,
  type DevSitemapNode,
} from "@/lib/devNavigationBridge";

// The web domains whose `/open/*` links this resolver accepts. The native
// entitlement is variant-specific (native app.json -> ios.associatedDomains),
// while the served association lives at public/.well-known/apple-app-site-association.
// Adopters: this list is deliberately empty in the published Foundation
// snapshot — add your own host here and in app.json to enable universal links.
// A universal link from any other host is browsing, not an app-open request,
// and must be left to Safari. We match on HOSTNAME only — a non-standard port
// or userinfo (e.g. user@host) on the legitimate host is not part of this
// check and is intentionally not rejected; neither can change which host is
// contacted, and the resolved route can never become an external URL.
// Deployment configuration — see DEPLOYMENT.md (Universal-link hosts).
export const UNIVERSAL_LINK_HOSTS: readonly string[] = Object.freeze([
]);

// The single claimed path prefix. We deliberately do NOT claim `*` or any
// existing web route — only this dedicated, otherwise-unused namespace — so
// ordinary Safari browsing of teacher/parent/staff surfaces is never hijacked
// on an iPad that has the app installed.
const OPEN_PREFIX = "/open";

// Percent-encoded separators/controls that the URL parser leaves ENCODED in
// url.pathname (it does not decode these): an encoded slash (%2f), backslash
// (%5c), or control byte (%00-%1f, %7f). Left in place they would reach a
// dynamic route parameter (e.g. /session/[id]) as decoded data, so we reject
// them explicitly — the plain-character forms are caught separately below.
const ENCODED_SEPARATOR_OR_CONTROL = /%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i;

export type UniversalLinkResult =
  | { ok: true; route: string; routePathname: string }
  | { ok: false; reason: string };

/**
 * Map an incoming universal-link URL to a validated native route.
 *
 * The URL is UNTRUSTED input — anyone can hand the app a link. This maps
 * `/open/<native-route>` to `<native-route>` (query preserved, fragment
 * dropped) and rejects, precisely:
 *   - anything that is not an absolute URL (a bare path or scheme-relative
 *     "//host/x" has no origin and fails to parse);
 *   - any scheme other than https;
 *   - any host that is not the claimed domain (hostname match;
 *     port/userinfo are not considered — see UNIVERSAL_LINK_HOSTS);
 *   - any path outside the `/open/` namespace, INCLUDING plain `..` traversal,
 *     which the URL parser has already normalized (so /open/../admin becomes
 *     /admin and fails the prefix check);
 *   - percent-encoded slash/backslash/control bytes in the path (which the
 *     parser leaves encoded);
 *   - any resolved route that is not a clean single-slash app-relative path, or
 *     does not exist in the app's Expo Router sitemap.
 * Route existence reuses `sitemapHasPathname` — the same primitive the dev
 * navigation bridge validates against — rather than a second implementation.
 *
 * @param incoming the raw URL string from Linking.getInitialURL / the "url" event
 * @param sitemap  the live Expo Router sitemap (useSitemap()); null while it loads
 */
export function resolveUniversalLink(
  incoming: string,
  sitemap: DevSitemapNode | null,
): UniversalLinkResult {
  if (typeof incoming !== "string" || incoming.length === 0) {
    return { ok: false, reason: "link is empty" };
  }

  let url: URL;
  try {
    // Absolute parse only: a bare path or a scheme-relative "//evil/x" has no
    // origin and throws here, so relative-URL smuggling can't slip through.
    url = new URL(incoming);
  } catch {
    return { ok: false, reason: "link is not a valid absolute URL" };
  }

  if (url.protocol !== "https:") {
    return { ok: false, reason: `unsupported scheme "${url.protocol}"` };
  }
  if (!UNIVERSAL_LINK_HOSTS.includes(url.hostname)) {
    return { ok: false, reason: `host "${url.hostname}" is not a claimed universal-link domain` };
  }

  // url.pathname is normalized by the URL parser, so PLAIN `..` traversal (e.g.
  // /open/../admin) has already collapsed to its real path and no longer starts
  // with /open — the prefix check rejects it. PERCENT-ENCODED separators are
  // NOT decoded by the parser, so they are rejected separately just below.
  const pathname = url.pathname;
  if (pathname !== OPEN_PREFIX && !pathname.startsWith(`${OPEN_PREFIX}/`)) {
    return { ok: false, reason: `path "${pathname}" is outside the /open/ namespace` };
  }
  if (ENCODED_SEPARATOR_OR_CONTROL.test(pathname)) {
    return { ok: false, reason: `path "${pathname}" contains an encoded separator or control character` };
  }

  // Everything after /open is the native route. Bare /open (or /open/) opens
  // the app at its root.
  const stripped = pathname.slice(OPEN_PREFIX.length);
  const routePathname = stripped === "" || stripped === "/" ? "/" : stripped;

  // Belt-and-suspenders: the route we hand to the router must be a single-slash
  // app-relative path with no LITERAL control characters or backslashes (the
  // encoded forms were rejected above).
  if (
    !routePathname.startsWith("/") ||
    routePathname.startsWith("//") ||
    routePathname.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(routePathname)
  ) {
    return { ok: false, reason: `resolved route "${routePathname}" is not a clean app-relative path` };
  }

  if (!sitemapHasPathname(sitemap, routePathname)) {
    return { ok: false, reason: `no app route matches "${routePathname}"` };
  }

  // Preserve the query string; drop the fragment.
  return { ok: true, route: `${routePathname}${url.search}`, routePathname };
}

// ---------------------------------------------------------------------------
// Pure decision helpers for the navigation hook (unit-tested without RN).
// ---------------------------------------------------------------------------

/** The single held link plus whether a WARM ("url" event) link has ever been
 *  seen. Once a warm link arrives, a later-resolving cold-start URL must never
 *  overwrite it (the getInitialURL promise can resolve after a warm event). */
export type PendingLinkState = { url: string | null; warmSeen: boolean };

export type PendingLinkEvent =
  | { type: "cold"; url: string | null }
  | { type: "warm"; url: string | null }
  | { type: "consume" };

export const initialPendingLinkState: PendingLinkState = { url: null, warmSeen: false };

/**
 * Reduce a delivery event into the pending-link state.
 * - "warm": always becomes the held link and marks warmSeen (a newer warm link
 *   supersedes an older one).
 * - "cold": fills the slot ONLY if no warm link has been seen — so a stale
 *   cold-start URL resolving late can't clobber a newer warm link.
 * - "consume": clears the held link (warmSeen is sticky for the session).
 */
export function reducePendingLink(
  state: PendingLinkState,
  event: PendingLinkEvent,
): PendingLinkState {
  switch (event.type) {
    case "warm":
      return { url: event.url ?? state.url, warmSeen: true };
    case "cold":
      if (state.warmSeen || !event.url) return state;
      return { url: event.url, warmSeen: false };
    case "consume":
      return { url: null, warmSeen: state.warmSeen };
  }
}

export type UniversalLinkDecision =
  | { action: "wait" }
  | { action: "reject"; reason: string }
  | { action: "skip" }
  | { action: "navigate"; route: string };

/**
 * Decide what to do with a held link given the current auth/sitemap/route
 * context. Pure so the ordering and no-op logic is testable without RN.
 * - No pending link, or not yet authenticated, or sitemap not loaded → wait
 *   (the caller holds the link; NEVER navigates past the auth gate).
 * - Invalid link → reject.
 * - Already on the resolved route (href match, reusing navigationHrefMatches)
 *   → skip, so a link to the current screen doesn't push a duplicate.
 * - Otherwise → navigate.
 */
export function decideUniversalLinkNavigation({
  pendingUrl,
  isAuthenticated,
  sitemap,
  currentHref,
}: {
  pendingUrl: string | null;
  isAuthenticated: boolean;
  sitemap: DevSitemapNode | null;
  currentHref: string | null;
}): UniversalLinkDecision {
  if (!pendingUrl) return { action: "wait" };
  if (!isAuthenticated) return { action: "wait" };
  if (!sitemap) return { action: "wait" };

  const result = resolveUniversalLink(pendingUrl, sitemap);
  if (!result.ok) return { action: "reject", reason: result.reason };
  if (currentHref && navigationHrefMatches(currentHref, result.route)) {
    return { action: "skip" };
  }
  return { action: "navigate", route: result.route };
}
