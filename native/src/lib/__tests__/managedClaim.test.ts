import { beforeEach, describe, expect, it, vi } from "vitest";

const managedConfig = vi.hoisted(() => ({
  getManagedConfig: vi.fn(),
}));

vi.mock("../../../modules/managed-config", () => managedConfig);

import { readManagedSerial } from "../managedClaim";

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
