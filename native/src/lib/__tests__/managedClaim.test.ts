import { beforeEach, describe, expect, it, vi } from "vitest";

const secureStore = vi.hoisted(() => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
const managedConfig = vi.hoisted(() => ({
  getManagedConfig: vi.fn(),
}));

vi.mock("expo-secure-store", () => secureStore);
vi.mock("../../../modules/managed-config", () => managedConfig);

import {
  clearManagedClaimSuppression,
  isManagedClaimSuppressed,
  readManagedSerial,
  suppressManagedClaim,
} from "../managedClaim";

describe("managed claim suppression", () => {
  beforeEach(() => {
    secureStore.getItemAsync.mockReset();
    secureStore.setItemAsync.mockReset();
    secureStore.deleteItemAsync.mockReset();
    managedConfig.getManagedConfig.mockReset();
    managedConfig.getManagedConfig.mockReturnValue(null);
  });

  it("suppresses the current managed claim", async () => {
    await suppressManagedClaim("rhc_current");

    expect(secureStore.setItemAsync).toHaveBeenCalledWith(
      "rabbithole.managedClaim.suppressedToken",
      "rhc_current",
    );
  });

  it("clears suppression only for the claim that failed to sign out", async () => {
    secureStore.getItemAsync.mockResolvedValue("rhc_reassigned");

    await clearManagedClaimSuppression("rhc_current");

    expect(secureStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  it("removes stale suppression when MDM delivers a changed claim", async () => {
    secureStore.getItemAsync.mockResolvedValue("rhc_previous");

    await expect(isManagedClaimSuppressed("rhc_current")).resolves.toBe(false);
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith(
      "rabbithole.managedClaim.suppressedToken",
    );
  });
});

describe("managed device identity", () => {
  beforeEach(() => {
    managedConfig.getManagedConfig.mockReset();
  });

  it("reads a trimmed serial delivered by MDM", () => {
    managedConfig.getManagedConfig.mockReturnValue({
      claimSerial: "  MKD0M6X7Q2  ",
    });

    expect(readManagedSerial()).toBe("MKD0M6X7Q2");
  });

  it("omits a missing or malformed serial", () => {
    managedConfig.getManagedConfig.mockReturnValue({ claimSerial: 42 });
    expect(readManagedSerial()).toBeNull();

    managedConfig.getManagedConfig.mockReturnValue({ claimSerial: "   " });
    expect(readManagedSerial()).toBeNull();
  });
});
