import { afterEach, describe, expect, it, vi } from "vitest";

// The reader caches the native module, so each case sets what
// `requireOptionalNativeModule` answers and imports a fresh copy.
async function load(nativeModule: unknown) {
  vi.resetModules();
  vi.doMock("expo-modules-core", () => ({
    requireOptionalNativeModule: () => nativeModule,
  }));
  return await import("../batteryReading");
}

afterEach(() => {
  vi.doUnmock("expo-modules-core");
});

describe("readBattery", () => {
  it("reports nothing on a binary built before the battery module", async () => {
    const battery = await load(null);
    await expect(battery.readBattery()).resolves.toBeNull();
    // Subscribing is a harmless no-op there too.
    expect(() => battery.subscribeBatteryStateChange(() => {})()).not.toThrow();
  });

  it("maps iOS's fraction and state onto the check-in's fields", async () => {
    const battery = await load({
      getBatteryLevelAsync: async () => 0.137,
      getBatteryStateAsync: async () => 2,
    });
    await expect(battery.readBattery()).resolves.toEqual({
      batteryLevel: 14,
      batteryState: "charging",
    });
  });

  it("drops an unknown level (-1) but keeps the state", async () => {
    const battery = await load({
      getBatteryLevelAsync: async () => -1,
      getBatteryStateAsync: async () => 1,
    });
    await expect(battery.readBattery()).resolves.toEqual({
      batteryState: "unplugged",
    });
  });

  it("answers null when the native read throws", async () => {
    const battery = await load({
      getBatteryLevelAsync: async () => {
        throw new Error("boom");
      },
      getBatteryStateAsync: async () => 3,
    });
    await expect(battery.readBattery()).resolves.toBeNull();
  });
});

describe("batteryStateFromNative", () => {
  it("covers every expo-battery state", async () => {
    const { batteryStateFromNative } = await load(null);
    expect([0, 1, 2, 3, 4, 9].map(batteryStateFromNative)).toEqual([
      "unknown",
      "unplugged",
      "charging",
      "full",
      "unplugged",
      "unknown",
    ]);
  });
});
