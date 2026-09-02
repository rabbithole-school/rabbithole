import { requireOptionalNativeModule } from "expo-modules-core";

import type { SingleAppModeModule } from "./src/SingleAppMode.types";

// `requireOptionalNativeModule` returns null (instead of throwing) when the
// module isn't present in the running binary — e.g. a dev client / Simulator
// build made before this module was added, or any non-Apple platform. Every
// consumer then safely degrades to "not locked" / "did nothing", which is the
// correct behavior anywhere ASAM can't run.
const nativeModule =
  requireOptionalNativeModule<SingleAppModeModule>("SingleAppMode");

/**
 * Is the app currently locked in Single App Mode right now? Point-in-time read
 * of `UIAccessibility.isGuidedAccessEnabled`. False when the native module is
 * unavailable (Simulator / older binary) or on any error.
 */
export function isSingleAppModeActive(): boolean {
  try {
    return nativeModule?.isActive() ?? false;
  } catch {
    return false;
  }
}

/**
 * Lock the app into Single App Mode (Autonomous Single App Mode). Resolves the
 * OS-reported success flag; resolves `false` (never throws) when the module is
 * unavailable or the app isn't MDM-permitted for ASAM.
 */
export async function enterSingleAppMode(): Promise<boolean> {
  try {
    return (await nativeModule?.enter()) ?? false;
  } catch {
    return false;
  }
}

/**
 * Release Single App Mode so the surrounding kiosk (and Settings → Wi-Fi) is
 * reachable again. Resolves the OS-reported success flag; resolves `false`
 * (never throws) when unavailable.
 */
export async function exitSingleAppMode(): Promise<boolean> {
  try {
    return (await nativeModule?.exit()) ?? false;
  } catch {
    return false;
  }
}

/**
 * Keep a managed install at maximum brightness while enabled. A native rebuild
 * is required when the current client predates this API.
 */
export async function setManagedMaximumBrightness(
  enabled: boolean,
): Promise<boolean> {
  try {
    if (nativeModule?.setManagedMaximumBrightness) {
      await nativeModule.setManagedMaximumBrightness(enabled);
      return true;
    }
    // Best effort for a cold old client. A block observer retained by an older
    // Metro runtime survives JS reloads, so only a full process restart removes it.
    await nativeModule?.setBrightnessPinned?.(false);
    if (enabled) {
      console.warn(
        "[managed-brightness] Current native client cannot enforce maximum brightness. Fully quit the app and install a rebuilt client.",
      );
    }
    return false;
  } catch (error) {
    console.warn("[managed-brightness] Could not update brightness policy.", error);
    return false;
  }
}
