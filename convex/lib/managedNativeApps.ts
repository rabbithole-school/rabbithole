/**
 * The ONE catalog of managed-native apps this deployment can request a
 * temporary per-device MDM unlock for (PR #3212's `deviceAppUnlock.ts`).
 *
 * A catalog app (`externalApps`) is "managed-native" purely by matching an
 * entry here — there is no separate schema flag or assignment API. This module
 * is the single place that mapping is defined; `deviceAppUnlock.ts` imports it
 * to authorize/execute an unlock, and `appAudiences.ts` imports it (read-only)
 * to classify a catalog row for the teacher Apps tab and the Slack
 * `list_external_apps` tool, so a teacher can tell up front that a tile means
 * "one device unlocks it at a time" rather than an ordinary always-available
 * web app.
 *
 * ── TWO WAYS TO IDENTIFY ONE, AND WHY ─────────────────────────────────────
 *
 * Historically the `nativeUrlScheme` WAS the identity: a catalog row matched
 * an entry here by its scheme, and the scheme was also how the tile launched
 * the app. That conflated two different questions, and Mentava Reading broke
 * the conflation — its shipping build registers NO custom URL scheme and no
 * associated domains (read off the device 2026-09-21; verified against three
 * known-positive controls in the same read), so it can be *managed* but can
 * never be *launched* by URL.
 *
 * So identity is now `nativeUrlScheme` OR `nativeBundleId`, and a null scheme
 * is a first-class entry rather than an absent one:
 *
 *   - `nativeUrlScheme` non-null → the tile opens the app directly.
 *   - `nativeUrlScheme` null → the tile does everything else (readiness,
 *     allowlist, Home Screen placement, ASAM release) and then tells the
 *     scholar to tap the app on the Home Screen. See
 *     `native/src/contexts/NativeAppLaunchContext.tsx`.
 *
 * The native client keeps its own pre-flight mirror —
 * `native/src/lib/asam/managedAppSchemes.ts` — since a device must recognize a
 * managed app before it ever reaches the network; that file documents the
 * backend (here) as authoritative and is drift-tested against
 * `native/app.json`.
 */

export type ManagedNativeAppKey =
  | "google-sheets"
  | "lego-spike"
  | "stop-motion-studio"
  | "mentava-reading"
  | "google-arts-culture";

// Deployment configuration — see DEPLOYMENT.md (Managed external apps).
export const MANAGED_NATIVE_APPS: Record<
  ManagedNativeAppKey,
  { bundleId: string; nativeUrlScheme: string | null }
> = {
  "google-sheets": {
    bundleId: "com.google.Sheets",
    nativeUrlScheme: "googlesheets://",
  },
  "lego-spike": {
    bundleId: "com.lego.education.spikenext",
    nativeUrlScheme: "spike://",
  },
  "stop-motion-studio": {
    // Stop Motion Studio Pro (Cateater, LLC; iTunes 640564761) replaced the
    // non-Pro app on 2026-09-10.
    bundleId: "com.cateater.funapps.stopmotionstudiopro",
    // Keep the scheme unchanged because the production catalog row is matched
    // by it. "stopmotionstudio://" was verified against the old app on a
    // physical iPad on 2026-09-01, and VERIFIED AGAINST THE PRO APP on a fleet
    // iPad on 2026-09-17 (tile tap opens Stop Motion Studio Pro) — the Pro
    // app kept the scheme. Tap-to-launch also needs the `stopmotionstudio`
    // LSApplicationQueriesSchemes plist entry (native/app.json) on the
    // device's installed build; that shipped in build 41 and the fleet is well
    // past it, so `canOpenURL` succeeds.
    nativeUrlScheme: "stopmotionstudio://",
  },
  "mentava-reading": {
    bundleId: "com.mentava.learn2read",
    // Intentionally null, and NOT an oversight to be "fixed" by guessing a
    // scheme. The shipping build's Info.plist declares CFBundleURLTypes of
    // only http/https/mailto, and its entitlements carry no
    // associated-domains — so there is no scheme and no universal link to
    // open it with. A fabricated scheme here would produce a tile that fails
    // on tap. If Mentava ever ships one, set it here and the tile upgrades to
    // a direct launch with no other change.
    nativeUrlScheme: null,
  },
  "google-arts-culture": {
    // Google Arts & Culture (Google LLC; iTunes 1050970557), licensed through
    // ASM and installed on Student Devices 2026-09-22 for artist research in
    // Photography/Art.
    bundleId: "com.google.Stella",
    // Read off the Pilot iPad (11.16.3, 2026-09-22) with SPIKE and Sheets as
    // known-positive controls in the same read: CFBundleURLSchemes is
    // `com.google.stella` plus a `com.google.sso.*` sign-in callback, which is
    // not a launch target. The app also claims universal links for
    // artsandculture.google.com, but the custom scheme fits the existing
    // canOpenURL readiness check; an https link always reports openable.
    nativeUrlScheme: "com.google.stella://",
  },
};

/** How a catalog row names the native app it stands for. */
export type ManagedNativeAppIdentity = {
  nativeUrlScheme?: string | null;
  nativeBundleId?: string | null;
};

const normalize = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : null;
};

/**
 * Normalize a catalog app to its managed-app key, or `null` if it isn't one
 * (a plain native deep link, or neither field set — a web-only app).
 *
 * Scheme and bundle id are BOTH case/whitespace-insensitive, matching how the
 * values are stored and how staff type them. The scheme is checked first so a
 * row that carries both keeps its historical meaning.
 *
 * This takes the whole identity rather than a bare scheme so that adding a
 * scheme-less app cannot silently skip a call site: every caller had to be
 * revisited to pass the second field, which is the point.
 */
export function managedNativeAppKeyForApp(
  app: ManagedNativeAppIdentity,
): ManagedNativeAppKey | null {
  const scheme = normalize(app.nativeUrlScheme);
  const bundleId = normalize(app.nativeBundleId);
  if (!scheme && !bundleId) return null;
  const entries = Object.entries(MANAGED_NATIVE_APPS) as [
    ManagedNativeAppKey,
    (typeof MANAGED_NATIVE_APPS)[ManagedNativeAppKey],
  ][];
  for (const [key, supported] of entries) {
    if (scheme && supported.nativeUrlScheme === scheme) return key;
    if (bundleId && supported.bundleId.toLowerCase() === bundleId) return key;
  }
  return null;
}

/** True when this managed app can be opened directly by URL. */
export function managedNativeAppLaunchesByUrl(
  key: ManagedNativeAppKey,
): boolean {
  return MANAGED_NATIVE_APPS[key].nativeUrlScheme !== null;
}

/** Every non-null scheme, for the native `LSApplicationQueriesSchemes` mirror. */
export const MANAGED_NATIVE_APP_URL_SCHEMES: readonly string[] = Object.values(
  MANAGED_NATIVE_APPS,
)
  .map(({ nativeUrlScheme }) => nativeUrlScheme)
  .filter((scheme): scheme is string => scheme !== null);
