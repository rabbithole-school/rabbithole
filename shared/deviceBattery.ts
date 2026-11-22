export type DeviceBatteryBand =
  | "low"
  | "medium"
  | "high"
  | "full"
  | "unknown";

export function deviceBatteryBand(
  batteryLevel: number | null,
): DeviceBatteryBand {
  if (
    batteryLevel === null ||
    !Number.isFinite(batteryLevel) ||
    batteryLevel < 0 ||
    batteryLevel > 100
  ) {
    return "unknown";
  }
  if (batteryLevel < 20) return "low";
  if (batteryLevel < 50) return "medium";
  if (batteryLevel < 100) return "high";
  return "full";
}

/**
 * How old a SimpleMDM battery reading can get before nothing should treat it
 * as the iPad's charge now: the devices console shows "Unknown" past it, and
 * the school-night charge reminder won't text about it (convex/lib/
 * chargeReminder.ts). SimpleMDM hears from a reachable iPad about hourly, so
 * an older reading means the iPad has been off, flat or offline since
 * (2026-11-07: a test iPad charged to 100% overnight still showed the 1% it
 * died at the afternoon before).
 */
export const DEVICE_BATTERY_STALE_AFTER_MS = 3 * 60 * 60 * 1000;

/**
 * True when a battery reading taken at `readAt` is too old to show as the
 * iPad's charge. A reading with no date can't be trusted either.
 */
export function batteryReadingIsStale(
  readAt: number | null,
  nowMs: number,
): boolean {
  if (readAt === null || !Number.isFinite(readAt)) return true;
  return nowMs - readAt > DEVICE_BATTERY_STALE_AFTER_MS;
}
