import { beforeEach, describe, expect, it, vi } from "vitest";

const secureStore = vi.hoisted(() => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

vi.mock("expo-secure-store", () => secureStore);

describe("getStableDeviceId", () => {
  beforeEach(() => {
    vi.resetModules();
    secureStore.getItemAsync.mockReset();
    secureStore.setItemAsync.mockReset();
  });

  it("shares one first-launch read and write across concurrent callers", async () => {
    let resolveRead: ((value: null) => void) | undefined;
    secureStore.getItemAsync.mockReturnValue(
      new Promise<null>((resolve) => {
        resolveRead = resolve;
      }),
    );
    secureStore.setItemAsync.mockResolvedValue(undefined);
    const { getStableDeviceId } = await import("../deviceIdentity");

    const first = getStableDeviceId();
    const second = getStableDeviceId();
    expect(secureStore.getItemAsync).toHaveBeenCalledTimes(1);

    resolveRead?.(null);
    const [firstId, secondId] = await Promise.all([first, second]);

    expect(firstId).toBe(secondId);
    expect(secureStore.setItemAsync).toHaveBeenCalledTimes(1);
    expect(secureStore.setItemAsync).toHaveBeenCalledWith(
      "rabbithole.managedClaim.deviceId",
      firstId,
    );
  });

  it("reuses the persisted id without writing", async () => {
    secureStore.getItemAsync.mockResolvedValue("persisted-device-id");
    const { getStableDeviceId } = await import("../deviceIdentity");

    await expect(getStableDeviceId()).resolves.toBe("persisted-device-id");
    await expect(getStableDeviceId()).resolves.toBe("persisted-device-id");

    expect(secureStore.getItemAsync).toHaveBeenCalledTimes(1);
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it("allows a retry after a SecureStore failure", async () => {
    secureStore.getItemAsync.mockResolvedValue(null);
    secureStore.setItemAsync
      .mockRejectedValueOnce(new Error("write failed"))
      .mockResolvedValueOnce(undefined);
    const { getStableDeviceId } = await import("../deviceIdentity");

    await expect(getStableDeviceId()).rejects.toThrow("write failed");
    await expect(getStableDeviceId()).resolves.toMatch(
      /^[0-9a-f]{8}-[0-9a-f-]{27}$/,
    );

    expect(secureStore.getItemAsync).toHaveBeenCalledTimes(2);
    expect(secureStore.setItemAsync).toHaveBeenCalledTimes(2);
  });
});
