import { describe, expect, it, vi } from "vitest";

import type { Id } from "@/lib/convex";
import { reportReturnedToRabbithole } from "../appUnlockClient";

const TARGET = {
  externalAppId: "external_app_sheets" as Id<"externalApps">,
  deviceId: "device-uuid",
  leaseToken: "lease-1",
};

describe("reportReturnedToRabbithole", () => {
  it("tells the backend which iPad came back", async () => {
    const mutation = vi.fn().mockResolvedValue({ marked: true, expiresAt: 1 });

    await expect(reportReturnedToRabbithole({ mutation }, TARGET)).resolves.toBe(
      true,
    );
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(mutation.mock.calls[0]?.[1]).toEqual({
      deviceId: "device-uuid",
      leaseToken: "lease-1",
    });
  });

  it("swallows the rejection when there is no session to return from", async () => {
    const mutation = vi.fn().mockRejectedValue(new Error("no active session"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // A scholar who backgrounded Rabbithole without launching anything must not
    // see an error, and the caller must not have to guard the call site. This is
    // the ORDINARY path, so it must also stay silent in the logs.
    await expect(reportReturnedToRabbithole({ mutation }, TARGET)).resolves.toBe(
      false,
    );
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
