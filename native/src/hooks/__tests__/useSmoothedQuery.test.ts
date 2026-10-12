import { describe, expect, it } from "vitest";

import { nextRetained, resolveSmoothed } from "@/hooks/useSmoothedQuery";

// Mirrors the web hook's test: the keep-previous transition is proven through
// its pure core. On native this is what stops the Home's minute-bucket
// re-arm from unmounting the plate (and the quest dialog inside it).
describe("resolveSmoothed (native)", () => {
  it("shows nothing and is not pending before the very first result", () => {
    expect(resolveSmoothed(undefined, undefined)).toEqual({
      data: undefined,
      isPending: false,
    });
  });

  it("passes the live value through once loaded", () => {
    expect(resolveSmoothed("plateA", "plateA")).toEqual({
      data: "plateA",
      isPending: false,
    });
  });

  it("retains the previous value while a minute re-arm is in flight", () => {
    expect(resolveSmoothed(undefined, "plateA")).toEqual({
      data: "plateA",
      isPending: true,
    });
  });

  it("swaps to the new value when the re-armed result lands", () => {
    expect(resolveSmoothed("plateB", "plateA")).toEqual({
      data: "plateB",
      isPending: false,
    });
  });
});

// A skip (signed out) must drop the retained plate so the next scholar to sign
// in on a shared iPad never sees the previous scholar's Home for a round-trip.
describe("nextRetained (native)", () => {
  it("keeps the previous plate while a minute re-arm loads", () => {
    expect(nextRetained(undefined, "plateA", false)).toBe("plateA");
  });

  it("drops the retained plate while skipped, and re-enables from nothing", () => {
    const afterSkip = nextRetained(undefined, "plateA", true);
    expect(afterSkip).toBeUndefined();
    expect(nextRetained(undefined, afterSkip, false)).toBeUndefined();
  });
});
