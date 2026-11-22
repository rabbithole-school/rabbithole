// Links a scholar taps in Messages or tutor chat. A managed BunnyPad has no
// browser (Rabbithole Lock keeps the scholar in the app), so handing a link to
// Safari did nothing at all (TRA-643). These open in the embedded web host as
// kind "link" instead, fenced to the link's site.
//
// The fence leans permissive on redirects. Andy, 2026-11-10: "try to be
// permissive of any obvious cases with redirects". A redirect reaches any site,
// and that site joins the allowed set, so a shortened link or a sign-in bounce
// still reaches its page. A navigation the scholar starts to a different site
// is kept in place. Each kept navigation is reported to the platform-ops
// channel (`alerts.reportBlockedLink`) so a fence that is too tight shows up.

import { registrableHost, urlAllowedByAllowlist } from "@/lib/webActivityExtract";

/**
 * How long after a page finishes loading a hop to a new site still counts as
 * that page's own redirect. Script redirects (a "you're being redirected"
 * page, a sign-in handoff) run as the page finishes loading; a navigation
 * later than this was started by the scholar, however the page wired it.
 * Not measured: the platform-ops posts show whether it is too short.
 */
export const LINK_REDIRECT_GRACE_MS = 3_000;

export type LinkNavigationVerdict =
  /** Already on an allowed site. */
  | "allow"
  /** A redirect to a new site: let it through and add the site. */
  | "widen"
  /** A navigation the scholar started to a different site. */
  | "block";

/**
 * Decide a top-frame navigation inside the link viewer.
 *
 * - `navigationType` is react-native-webview's iOS value ("click",
 *   "formsubmit", "backforward", "reload", "formresubmit", "other").
 * - `loadInFlight` is true from the moment the viewer let a top-frame load
 *   start until it ends. Any hop in that window is a server redirect, even
 *   when iOS still reports the original tap's type.
 * - `msSinceLoadEnd` is how long ago the last load ended (null before the
 *   first one has).
 */
export function linkNavigationVerdict(args: {
  url: string;
  navigationType?: string;
  loadInFlight: boolean;
  msSinceLoadEnd: number | null;
  allowedSites: readonly string[];
}): LinkNavigationVerdict {
  // YouTube outside the locked player is open YouTube: search, Shorts,
  // autoplay. Never reachable through the viewer, even by redirect.
  if (isYouTubeSiteUrl(args.url)) return "block";
  if (urlAllowedByAllowlist(args.url, [...args.allowedSites])) return "allow";
  if (args.loadInFlight) return "widen";
  const scholarTap =
    args.navigationType === "click" || args.navigationType === "formsubmit";
  const justLoaded =
    args.msSinceLoadEnd !== null && args.msSinceLoadEnd < LINK_REDIRECT_GRACE_MS;
  return !scholarTap && justLoaded ? "widen" : "block";
}

function hostOf(url: string): string | null {
  const match = /^https?:\/\/([^/?#:]+)/i.exec(url.trim());
  return match ? match[1].toLowerCase().replace(/\.$/, "") : null;
}

/** Any YouTube page: youtube.com and its subdomains, youtu.be, youtube-nocookie.com. */
export function isYouTubeSiteUrl(url: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  return (
    host === "youtu.be" ||
    ["youtube.com", "youtube-nocookie.com"].some(
      (site) => host === site || host.endsWith(`.${site}`),
    )
  );
}

/** The site (registrable host) a URL belongs to, or null if it has none. */
export function linkSite(url: string): string | null {
  const host = hostOf(url);
  if (!host) return null;
  return registrableHost(host) || null;
}

/** The https form of an http(s) URL; the viewer only embeds HTTPS. */
export function httpsForm(url: string): string {
  return url.trim().replace(/^http:\/\//i, "https://");
}

/** True when two URLs name the same document and differ only after `#`. */
export function isFragmentJump(from: string, to: string): boolean {
  if (from === to) return false;
  return from.split("#")[0] === to.split("#")[0];
}

/**
 * The viewer's title: the link's own words, or its host when the words are
 * just the URL (a bare link pasted into a message).
 */
export function linkViewerTitle(href: string, label: string): string {
  const words = label.trim();
  if (words && words !== href.trim()) return words;
  return hostOf(href)?.replace(/^www\./, "") ?? href;
}
