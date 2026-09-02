import * as SecureStore from "expo-secure-store";

const DEVICE_ID_KEY = "rabbithole.managedClaim.deviceId";
let stableDeviceIdPromise: Promise<string> | null = null;

async function loadStableDeviceId(): Promise<string> {
  const existing = await SecureStore.getItemAsync(DEVICE_ID_KEY);
  if (existing) return existing;
  const created =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
          const randomNibble = Math.floor(Math.random() * 16);
          const value =
            character === "x" ? randomNibble : (randomNibble & 0x3) | 0x8;
          return value.toString(16);
        });
  await SecureStore.setItemAsync(DEVICE_ID_KEY, created);
  return created;
}

/**
 * Stable per-install device identity shared by managed sign-in and Rabbithole
 * Lock. Keychain-backed SecureStore survives app reinstall and resets on erase.
 */
export function getStableDeviceId(): Promise<string> {
  if (!stableDeviceIdPromise) {
    stableDeviceIdPromise = loadStableDeviceId().catch((error) => {
      stableDeviceIdPromise = null;
      throw error;
    });
  }
  return stableDeviceIdPromise;
}
