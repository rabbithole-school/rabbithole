// One canonical derivation of an External App's KIND — the single signal the
// teacher Apps filter (and any other surface) reads. Kept in shared/ so the
// SAME rule runs server-side (the convex/appAudiences.ts row builder that feeds
// both the web Apps tab and the aide's list_external_apps tool) and never gets
// re-derived by client-side URL parsing.
//
//   • "native" — a native iPad app: externalApps.nativeUrlScheme is set.
//     Presence is the only signal (schema: "there is no separate is-native
//     flag"), so it is checked first.
//   • "custom" — a Rabbithole custom app: its launch URL is the token-gated
//     /custom-apps?token=… path (convex/customApps.ts → customAppPath).
//   • "web"    — a plain external website (everything else).

export type ExternalAppKind = "web" | "custom" | "native";

/** The domain-agnostic launcher PATH prefix a custom-app token resolves to.
 * This is the ONE canonical spelling of the custom-app URL rule — the generator
 * (`customAppPath`) and the classifier (`isCustomAppUrl`) are built from it as a
 * pair, so a route/query change can't silently drift them apart. Lives in
 * shared/ because Convex may import shared/ but not vice-versa. */
export const CUSTOM_APP_URL_PREFIX = "/custom-apps?token=";

/** The domain-agnostic launcher PATH a custom-app token resolves to — this is
 * what's stored as the catalog `webUrl`. The web launcher opens it relative to
 * the current origin (window.open), and the native host resolves it against the
 * configured Rabbithole web origin, so one install works on dev, preview, and
 * prod without baking in a domain. */
export function customAppPath(token: string): string {
  return `${CUSTOM_APP_URL_PREFIX}${token}`;
}

/** A custom Rabbithole app stores its launch URL as the token-gated path. */
export function isCustomAppUrl(webUrl: string): boolean {
  return webUrl.startsWith(CUSTOM_APP_URL_PREFIX);
}

export function externalAppKind(app: {
  webUrl: string;
  nativeUrlScheme?: string | null;
  /**
   * Identity for a managed native app that registers no URL scheme. Reading
   * the scheme alone classified such an app as "web", so it showed under the
   * teacher's Web filter and was absent from Native iPad — the launcher and
   * the catalog disagreeing about what the same row IS.
   */
  nativeBundleId?: string | null;
}): ExternalAppKind {
  if (app.nativeUrlScheme || app.nativeBundleId) return "native";
  if (isCustomAppUrl(app.webUrl)) return "custom";
  return "web";
}
