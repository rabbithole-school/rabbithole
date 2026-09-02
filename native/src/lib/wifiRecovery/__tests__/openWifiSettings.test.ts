import { describe, it, expect, vi } from "vitest";

import {
  WIFI_SETTINGS_URL_CANDIDATES,
  openWifiSettings,
  type OpenWifiSettingsDeps,
} from "../openWifiSettings";

// The candidate order is the contract under test. Assert against the exported
// constant so these tests track any future retuning of the list.
const [APP_SETTINGS_URL] = WIFI_SETTINGS_URL_CANDIDATES;

/** Deps whose `canOpenURL` answers `true` only for the URLs in `openable`. */
function makeDeps(openable: string[]): OpenWifiSettingsDeps {
  return {
    canOpenURL: vi.fn(async (url: string) => openable.includes(url)),
    openURL: vi.fn(async () => undefined),
    openSettings: vi.fn(async () => undefined),
  };
}

describe("openWifiSettings", () => {
  it("contains only the public app-settings URL", () => {
    expect(WIFI_SETTINGS_URL_CANDIDATES).toEqual(["app-settings:"]);
  });

  it("opens app settings when it can be opened", async () => {
    const deps = makeDeps([APP_SETTINGS_URL]);

    await openWifiSettings(deps);

    expect(deps.openURL).toHaveBeenCalledTimes(1);
    expect(deps.openURL).toHaveBeenCalledWith(APP_SETTINGS_URL);
    expect(deps.openSettings).not.toHaveBeenCalled();
  });

  it("falls back to openSettings() when no URL opens", async () => {
    const deps = makeDeps([]); // nothing openable

    await openWifiSettings(deps);

    expect(deps.openURL).not.toHaveBeenCalled();
    expect(deps.openSettings).toHaveBeenCalledTimes(1);
    // It probed every candidate before giving up on deep links.
    for (const url of WIFI_SETTINGS_URL_CANDIDATES) {
      expect(deps.canOpenURL).toHaveBeenCalledWith(url);
    }
  });

  it("skips a candidate that reports openable but throws on open, then continues", async () => {
    const deps: OpenWifiSettingsDeps = {
      canOpenURL: vi.fn(async () => true), // every candidate claims openable
      openURL: vi.fn(async () => {
        throw new Error("no handler");
      }),
      openSettings: vi.fn(async () => undefined),
    };

    await openWifiSettings(deps);

    expect(deps.openURL).toHaveBeenCalledWith(APP_SETTINGS_URL);
    expect(deps.openSettings).toHaveBeenCalledTimes(1);
  });
});
