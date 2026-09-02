import type { OpenInteractiveWebContent } from "@/lib/externalAppHost";

const PROD_WEB_BASE_URL = "https://rabbithole.school";

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function configuredWebBaseUrl() {
  const raw = process.env.EXPO_PUBLIC_RABBITHOLE_WEB_URL?.trim();
  if (!raw) return PROD_WEB_BASE_URL;
  try {
    const url = new URL(raw);
    return trimTrailingSlash(url.toString());
  } catch {
    return PROD_WEB_BASE_URL;
  }
}

/**
 * The base origin for Rabbithole-hosted web embeds. Production defaults to the
 * deployed web app. Once web manipulatives from PR #423 ship, plug their route
 * in by passing a path through `rabbitholeWebUrl()` (or an activity's `webUrl`),
 * not by hardcoding a LAN development address in native code.
 */
export const rabbitholeWebBaseUrl = configuredWebBaseUrl();

export function rabbitholeWebUrl(pathOrUrl: string) {
  const value = pathOrUrl.trim();
  if (/^https?:\/\//i.test(value)) return value;
  const path = value.startsWith("/") ? value : `/${value}`;
  return new URL(path, `${rabbitholeWebBaseUrl}/`).toString();
}

/**
 * Resolve a user's stored avatar `image` into a URI expo-image can actually
 * load. Seeded/dev users store a RELATIVE path (e.g. "/avatars/kai-nakamura.png")
 * served by the Next web app, while Google-OAuth users store an ABSOLUTE https
 * URL. On web, `<img src>` resolves a relative path against its own origin for
 * free; expo-image has no origin, so a bare "/avatars/..." fails to load and the
 * avatar renders blank. Mirror web by resolving relative paths against the
 * Rabbithole web origin (absolute URLs pass through unchanged). Returns null for
 * an empty/absent image so callers fall back to initials.
 */
export function resolveUserImageUri(image: string | null | undefined): string | null {
  const value = image?.trim();
  if (!value) return null;
  return rabbitholeWebUrl(value);
}

export function allowedHostsForUrl(url: string): string[] {
  try {
    return [new URL(url).hostname.toLowerCase()];
  } catch {
    return [];
  }
}

/**
 * Build the fully-resolved `/embed/manipulative` URL for a practice item.
 * `scholarId` is NOT secret (it's the caller's own id, also used by
 * `submitAnswer`) so it rides the query string; the auth SESSION is handed
 * over separately as a one-shot `#et=` fragment by the host (see
 * `openManipulativeEmbed` + convex/embedAuth.ts).
 */
export function manipulativeEmbedUrl(args: { itemId: string; scholarId: string }): string {
  const path = `/embed/manipulative?itemId=${encodeURIComponent(args.itemId)}&scholarId=${encodeURIComponent(args.scholarId)}`;
  return rabbitholeWebUrl(path);
}

/** True when a URL points at the Rabbithole `/embed/manipulative` route. */
export function isManipulativeEmbedUrl(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/\/+$/, "") === "/embed/manipulative";
  } catch {
    return false;
  }
}

/**
 * Build the fully-resolved `/embed/geomap` URL for a stored map artifact. The
 * `artifactId` is NOT secret — it's owner-scoped (the reads/mutations enforce
 * owner-or-staff) — so it rides the query string exactly like
 * `manipulativeEmbedUrl`'s `itemId`. The auth SESSION is handed over separately
 * as a one-shot `#et=` fragment by the keep-alive host (see ExternalAppHost +
 * convex/embedAuth.ts) when the embed is opened with `authHandoff: true`.
 */
export function geomapEmbedUrl(args: { artifactId: string }): string {
  const path = `/embed/geomap?artifactId=${encodeURIComponent(args.artifactId)}`;
  return rabbitholeWebUrl(path);
}

/** True when a URL points at the Rabbithole `/embed/geomap` route. */
export function isGeomapEmbedUrl(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/\/+$/, "") === "/embed/geomap";
  } catch {
    return false;
  }
}

export const allowHttpWebEmbeds =
  __DEV__ && process.env.EXPO_PUBLIC_ALLOW_HTTP_WEB_EMBEDS === "1";

// Let every navigation reach onShouldStartLoadWithRequest. The host blocks
// non-HTTPS/custom schemes there; using originWhitelist as the blocker would make
// react-native-webview hand those links to Linking.openURL outside Rabbithole.
export const webEmbedOriginWhitelist = ["*"];

export function webEmbedUrlError(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "This activity does not have a valid web URL yet.";
  }
  if (parsed.protocol === "https:") return null;
  if (parsed.protocol === "http:" && allowHttpWebEmbeds) return null;
  if (parsed.protocol === "http:") {
    return "Web embeds must use HTTPS. For local-only debugging, set EXPO_PUBLIC_ALLOW_HTTP_WEB_EMBEDS=1 in a dev build.";
  }
  return "Only http(s) web URLs can be embedded.";
}

export function webEmbedNavigationUrlError(url: string): string | null {
  if (!/^https?:\/\//i.test(url)) {
    if (/^(about:|blob:)/i.test(url)) return null;
    return "That link opens outside this activity, so Rabbithole kept you here.";
  }
  return webEmbedUrlError(url);
}

/**
 * Optional dev/demo affordance. Set exactly one of:
 * - EXPO_PUBLIC_MANIPULATIVE_DEMO_PATH=/dev-manipulatives/...
 * - EXPO_PUBLIC_MANIPULATIVE_DEMO_URL=https://...
 *
 * This is intentionally env-gated and absent in production; shipped activities
 * should call `openManipulativeEmbed` / `openInteractiveWebContent` with their
 * own URL.
 *
 * Auth: when the demo points at the real `/embed/manipulative` route we set
 * `authHandoff` so it exercises the PROD one-shot embed-token flow (which works
 * on dev deployments too — prefer it everywhere). A demo URL that still points
 * at the `/dev-login?...&to=/embed/manipulative` redirect keeps the old
 * dev-only session bootstrap — that `__DEV__` path is the fallback ONLY for
 * when no token flow is wired, and this whole helper already returns null
 * outside `__DEV__`.
 */
export function devManipulativeDemoContent(): OpenInteractiveWebContent | null {
  if (!__DEV__) return null;
  const configured =
    process.env.EXPO_PUBLIC_MANIPULATIVE_DEMO_URL?.trim() ||
    process.env.EXPO_PUBLIC_MANIPULATIVE_DEMO_PATH?.trim();
  if (!configured) return null;
  const url = rabbitholeWebUrl(configured);
  if (webEmbedUrlError(url)) return null;
  return {
    kind: "interactive",
    id: "dev-manipulative-demo",
    title: "Web Manipulative",
    subtitle: "Embedded from the Rabbithole web app",
    url,
    allowedHosts: allowedHostsForUrl(url),
    gestureMode: "interactive",
    ...(isManipulativeEmbedUrl(url) ? { authHandoff: true } : {}),
  };
}
