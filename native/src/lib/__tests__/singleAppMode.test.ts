import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  nativeModule: null as Record<string, unknown> | null,
}));

vi.mock("expo-modules-core", () => ({
  requireOptionalNativeModule: () => state.nativeModule,
}));

describe("setManagedMaximumBrightness", () => {
  beforeEach(() => {
    state.nativeModule = null;
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the managed-lifetime API in current native builds", async () => {
    const setManagedMaximumBrightness = vi.fn(() => Promise.resolve());
    state.nativeModule = { setManagedMaximumBrightness };
    const singleAppMode = await import("../../../modules/single-app-mode");

    const supported = await singleAppMode.setManagedMaximumBrightness(true);

    expect(supported).toBe(true);
    expect(setManagedMaximumBrightness).toHaveBeenCalledWith(true);
  });

  it("requires a cold rebuild after best-effort legacy teardown", async () => {
    const setBrightnessPinned = vi.fn(() => Promise.resolve());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    state.nativeModule = { setBrightnessPinned };
    const singleAppMode = await import("../../../modules/single-app-mode");

    const supported = await singleAppMode.setManagedMaximumBrightness(true);

    expect(supported).toBe(false);
    expect(setBrightnessPinned).toHaveBeenCalledWith(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("install a rebuilt client"),
    );
  });
});
