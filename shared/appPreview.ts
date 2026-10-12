// Derive how a teacher opens an External App "as a scholar sees it" from the
// SAME `webUrl` the scholar launcher opens (`useExternalApp` → window.open of
// `webUrl`; a custom app stores that as the domain-agnostic
// `/custom-apps?token=…` path via convex/customApps.ts). No new query, no new
// field — this is a pure read over the catalog row the Apps tab already has.
//
// Reused by the app row's Preview button and the AppAccessDrawer header, so the
// "can this be previewed, and where does it point" rule lives in exactly one
// place.

import { isCustomAppUrl } from "./appKind";

export interface AppPreviewInput {
  /** The scholar launch URL — a custom app's `/custom-apps?token=…` path or an
   * external app's web URL. This is exactly what the web launcher opens. */
  webUrl: string;
  /** Set for a native iPad app. Its presence only changes the DISABLED wording
   * (there's an iPad app but no web page to preview); the web launch URL still
   * decides whether a preview can open at all. */
  nativeUrlScheme?: string | null;
}

export interface AppPreviewTarget {
  /** The URL to open in a new tab, or null when preview is disabled. */
  href: string | null;
  /** Why preview is disabled (for the tooltip), or null when it's available. */
  disabledReason: string | null;
}

/** Preview may only ever open the canonical same-origin custom-app path or a
 * real https web address — never `http:`, `data:`, `javascript:`, a bare
 * scheme, or a relative/garbage string. */
function isHttpsWebUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && parsed.host !== "";
}

/**
 * A teacher can preview an app iff opening its launch URL shows what a scholar
 * would see. `credentialSource` is NOT an input: a teacher who lands on a
 * site's own sign-in page is still seeing an honest preview of what the scholar
 * gets, so a login wall never disables Preview.
 *
 *   • custom app (token-gated `/custom-apps?token=…`) → always previewable; the
 *     token IS the access, and the teacher genuinely can't see it otherwise
 *     (confirmed no role gate in app/custom-apps/page.tsx).
 *   • any app with an https launch URL → opens it. For a native iPad app the
 *     web launch URL is exactly what a scholar on the WEB launcher gets, so it
 *     opens that same page.
 *   • native iPad app with no https web page → nothing to preview on the web.
 *   • no launch URL → nothing to open.
 *   • a launch URL that isn't a web address (`http:`, `data:`, a scheme, …) →
 *     refused; Preview only ever opens the custom path or an https URL.
 */
export function appPreviewTarget(app: AppPreviewInput): AppPreviewTarget {
  const url = app.webUrl.trim();

  // The custom-app path is same-origin and token-gated — always openable.
  if (isCustomAppUrl(url)) {
    return { href: url, disabledReason: null };
  }

  // Otherwise Preview only ever opens a real https web address.
  if (isHttpsWebUrl(url)) {
    return { href: url, disabledReason: null };
  }

  // A native iPad app whose web launch URL isn't a web page: on the web
  // launcher a scholar gets that same (non-web) URL, so there's nothing to show.
  if (app.nativeUrlScheme) {
    return {
      href: null,
      disabledReason: "Opens as an iPad app; nothing to preview on the web.",
    };
  }

  if (!url) {
    return {
      href: null,
      disabledReason: "No launch link yet, so there's nothing to preview.",
    };
  }

  return {
    href: null,
    disabledReason: "This app's link isn't a web address.",
  };
}
