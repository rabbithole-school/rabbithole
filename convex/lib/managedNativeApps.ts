/**
 * The ONE catalog of managed-native apps this deployment can request a
 * temporary per-device MDM unlock for (PR #3212's `deviceAppUnlock.ts`).
 *
 * A catalog app (`externalApps`) is "managed-native" purely by its
 * `nativeUrlScheme` matching an entry here — there is no separate schema flag
 * or assignment API. This module is the single place that mapping is defined;
 * `deviceAppUnlock.ts` imports it to authorize/execute an unlock, and
 * `appAudiences.ts` imports it (read-only) to classify a catalog row for the
 * teacher Apps tab and the Slack `list_external_apps` tool, so a teacher can
 * tell up front that a tile means "one device unlocks it at a time" rather
 * than an ordinary always-available web app.
 *
 * The native client keeps its own pre-flight mirror of the scheme list —
 * `native/src/lib/asam/managedAppSchemes.ts` — since a device must recognize a
 * managed scheme before it ever reaches the network; that file documents the
 * backend (here) as authoritative and is drift-tested against `native/app.json`.
 */

export type ManagedNativeAppKey = "google-sheets" | "lego-spike";

export const MANAGED_NATIVE_APPS: Record<
  ManagedNativeAppKey,
  { bundleId: string; nativeUrlScheme: string }
> = {
  "google-sheets": {
    bundleId: "com.google.Sheets",
    nativeUrlScheme: "googlesheets://",
  },
  "lego-spike": {
    bundleId: "com.lego.education.spikenext",
    nativeUrlScheme: "spike://",
  },
};

/** Normalize a catalog app's `nativeUrlScheme` to its managed-app key, or
 *  `null` if it isn't one (a plain native deep link, or unset — a web-only
 *  app). Case/whitespace-insensitive to match how the value is stored. */
export function managedNativeAppKeyForScheme(
  nativeUrlScheme: string | null | undefined,
): ManagedNativeAppKey | null {
  const normalized = nativeUrlScheme?.trim().toLowerCase();
  if (!normalized) return null;
  const entry = (
    Object.entries(MANAGED_NATIVE_APPS) as [
      ManagedNativeAppKey,
      (typeof MANAGED_NATIVE_APPS)[ManagedNativeAppKey],
    ][]
  ).find(([, supported]) => supported.nativeUrlScheme === normalized);
  return entry ? entry[0] : null;
}
