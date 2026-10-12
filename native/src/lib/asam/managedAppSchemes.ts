// The apps this managed-iPad build can temporarily unlock, mirrored from the
// backend's MANAGED_NATIVE_APPS in convex/lib/managedNativeApps.ts. Two jobs:
//
//  1. Decide LOCALLY whether a tapped tile is even part of the unlock feature.
//     The backend's status query throws for an app it does not manage, so
//     asking about (say) the practice app would turn a working launch into a
//     scholar-visible failure. Matching first keeps every other tile on
//     exactly today's path — no round trip, no modal.
//  2. Pin the iOS `LSApplicationQueriesSchemes` allowlist. iOS refuses
//     `canOpenURL` for any scheme missing from it, and the list is baked in at
//     build time — see native/app.json → expo.ios.infoPlist, kept in sync by
//     __tests__/managedAppSchemes.test.ts.
//
// A managed app is identified by its URL SCHEME or its BUNDLE ID. The two are
// not interchangeable: the scheme is also how a tile LAUNCHES the app, and an
// app can be managed without having one. Mentava Reading registers no custom
// scheme and no associated domains, so it is managed by bundle id alone and
// its tile hands off to the Home Screen instead of opening a URL.
//
// The backend is the authority on both; this list is a mirror, and drift shows
// up as a tile that simply behaves as it does today rather than as a broken
// launch.

/** Scheme prefixes exactly as the backend records them. */
export const MANAGED_APP_URL_SCHEMES = [
  "googlesheets://",
  "spike://",
  "stopmotionstudio://",
  "com.google.stella://",
] as const;

/**
 * Bundle ids of managed apps that have NO URL scheme. Deliberately separate
 * from the scheme list: only schemes belong in LSApplicationQueriesSchemes,
 * and putting a bundle id there would be silently meaningless.
 */
export const MANAGED_APP_BUNDLE_IDS = ["com.mentava.learn2read"] as const;

/** The bare scheme names, as iOS wants them in LSApplicationQueriesSchemes. */
export const MANAGED_APP_QUERY_SCHEMES = MANAGED_APP_URL_SCHEMES.map((scheme) =>
  scheme.replace("://", ""),
);

const normalize = (value: string | undefined | null): string | null => {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : null;
};

/**
 * True when this catalog tile's native scheme is one the backend can unlock.
 * Compared the same way the backend compares it — trimmed and lowercased — so
 * a staff typo of "GoogleSheets://" resolves identically on both sides.
 */
export function isUnlockManagedScheme(nativeUrlScheme: string | undefined | null): boolean {
  const normalized = normalize(nativeUrlScheme);
  if (!normalized) return false;
  return MANAGED_APP_URL_SCHEMES.some((scheme) => scheme === normalized);
}

/**
 * True when this tile names a managed app by EITHER identity. This is the
 * check the launcher gates on; `isUnlockManagedScheme` alone would silently
 * drop every scheme-less managed app back onto the web-view path.
 */
export function isUnlockManagedApp(app: {
  nativeUrlScheme?: string | undefined | null;
  nativeBundleId?: string | undefined | null;
}): boolean {
  if (isUnlockManagedScheme(app.nativeUrlScheme)) return true;
  const bundleId = normalize(app.nativeBundleId);
  if (!bundleId) return false;
  return MANAGED_APP_BUNDLE_IDS.some((id) => id.toLowerCase() === bundleId);
}
