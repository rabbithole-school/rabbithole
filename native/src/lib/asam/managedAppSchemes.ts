// The apps this managed-iPad build can temporarily unlock, mirrored from the
// backend's SUPPORTED_APPS in convex/deviceAppUnlock.ts. Two jobs:
//
//  1. Decide LOCALLY whether a tapped tile is even part of the unlock feature.
//     The backend's status query throws for an app it does not manage, so
//     asking about (say) the practice app would turn a working launch into a
//     scholar-visible failure. Matching the scheme first keeps every other tile
//     on exactly today's path — no round trip, no modal.
//  2. Pin the iOS `LSApplicationQueriesSchemes` allowlist. iOS refuses
//     `canOpenURL` for any scheme missing from it, and the list is baked in at
//     build time — see native/app.json → expo.ios.infoPlist, kept in sync by
//     __tests__/managedAppSchemes.test.ts.
//
// The backend is the authority on both the scheme and the bundle id; this list
// is a mirror, and drift shows up as a tile that simply behaves as it does
// today rather than as a broken launch.

/** Scheme prefixes exactly as the backend records them. */
export const MANAGED_APP_URL_SCHEMES = ["googlesheets://", "spike://"] as const;

/** The bare scheme names, as iOS wants them in LSApplicationQueriesSchemes. */
export const MANAGED_APP_QUERY_SCHEMES = MANAGED_APP_URL_SCHEMES.map((scheme) =>
  scheme.replace("://", ""),
);

/**
 * True when this catalog tile's native scheme is one the backend can unlock.
 * Compared the same way the backend compares it — trimmed and lowercased — so
 * a staff typo of "GoogleSheets://" resolves identically on both sides.
 */
export function isUnlockManagedScheme(nativeUrlScheme: string | undefined | null): boolean {
  if (!nativeUrlScheme) return false;
  const normalized = nativeUrlScheme.trim().toLowerCase();
  return MANAGED_APP_URL_SCHEMES.some((scheme) => scheme === normalized);
}
