import { getFunctionName } from "convex/server";
import { describe, expect, it, vi } from "vitest";

import {
  nudgeDeviceAppProjection,
  readManagedAppInstallState,
} from "../appUnlockClient";

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

describe("readManagedAppInstallState", () => {
  it("binds the backend query by name and passes the device and app", async () => {
    const query = vi.fn().mockResolvedValue("missing");

    await expect(
      readManagedAppInstallState({ query }, "device-uuid", "app-id"),
    ).resolves.toBe("missing");
    expect(getFunctionName(query.mock.calls[0]?.[0])).toBe(
      "deviceAppUnlock:managedAppInstallState",
    );
    expect(query.mock.calls[0]?.[1]).toEqual({
      deviceId: "device-uuid",
      externalAppId: "app-id",
    });
  });

  it("reads a failure as unknown, which keeps the Home Screen handoff", async () => {
    const query = vi.fn().mockRejectedValue(new Error("no claim"));

    await expect(
      readManagedAppInstallState({ query }, "device-uuid", "app-id"),
    ).resolves.toBe("unknown");
  });

  it("gives up after the timeout instead of holding the tap", async () => {
    const query = vi.fn().mockReturnValue(new Promise(() => {}));

    await expect(
      readManagedAppInstallState({ query }, "device-uuid", "app-id", 5),
    ).resolves.toBe("unknown");
  });

  it("reads an unexpected answer (an older backend) as unknown", async () => {
    const query = vi.fn().mockResolvedValue(null);

    await expect(
      readManagedAppInstallState({ query }, "device-uuid", "app-id"),
    ).resolves.toBe("unknown");
  });
});
