// Lightweight wrapper around expo-secure-store for "has seen onboarding" flag.
// Uses a single key; returns false if the store is unavailable (never throws).

import * as SecureStore from "expo-secure-store";

const KEY = "rabbithole_onboarding_seen_v1";

export async function hasSeenOnboarding(): Promise<boolean> {
  try {
    const val = await SecureStore.getItemAsync(KEY);
    return val === "1";
  } catch {
    return false;
  }
}

export async function markOnboardingSeen(): Promise<void> {
  try {
    await SecureStore.setItemAsync(KEY, "1");
  } catch {
    // Best-effort; never throw — a failed write means the flow might show again
    // next launch, which is acceptable.
  }
}
