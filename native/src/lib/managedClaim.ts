import * as SecureStore from "expo-secure-store";

import { getManagedConfig } from "../../modules/managed-config";

const SUPPRESSED_CLAIM_KEY = "rabbithole.managedClaim.suppressedToken";

export type ManagedClaim = {
  claimToken: string;
  claimSerial?: string;
  claimVersion?: string;
};

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function readManagedClaim(): ManagedClaim | null {
  const config = getManagedConfig();
  const claimToken = optionalString(config?.claimToken);
  if (!claimToken) return null;
  return {
    claimToken,
    claimSerial: optionalString(config?.claimSerial),
    claimVersion: optionalString(config?.claimVersion),
  };
}

export function readManagedSerial(): string | null {
  return optionalString(getManagedConfig()?.claimSerial) ?? null;
}

export async function suppressManagedClaim(claimToken: string): Promise<void> {
  await SecureStore.setItemAsync(SUPPRESSED_CLAIM_KEY, claimToken);
}

export async function clearManagedClaimSuppression(
  claimToken: string,
): Promise<void> {
  const suppressed = await SecureStore.getItemAsync(SUPPRESSED_CLAIM_KEY);
  if (suppressed === claimToken) {
    await SecureStore.deleteItemAsync(SUPPRESSED_CLAIM_KEY);
  }
}

export async function isManagedClaimSuppressed(
  claimToken: string,
): Promise<boolean> {
  const suppressed = await SecureStore.getItemAsync(SUPPRESSED_CLAIM_KEY);
  if (!suppressed) return false;
  if (suppressed === claimToken) return true;
  await SecureStore.deleteItemAsync(SUPPRESSED_CLAIM_KEY);
  return false;
}

