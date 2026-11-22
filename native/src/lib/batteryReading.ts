import { requireOptionalNativeModule } from "expo-modules-core";

/**
 * The iPad's battery, read for the native client check-in so the server's
 * school-night charge reminder can tell a plugged-in BunnyPad from a flat one
 * (convex/lib/chargeReminder.ts).
 *
 * Read through `requireOptionalNativeModule`, not `expo-battery`'s own entry:
 * that one calls `requireNativeModule` at import time and would crash a dev
 * client or binary built before the module was added. Here an older binary
 * simply reports nothing, and the server treats "nothing" as "not known to be
 * charging".
 */
type ExpoBatteryModule = {
  getBatteryLevelAsync?: () => Promise<number>;
  getBatteryStateAsync?: () => Promise<number>;
  addListener?: (
    eventName: string,
    listener: (event: unknown) => void,
  ) => { remove: () => void };
};

export type BatteryState = "unplugged" | "charging" | "full" | "unknown";

export type BatteryReading = {
  /** 0–100, or undefined when iOS can't say (it reports -1). */
  batteryLevel?: number;
  batteryState: BatteryState;
};

// expo-battery's BatteryState enum: 0 UNKNOWN, 1 UNPLUGGED, 2 CHARGING,
// 3 FULL, 4 NOT_CHARGING (Android only).
export function batteryStateFromNative(value: number): BatteryState {
  if (value === 1 || value === 4) return "unplugged";
  if (value === 2) return "charging";
  if (value === 3) return "full";
  return "unknown";
}

/** expo-battery's 0–1 fraction as a whole percent; -1 (unknown) → undefined. */
export function batteryPercentFromNative(level: number): number | undefined {
  if (!Number.isFinite(level) || level < 0 || level > 1) return undefined;
  return Math.round(level * 100);
}

let cachedModule: ExpoBatteryModule | null | undefined;
function batteryModule(): ExpoBatteryModule | null {
  if (cachedModule === undefined) {
    cachedModule = requireOptionalNativeModule<ExpoBatteryModule>("ExpoBattery");
  }
  return cachedModule;
}

/** Null when this binary has no battery module or the read fails. */
export async function readBattery(): Promise<BatteryReading | null> {
  const battery = batteryModule();
  if (!battery?.getBatteryStateAsync || !battery.getBatteryLevelAsync) {
    return null;
  }
  try {
    const [level, state] = await Promise.all([
      battery.getBatteryLevelAsync(),
      battery.getBatteryStateAsync(),
    ]);
    const batteryLevel = batteryPercentFromNative(level);
    return {
      ...(batteryLevel !== undefined ? { batteryLevel } : {}),
      batteryState: batteryStateFromNative(state),
    };
  } catch {
    return null;
  }
}

/**
 * Call `onChange` when the iPad is plugged in or unplugged, so the check-in
 * reports it at once instead of up to five minutes later. Returns the
 * unsubscribe; a no-op on a binary without the battery module.
 */
export function subscribeBatteryStateChange(onChange: () => void): () => void {
  const battery = batteryModule();
  if (!battery?.addListener) return () => {};
  try {
    const subscription = battery.addListener(
      "Expo.batteryStateDidChange",
      () => onChange(),
    );
    return () => subscription.remove();
  } catch {
    return () => {};
  }
}
