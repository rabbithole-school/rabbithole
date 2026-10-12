import { MANAGED_NATIVE_APPS } from "./managedNativeApps";

/**
 * The committed Student Devices layout, retained as the drift-tested record of
 * `mdm/profiles/home-layout.mobileconfig`.
 *
 * It is NO LONGER a fallback tiling source. That group-assigned profile was
 * retired from Student Devices during the TRA-241 cutover, because Apple
 * permits only one Home Screen Layout payload per device and the per-device
 * projection now supplies it. Treating it as a fallback would describe a
 * layout that is not installed anywhere.
 */

export const STUDENT_DEVICES_TILED_BUNDLE_IDS: readonly string[] = [
  "school.rabbithole.canary",
  "com.lego.education.spikenext",
  "com.apple.Preferences",
];

export const PILOT_TILED_BUNDLE_IDS: readonly string[] = [
  "school.rabbithole.canary",
];

export const RABBITHOLE_BUNDLE_IDS: readonly string[] = [
  "school.rabbithole",
  "school.rabbithole.canary",
  "school.rabbithole.metro",
];

export const SETTINGS_BUNDLE_ID = "com.apple.Preferences";
export const TILED_BASELINE_BUNDLE_IDS: readonly string[] = [
  "com.apple.mobileslideshow",
  // Files — the photography class's import path for SD-card readers whose
  // cards are NOT laid out as a camera's DCIM tree. Photos only offers an
  // Import tab for DCIM media, so a card written by a computer is invisible
  // there while being perfectly readable in Files. Needs
  // `allowFilesUSBDriveAccess` in the kiosk restrictions, which is already on.
  "com.apple.DocumentsApp",
];
export const HOME_LAYOUT_PROJECTION_FORMAT_VERSION = 2;
export const PILOT_PROFILE_PAYLOAD_IDENTIFIER =
  "school.rabbithole.device-app-unlock.pilot";

/**
 * The Home Screen is the allowlist projection rendered in a deliberate order:
 * Rabbithole first, catalog-managed apps in catalog order, explicitly tiled
 * baseline apps in `TILED_BASELINE_BUNDLE_IDS` order when present, then
 * Settings last. Every other baseline-only app, such as WebDriverAgent,
 * remains allowlisted but untiled.
 */
export function projectedHomeLayoutBundleIds(
  projectedBundleIds: readonly string[],
): string[] {
  const projected = new Set(projectedBundleIds);
  const rabbitholeBundleId = RABBITHOLE_BUNDLE_IDS.find((bundleId) =>
    projected.has(bundleId)
  );
  return [
    ...(rabbitholeBundleId ? [rabbitholeBundleId] : []),
    ...Object.values(MANAGED_NATIVE_APPS)
      .map(({ bundleId }) => bundleId)
      .filter((bundleId) => projected.has(bundleId)),
    ...TILED_BASELINE_BUNDLE_IDS.filter((bundleId) =>
      projected.has(bundleId)
    ),
    ...(projected.has(SETTINGS_BUNDLE_ID) ? [SETTINGS_BUNDLE_ID] : []),
  ];
}

export function projectsHomeLayout(profilePayloadIdentifier: string): boolean {
  return profilePayloadIdentifier !== PILOT_PROFILE_PAYLOAD_IDENTIFIER;
}

/**
 * A bound fleet device's tiling source is its own accepted projection.
 *
 * Returns `null` — meaning "we cannot tell" — when no current projection has
 * been recorded, rather than falling back to the retired static fleet layout.
 * Before the TRA-241 cutover that fallback was honest, because every device
 * carried the group-assigned layout; afterwards it would assert tiles that no
 * profile places, in both directions: claiming a tile for an untiled app, and
 * denying one for an app the projection actually places. Unknown is the true
 * answer, and this module never performs the live read that would resolve it.
 *
 * Pilot never projects a Home Screen payload, so its own committed static
 * layout remains authoritative regardless of allowlist projection state.
 */
export function tiledBundleIdsForDevice(args: {
  hasBinding: boolean;
  profilePayloadIdentifier?: string | null;
  projectionFormatVersion: number | undefined;
  appliedBundleIds: readonly string[] | undefined;
}): readonly string[] | null {
  if (
    args.profilePayloadIdentifier &&
    !projectsHomeLayout(args.profilePayloadIdentifier)
  ) {
    return PILOT_TILED_BUNDLE_IDS;
  }
  if (
    args.hasBinding &&
    args.projectionFormatVersion === HOME_LAYOUT_PROJECTION_FORMAT_VERSION &&
    args.appliedBundleIds !== undefined
  ) {
    return projectedHomeLayoutBundleIds(args.appliedBundleIds);
  }
  return null;
}
