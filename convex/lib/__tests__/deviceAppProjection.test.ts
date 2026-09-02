// The verify BARRIER's clearing rule, tested at the pure layer.
//
// This is the one piece of the allowlist projection whose correctness is a
// statement about TIME rather than about the database: "a write succeeding
// proves nothing about a different write that may still be in flight." The
// database-level consequences are covered in
// convex/__tests__/deviceAppProjection.test.ts; what is pinned here is the
// rule itself, where an off-by-one on the comparison is invisible in an
// integration test but reinstates the exact bug the fence exists to prevent.

import { describe, expect, test } from "vitest";
import {
  MAX_PATCH_LANDING_MS,
  resolveProjectionTrust,
  uncertainProjectionWrite,
} from "../deviceAppProjection";

describe("uncertainProjectionWrite", () => {
  test("fences the window in which the uncertain write could still land", () => {
    const startedAt = 1_000_000;
    expect(uncertainProjectionWrite({}, startedAt)).toEqual({
      projectionVerifyNeeded: true,
      projectionVerifiedAt: undefined,
      projectionVerifyBarrierAt: startedAt + MAX_PATCH_LANDING_MS,
    });
  });

  test("concurrent uncertain writes keep the LATEST barrier, never shorten it", () => {
    const first = 5_000_000;
    const earlier = 1_000_000;
    // A second, older uncertain operation must not pull the fence back in
    // front of a write that can still land later than it can.
    expect(
      uncertainProjectionWrite(
        { projectionVerifyBarrierAt: first + MAX_PATCH_LANDING_MS },
        earlier,
      ).projectionVerifyBarrierAt,
    ).toBe(first + MAX_PATCH_LANDING_MS);
  });

  test("a later uncertain write extends the barrier", () => {
    const early = 1_000_000;
    const late = 9_000_000;
    expect(
      uncertainProjectionWrite(
        { projectionVerifyBarrierAt: early + MAX_PATCH_LANDING_MS },
        late,
      ).projectionVerifyBarrierAt,
    ).toBe(late + MAX_PATCH_LANDING_MS);
  });
});

describe("resolveProjectionTrust — only a live read AFTER the barrier clears it", () => {
  const barrierAt = 10_000_000;

  test("a live read after the barrier restores trust", () => {
    expect(
      resolveProjectionTrust({
        now: barrierAt + 1,
        barrierAt,
        verifiedByLiveRead: true,
      }),
    ).toEqual({
      projectionVerifyNeeded: false,
      projectionVerifiedAt: barrierAt + 1,
      projectionVerifyBarrierAt: undefined,
    });
  });

  test("a live read BEFORE the barrier does not — this is the whole fence", () => {
    // The interleaving: an earlier write timed out, a later one succeeded and
    // read the profile, and only then does the first one land. Clearing here
    // would trust a profile that is about to change under us.
    const result = resolveProjectionTrust({
      now: barrierAt - 1,
      barrierAt,
      verifiedByLiveRead: true,
    });
    expect(result.projectionVerifyNeeded).toBe(true);
    expect(result.projectionVerifiedAt).toBeUndefined();
    expect(result.projectionVerifyBarrierAt).toBe(barrierAt);
  });

  test("exactly AT the barrier is still inside the window (strictly after only)", () => {
    expect(
      resolveProjectionTrust({
        now: barrierAt,
        barrierAt,
        verifiedByLiveRead: true,
      }).projectionVerifyNeeded,
    ).toBe(true);
  });

  test("a write that did NOT read the profile never clears it, however late", () => {
    expect(
      resolveProjectionTrust({
        now: barrierAt + 1_000_000,
        barrierAt,
        verifiedByLiveRead: false,
      }).projectionVerifyNeeded,
    ).toBe(true);
  });

  test("with no barrier outstanding, a live read restores trust immediately", () => {
    expect(
      resolveProjectionTrust({
        now: 42,
        barrierAt: undefined,
        verifiedByLiveRead: true,
      }),
    ).toEqual({
      projectionVerifyNeeded: false,
      projectionVerifiedAt: 42,
      projectionVerifyBarrierAt: undefined,
    });
  });

  test("with no barrier, a non-read still does not restore trust", () => {
    expect(
      resolveProjectionTrust({
        now: 42,
        barrierAt: undefined,
        verifiedByLiveRead: false,
      }).projectionVerifyNeeded,
    ).toBe(true);
  });
});
