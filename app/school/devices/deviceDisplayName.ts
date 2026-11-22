/**
 * The name a device goes by on every school-devices surface: the name set in
 * SimpleMDM, then the serial, then the paired-device label (which can be the
 * hardware model, e.g. "iPad (A16)"), then a bare "iPad". The drawer and the
 * device settings page both call this so the two headings cannot drift.
 */
export function deviceDisplayName(parts: {
  managedName?: string | null;
  serial?: string | null;
  deviceLabel?: string | null;
}): string {
  return parts.managedName ?? parts.serial ?? parts.deviceLabel ?? "iPad";
}
