/**
 * openWifiSettings — deep-link into the iOS wifi settings pane (multi-app kiosk).
 *
 * In multi-app kiosk (MDM allowlist) mode the scholar CAN open the Settings app,
 * so recovery is "one tap into app settings, then pick Wi-Fi in Settings". This
 * helper deliberately uses only Apple's public Settings URL; Stable can ship
 * through App Store review without embedding private Settings schemes.
 *
 * NATIVE-ONLY BY DESIGN — there is no web counterpart (the web app never runs in
 * kiosk/Single App Mode). Kept pure/injectable so the fallback ORDER can be unit
 * tested without a native module (no `react-native` at import-eval time beyond a
 * lazily-defaulted dep).
 *
 * `app-settings:` opens the public app-specific Settings page. The surrounding
 * kiosk profile keeps Settings reachable, so an adult can continue to Wi-Fi
 * without relying on a private, review-unsafe scheme.
 */
import type { Linking as LinkingModule } from "react-native";

/**
 * Ordered public deep-link candidates to reach Settings.
 */
export const WIFI_SETTINGS_URL_CANDIDATES: readonly string[] = [
  "app-settings:",
];

/**
 * Injectable `Linking`-like surface so this is unit-testable without a native
 * module. Defaults to react-native's `Linking`.
 */
export type OpenWifiSettingsDeps = {
  canOpenURL: (url: string) => Promise<boolean>;
  openURL: (url: string) => Promise<unknown>;
  openSettings: () => Promise<unknown>;
};

const defaultDeps: OpenWifiSettingsDeps = {
  canOpenURL: (url) => linking().canOpenURL(url),
  openURL: (url) => linking().openURL(url),
  openSettings: () => linking().openSettings(),
};

// Lazily resolve react-native's Linking so this module can be imported in a pure
// node test env (and the fallback ORDER unit-tested) WITHOUT evaluating any
// native module — only the injected deps are ever exercised in tests.
function linking(): typeof LinkingModule {
  // Runtime require (not a static import) so importing this module never
  // evaluates react-native — this is the standard Metro/RN pattern (see
  // components/manipulatives/kitAudio.ts). Only the default deps hit it; tests
  // inject their own and never load a native module.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy RN Linking.
  return (require("react-native") as { Linking: typeof LinkingModule }).Linking;
}

/**
 * Try each wifi-settings deep link in order; the first one that both reports
 * openable AND opens without throwing wins. If none open, fall back to the app's
 * own settings page via `openSettings()`. Never throws — a failure to reach any
 * settings surface resolves quietly (the overlay's "Check again" is the retry).
 */
export async function openWifiSettings(
  deps: OpenWifiSettingsDeps = defaultDeps,
): Promise<void> {
  for (const url of WIFI_SETTINGS_URL_CANDIDATES) {
    let openable = false;
    try {
      openable = await deps.canOpenURL(url);
    } catch {
      openable = false;
    }
    if (!openable) continue;

    try {
      await deps.openURL(url);
      return;
    } catch {
      // This candidate reported openable but failed to open — try the next one.
    }
  }

  try {
    await deps.openSettings();
  } catch {
    // Nothing reachable; give up silently. The overlay stays up so the scholar
    // can ask a trusted adult and retry.
  }
}
