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
