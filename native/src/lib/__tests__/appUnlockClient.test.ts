import { getFunctionName } from "convex/server";
import { describe, expect, it, vi } from "vitest";

import { nudgeDeviceAppProjection } from "../appUnlockClient";

describe("nudgeDeviceAppProjection", () => {
  it("asks the backend to converge THIS iPad, and names no app", async () => {
    // The server owns app identity under the projection — the client stops
    // requesting a specific one, so a device id is the whole payload.
    const mutation = vi.fn().mockResolvedValue({ nudged: true });

    await expect(
      nudgeDeviceAppProjection({ mutation }, "device-uuid"),
    ).resolves.toBe(true);
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(mutation.mock.calls[0]?.[1]).toEqual({ deviceId: "device-uuid" });
  });

  it("binds the backend function by its current name", async () => {
    // The one rename point: if this string drifts from convex/deviceAppUnlock.ts
    // every cold launch silently waits for the reconciler's own cron instead.
    const mutation = vi.fn().mockResolvedValue({ nudged: false });

    await nudgeDeviceAppProjection({ mutation }, "device-uuid");

    expect(getFunctionName(mutation.mock.calls[0]?.[0])).toBe(
      "deviceAppUnlock:nudgeProjection",
    );
  });

  it("reports an iPad the projection does not cover without failing", async () => {
    const mutation = vi.fn().mockResolvedValue({ nudged: false });

    await expect(
      nudgeDeviceAppProjection({ mutation }, "device-uuid"),
    ).resolves.toBe(false);
  });

  it("swallows a transport failure — the nudge is latency, not correctness", async () => {
    // The reconciler's cron converges the device regardless, so a launch must
    // never fail because the hint did. This is the ORDINARY offline path, so it
    // must also stay silent in the logs.
    const mutation = vi.fn().mockRejectedValue(new Error("network down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      nudgeDeviceAppProjection({ mutation }, "device-uuid"),
    ).resolves.toBe(false);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
