import { requireOptionalNativeModule } from "expo-modules-core";

import type { ManagedConfigModule } from "./src/ManagedConfig.types";

const nativeModule =
  requireOptionalNativeModule<ManagedConfigModule>("ManagedConfig");

/**
 * Reads the MDM-delivered AppConfig dictionary, dropping CFPreferences'
 * in-process cache first so a running app sees a claim MDM replaced under it
 * (see the Swift module for why that is not optional). Older dev clients, Expo
 * Go, and non-Apple platforms safely behave as if no managed configuration was
 * present.
 */
export function getManagedConfig(): Record<string, unknown> | null {
  try {
    return nativeModule?.getManagedConfig() ?? null;
  } catch {
    return null;
  }
}
